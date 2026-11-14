import type { ScoredArticle } from './ai';

const PROXY_URL = import.meta.env.VITE_OPENROUTER_PROXY_URL as
  | string
  | undefined;
const API_URL = PROXY_URL || 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemma-4-31b-it:free';
const FALLBACK_MODELS = [
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
];

const apiKey = import.meta.env.VITE_OPENROUTER_API_KEY as string | undefined;
const model =
  (import.meta.env.VITE_OPENROUTER_MODEL as string | undefined) || DEFAULT_MODEL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;

export const isOpenRouterConfigured = (): boolean => !!apiKey || !!PROXY_URL;
export const openRouterModel = (): string => model;

const SYSTEM_PROMPT = `You are ConstIntell, a constitutional research assistant.

NON-NEGOTIABLE RULES:
1. Answer the user's question based ONLY on the CONTEXT block in the user message. Do not use outside knowledge of any constitution, statute, case law, or legal commentary. If you find yourself wanting to cite something not in the CONTEXT, you must not.
2. If the CONTEXT does not contain enough information to answer, say so plainly using this exact phrasing as your opening line:
   "The provided sources do not contain a direct answer to that."
   Then recommend the most closely related source from the list, naming the country and article.
3. Cite every factual claim inline using the bracket form [Source N], where N is the source number from the CONTEXT. Do not invent source numbers.
4. When the answer hinges on the exact wording of a constitutional provision, quote it on a new line prefixed with "> " and attribute it: country name + article/section number.
5. Be concise — at most 3 to 5 short paragraphs. Do not restate the question, pad with filler, or interpret beyond what the text says.
6. You are a research tool, not legal counsel. Do not give legal advice, predict court outcomes, or recommend actions a person should take.
7. End every reply with this disclaimer on its own line, exactly:
_AI responses are informational and not legal advice. Consult a qualified attorney for binding interpretation._`;

const buildContext = (sources: ScoredArticle[]): string =>
  sources
    .map(
      (s, i) =>
        `[Source ${i + 1}] ${s.constitution.country} — ${s.article.article_number}: ${s.article.title}\nChapter: ${s.article.chapter}\n${s.article.content}`,
    )
    .join('\n\n---\n\n');

const buildUserMessage = (question: string, sources: ScoredArticle[]): string =>
  `CONTEXT:\n---\n${buildContext(sources)}\n---\n\nQuestion: ${question}\n\nAnswer:`;

export interface RagOptions {
  question: string;
  sources: ScoredArticle[];
  signal?: AbortSignal;
  onToken: (token: string) => void;
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
}

async function postWithRetry(
  body: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (PROXY_URL && supabaseAnonKey) {
    headers.apikey = supabaseAnonKey;
    headers.Authorization = `Bearer ${supabaseAnonKey}`;
  } else if (!PROXY_URL && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['HTTP-Referer'] =
      typeof window !== 'undefined' ? window.location.origin : 'https://ConstIntell.app';
    headers['X-Title'] = 'ConstIntell';
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(API_URL, { method: 'POST', headers, body, signal });
    if (res.status !== 429) return res;
    if (attempt === 1) return res;
    const retryAfter = Number(res.headers.get('Retry-After')) * 1000;
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter, 4000)
      : 1500;
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error('OpenRouter retry loop exhausted');
}

function buildBody(modelId: string, opts: RagOptions): string {
  return JSON.stringify({
    model: modelId,
    stream: true,
    temperature: 0.15,
    max_tokens: 800,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(opts.question, opts.sources) },
    ],
  });
}

async function streamFromResponse(
  res: Response,
  onToken: (t: string) => void,
): Promise<void> {
  if (!res.body) throw new Error('OpenRouter response had no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') {
          if (data === '[DONE]') return;
          continue;
        }
        try {
          const json = JSON.parse(data) as StreamChunk;
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) onToken(delta);
        } catch {
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const streamRAG = async (opts: RagOptions): Promise<void> => {
  if (!apiKey && !PROXY_URL) {
    throw new Error('OpenRouter is not configured (no API key and no proxy URL).');
  }

  const candidates = Array.from(new Set([model, ...FALLBACK_MODELS]));

  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    try {
      const res = await postWithRetry(buildBody(m, opts), opts.signal);

      if (res.status === 429) {
        const detail = await res.text().catch(() => '');
        lastErr = new Error(`OpenRouter 429 on ${m} — ${detail.slice(0, 200)}`);
        if (i < candidates.length - 1) {
          console.info(`[openrouter] ${m} rate-limited; trying next model.`);
          continue;
        }
        throw lastErr;
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`OpenRouter ${res.status} on ${m} — ${detail.slice(0, 240)}`);
      }

      await streamFromResponse(res, opts.onToken);
      return;
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') throw err;
      lastErr = err;
      const msg = e.message || '';
      if (!msg.includes('429')) throw err;
    }
  }
  throw lastErr ?? new Error('OpenRouter: all fallback models exhausted');
};



