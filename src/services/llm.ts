import type { ScoredArticle } from './ai';
import { getApiKey, getPreferredModel, getProvider, type AiProvider } from './aiKey';

const OPENROUTER_FALLBACK_MODELS = [
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
];

const CLAUDE_SERVER_FALLBACK_MODELS = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);
const CLAUDE_EFFORT_MODELS = /^claude-(fable|mythos|opus|sonnet|haiku)-5|^claude-opus-4-[678]/;

export class InvalidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidKeyError';
  }
}

export const isAiConfigured = (): boolean => !!getApiKey();
export const aiModel = (): string => getPreferredModel() || getProvider().defaultModel;

const SYSTEM_PROMPT = `You are ConstIntell, a constitutional research assistant.

NON-NEGOTIABLE RULES:
1. Answer the user's question based ONLY on the CONTEXT block in the latest user message. Do not use outside knowledge of any constitution, statute, case law, or legal commentary. If you find yourself wanting to cite something not in the CONTEXT, you must not. Earlier turns of the conversation only show what the user is asking about; they are not sources.
2. If the CONTEXT does not contain enough information to answer, say so plainly using this exact phrasing as your opening line:
   "The provided sources do not contain a direct answer to that."
   Then recommend the most closely related source from the list, naming the country and article.
3. Cite every factual claim inline using the bracket form [Source N], where N is the source number from the CONTEXT. Do not invent source numbers.
4. When the answer hinges on the exact wording of a constitutional provision, quote it on a new line prefixed with "> " and attribute it: country name + article/section number.
5. Be concise — at most 3 to 5 short paragraphs. Do not restate the question, pad with filler, or interpret beyond what the text says.
6. You are a research tool, not legal counsel. Do not give legal advice, predict court outcomes, or recommend actions a person should take.
7. End every reply with this disclaimer on its own line, exactly:
_AI responses are informational and not legal advice. Consult a qualified attorney for binding interpretation._`;

export const sourceBlock = (s: ScoredArticle, n: number): string =>
  `[Source ${n}] ${s.constitution.country} — ${s.article.article_number}: ${s.article.title}\nChapter: ${s.article.chapter}\n${s.article.content}`;

const buildContext = (sources: ScoredArticle[]): string =>
  sources.map((s, i) => sourceBlock(s, i + 1)).join('\n\n---\n\n');

const buildUserMessage = (question: string, sources: ScoredArticle[], notes?: string): string => {
  const analysis = notes
    ? `\n\nANALYST NOTES (one analyst per country read only that country's sources; use them to structure a side-by-side comparison, but check every point against the CONTEXT, which wins if they disagree):\n${notes}`
    : '';
  return `CONTEXT:\n---\n${buildContext(sources)}\n---${analysis}\n\nQuestion: ${question}\n\nAnswer:`;
};

const repairMessage = (problems: string[]): string =>
  `Your answer above has these problems:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nRewrite the whole answer with them fixed. Keep everything that was correct and follow all the rules.`;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type RequestKind = 'answer' | 'plan' | 'analyze' | 'tutor';

const TOKEN_LIMITS: Record<RequestKind, { chat: number; openai: number; claude: number }> = {
  answer: { chat: 800, openai: 4000, claude: 8000 },
  plan: { chat: 600, openai: 2000, claude: 2000 },
  analyze: { chat: 500, openai: 2000, claude: 2000 },
  tutor: { chat: 1500, openai: 4000, claude: 4000 },
};

const TEMPERATURE: Record<RequestKind, number> = { answer: 0.15, plan: 0, analyze: 0.15, tutor: 0.4 };

interface ChatRequest {
  kind: RequestKind;
  system: string;
  messages: ChatTurn[];
  signal?: AbortSignal;
  onToken: (token: string) => void;
}

export interface RagOptions {
  question: string;
  sources: ScoredArticle[];
  history?: ChatTurn[];
  notes?: string;
  repair?: { draft: string; problems: string[] };
  signal?: AbortSignal;
  onToken: (token: string) => void;
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
}

function chatHeaders(provider: AiProvider, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (provider.id === 'openrouter') {
    headers['HTTP-Referer'] =
      typeof window !== 'undefined' ? window.location.origin : 'https://ConstIntell.app';
    headers['X-Title'] = 'ConstIntell';
  }
  return headers;
}

function chatBody(provider: AiProvider, modelId: string, req: ChatRequest): string {
  const messages = [{ role: 'system', content: req.system }, ...req.messages];
  const limits = TOKEN_LIMITS[req.kind];
  if (provider.id === 'openai') {
    return JSON.stringify({ model: modelId, stream: true, max_completion_tokens: limits.openai, messages });
  }
  return JSON.stringify({
    model: modelId,
    stream: true,
    temperature: TEMPERATURE[req.kind],
    max_tokens: limits.chat,
    messages,
  });
}

