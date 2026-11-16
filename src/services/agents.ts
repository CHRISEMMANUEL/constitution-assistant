import { searchArticles, type ArticleSearchHit } from './api';
import {
  answer,
  confidenceFromScore,
  constitutionsById,
  isProfileOnlyArticle,
  mentionedCountryIds,
  searchCorpus,
  waitForCorpus,
  type CitedAnswer,
  type ScoredArticle,
} from './ai';
import { completeChat, isAiConfigured, streamRAG, type ChatTurn } from './llm';

export type AgentStage = 'planning' | 'searching' | 'writing';

export interface PlannedSearch {
  query: string;
  countryIds: string[];
}

interface Findings {
  sources: ScoredArticle[];
  confidence: CitedAnswer['confidence'];
}

const MAX_SEARCHES = 4;
const PER_SEARCH = 6;
const MAX_SOURCES = 8;
const HISTORY_TURNS = 6;
const HISTORY_CHARS = 1200;

const PLANNER_PROMPT = `You plan searches over a database of national constitutions for a research assistant.
Reply with one JSON object and nothing else, in this shape:
{"searches": [{"query": "...", "countries": ["..."]}]}
- searches: 1 to 4 searches that together find the provisions needed to answer the latest question. Resolve references to earlier turns ("what about Kenya?", "that article").
- When the question compares countries, make one search per country.
- query: 2 to 8 keywords likely to appear in constitutional text, for example "freedom expression speech press". Not a sentence.
- countries: English names of the countries the search is about, or [] to search every country.`;

const stripForHistory = (text: string): string =>
  text
    .replace(/\s?\[Source \d+\]/g, '')
    .replace(/^_AI responses are informational.*$/gm, '')
    .trim();

export function conversationHistory(turns: ChatTurn[]): ChatTurn[] {
  const merged: ChatTurn[] = [];
  for (const turn of turns) {
    const content = (turn.role === 'assistant' ? stripForHistory(turn.content) : turn.content.trim())
      .slice(0, HISTORY_CHARS);
    if (!content) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.content += `\n\n${content}`;
    else merged.push({ role: turn.role, content });
  }
  const recent = merged.slice(-HISTORY_TURNS);
  while (recent.length && recent[0].role !== 'user') recent.shift();
  if (recent.length && recent[recent.length - 1].role === 'user') recent.pop();
  return recent;
}

const plannerMessage = (question: string, history: ChatTurn[]): string => {
  const transcript = history
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n\n');
  return transcript
    ? `Conversation so far:\n${transcript}\n\nLatest question: ${question}`
    : `Latest question: ${question}`;
};

function parsePlan(text: string): Array<{ query: string; countries: string[] }> {
  const match = text.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const raw = JSON.parse(match[0]) as { searches?: unknown };
    if (!Array.isArray(raw.searches)) return [];
    return raw.searches
      .map((s) => {
        const item = s as { query?: unknown; countries?: unknown };
        return {
          query: typeof item.query === 'string' ? item.query.trim() : '',
          countries: Array.isArray(item.countries)
            ? item.countries.filter((c): c is string => typeof c === 'string')
            : [],
        };
      })
      .filter((s) => s.query)
      .slice(0, MAX_SEARCHES);
  } catch {
    return [];
  }
}

async function fallbackPlan(question: string): Promise<PlannedSearch[]> {
  const ids = await mentionedCountryIds(question);
  if (ids.length > 1) return ids.map((id) => ({ query: question, countryIds: [id] }));
  return [{ query: question, countryIds: ids }];
}

async function plan(question: string, history: ChatTurn[], signal?: AbortSignal): Promise<PlannedSearch[]> {
  let reply: string;
  try {
    reply = await completeChat(
      PLANNER_PROMPT,
      [{ role: 'user', content: plannerMessage(question, history) }],
      signal,
    );
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'AbortError' || name === 'InvalidKeyError') throw err;
    console.warn('[agents] planner failed, searching with the question as typed.', err);
    return fallbackPlan(question);
  }

  const searches = parsePlan(reply);
  if (searches.length === 0) {
    console.warn('[agents] planner reply had no usable searches.', reply.slice(0, 300));
    return fallbackPlan(question);
  }
  return Promise.all(
    searches.map(async (s) => ({
      query: s.query,
      countryIds: s.countries.length ? await mentionedCountryIds(s.countries.join(', ')) : [],
    })),
  );
}

