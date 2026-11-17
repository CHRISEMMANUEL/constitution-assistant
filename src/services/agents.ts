import { searchArticles, type ArticleSearchHit } from './api';
import {
  answer,
  answerFromDatabase,
  confidenceFromScore,
  constitutionsById,
  fromDatabaseHits,
  isProfileOnlyArticle,
  mentionedCountryIds,
  searchCorpus,
  waitForCorpus,
  type CitedAnswer,
  type ScoredArticle,
} from './ai';
import { completeChat, isAiConfigured, sourceBlock, streamRAG, type ChatTurn } from './llm';
import { Trace, type AgentStep } from './trace';
import { describeProblems, problemCount, stripBadCitations, verifyAnswer } from './verifier';

export interface PlannedSearch {
  query: string;
  countryIds: string[];
}

interface Plan {
  searches: PlannedSearch[];
  fromPlanner: boolean;
}

interface Findings {
  sources: ScoredArticle[];
  confidence: CitedAnswer['confidence'];
  offline: boolean;
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

const ANALYST_PROMPT = `You are one analyst on a team comparing national constitutions. You see the provisions of ONE country only.
Write notes for the writer who will compose the final comparison:
- 2 to 5 bullet points on what these provisions say about the question.
- End each bullet with the [Source N] it comes from, using only the source numbers shown.
- When the exact wording matters, include it as a short quote in double quotes, copied word for word.
- If none of the provisions address the question, reply with this one line: "No provision among these sources addresses this."
- Use no outside knowledge. Do not write the comparison itself.`;

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

async function plan(question: string, history: ChatTurn[], signal?: AbortSignal): Promise<Plan> {
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
    return { searches: await fallbackPlan(question), fromPlanner: false };
  }

  const searches = parsePlan(reply);
  if (searches.length === 0) {
    console.warn('[agents] planner reply had no usable searches.', reply.slice(0, 300));
    return { searches: await fallbackPlan(question), fromPlanner: false };
  }
  const planned = await Promise.all(
    searches.map(async (s) => ({
      query: s.query,
      countryIds: s.countries.length ? await mentionedCountryIds(s.countries.join(', ')) : [],
    })),
  );
  return { searches: planned, fromPlanner: true };
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
    const lists = await Promise.all(remote.map(fromDatabaseHits));
    const answered = lists.filter((l) => l.length > 0);
    const exact = answered.filter((l) => l[0].score >= 1).length;
    const confidence: CitedAnswer['confidence'] =
      answered.length === 0 ? 'low' : exact === answered.length ? 'high' : exact > 0 ? 'medium' : 'low';
    return { sources: interleave(lists, MAX_SOURCES), confidence, offline: false };
  }

  await waitForCorpus();
  const lists = searches.map(searchLocally);
  const best = Math.max(0, ...lists.flat().map((h) => h.score));
  return { sources: interleave(lists, MAX_SOURCES), confidence: confidenceFromScore(best), offline: true };
}

// A comparison is any plan whose searches name two or more countries; each gets an analyst.
const comparedCountries = (searches: PlannedSearch[]): string[] => [
  ...new Set(searches.flatMap((s) => s.countryIds)),
];

async function analyzeCountry(
  question: string,
  search: string,
  country: string,
  numbered: Array<{ n: number; source: ScoredArticle }>,
  signal?: AbortSignal,
): Promise<string> {
  const blocks = numbered.map(({ n, source }) => sourceBlock(source, n)).join('\n\n---\n\n');
  const reply = await completeChat(
    ANALYST_PROMPT,
    [
      {
        role: 'user',
        content: `Country: ${country}\nQuestion: ${question}\nSearch used: ${search}\n\nSOURCES:\n---\n${blocks}\n---`,
      },
    ],
    signal,
    'analyze',
  );
  return reply.trim();
}

