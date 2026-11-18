import {
  articles as bundledArticles,
  constitutions as bundledConstitutions,
  type BundledArticle,
  type BundledConstitution,
} from '../data/constitutions';
import {
  fetchAllArticles,
  fetchConstitutions,
  searchArticles,
  type Article,
  type ArticleSearchHit,
  type Constitution,
} from './api';

export interface CitedAnswer {
  reply: string;
  hits: ScoredArticle[];
  confidence: 'high' | 'medium' | 'low';
  degraded?: 'llm-unavailable' | 'invalid-key' | 'profile-only';
  unverifiedQuotes?: number;
  // Set when the question named no country: the reply asks which one, offering these as choices.
  askCountry?: { question: string; countries: Array<{ id: string; name: string; flag: string }> };
}

export interface ScoredArticle {
  article: BundledArticle | Article;
  constitution: BundledConstitution | Constitution;
  score: number;
}

const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','of','in','on','at','for','to','from','by','with','as',
  'is','are','was','were','be','been','being','do','does','did','have','has','had','will','would',
  'shall','should','can','could','may','might','must','this','that','these','those','it','its',
  'about','what','which','who','whom','whose','how','why','where','when','say','says','said',
  'i','me','my','we','our','you','your','they','them','their','there','here','than','also','any',
  'all','some','no','not','so','too','very','more','most','such','only','own','same','just',
  'me','please','tell','explain','give','show','want','need','know','question','article','section',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

interface IndexEntry {
  article: BundledArticle | Article;
  constitution: BundledConstitution | Constitution;
  termFreq: Map<string, number>;
  length: number;
}

interface CorpusIndex {
  entries: IndexEntry[];
  idf: Map<string, number>;
  boosts: Array<{ pattern: RegExp; id: string }>;
  source: 'bundled' | 'supabase';
}

let indexCache: CorpusIndex | null = null;
let preloadPromise: Promise<void> | null = null;
let constitutionsPromise: Promise<Map<string, BundledConstitution | Constitution>> | null = null;

export function constitutionsById(): Promise<Map<string, BundledConstitution | Constitution>> {
  if (!constitutionsPromise) {
    constitutionsPromise = fetchConstitutions()
      .then((cs) => new Map<string, BundledConstitution | Constitution>(cs.map((c) => [c.id, c])))
      .catch(() => new Map(bundledConstitutions.map((c) => [c.id, c])));
  }
  return constitutionsPromise;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildBoosts(
  cs: Array<BundledConstitution | Constitution>,
): Array<{ pattern: RegExp; id: string }> {
  const out: Array<{ pattern: RegExp; id: string }> = [];
  for (const c of cs) {
    if (!c.country) continue;
    // The optional suffix catches demonyms such as Nigerian, Kenyan, Ghanaian and Japanese.
    out.push({
      pattern: new RegExp(`\\b(${escapeRegex(c.country)})(?:n|an|ian|ese)?s?\\b`, 'i'),
      id: c.id,
    });
  }
  const aliases: Array<[RegExp, string]> = [
    [/\b(united states|usa|u\.s\.|america|american)\b/i, 'us'],
    [/\bU\.?S\.?A?\b/, 'us'],
    [/\bbritain|british|uk\b/i, 'gb'],
    [/\b(czech republic|czechia)\b/i, 'cz'],
    [/\bholland\b/i, 'nl'],
    [/\bburma\b/i, 'mm'],
    [/\bivory coast\b/i, 'ci'],
  ];
  for (const [pattern, id] of aliases) out.push({ pattern, id });
  return out;
}

const globally = (pattern: RegExp): RegExp =>
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);

// Longest match wins, so "South Sudan" is not also Sudan. On a tie the longer country name wins,
// so "Nigerian" is Nigeria + "n" rather than Niger + "ian".
function countriesIn(text: string, boosts: Array<{ pattern: RegExp; id: string }>): string[] {
  const found = boosts.flatMap(({ pattern, id }) =>
    [...text.matchAll(globally(pattern))].map((m) => ({
      id,
      start: m.index,
      end: m.index + m[0].length,
      name: (m[1] ?? m[0]).length,
    })),
  );
  type Match = (typeof found)[number];
  const beats = (b: Match, a: Match) =>
    b.start <= a.start &&
    b.end >= a.end &&
    (b.end - b.start > a.end - a.start || (b.end - b.start === a.end - a.start && b.name > a.name));
  const kept = found.filter((a) => !found.some((b) => beats(b, a)));
  return [...new Set(kept.sort((a, b) => a.start - b.start).map((m) => m.id))];
}

