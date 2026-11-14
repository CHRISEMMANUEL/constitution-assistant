#!/usr/bin/env node

import fs from 'node:fs';
import { SOURCE_RANK, createServiceClient, supabaseWithRetry } from './lib/db.mjs';
import { ADAPTERS } from './official/adapters.mjs';

const REGISTRY = JSON.parse(
  fs.readFileSync(new URL('./sources.json', import.meta.url), 'utf-8'),
);
const OUT_DIR = 'official-out';

const args = process.argv.slice(2);
const write = args.includes('--write');
const requested = args.filter((a) => !a.startsWith('--'));

const slug = (s) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function toRows(id, articles) {
  const used = new Map();
  return articles.map((a, ord) => {
    const base = `${id}-of-${slug(a.article_number)}`;
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    return {
      id: n > 1 ? `${base}-${n}` : base,
      constitution_id: id,
      chapter: a.chapter,
      article_number: a.article_number,
      title: a.title || a.article_number,
      content: a.content,
      ord,
    };
  });
}

function validate(entry, rows) {
  const problems = [];
  const { min, max, contains = [], sequence } = entry.expect;
  if (rows.length < min || rows.length > max) {
    problems.push(`${rows.length} articles, expected ${min}–${max}`);
  }
  const numbers = new Set(rows.map((r) => r.article_number));
  for (const n of contains) {
    if (!numbers.has(n)) problems.push(`missing "${n}"`);
  }
  if (sequence) {
    const gaps = [];
    for (let n = sequence.from; n <= sequence.to; n++) {
      if (!numbers.has(`${sequence.prefix}${n}`)) gaps.push(n);
    }
    if (gaps.length > 0) problems.push(`gaps in ${sequence.prefix.trim()} numbering: ${gaps.join(', ')}`);
  }
  for (const r of rows) {
    if (r.content.trim().length < 3) problems.push(`${r.id} has no text`);
  }
  if (numbers.size < rows.length) {
    const seen = new Set();
    const dupe = rows.find((r) => seen.has(r.article_number) || !seen.add(r.article_number));
    problems.push(`${rows.length - numbers.size} duplicate article numbers (e.g. "${dupe.article_number}")`);
  }
  return problems;
}

async function writeCountry(sb, id, entry, rows) {
  const { data: existing, error: cErr } = await supabaseWithRetry(() =>
    sb.from('constitutions').select('id').eq('id', id).maybeSingle(),
  );
  if (cErr) throw new Error(cErr.message);
  if (!existing) throw new Error(`constitution "${id}" not found — run the seed first`);

  const tagged = rows.map((r) => ({ ...r, source: 'official', active: true }));
  for (let i = 0; i < tagged.length; i += 50) {
    const { error } = await supabaseWithRetry(() =>
      sb.from('articles').upsert(tagged.slice(i, i + 50)),
    );
    if (error) throw new Error(error.message);
  }

  const { data: official, error: oErr } = await supabaseWithRetry(() =>
    sb.from('articles').select('id').eq('constitution_id', id).eq('source', 'official').eq('active', true),
  );
  if (oErr) throw new Error(oErr.message);
  const keep = new Set(rows.map((r) => r.id));
  const stale = official.map((r) => r.id).filter((rid) => !keep.has(rid));
  for (let i = 0; i < stale.length; i += 100) {
    const { error } = await supabaseWithRetry(() =>
      sb.from('articles').update({ active: false }).in('id', stale.slice(i, i + 100)),
    );
    if (error) throw new Error(error.message);
  }

  const lower = Object.keys(SOURCE_RANK).filter((s) => SOURCE_RANK[s] < SOURCE_RANK.official);
  const { error: lErr } = await supabaseWithRetry(() =>
    sb.from('articles').update({ active: false }).eq('constitution_id', id).in('source', lower),
  );
  if (lErr) throw new Error(lErr.message);

  const { error: mErr } = await supabaseWithRetry(() =>
    sb
      .from('constitutions')
      .update({
        summary: `${rows[0].content.slice(0, 380)}…\n\nSource: ${entry.source_name}. Licence: ${entry.license}.`,
        source_name: entry.source_name,
        source_url: entry.source_url,
        license: entry.license,
        language: entry.language,
        official_translation: entry.official_translation,
        retrieved_at: new Date().toISOString(),
      })
      .eq('id', id),
  );
  if (mErr) throw new Error(mErr.message);
  return stale.length;
}

async function main() {
  const ids = requested.length > 0 ? requested : Object.keys(REGISTRY);
  const unknown = ids.filter((id) => !REGISTRY[id]);
  if (unknown.length > 0) {
    console.error(`Not in scripts/sources.json: ${unknown.join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sb = write ? createServiceClient() : null;
  let failures = 0;

  for (const id of ids) {
    const entry = REGISTRY[id];
    if (entry.status !== 'ready') {
      console.log(`${id}  skipped (${entry.status}): ${entry.reason || ''}`);
      continue;
    }
    process.stdout.write(`${id}  ${entry.adapter} … `);
    let result;
    try {
      result = await ADAPTERS[entry.adapter](entry);
    } catch (err) {
      console.log(`✗ fetch/parse: ${err.message}`);
      failures++;
      continue;
    }
    const rows = toRows(id, result.articles);
    const problems = validate(entry, rows);
    fs.writeFileSync(
      `${OUT_DIR}/${id}.json`,
      JSON.stringify({ id, revision: result.revision, problems, rows }, null, 2),
    );
    if (problems.length > 0) {
      console.log(`✗ ${rows.length} articles, not written:\n    ${problems.join('\n    ')}`);
      failures++;
      continue;
    }
    if (!write) {
      console.log(`✓ ${rows.length} articles (dry run → ${OUT_DIR}/${id}.json)`);
      continue;
    }
    try {
      const stale = await writeCountry(sb, id, entry, rows);
      console.log(`✓ ${rows.length} articles written as official${stale ? `, ${stale} stale official rows hidden` : ''}`);
    } catch (err) {
      console.log(`✗ write: ${err.message}`);
      failures++;
    }
  }

  if (!write) console.log('\nDry run only. Add --write to save to Supabase.');
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFatal:', err);
  process.exit(1);
});