async function analyze(
  question: string,
  searches: PlannedSearch[],
  sources: ScoredArticle[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const countryIds = comparedCountries(searches);
  if (countryIds.length < 2) return undefined;

  const byId = await constitutionsById();
  const notes = await Promise.all(
    countryIds.map(async (id) => {
      const name = byId.get(id)?.country ?? id;
      const numbered = sources
        .map((source, i) => ({ n: i + 1, source }))
        .filter(({ source }) => source.constitution.id === id);
      if (numbered.length === 0) return `## ${name}\nNo source for ${name} was found in the indexed text.`;
      const search = searches.find((s) => s.countryIds.includes(id))?.query ?? question;
      try {
        return `## ${name}\n${await analyzeCountry(question, search, name, numbered, signal)}`;
      } catch (err) {
        const errName = (err as Error).name;
        if (errName === 'AbortError' || errName === 'InvalidKeyError') throw err;
        console.warn(`[agents] analyst for ${name} failed, the writer goes without its notes.`, err);
        return null;
      }
    }),
  );
  const usable = notes.filter((n): n is string => n !== null);
  return usable.length ? usable.join('\n\n') : undefined;
}

export interface SmartAnswerOptions {
  query: string;
  history?: ChatTurn[];
  signal?: AbortSignal;
  onTrace?: (steps: AgentStep[]) => void;
  onToken?: (token: string) => void;
  onReset?: () => void;
  onSources?: (sources: ScoredArticle[]) => void;
}

const tagProfileOnly = (a: CitedAnswer): CitedAnswer => {
  const top = a.hits[0];
  if (top && isProfileOnlyArticle(top.article) && a.hits.length === 1) {
    return { ...a, degraded: 'profile-only' };
  }
  return a;
};

interface Draft {
  question: string;
  sources: ScoredArticle[];
  history: ChatTurn[];
  notes?: string;
  text: string;
}

// The verifier is code, not a model: it checks citation numbers and quotes against the sources and
// asks the writer for one rewrite when something is off. Citations still out of range are dropped.
async function verifyAndRepair(
  draft: Draft,
  opts: SmartAnswerOptions,
  trace: Trace,
): Promise<{ reply: string; unverifiedQuotes: number }> {
  const { sources } = draft;
  trace.start('verifying');
  const report = verifyAnswer(draft.text, sources);
  trace.note({ count: problemCount(report) });
  if (problemCount(report) === 0) return { reply: draft.text, unverifiedQuotes: 0 };

  console.warn('[agents] verifier found problems, asking the writer for one repair.', report);
  trace.start('repairing');
  opts.onReset?.();
  let repaired = '';
  try {
    await streamRAG({
      question: draft.question,
      sources,
      history: draft.history,
      notes: draft.notes,
      repair: { draft: draft.text, problems: describeProblems(report, sources.length) },
      signal: opts.signal,
      onToken: (t) => {
        repaired += t;
        opts.onToken?.(t);
      },
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    console.warn('[agents] repair failed, keeping the first draft.', err);
    repaired = '';
  }

  const second = repaired.trim() ? verifyAnswer(repaired, sources) : null;
  const useRepair = second !== null && problemCount(second) <= problemCount(report);
  const chosen = useRepair ? repaired.trim() : draft.text;
  const final = useRepair ? second : report;
  trace.note({ repaired: useRepair });
  return {
    reply: stripBadCitations(chosen, sources.length),
    unverifiedQuotes: final.unmatchedQuotes.length,
  };
}

async function localAnswer(query: string): Promise<CitedAnswer> {
  const fromDatabase = await answerFromDatabase(query);
  if (fromDatabase) return fromDatabase;
  await waitForCorpus();
  return answer(query);
}

export const answerSmart = async (opts: SmartAnswerOptions): Promise<CitedAnswer> => {
  const { query, signal, onToken, onSources } = opts;
  const trimmed = query.trim();
  const trace = new Trace(opts.onTrace);

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
    trace.start('searching');
    const local = await localAnswer(trimmed);
    trace.note({ count: local.hits.length });
    trace.close();
    onSources?.(local.hits);
    onToken?.(local.reply);
    return tagProfileOnly(local);
  }

  const history = conversationHistory(opts.history ?? []);
  let findings: Findings = { sources: [], confidence: 'low', offline: false };
  let accumulated = '';
  try {
    trace.start('planning');
    const { searches, fromPlanner } = await plan(trimmed, history, signal);
    const byId = await constitutionsById();
    const countryName = (id: string) => byId.get(id)?.country ?? id;
    trace.note({
      searches: searches.map((s) => ({ query: s.query, countries: s.countryIds.map(countryName) })),
      fallback: !fromPlanner,
    });

    trace.start('searching');
    findings = await research(searches);
    trace.note({ count: findings.sources.length, fallback: findings.offline });
    onSources?.(findings.sources);

    if (findings.sources.length === 0) {
      const fallback = await localAnswer(trimmed);
      trace.close();
      onSources?.(fallback.hits);
      onToken?.(fallback.reply);
      return tagProfileOnly(fallback);
    }

    const compared = comparedCountries(searches);
    if (compared.length > 1) trace.start('analyzing', { countries: compared.map(countryName) });
    const notes = await analyze(trimmed, searches, findings.sources, signal);

    trace.start('writing');
    await streamRAG({
      question: trimmed,
      sources: findings.sources,
      history,
      notes,
      signal,
      onToken: (t) => {
        accumulated += t;
        onToken?.(t);
      },
    });
    const text = accumulated.trim();
    if (!text) {
      trace.close();
      return tagProfileOnly({
        reply: (await localAnswer(trimmed)).reply,
        hits: findings.sources,
        confidence: findings.confidence,
      });
    }

    const checked = await verifyAndRepair(
      { question: trimmed, sources: findings.sources, history, notes, text },
      opts,
      trace,
    );
    trace.close();
    return tagProfileOnly({
      reply: checked.reply,
      hits: findings.sources,
      confidence: findings.confidence,
      ...(checked.unverifiedQuotes ? { unverifiedQuotes: checked.unverifiedQuotes } : {}),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      trace.close('stopped');
      return {
        reply: accumulated || '_(generation cancelled)_',
        hits: findings.sources,
        confidence: findings.confidence,
      };
    }
    console.warn('[agents] AI answer failed, falling back to local.', err);
    trace.close('failed');
    const fallback = await localAnswer(trimmed);
    onToken?.(fallback.reply);
    const degraded = (err as Error).name === 'InvalidKeyError' ? 'invalid-key' : 'llm-unavailable';
    return tagProfileOnly({ ...fallback, degraded });
  }
};