function interleave(lists: ScoredArticle[][], max: number): ScoredArticle[] {
  const seen = new Set<string>();
  const out: ScoredArticle[] = [];
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < depth && out.length < max; i++) {
    for (const list of lists) {
      const hit = list[i];
      if (!hit || seen.has(hit.article.id)) continue;
      seen.add(hit.article.id);
      out.push(hit);
      if (out.length >= max) break;
    }
  }
  return out;
}

function searchLocally(search: PlannedSearch): ScoredArticle[] {
  if (search.countryIds.length === 0) return searchCorpus(search.query, PER_SEARCH);
  return searchCorpus(search.query, Number.MAX_SAFE_INTEGER)
    .filter((hit) => search.countryIds.includes(hit.constitution.id))
    .slice(0, PER_SEARCH);
}

async function research(searches: PlannedSearch[]): Promise<Findings> {
  const remote = await Promise.all(
    searches.map((s) => searchArticles(s.query, s.countryIds, PER_SEARCH)),
  );

  if (remote.every((hits): hits is ArticleSearchHit[] => hits !== null)) {
    const byId = await constitutionsById();
    const lists = remote.map((hits) =>
      hits.flatMap(({ rank, matched_all, ...article }) => {
        const constitution = byId.get(article.constitution_id);
        return constitution ? [{ article, constitution, score: rank + (matched_all ? 1 : 0) }] : [];
      }),
    );
    const answered = lists.filter((l) => l.length > 0);
    const exact = answered.filter((l) => l[0].score >= 1).length;
    const confidence: CitedAnswer['confidence'] =
      answered.length === 0 ? 'low' : exact === answered.length ? 'high' : exact > 0 ? 'medium' : 'low';
    return { sources: interleave(lists, MAX_SOURCES), confidence };
  }

  await waitForCorpus();
  const lists = searches.map(searchLocally);
  const best = Math.max(0, ...lists.flat().map((h) => h.score));
  return { sources: interleave(lists, MAX_SOURCES), confidence: confidenceFromScore(best) };
}

export interface SmartAnswerOptions {
  query: string;
  history?: ChatTurn[];
  signal?: AbortSignal;
  onStage?: (stage: AgentStage) => void;
  onToken?: (token: string) => void;
  onSources?: (sources: ScoredArticle[]) => void;
}

const tagProfileOnly = (a: CitedAnswer): CitedAnswer => {
  const top = a.hits[0];
  if (top && isProfileOnlyArticle(top.article) && a.hits.length === 1) {
    return { ...a, degraded: 'profile-only' };
  }
  return a;
};

async function localAnswer(query: string): Promise<CitedAnswer> {
  await waitForCorpus();
  return answer(query);
}

export const answerSmart = async (opts: SmartAnswerOptions): Promise<CitedAnswer> => {
  const { query, signal, onStage, onToken, onSources } = opts;
  const trimmed = query.trim();

  if (!trimmed) {
    const empty: CitedAnswer = {
      reply:
        'Please ask a question about constitutional law and I will cite the most relevant articles I have indexed.',
      hits: [],
      confidence: 'low',
    };
    onToken?.(empty.reply);
    return empty;
  }

  if (!isAiConfigured()) {
    const local = await localAnswer(trimmed);
    onSources?.(local.hits);
    onToken?.(local.reply);
    return tagProfileOnly(local);
  }

  const history = conversationHistory(opts.history ?? []);
  let findings: Findings = { sources: [], confidence: 'low' };
  let accumulated = '';
  try {
    onStage?.('planning');
    const searches = await plan(trimmed, history, signal);

    onStage?.('searching');
    findings = await research(searches);
    onSources?.(findings.sources);

    if (findings.sources.length === 0) {
      const fallback = await localAnswer(trimmed);
      onSources?.(fallback.hits);
      onToken?.(fallback.reply);
      return tagProfileOnly(fallback);
    }

    onStage?.('writing');
    await streamRAG({
      question: trimmed,
      sources: findings.sources,
      history,
      signal,
      onToken: (t) => {
        accumulated += t;
        onToken?.(t);
      },
    });
    return tagProfileOnly({
      reply: accumulated.trim() || (await localAnswer(trimmed)).reply,
      hits: findings.sources,
      confidence: findings.confidence,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return {
        reply: accumulated || '_(generation cancelled)_',
        hits: findings.sources,
        confidence: findings.confidence,
      };
    }
    console.warn('[agents] AI answer failed, falling back to local.', err);
    const fallback = await localAnswer(trimmed);
    onToken?.(fallback.reply);
    const degraded = (err as Error).name === 'InvalidKeyError' ? 'invalid-key' : 'llm-unavailable';
    return tagProfileOnly({ ...fallback, degraded });
  }
};
