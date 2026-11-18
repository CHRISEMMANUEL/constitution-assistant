import { constitutionsById, mentionedCountryIds, withoutCountryNames, type CitedAnswer } from './ai';
import type { ChatTurn } from './llm';

// Questions about many countries at once are searched across every constitution without asking.
const GLOBAL_QUESTION =
  /\b(?:countries|nations|constitutions|world|worldwide|global|globally|international|internationally|everywhere|universal|universally)\b|\b(?:any|every|each|which|most) (?:country|nation|constitution)\b/i;

// "What is a constitution?" is about the idea itself, not one country's text.
const ABOUT_CONSTITUTIONS = /^\W*(?:what(?:'s|\s+is|\s+are)\s+)?(?:a\s+|an\s+|the\s+)?constitution(?:s|al law|alism)?\W*$/i;

// Replies to "which country?" that mean every country.
const ALL_COUNTRIES =
  /^\W*(?:all|all of them|all countries|every country|every one|everywhere|worldwide|globally|any|any country)\W*$/i;

// Words a bare country reply may carry besides the names: "Nigeria please", "what about Kenya and Ghana?".
const FILLER = new Set([
  'in', 'and', 'or', 'the', 'of', 'for', 'please', 'pls', 'constitution', 'what', 'about', 'how', 'i', 'mean',
  'ok', 'okay', 'its', 's',
]);

// Offered as choices after the user's own country (from the browser language, e.g. en-NG).
const COMMON_COUNTRIES = ['ng', 'us', 'in', 'za'];
const MAX_CHOICES = 4;

const ASK_REPLY =
  "Constitutions differ from country to country on this. Which country's constitution do you mean? Pick one below or type a country name, or choose All countries to search every constitution.";

export const isGlobalQuestion = (question: string): boolean =>
  GLOBAL_QUESTION.test(question) || ABOUT_CONSTITUTIONS.test(question);

export async function inCountries(question: string, ids: string[]): Promise<string> {
  const byId = await constitutionsById();
  const names = ids.map((id) => byId.get(id)?.country ?? id);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return `${question.replace(/[\s?.!]+$/, '')} in ${list}`;
}

// The countries a follow-up such as "what about freedom of expression?" is about: those named in
// the latest user turn that names any, unless a question about every country came after it.
export async function contextCountryIds(history: ChatTurn[]): Promise<string[]> {
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.role !== 'user') continue;
    const ids = await mentionedCountryIds(turn.content);
    if (ids.length) return ids;
    if (isGlobalQuestion(turn.content)) return [];
  }
  return [];
}

// Turns a reply to "which country?" into the full question: "Nigeria" after "what is the right to
// life" becomes "what is the right to life in Nigeria". Anything else is a new question (null).
export async function answerToCountryQuestion(
  reply: string,
  pending: string,
  allCountries = false,
): Promise<{ query: string; allCountries: boolean } | null> {
  if (allCountries || ALL_COUNTRIES.test(reply)) return { query: pending, allCountries: true };
  const ids = await mentionedCountryIds(reply);
  if (ids.length === 0) return null;
  const rest = (await withoutCountryNames(reply)).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!rest.every((w) => FILLER.has(w))) return null;
  return { query: await inCountries(pending, ids), allCountries: false };
}

function browserRegion(): string | null {
  if (typeof navigator === 'undefined') return null;
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    const region = tag?.split('-').slice(1).find((part) => /^[a-z]{2}$/i.test(part));
    if (region) return region.toLowerCase();
  }
  return null;
}

export async function askForCountry(question: string): Promise<CitedAnswer> {
  const byId = await constitutionsById();
  const region = browserRegion();
  const ids = [...new Set([...(region ? [region] : []), ...COMMON_COUNTRIES])]
    .filter((id) => byId.has(id))
    .slice(0, MAX_CHOICES);
  return {
    reply: ASK_REPLY,
    hits: [],
    confidence: 'high',
    askCountry: {
      question,
      countries: ids.map((id) => {
        const c = byId.get(id)!;
        return { id, name: c.country, flag: c.flag };
      }),
    },
  };
}
