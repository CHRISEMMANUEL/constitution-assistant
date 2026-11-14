// deno-lint-ignore-file no-explicit-any
// @ts-ignore — Deno globals only resolve at runtime, not in local TS check.
declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
  env: { get: (k: string) => string | undefined };
};

const ALLOWED_ORIGINS = [
  'https://constitution-assistant.netlify.app',
  'http://localhost:5173',
  'http://localhost:4173',
];
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TOKENS = 800;
const MAX_BODY_CHARS = 60_000;

const isAllowedOrigin = (origin: string | null): boolean =>
  !!origin &&
  (ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/[a-z0-9-]+--constitution-assistant\.netlify\.app$/.test(origin));

const buildCorsHeaders = (origin: string | null): Record<string, string> => ({
  'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin! : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-title, http-referer, x-requested-with',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

const jsonError = (
  corsHeaders: Record<string, string>,
  status: number,
  error: string,
): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const sanitizeBody = (raw: string): string | null => {
  if (raw.length > MAX_BODY_CHARS) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed?.model !== 'string' || !parsed.model.endsWith(':free')) return null;
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return null;
  const requested = Number(parsed.max_tokens);
  parsed.max_tokens = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_TOKENS)
    : MAX_TOKENS;
  return JSON.stringify(parsed);
};

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);

  if (origin && !isAllowedOrigin(origin)) {
    return jsonError(corsHeaders, 403, 'Origin not allowed');
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: corsHeaders,
    });
  }

  const apiKey = Deno.env.get('OPENROUTER_API_KEY');
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: 'OPENROUTER_API_KEY secret not set on the function',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return jsonError(corsHeaders, 400, 'Could not read request body');
  }

  const body = sanitizeBody(raw);
  if (!body) {
    return jsonError(corsHeaders, 400, 'Invalid request: a free (:free) model and a messages array are required');
  }

  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://constitution-assistant.netlify.app',
        'X-Title': 'Constitution Assistant',
      },
      body,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'Upstream fetch failed',
        detail: (err as Error).message,
      }),
      {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  const upstreamCT = upstream.headers.get('content-type') ?? '';

  if (upstreamCT.includes('event-stream')) {
    const passthroughHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
      const lower = k.toLowerCase();
      if (
        lower === 'content-encoding' ||
        lower === 'transfer-encoding' ||
        lower === 'connection'
      ) {
        continue;
      }
      passthroughHeaders.set(k, v);
    }
    for (const [k, v] of Object.entries(corsHeaders)) {
      passthroughHeaders.set(k, v);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: passthroughHeaders,
    });
  }

  const text = await upstream.text();
  let status = upstream.status;
  try {
    const j = JSON.parse(text);
    const innerCode = j?.error?.code;
    if (typeof innerCode === 'number' && innerCode >= 400 && innerCode < 600) {
      status = innerCode;
    }
  } catch {
  }

  return new Response(text, {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': upstreamCT || 'application/json',
    },
  });
});
