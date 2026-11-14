import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

try {
  const dotenv = fs.readFileSync('.env', 'utf-8');
  for (const line of dotenv.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {
}

export const SOURCE_RANK = { official: 4, constitute: 3, wikipedia: 2, generated: 1, manual: 0 };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function detectKeyRole(key) {
  if (key.startsWith('sb_secret_')) return 'service_role';
  if (key.startsWith('sb_publishable_')) return 'anon';
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return payload.role || null;
  } catch {
    return null;
  }
}

export function createServiceClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('\n  Missing credentials.\n');
    console.error('  Need:');
    console.error('    SUPABASE_URL  (or VITE_SUPABASE_URL in .env)');
    console.error('    SUPABASE_SERVICE_ROLE_KEY  (NEVER commit this)\n');
    console.error(
      '  Get the service role key from Supabase Dashboard → Project Settings → API.\n',
    );
    process.exit(1);
  }

  const role = detectKeyRole(key);
  if (role && role !== 'service_role') {
    console.error(`\n  Wrong Supabase key — detected role "${role}".\n`);
    console.error('  RLS will block every write. You need the service_role key.');
    console.error('  Find it at:');
    console.error('    Supabase Dashboard → Project Settings → API → service_role');
    console.error('  (or "sb_secret_*" on newer projects). NOT the anon key.\n');
    process.exit(2);
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

export async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const wait = [1500, 4000, 9000][i] ?? 9000;
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

export async function supabaseWithRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      const msg = result?.error?.message || '';
      const isNetwork =
        /fetch failed|network|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg);
      if (result?.error && isNetwork && i < attempts - 1) {
        await sleep([1500, 4000, 9000][i] ?? 9000);
        continue;
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep([1500, 4000, 9000][i] ?? 9000);
    }
  }
  throw lastErr ?? new Error('supabaseWithRetry exhausted');
}