async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { method: 'POST', headers, body, signal });
    if (res.status !== 429) return res;
    if (attempt === 1) return res;
    const retryAfter = Number(res.headers.get('Retry-After')) * 1000;
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter, 4000)
      : 1500;
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error('Retry loop exhausted');
}

async function streamFromResponse(
  res: Response,
  onToken: (t: string) => void,
): Promise<void> {
  if (!res.body) throw new Error('AI response had no body');
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

const isKeyRejected = (status: number, detail: string): boolean =>
  status === 401 || status === 403 || (status === 400 && /api[ _-]?key/i.test(detail));

async function streamChatCompletions(
  provider: AiProvider,
  apiKey: string,
  model: string,
  opts: ChatRequest,
): Promise<void> {
  const candidates = provider.freeModels && model.endsWith(':free')
    ? Array.from(new Set([model, ...OPENROUTER_FALLBACK_MODELS]))
    : [model];
  const headers = chatHeaders(provider, apiKey);

  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    try {
      const res = await postWithRetry(provider.chatUrl, headers, chatBody(provider, m, opts), opts.signal);

      if (res.status === 429) {
        const detail = await res.text().catch(() => '');
        lastErr = new Error(`${provider.name} 429 on ${m} — ${detail.slice(0, 200)}`);
        if (i < candidates.length - 1) {
          console.info(`[llm] ${m} rate-limited; trying next model.`);
          continue;
        }
        throw lastErr;
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (isKeyRejected(res.status, detail)) {
          throw new InvalidKeyError(`${provider.name} ${res.status} — ${detail.slice(0, 200)}`);
        }
        throw new Error(`${provider.name} ${res.status} on ${m} — ${detail.slice(0, 240)}`);
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
  throw lastErr ?? new Error(`${provider.name}: all fallback models exhausted`);
}

async function streamClaude(apiKey: string, model: string, opts: ChatRequest): Promise<void> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  const params = {
    model,
    max_tokens: TOKEN_LIMITS[opts.kind].claude,
    system: opts.system,
    messages: opts.messages,
    ...(CLAUDE_EFFORT_MODELS.test(model) ? { output_config: { effort: 'low' as const } } : {}),
  };

  try {
    let message: { stop_reason: string | null; model: string };
    if (CLAUDE_SERVER_FALLBACK_MODELS.has(model)) {
      const stream = client.beta.messages.stream(
        { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
        { signal: opts.signal },
      );
      stream.on('text', (delta) => opts.onToken(delta));
      message = await stream.finalMessage();
    } else {
      const stream = client.messages.stream(params, { signal: opts.signal });
      stream.on('text', (delta) => opts.onToken(delta));
      message = await stream.finalMessage();
    }
    if (message.stop_reason === 'refusal') {
      throw new Error(`Claude declined to answer on ${message.model}`);
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new InvalidKeyError(`Claude ${err.status} — ${err.message.slice(0, 200)}`);
    }
    if (err instanceof Anthropic.APIUserAbortError) {
      const abort = new Error('Generation cancelled');
      abort.name = 'AbortError';
      throw abort;
    }
    throw err;
  }
}

async function runChat(req: ChatRequest): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new InvalidKeyError('No API key saved.');
  }

  const provider = getProvider();
  const model = aiModel();
  if (provider.id === 'anthropic') {
    await streamClaude(apiKey, model, req);
    return;
  }
  await streamChatCompletions(provider, apiKey, model, req);
}

export const streamRAG = (opts: RagOptions): Promise<void> =>
  runChat({
    kind: 'answer',
    system: SYSTEM_PROMPT,
    messages: [
      ...(opts.history ?? []),
      { role: 'user', content: buildUserMessage(opts.question, opts.sources, opts.notes) },
      ...(opts.repair
        ? [
            { role: 'assistant' as const, content: opts.repair.draft },
            { role: 'user' as const, content: repairMessage(opts.repair.problems) },
          ]
        : []),
    ],
    signal: opts.signal,
    onToken: opts.onToken,
  });

export const completeChat = async (
  system: string,
  messages: ChatTurn[],
  signal?: AbortSignal,
  kind: RequestKind = 'plan',
): Promise<string> => {
  let text = '';
  await runChat({
    kind,
    system,
    messages,
    signal,
    onToken: (t) => {
      text += t;
    },
  });
  return text;
};
