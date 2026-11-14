#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
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

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('\n  Need SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.\n');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const TABLES = ['constitutions', 'articles', 'bookmarks'];
const PAGE = 500;

async function fetchPage(table, from, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      const { data, error } = await sb
        .from(table)
        .select('*')
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      return data;
    } catch (e) {
      if (i >= attempts) throw new Error(`${table} @${from}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

async function dumpTable(table) {
  const { count, error: cErr } = await sb
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (cErr) throw new Error(`${table}: ${cErr.message}`);

  const rows = [];
  for (let from = 0; from < count; from += PAGE) {
    rows.push(...(await fetchPage(table, from)));
  }
  if (rows.length !== count) {
    throw new Error(`${table}: expected ${count} rows, got ${rows.length}`);
  }
  return rows;
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join('backups', stamp);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = { createdAt: new Date().toISOString(), url: SUPABASE_URL, tables: {} };
  for (const table of TABLES) {
    const rows = await dumpTable(table);
    fs.writeFileSync(path.join(dir, `${table}.json`), JSON.stringify(rows));
    manifest.tables[table] = rows.length;
    console.log(`${table}: ${rows.length} rows`);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nSaved to ${dir}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
