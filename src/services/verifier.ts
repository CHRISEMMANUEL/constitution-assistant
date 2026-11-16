import type { ScoredArticle } from './ai';

export interface VerifyReport {
  badSources: number[];
  unmatchedQuotes: string[];
  uncited: boolean;
}

const CITATION = /\[Sources?\s+([^\]]*\d[^\]]*)\]/gi;
const NO_ANSWER_OPENER = 'the provided sources do not contain a direct answer';
const MIN_QUOTE_WORDS = 3;
const MIN_INLINE_QUOTE_WORDS = 6;

const normalize = (text: string): string =>
  text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const wordCount = (text: string): number => normalize(text).split(' ').filter(Boolean).length;

const citedNumbers = (group: string): number[] => (group.match(/\d+/g) ?? []).map(Number);

const withoutCitations = (text: string): string => text.replace(CITATION, ' ');

const quotedSpans = (text: string): string[] =>
  [...text.matchAll(/["“]([^"“”]+)["”]/g)].map((m) => m[1]);

function extractQuotes(reply: string): string[] {
  const quotes: string[] = [];
  const prose: string[] = [];
  for (const line of reply.split('\n')) {
    const block = line.match(/^\s*>\s?(.*)$/);
    if (!block) {
      prose.push(line);
      continue;
    }
    const body = withoutCitations(block[1]);
    const spans = quotedSpans(body);
    // A blockquote without quote marks is the quote itself, minus a trailing "— Country, Article N".
    const unquoted = ` ${body}`.replace(/\s[—–-]\s.*$/, '').replace(/\([^)]*\)\s*$/, '');
    quotes.push(...(spans.length ? spans : [unquoted]));
  }
  for (const span of quotedSpans(withoutCitations(prose.join('\n')))) {
    if (wordCount(span) >= MIN_INLINE_QUOTE_WORDS) quotes.push(span);
  }
  return quotes.map((q) => q.trim()).filter((q) => wordCount(q) >= MIN_QUOTE_WORDS);
}

// Ellipses and [bracketed insertions] are allowed edits; every remaining fragment must be verbatim.
const quoteFound = (quote: string, haystack: string): boolean =>
  quote
    .split(/\.{3}|…|\[[^\]]*\]/)
    .map(normalize)
    .filter((fragment) => fragment.split(' ').length >= MIN_QUOTE_WORDS)
    .every((fragment) => haystack.includes(fragment));

export function verifyAnswer(reply: string, sources: ScoredArticle[]): VerifyReport {
  const cited = [...reply.matchAll(CITATION)].flatMap((m) => citedNumbers(m[1]));
  const badSources = [...new Set(cited.filter((n) => n < 1 || n > sources.length))];
  const haystack = sources
    .map((s) => normalize(`${s.article.title} ${s.article.content}`))
    .join(' | ');
  const unmatchedQuotes = extractQuotes(reply).filter((q) => !quoteFound(q, haystack));
  const uncited =
    sources.length > 0 &&
    cited.length === badSources.length &&
    !normalize(reply).startsWith(normalize(NO_ANSWER_OPENER));
  return { badSources, unmatchedQuotes, uncited };
}

export const problemCount = (r: VerifyReport): number =>
  r.badSources.length + r.unmatchedQuotes.length + (r.uncited ? 1 : 0);

export function describeProblems(r: VerifyReport, sourceCount: number): string[] {
  const problems: string[] = [];
  if (r.badSources.length) {
    problems.push(
      `It cites ${r.badSources.map((n) => `[Source ${n}]`).join(', ')}, but the CONTEXT only has Sources 1 to ${sourceCount}.`,
    );
  }
  for (const q of r.unmatchedQuotes) {
    problems.push(
      `This quote does not appear word for word in any source: "${q.slice(0, 300)}". Quote the exact wording from the CONTEXT, or paraphrase it without quote marks.`,
    );
  }
  if (r.uncited) {
    problems.push('It makes claims without any [Source N] citation. Cite the source for every claim.');
  }
  return problems;
}

// Drops citation numbers that point past the source list; a bracket left with none is removed.
export const stripBadCitations = (reply: string, sourceCount: number): string =>
  reply.replace(/\s?\[Sources?\s+([^\]]*\d[^\]]*)\]/gi, (match, group: string) => {
    const nums = citedNumbers(group);
    const valid = nums.filter((n) => n >= 1 && n <= sourceCount);
    if (valid.length === nums.length) return match;
    if (valid.length === 0) return '';
    const lead = match.startsWith(' ') ? ' ' : '';
    return `${lead}[Source ${valid.join(', ')}]`;
  });
