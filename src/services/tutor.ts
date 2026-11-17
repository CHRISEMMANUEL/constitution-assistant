import type { ScoredArticle } from './ai';
import { completeChat, sourceBlock, type ChatTurn } from './llm';
import { Trace, type AgentStep } from './trace';
import { normalize, quoteInSource } from './verifier';

export interface QuizQuestion {
  question: string;
  options: string[];
  answer: number;
  explanation: string;
  source: number;
  quote: string;
}

export interface Quiz {
  topic: string;
  questions: QuizQuestion[];
  sources: ScoredArticle[];
}

export interface QuizOptions {
  topic: string;
  sources: ScoredArticle[];
  signal?: AbortSignal;
  onTrace?: (steps: AgentStep[]) => void;
}

export class NoQuizError extends Error {
  constructor() {
    super('No question passed the checks.');
    this.name = 'NoQuizError';
  }
}

const OPTIONS = 4;
const MIN_QUESTIONS = 3;
const MAX_QUESTIONS = 5;

const TUTOR_PROMPT = `You are a tutor who writes practice questions about national constitutions for students.
Reply with one JSON object and nothing else, in this shape:
{"questions": [{"question": "...", "options": ["...", "...", "...", "..."], "answer": 0, "explanation": "...", "source": 1, "quote": "..."}]}
- Write 3 to 5 multiple-choice questions that test understanding of what the SOURCES say, not article numbering or trivia.
- options: exactly 4 short options. One is correct; the other three are plausible but wrong according to the sources.
- answer: the index (0 to 3) of the correct option.
- source: the [Source N] number the correct answer comes from.
- quote: 5 to 30 words copied word for word from that source that prove the answer.
- explanation: one or two sentences on why the answer is right, based only on the source.
- Use no outside knowledge. Every question must be answerable from its source alone.`;

const tutorMessage = (topic: string, sources: ScoredArticle[]): string =>
  `Topic the student asked about: ${topic}\n\nSOURCES:\n---\n${sources
    .map((s, i) => sourceBlock(s, i + 1))
    .join('\n\n---\n\n')}\n---`;

const retryMessage = (problems: string[]): string =>
  `Some questions failed the checks:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nReply with the whole JSON object again: keep the questions that passed, fix or replace the others, and write 3 to 5 questions in total.`;

function parseQuestions(text: string): unknown[] | null {
  const match = text.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as { questions?: unknown };
    return Array.isArray(raw.questions) ? raw.questions : null;
  } catch {
    return null;
  }
}

const firstNumber = (value: unknown): number => Number(String(value ?? '').match(/\d+/)?.[0] ?? NaN);

// Returns the question when it passes every check, otherwise the reason it failed.
function checkQuestion(item: unknown, sources: ScoredArticle[]): QuizQuestion | string {
  const q = (item ?? {}) as Record<string, unknown>;
  const question = typeof q.question === 'string' ? q.question.trim() : '';
  if (!question) return 'A question has no text.';
  const label = `"${question.slice(0, 120)}"`;

  const options = Array.isArray(q.options)
    ? q.options.filter((o): o is string => typeof o === 'string').map((o) => o.trim()).filter(Boolean)
    : [];
  if (options.length !== OPTIONS || new Set(options.map(normalize)).size !== OPTIONS) {
    return `${label} needs exactly ${OPTIONS} different options.`;
  }
  const answer = firstNumber(q.answer);
  if (!Number.isInteger(answer) || answer < 0 || answer >= OPTIONS) {
    return `${label} has an answer index that is not 0 to ${OPTIONS - 1}.`;
  }
  const source = firstNumber(q.source);
  if (!Number.isInteger(source) || source < 1 || source > sources.length) {
    return `${label} cites a source number that is not 1 to ${sources.length}.`;
  }
  const quote = typeof q.quote === 'string' ? q.quote.trim().replace(/^["“]|["”]$/g, '') : '';
  if (!quoteInSource(quote, sources[source - 1])) {
    return `${label}: its quote does not appear word for word in [Source ${source}]. Copy at least 5 words exactly.`;
  }
  const explanation = typeof q.explanation === 'string' ? q.explanation.trim() : '';
  if (!explanation) return `${label} has no explanation.`;

  return { question, options, answer, explanation, source, quote };
}