function buildIndexFrom(
  articleList: Array<BundledArticle | Article>,
  constitutionList: Array<BundledConstitution | Constitution>,
  source: 'bundled' | 'supabase',
): CorpusIndex {
  const cById = new Map(constitutionList.map((c) => [c.id, c]));
  const entries: IndexEntry[] = articleList
    .map((a) => {
      const constitution = cById.get(a.constitution_id);
      if (!constitution) return null;
      const tokens = tokenize(`${a.title} ${a.content} ${a.chapter}`);
      const tf = new Map<string, number>();
      tokens.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + 1));
      return {
        article: a,
        constitution,
        termFreq: tf,
        length: tokens.length || 1,
      };
    })
    .filter((e): e is IndexEntry => e !== null);

  const df = new Map<string, number>();
  entries.forEach((e) => {
    for (const t of e.termFreq.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  });
  const N = entries.length || 1;
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log(1 + N / freq));
  }

  return { entries, idf, boosts: buildBoosts(constitutionList), source };
}

async function buildIndexFromAsync(
  articleList: Array<BundledArticle | Article>,
  constitutionList: Array<BundledConstitution | Constitution>,
  source: 'bundled' | 'supabase',
): Promise<CorpusIndex> {
  const CHUNK = 500;
  const cById = new Map(constitutionList.map((c) => [c.id, c]));
  const entries: IndexEntry[] = [];

  for (let i = 0; i < articleList.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, articleList.length);
    for (let j = i; j < end; j++) {
      const a = articleList[j];
      const constitution = cById.get(a.constitution_id);
      if (!constitution) continue;
      const tokens = tokenize(`${a.title} ${a.content} ${a.chapter}`);
      const tf = new Map<string, number>();
      tokens.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + 1));
      entries.push({
        article: a,
        constitution,
        termFreq: tf,
        length: tokens.length || 1,
      });
    }
    if (end < articleList.length) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  const df = new Map<string, number>();
  for (const e of entries) {
    for (const t of e.termFreq.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = entries.length || 1;
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log(1 + N / freq));
  }

  return { entries, idf, boosts: buildBoosts(constitutionList), source };
}

function buildIndex(): CorpusIndex {
  if (indexCache) return indexCache;
  indexCache = buildIndexFrom(bundledArticles, bundledConstitutions, 'bundled');
  return indexCache;
}

export async function preloadCorpus(): Promise<void> {
  if (preloadPromise) return preloadPromise;
  preloadPromise = (async () => {
    try {
      const [consById, allArticles] = await Promise.all([
        constitutionsById(),
        fetchAllArticles(),
      ]);
      const allCons = Array.from(consById.values());
      if (allArticles.length === 0 || allCons.length === 0) return;
      indexCache = await buildIndexFromAsync(allArticles, allCons, 'supabase');
      console.info(
        `[ai] corpus loaded: ${allArticles.length} articles across ${allCons.length} countries (Supabase).`,
      );
    } catch (err) {
      console.warn('[ai] corpus preload failed; using bundled fallback.', err);
    }
  })();
  return preloadPromise;
}

export const corpusSize = (): number => buildIndex().entries.length;

export const isCorpusReady = (): boolean => indexCache?.source === 'supabase';

export const isCorpusLoading = (): boolean =>
  !!preloadPromise && !isCorpusReady();

// The full corpus (~43k articles) is only downloaded the first time a local search needs it.
export async function waitForCorpus(): Promise<void> {
  await preloadCorpus();
}

let countryPatterns: Promise<Array<{ pattern: RegExp; id: string }>> | null = null;

function countryBoosts(): Promise<Array<{ pattern: RegExp; id: string }>> {
  if (!countryPatterns) {
    countryPatterns = constitutionsById().then((cs) => buildBoosts(Array.from(cs.values())));
  }
  return countryPatterns;
}

export async function mentionedCountryIds(text: string): Promise<string[]> {
  return countriesIn(text, await countryBoosts());
}

export async function withoutCountryNames(text: string): Promise<string> {
  let rest = text;
  for (const { pattern } of await countryBoosts()) rest = rest.replace(globally(pattern), ' ');
  return rest;
}

export const isProfileOnlyArticle = (a: BundledArticle | Article): boolean =>
  typeof a.id === 'string' && a.id.endsWith('-profile');

