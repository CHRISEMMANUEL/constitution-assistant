const GREETING = new Set([
  'hi', 'hii', 'hiya', 'hello', 'helo', 'hey', 'heya', 'howdy', 'yo', 'sup', 'greetings', 'morning',
  'afternoon', 'evening', 'good', 'day', 'there', 'whats', 'what', 'up', 'how', 'are', 'you', 'doing',
  'is', 'it', 'going', 'everyone', 'all', 'bot', 'assistant', 'friend', 'dear', 'sir', 'madam',
]);

const THANKS = new Set([
  'thanks', 'thank', 'thx', 'ty', 'cheers', 'appreciated', 'appreciate', 'ok', 'okay', 'k', 'cool',
  'great', 'nice', 'awesome', 'perfect', 'got', 'noted', 'bye', 'goodbye', 'later', 'see', 'ya',
  'so', 'much', 'very', 'a', 'lot', 'that', 'this', 'helps', 'helped', 'helpful', 'alright', 'fine',
]);

const ABOUT = new Set([
  'who', 'what', 'are', 'you', 'can', 'do', 'does', 'help', 'me', 'with', 'how', 'use', 'work', 'works',
  'this', 'app', 'is', 'your', 'name', 'about', 'tell', 'i', 'ask', 'things', 'kind', 'of', 'questions',
  'should', 'the', 'a', 'it',
]);

export type SmallTalkKind = 'greeting' | 'thanks' | 'about';

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

const onlyFrom = (words: string[], ...sets: Array<Set<string>>): boolean =>
  words.every((w) => sets.some((s) => s.has(w)));

// A message is small talk only when every word is a greeting, thanks or a question about the
// assistant itself, so "hi, what does Kenya say about free speech" is still searched.
export function smallTalkKind(text: string): SmallTalkKind | null {
  const words = wordsOf(text);
  if (words.length === 0) return /[a-z0-9]/i.test(text) ? null : 'greeting';
  if (words.length > 8) return null;
  if (onlyFrom(words, THANKS, GREETING) && words.some((w) => THANKS.has(w) && !GREETING.has(w))) return 'thanks';
  if (onlyFrom(words, GREETING)) return 'greeting';
  if (onlyFrom(words, ABOUT, GREETING)) return 'about';
  return null;
}

const EXAMPLES =
  'For example:\n• "right to life in Nigeria"\n• "freedom of religion in Ghana"\n• "compare freedom of expression in Kenya and South Africa"';

export const SMALL_TALK_REPLIES: Record<SmallTalkKind, string> = {
  greeting: `Hello! Ask me about any country's constitution and I will answer from its text, with the articles cited. ${EXAMPLES}`,
  thanks: 'You are welcome. Ask another question about a constitution whenever you like.',
  about: `I answer questions about national constitutions from their actual text, citing the articles I quote. Name a country, a right or a power, or ask me to compare two countries. ${EXAMPLES}`,
};