function checkAll(items: unknown[] | null, sources: ScoredArticle[]) {
  if (!items) return { questions: [], problems: ['The reply was not the JSON object asked for.'] };
  const questions: QuizQuestion[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const checked = checkQuestion(item, sources);
    if (typeof checked === 'string') {
      problems.push(checked);
      continue;
    }
    const key = normalize(checked.question);
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(checked);
  }
  return { questions: questions.slice(0, MAX_QUESTIONS), problems };
}

// Models favour putting the right answer first, so the options are reordered here.
function shuffle(q: QuizQuestion): QuizQuestion {
  const order = q.options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { ...q, options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) };
}

// The tutor writes questions from the sources of one answer; code checks each one against its
// source and asks for one rewrite when fewer than three pass.
export async function buildQuiz(opts: QuizOptions): Promise<Quiz> {
  const { topic, sources, signal } = opts;
  const trace = new Trace(opts.onTrace);
  const messages: ChatTurn[] = [{ role: 'user', content: tutorMessage(topic, sources) }];

  try {
    trace.start('drafting_quiz');
    const draft = await completeChat(TUTOR_PROMPT, messages, signal, 'tutor');
    const items = parseQuestions(draft);
    trace.note({ count: items?.length ?? 0 });

    trace.start('checking_quiz');
    let result = checkAll(items, sources);
    trace.note({ count: items?.length ?? 0, kept: result.questions.length });

    if (result.questions.length < MIN_QUESTIONS) {
      console.warn('[tutor] too few questions passed, asking for one rewrite.', result.problems);
      trace.start('repairing');
      let better = false;
      try {
        const retry = await completeChat(
          TUTOR_PROMPT,
          [
            ...messages,
            { role: 'assistant', content: draft },
            { role: 'user', content: retryMessage(result.problems) },
          ],
          signal,
          'tutor',
        );
        const second = checkAll(parseQuestions(retry), sources);
        better = second.questions.length > result.questions.length;
        if (better) result = second;
      } catch (err) {
        const name = (err as Error).name;
        if (name === 'AbortError' || name === 'InvalidKeyError') throw err;
        console.warn('[tutor] rewrite failed, keeping the questions that passed.', err);
      }
      trace.note({ repaired: better });
    }

    if (result.questions.length === 0) {
      trace.close('failed');
      throw new NoQuizError();
    }
    trace.close();
    return { topic, questions: result.questions.map(shuffle), sources };
  } catch (err) {
    trace.close((err as Error).name === 'AbortError' ? 'stopped' : 'failed');
    throw err;
  }
}

const CLOZE_COMMON = new Set([
  'shall', 'which', 'their', 'there', 'these', 'those', 'other', 'under', 'where', 'after', 'before',
  'being', 'every', 'within', 'without', 'about', 'provided', 'subject', 'accordance', 'section',
  'sections', 'article', 'articles', 'chapter', 'paragraph', 'subsection', 'constitution', 'including',
  'whether', 'unless', 'except', 'having', 'until', 'against', 'between', 'during', 'through', 'would',
  'could', 'should', 'might', 'whose', 'thereof', 'herein', 'hereby', 'otherwise', 'further', 'manner',
  'concerning', 'relating', 'regarding', 'respect', 'applicable', 'following', 'therefore', 'provision',
  'provisions', 'matters', 'repealed',
]);

const BLANK = '_____';
const MAX_PASSAGE_WORDS = 40;

const contentWords = (text: string, minLength = 5): string[] =>
  (text.toLowerCase().match(new RegExp(`[a-z]{${minLength},}`, 'g')) ?? []).filter((w) => !CLOZE_COMMON.has(w));