// Country names and "constitution" are dropped from local queries, as in the database search: they
// match articles that name their own country ("Supreme Court of Nigeria") rather than the subject.
function queryTokens(query: string, boosts: Array<{ pattern: RegExp }>): string[] {
  let rest = query;
  for (const { pattern } of boosts) rest = rest.replace(globally(pattern), ' ');
  const tokens = tokenize(rest.replace(/\bconstitution(?:s|al)?\b/gi, ' '));
  return tokens.length ? tokens : tokenize(query);
}

// A named country is a filter, not a boost: a question about Nigeria never answers from Serbia.
export function searchCorpus(query: string, k = 4): ScoredArticle[] {
  const { entries, idf, boosts } = buildIndex();
  const qTokens = queryTokens(query, boosts);
  if (qTokens.length === 0) return [];

  const countries = countriesIn(query, boosts);
  const pool = countries.length ? entries.filter((e) => countries.includes(e.constitution.id)) : entries;

  const scored: ScoredArticle[] = pool.map((e) => {
    let score = 0;
    for (const t of qTokens) {
      const tf = e.termFreq.get(t);
      if (!tf) continue;
      score += (tf / e.length) * (idf.get(t) ?? 0);
    }
    return { article: e.article, constitution: e.constitution, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function snippet(text: string, query: string, max = 280): string {
  const qTokens = tokenize(query);
  const lower = text.toLowerCase();
  let bestIdx = -1;
  for (const t of qTokens) {
    const i = lower.indexOf(t);
    if (i !== -1 && (bestIdx === -1 || i < bestIdx)) bestIdx = i;
  }
  if (bestIdx === -1) return text.slice(0, max) + (text.length > max ? '…' : '');
  const start = Math.max(0, bestIdx - 60);
  const end = Math.min(text.length, start + max);
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, end).trim() +
    (end < text.length ? '…' : '')
  );
}

const COMPARE_TRIGGER = /\b(compare|vs|versus|difference|differ)\b/i;

function compareAcrossCountries(query: string): CitedAnswer | null {
  if (!COMPARE_TRIGGER.test(query)) return null;
  const { entries, idf, boosts } = buildIndex();
  const mentioned = countriesIn(query, boosts);
  if (mentioned.length < 2) return null;
  const qTokens = queryTokens(query, boosts);

  const perCountry: ScoredArticle[] = [];
  for (const id of mentioned) {
    const candidates = entries.filter((e) => e.constitution.id === id);
    if (candidates.length === 0) continue;
    let best: IndexEntry | null = null;
    let bestScore = 0;
    for (const e of candidates) {
      let s = 0;
      for (const t of qTokens) {
        const tf = e.termFreq.get(t);
        if (!tf) continue;
        s += (tf / e.length) * (idf.get(t) ?? 0);
      }
      if (s > bestScore) {
        bestScore = s;
        best = e;
      }
    }
    if (best && bestScore > 0) {
      perCountry.push({
        article: best.article,
        constitution: best.constitution,
        score: bestScore,
      });
    }
  }

  return perCountry.length < 2 ? null : compareReply(query, perCountry);
}

function compareReply(query: string, perCountry: ScoredArticle[]): CitedAnswer {
  const intro = `Here is a side-by-side comparison drawn directly from each constitution:`;
  const blocks = perCountry
    .map(
      (h) =>
        `• **${h.constitution.country}** — ${h.article.article_number}, "${h.article.title}":\n   ${snippet(h.article.content, query, 240)}`,
    )
    .join('\n\n');

  return {
    reply: `${intro}\n\n${blocks}\n\n_Note: this is a quotation-only comparison from the indexed corpus, not legal advice._`,
    hits: perCountry,
    confidence: 'medium',
  };
}

const EMPTY_QUESTION: CitedAnswer = {
  reply: 'Please ask a question about constitutional law and I will cite the most relevant articles I have indexed.',
  hits: [],
  confidence: 'low',
};

const noMatchReply = (sizeNote: string): CitedAnswer => ({
  reply: `I couldn't find a passage that clearly matches that question. ${sizeNote} Try rephrasing — e.g. mention the country by name ("freedom of expression in Kenya"), the right itself ("right to a fair trial"), or ask me to compare two countries.`,
  hits: [],
  confidence: 'low',
});

export function answer(query: string): CitedAnswer {
  const trimmed = query.trim();
  if (!trimmed) return EMPTY_QUESTION;

  const cmp = compareAcrossCountries(trimmed);
  if (cmp) return cmp;

  const hits = searchCorpus(trimmed, 4);
  if (hits.length === 0) {
    const { entries, source } = buildIndex();
    return noMatchReply(
      source === 'supabase'
        ? `My corpus indexes ${entries.length} articles across every country with available text.`
        : `My corpus is still loading; only the offline bundle is ready right now.`,
    );
  }

  return hitsReply(trimmed, hits, confidenceFromScore(hits[0].score));
}

function hitsReply(
  trimmed: string,
  hits: ScoredArticle[],
  confidence: CitedAnswer['confidence'],
): CitedAnswer {
  const top = hits[0];
  const lead =
    confidence === 'high'
      ? `The closest provision in my indexed corpus is from **${top.constitution.country}**, **${top.article.article_number} — ${top.article.title}**:`
      : `The most relevant passage I could find (lower confidence) is from **${top.constitution.country}**, **${top.article.article_number} — ${top.article.title}**:`;

  const quote = `> ${snippet(top.article.content, trimmed, 360)}`;

  const more =
    hits.length > 1
      ? `\n\nRelated provisions you may want to read:\n` +
        hits
          .slice(1)
          .map(
            (h) =>
              `• ${h.constitution.flag} **${h.constitution.country}** — ${h.article.article_number} (${h.article.title})`,
          )
          .join('\n')
      : '';

  return {
    reply: `${lead}\n\n${quote}${more}\n\n_AI responses are informational and not legal advice._`,
    hits,
    confidence,
  };
}

export function retrieveForRAG(query: string, k = 6): ScoredArticle[] {
  const top = searchCorpus(query, k);
  const mentioned = countriesIn(query, buildIndex().boosts);
  if (mentioned.length < 2) return top;

  const deep = searchCorpus(query, 50);
  const seen = new Set<string>();
  const out: ScoredArticle[] = [];

  for (const id of mentioned) {
    const best = deep.find((s) => s.constitution.id === id);
    if (best && !seen.has(best.article.id)) {
      out.push(best);
      seen.add(best.article.id);
    }
  }
  for (const s of top) {
    if (out.length >= k) break;
    if (!seen.has(s.article.id)) {
      out.push(s);
      seen.add(s.article.id);
    }
  }
  return out;
}

export const confidenceFromScore = (score: number): CitedAnswer['confidence'] =>
  score > 0.25 ? 'high' : score > 0.08 ? 'medium' : 'low';

// Database rows score rank + 1 when every search term matched, so a score >= 1 means an exact match.
export async function fromDatabaseHits(hits: ArticleSearchHit[]): Promise<ScoredArticle[]> {
  const byId = await constitutionsById();
  return hits.flatMap(({ rank, matched_all, ...article }) => {
    const constitution = byId.get(article.constitution_id);
    return constitution ? [{ article, constitution, score: rank + (matched_all ? 1 : 0) }] : [];
  });
}

// Unlike the local tokenizer, the database search keeps digits and "article", so "Article 9" works.
const DATABASE_FILLER = new Set(
  [
    ...STOPWORDS,
    'constitution', 'constitutions', 'constitutional',
    'compare', 'comparison', 'vs', 'versus', 'difference', 'differences', 'differ', 'between',
  ].filter((w) => w !== 'article' && w !== 'section'),
);

// Country names become a filter rather than search terms, since articles rarely name their own country.
function databaseTerms(text: string, countries: Array<{ pattern: RegExp }>): string {
  let rest = text;
  for (const { pattern } of countries) rest = rest.replace(globally(pattern), ' ');
  return rest
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => (t.length > 1 || /\d/.test(t)) && !DATABASE_FILLER.has(t))
    .join(' ');
}

// Answers without downloading the corpus. Returns null when the database search is unavailable.
export async function answerFromDatabase(query: string): Promise<CitedAnswer | null> {
  const trimmed = query.trim();
  if (!trimmed) return EMPTY_QUESTION;

  const countries = await countryBoosts();
  const mentioned = countriesIn(trimmed, countries);
  const terms = databaseTerms(trimmed, countries) || trimmed;

  if (COMPARE_TRIGGER.test(trimmed) && mentioned.length >= 2) {
    const tops = await Promise.all(mentioned.map((id) => searchArticles(terms, [id], 1)));
    if (tops.some((t) => t === null)) return null;
    const perCountry = await fromDatabaseHits(tops.flatMap((t) => t ?? []));
    if (perCountry.length >= 2) return compareReply(trimmed, perCountry);
  }

  const found = await searchArticles(terms, mentioned, 4);
  if (found === null) return null;
  const hits = await fromDatabaseHits(found);
  if (hits.length === 0) {
    return noMatchReply('I searched the full text of every constitution in the database.');
  }
  return hitsReply(trimmed, hits, hits[0].score >= 1 ? 'high' : 'low');
}