const sentencesOf = (text: string): string[] =>
  text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.;:])\s+(?=[A-Z(“"])/)
    .map((s) => s.trim())
    .filter((s) => {
      const words = s.split(' ').length;
      return words >= 8 && words <= 80 && !/\brepealed\b/i.test(s);
    });

function blankOut(sentence: string, word: string): string | null {
  const words = sentence.split(' ');
  const matches = (w: string) => w.toLowerCase().replace(/[^a-z]/g, '') === word;
  const at = words.findIndex(matches);
  if (at === -1) return null;
  const cut = words.map((w) => (matches(w) ? w.replace(/[A-Za-z]+/, BLANK) : w));
  const start = Math.max(0, Math.min(at - MAX_PASSAGE_WORDS / 2, cut.length - MAX_PASSAGE_WORDS));
  const end = Math.min(cut.length, start + MAX_PASSAGE_WORDS);
  return `${start > 0 ? '…' : ''}${cut.slice(start, end).join(' ')}${end < cut.length ? '…' : ''}`;
}

// Without a key there is no model, so code writes fill-in-the-blank questions from the cited text:
// one key word is blanked and the wrong options are other words from the same sources.
export function buildClozeQuiz(topic: string, sources: ScoredArticle[]): Quiz {
  const usable = sources.filter((s) => !s.article.id.endsWith('-profile'));
  const countryWords = usable.flatMap((s) => contentWords(s.constitution.country, 4));
  const blankable = (w: string) => !countryWords.some((c) => w.startsWith(c));
  const topicWords = new Set(contentWords(topic, 4).filter(blankable));
  const wordsOf = (text: string) =>
    [...contentWords(text), ...contentWords(text, 4).filter((w) => w.length === 4 && topicWords.has(w))].filter(blankable);

  const frequency = new Map<string, number>();
  for (const s of usable) {
    for (const w of wordsOf(s.article.content)) frequency.set(w, (frequency.get(w) ?? 0) + 1);
  }
  const vocabulary = [...frequency.keys()];

  const candidates = usable.map((s, i) =>
    sentencesOf(s.article.content).flatMap((sentence) => {
      const inSentence = new Set(wordsOf(sentence));
      const answer = [...inSentence].sort(
        (a, b) =>
          Number(topicWords.has(b)) - Number(topicWords.has(a)) ||
          (frequency.get(a) ?? 0) - (frequency.get(b) ?? 0) ||
          b.length - a.length,
      )[0];
      if (!answer) return [];
      const distractors = vocabulary
        .filter((w) => !inSentence.has(w) && Math.abs(w.length - answer.length) <= 3)
        .sort((a, b) => (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0))
        .slice(0, OPTIONS - 1);
      const passage = blankOut(sentence, answer);
      if (!passage || distractors.length < OPTIONS - 1) return [];
      return [{
        question: `${s.constitution.flag} ${s.article.article_number}: “${passage}”`,
        options: [answer, ...distractors],
        answer: 0,
        explanation: `${s.constitution.country}, ${s.article.article_number}`,
        source: i + 1,
        quote: sentence,
        onTopic: topicWords.has(answer),
      }];
    }),
  );

  const questions: QuizQuestion[] = [];
  const usedAnswers = new Set<string>();
  let added = true;
  while (added && questions.length < MAX_QUESTIONS) {
    added = false;
    for (const list of candidates) {
      if (questions.length >= MAX_QUESTIONS) break;
      const fresh = (c: (typeof list)[number]) => !usedAnswers.has(c.options[0]);
      const onTopic = list.findIndex((c) => c.onTopic && fresh(c));
      const at = onTopic !== -1 ? onTopic : list.findIndex(fresh);
      if (at === -1) continue;
      const [{ onTopic: _onTopic, ...question }] = list.splice(at, 1);
      usedAnswers.add(question.options[0]);
      questions.push(question);
      added = true;
    }
  }

  if (questions.length === 0) throw new NoQuizError();
  return { topic, questions: questions.map(shuffle), sources };
}
