#!/usr/bin/env node

import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { parse as parseHtml } from 'node-html-parser';

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
  console.error('\n  Missing credentials.\n');
  console.error('  Need:');
  console.error('    SUPABASE_URL  (or VITE_SUPABASE_URL in .env)');
  console.error('    SUPABASE_SERVICE_ROLE_KEY  (NEVER commit this)\n');
  console.error(
    '  Get the service role key from Supabase Dashboard → Project Settings → API.\n',
  );
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

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

const detectedRole = detectKeyRole(SERVICE_KEY);
if (detectedRole && detectedRole !== 'service_role') {
  console.error(
    `\n  Wrong Supabase key — detected role "${detectedRole}".\n`,
  );
  console.error('  RLS will block every write. You need the service_role key.');
  console.error('  Find it at:');
  console.error('    Supabase Dashboard → Project Settings → API → service_role');
  console.error('  (or "sb_secret_*" on newer projects). NOT the anon key.\n');
  process.exit(2);
}

const CONSTITUTE_BASE = 'https://www.constituteproject.org/service';
const ATTRIBUTION =
  'Source: Constitute Project (Comparative Constitutions Project). ' +
  'English translation used with permission from HeinOnline and ' +
  'Oxford Constitutions of the World.';

const HEADERS = {
  'User-Agent': 'ConstIntell/1.0 (educational; contact via repo)',
  Accept: 'application/json',
};

const DELAY_MS = 220;

const MIDEAST_SUBREGIONS = new Set(['Western Asia', 'Middle East']);
const mapRegion = (region, subregion) => {
  if (region === 'Asia' && subregion && MIDEAST_SUBREGIONS.has(subregion)) {
    return 'mideast';
  }
  switch (region) {
    case 'Africa':    return 'africa';
    case 'Asia':      return 'asia';
    case 'Europe':    return 'europe';
    case 'Americas':  return 'americas';
    case 'Oceania':   return 'oceania';
    case 'Antarctic': return 'arctic';
    default:          return 'asia';
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, options = {}, attempts = 3) {
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

async function supabaseWithRetry(fn, attempts = 3) {
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

async function fetchCountries() {
  const fields =
    'name,cca2,cca3,region,subregion,flag,flags,capital,population,languages';
  const res = await fetchWithRetry(
    `https://restcountries.com/v3.1/all?fields=${fields}`,
  );
  if (!res.ok) throw new Error(`REST Countries ${res.status}`);
  return await res.json();
}

let constituteIndex = null;

async function loadConstituteIndex() {
  if (constituteIndex) return constituteIndex;
  const res = await fetchWithRetry(`${CONSTITUTE_BASE}/constitutions?lang=en`, {
    headers: HEADERS,
  });
  if (!res.ok) throw new Error(`Constitute index HTTP ${res.status}`);
  const data = await res.json();

  const byCountryId = new Map();
  for (const c of data) {
    if (!c.in_force) continue;
    if (c.is_draft) continue;
    const lang = (c.language || '').toLowerCase();
    if (lang && lang !== 'en') continue;

    const existing = byCountryId.get(c.country_id);
    const year = Number(c.year_revised || c.year_enacted) || 0;
    const existingYear = existing
      ? Number(existing.year_revised || existing.year_enacted) || 0
      : -1;
    if (year >= existingYear) byCountryId.set(c.country_id, c);
  }
  constituteIndex = byCountryId;
  return constituteIndex;
}

function matchToConstitute(restCountry, index) {
  const norm = (s) =>
    s
      .replace(/[\.,'’]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_');
  const common = restCountry.name.common;
  const official = restCountry.name.official;
  const candidates = [
    norm(common),
    norm(official),
    norm(common.replace(/^The /i, '')),
    norm(official.replace(/^The /i, '')),
    norm(common) + '_the',
    norm(common.replace(/^The /i, '')) + '_the',
    common === 'United States' ? 'United_States_of_America' : null,
    common === 'Czechia' ? 'Czech_Republic' : null,
    common === 'Myanmar' ? 'Myanmar_Burma' : null,
    common === 'East Timor' ? 'Timor-Leste' : null,
    common === 'Eswatini' ? 'Swaziland' : null,
    common === 'North Macedonia' ? 'Macedonia' : null,
    common === 'Cape Verde' ? 'Cabo_Verde' : null,
    common === 'Ivory Coast' ? 'Cote_dIvoire' : null,
  ].filter(Boolean);

  for (const c of candidates) {
    if (index.has(c)) return index.get(c);
  }
  return null;
}

async function fetchConstituteHtml(consId) {
  const res = await fetchWithRetry(
    `${CONSTITUTE_BASE}/html?cons_id=${encodeURIComponent(consId)}&lang=en`,
    { headers: HEADERS },
  );
  if (!res.ok) return null;
  const json = await res.json();
  return typeof json.html === 'string' && json.html.length > 0 ? json.html : null;
}

function makeFallbackTitle(text) {
  if (!text) return '';
  const firstSentence = text.split(/[.!?](?:\s|$)/)[0].trim();
  if (firstSentence.length <= 70) return firstSentence;
  const cut = firstSentence.slice(0, 67);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > 30 ? cut.slice(0, lastSpace) : cut;
  return trimmed.trim() + '…';
}

function parseConstitute(html) {
  const root = parseHtml(html);

  const articles = [];
  let currentChapter = '';
  let pendingHeading = null;
  let pendingParas = [];
  let ord = 0;

  function flush() {
    if (!pendingHeading) {
      pendingParas = [];
      return;
    }
    if (pendingParas.length === 0) {
      currentChapter = pendingHeading.replace(/\s+/g, ' ').trim();
      pendingHeading = null;
      return;
    }
    const heading = pendingHeading.replace(/\s+/g, ' ').trim();
    const m = heading.match(
      /^(Article|Art\.?|Section|Sec\.?|§)\s*([\d.IVXLCMivxlcm]+\w*)\s*[\-—.:]?\s*(.*)$/i,
    );
    let article_number;
    let explicitTitle = '';
    if (m) {
      const label = m[1].replace(/\.$/, '');
      const canonical =
        /^art/i.test(label) ? 'Article' :
        /^sec/i.test(label) ? 'Section' :
        '§';
      article_number = `${canonical} ${m[2]}`;
      explicitTitle = (m[3] || '').trim();
    } else {
      article_number = heading;
    }
    const fallbackTitle = makeFallbackTitle(pendingParas[0]);
    const title = explicitTitle || fallbackTitle || article_number;
    articles.push({
      ord: ord++,
      chapter: currentChapter || 'General Provisions',
      article_number,
      title,
      content: pendingParas.join('\n\n'),
    });
    pendingHeading = null;
    pendingParas = [];
  }

  function classOf(node) {
    return (node.attributes && node.attributes.class) || '';
  }

  function walk(node) {
    if (!node) return;
    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    if (tag === 'h2') {
      flush();
      const text = (node.text || '').trim();
      currentChapter = text;
      if (/^preamble$/i.test(text)) {
        pendingHeading = 'Preamble';
      }
      return;
    }
    if (tag === 'h3' || tag === 'h4') {
      flush();
      pendingHeading = (node.text || '').trim();
      return;
    }
    if (tag === 'p') {
      const text = (node.text || '').trim();
      if (!text) return;
      if (/^(\d{1,4}|[IVXLCDM]{1,8})\.?$/.test(text) && text.length <= 8) {
        flush();
        pendingHeading = `Section ${text.replace(/\.$/, '')}`;
        return;
      }
      pendingParas.push(text);
      return;
    }
    if ((tag === 'ol' || tag === 'ul') && pendingHeading) {
      const parentHeading = pendingHeading;
      flush();
      const liChildren = (node.childNodes || []).filter(
        (ch) => ch.tagName?.toLowerCase() === 'li',
      );
      let idx = 0;
      const parentMatch = parentHeading.match(
        /^(Article|Art\.?|Section|Sec\.?|§)\s*([\d.IVXLCMivxlcm]+\w*)/i,
      );
      const baseLabel = parentMatch
        ? (/^art/i.test(parentMatch[1])
            ? 'Article'
            : /^sec/i.test(parentMatch[1])
              ? 'Section'
              : '§')
        : null;
      const baseNum = parentMatch ? parentMatch[2] : null;
      for (const li of liChildren) {
        idx++;
        const style = li.attributes?.style || '';
        const styleMatch = style.match(/list-style-type:\s*['"]([^'"]+)['"]/);
        const label = styleMatch?.[1]?.trim() || String(idx);
        const liText = (li.text || '').trim();
        if (!liText) continue;
        const article_number = baseLabel && baseNum
          ? `${baseLabel} ${baseNum}.${label}`
          : `${parentHeading} (${label})`;
        articles.push({
          ord: ord++,
          chapter: currentChapter || 'General Provisions',
          article_number,
          title: makeFallbackTitle(liText) || article_number,
          content: liText,
        });
      }
      pendingHeading = null;
      pendingParas = [];
      return;
    }
    if (tag === 'li') {
      const text = (node.text || '').trim();
      if (text) pendingParas.push(text);
      return;
    }
    if (node.childNodes) {
      for (const ch of node.childNodes) walk(ch);
    }
  }

  walk(root);
  flush();
  return articles;
}

async function fetchWikipediaSummary(countryName) {
  const variants = [
    `Constitution of ${countryName}`,
    `Constitution of the ${countryName}`,
    `${countryName} Constitution`,
  ];
  for (const title of variants) {
    try {
      const res = await fetchWithRetry(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/\s+/g, '_'))}`,
        { headers: HEADERS },
      );
      if (!res.ok) continue;
      const json = await res.json();
      if (json.type === 'standard' && json.extract && json.extract.length > 80) {
        return {
          title: json.title,
          extract: json.extract,
          url: json.content_urls?.desktop?.page ?? '',
        };
      }
    } catch {
    }
  }
  return null;
}

async function upsertConstitution(row) {
  const { error } = await supabaseWithRetry(() =>
    sb.from('constitutions').upsert(row),
  );
  return error;
}

async function replaceArticles(constitutionId, rows) {
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const { error } = await supabaseWithRetry(() =>
      sb.from('articles').upsert(chunk),
    );
    if (error) return error;
  }
  const { error: dErr } = await supabaseWithRetry(() =>
    sb
      .from('articles')
      .delete()
      .eq('constitution_id', constitutionId)
      .gte('ord', rows.length),
  );
  return dErr || null;
}

async function main() {
  console.log('\nLoading Constitute Project index…');
  const cIndex = await loadConstituteIndex();
  console.log(
    `Constitute: ${cIndex.size} in-force constitutions available in English.\n`,
  );

  console.log('Fetching country list from REST Countries…');
  const countries = await fetchCountries();
  console.log(`REST Countries: ${countries.length} countries.\n`);

  let total = 0;
  let withConstitute = 0;
  let withWiki = 0;
  let withProfileOnly = 0;
  let articlesWritten = 0;
  let failed = 0;
  const needsRetry = [];

  async function processCountry(c, displayPrefix) {
    const id = c.cca2.toLowerCase();
    const country = c.name.common;
    const region = mapRegion(c.region, c.subregion);

    const capital = c.capital?.[0] || '';
    const population = Number.isFinite(c.population) ? c.population : null;
    const languages = c.languages ? Object.values(c.languages) : [];
    const subregion = c.subregion || '';
    const flagImage = c.flags?.svg || c.flags?.png || '';

    process.stdout.write(
      `${displayPrefix} ${c.flag} ${country.padEnd(34)} `,
    );

    const cMatch = matchToConstitute(c, cIndex);
    let parsedArticles = null;
    let adopted = '';
    let summary = '';
    let hadNetworkError = false;

    if (cMatch) {
      try {
        const html = await fetchConstituteHtml(cMatch.id);
        await sleep(DELAY_MS);
        if (html) {
          parsedArticles = parseConstitute(html);
          if (parsedArticles.length === 0) parsedArticles = null;
        }
      } catch (err) {
        hadNetworkError = true;
        process.stdout.write(`(constitute err: ${err.message}) `);
      }
      if (parsedArticles) {
        adopted = String(cMatch.year_revised || cMatch.year_enacted || '');
        const firstPara = parsedArticles[0]?.content?.slice(0, 380) || '';
        summary = `${firstPara}…\n\n${ATTRIBUTION}`.trim();
      }
    }

    let wiki = null;
    if (!parsedArticles) {
      try {
        wiki = await fetchWikipediaSummary(country);
        await sleep(DELAY_MS);
        if (wiki) summary = wiki.extract.slice(0, 480);
      } catch (err) {
        hadNetworkError = true;
        process.stdout.write(`(wiki err: ${err.message}) `);
      }
    }

    const constitutionRow = {
      id,
      country,
      country_code: c.cca2,
      flag: c.flag,
      region,
      title: `Constitution of ${country}`,
      adopted,
      summary,
      capital,
      population,
      languages,
      subregion,
      flag_image_url: flagImage,
    };
    const cErr = await upsertConstitution(constitutionRow);
    if (cErr) {
      console.log(`✗ ${cErr.message}`);
      if (cErr.message?.includes('row-level security') && total <= 3) {
        console.error('\n  Supabase rejected the write under RLS.');
        console.error('  The script needs the service_role (secret) key.');
        console.error(
          '  Get it from: Supabase Dashboard → Project Settings → API.\n',
        );
        process.exit(2);
      }
      const isNetwork = /fetch failed|network|timeout/i.test(cErr.message || '');
      return { status: 'failed', hadNetworkError: isNetwork, constituteAvailable: !!cMatch, articlesAdded: 0 };
    }

    if (parsedArticles) {
      const rows = parsedArticles.map((a) => ({
        id: `${id}-cp-${String(a.ord).padStart(3, '0')}`,
        constitution_id: id,
        chapter: a.chapter,
        article_number: a.article_number,
        title: a.title || a.article_number,
        content: a.content,
        ord: a.ord,
      }));
      const err = await replaceArticles(id, rows);
      if (err) {
        console.log(`✗ articles: ${err.message}`);
        const isNetwork = /fetch failed|network|timeout/i.test(err.message || '');
        return { status: 'failed', hadNetworkError: isNetwork, constituteAvailable: true, articlesAdded: 0 };
      }
      console.log(`✓ Constitute (${rows.length} articles)`);
      return { status: 'constitute', hadNetworkError: false, constituteAvailable: true, articlesAdded: rows.length };
    }

    if (wiki) {
      const overview = {
        id: `${id}-overview`,
        constitution_id: id,
        chapter: 'Overview',
        article_number: 'Overview',
        title: 'Constitutional overview',
        content: `${wiki.extract}\n\nSource: ${wiki.url}`,
        ord: 0,
      };
      const err = await replaceArticles(id, [overview]);
      if (err) {
        console.log(`profile ✓ article ✗ (${err.message})`);
        const isNetwork = /fetch failed|network|timeout/i.test(err.message || '');
        return { status: 'failed', hadNetworkError: isNetwork, constituteAvailable: !!cMatch, articlesAdded: 0 };
      }
      console.log('✓ Wikipedia overview');
      return { status: 'wiki', hadNetworkError, constituteAvailable: !!cMatch, articlesAdded: 1 };
    }

    const factsLine =
      [
        capital && `Capital: ${capital}`,
        population != null && `Population: ${population.toLocaleString('en-US')}`,
        subregion && `Sub-region: ${subregion}`,
        languages.length > 0 && `Official / national languages: ${languages.join(', ')}`,
      ]
        .filter(Boolean)
        .join('. ');
    const profile = {
      id: `${id}-profile`,
      constitution_id: id,
      chapter: 'Country profile',
      article_number: 'Profile',
      title: `${country} — country profile`,
      content:
        `${country} is a country in ${region}` +
        (subregion ? ` (${subregion}).` : '.') +
        (factsLine ? ` ${factsLine}.` : '') +
        `\n\nNo constitutional text is currently available for ${country} from the Constitute Project or Wikipedia. ` +
        `For the latest constitutional information, see https://en.wikipedia.org/wiki/Constitution_of_${encodeURIComponent(country.replace(/\s+/g, '_'))}.`,
      ord: 0,
    };
    const err = await replaceArticles(id, [profile]);
    if (err) {
      console.log(`profile ✗ (${err.message})`);
      const isNetwork = /fetch failed|network|timeout/i.test(err.message || '');
      return { status: 'failed', hadNetworkError: isNetwork, constituteAvailable: !!cMatch, articlesAdded: 0 };
    }
    console.log('✓ profile only');
    return { status: 'profile', hadNetworkError, constituteAvailable: !!cMatch, articlesAdded: 1 };
  }

  const firstStatus = new Map();
  const firstArticles = new Map();

  function applyDelta(status, articlesAdded, sign) {
    if (status === 'constitute') {
      withConstitute += sign;
      articlesWritten += sign * articlesAdded;
    } else if (status === 'wiki') {
      withWiki += sign;
      articlesWritten += sign * articlesAdded;
    } else if (status === 'profile') {
      withProfileOnly += sign;
      articlesWritten += sign * articlesAdded;
    } else if (status === 'failed') {
      failed += sign;
    }
  }

  for (const c of countries) {
    total++;
    const prefix = `[${String(total).padStart(3)}/${countries.length}]`;
    const r = await processCountry(c, prefix);
    applyDelta(r.status, r.articlesAdded, +1);
    firstStatus.set(c.cca2, r.status);
    firstArticles.set(c.cca2, r.articlesAdded);
    if (
      r.status === 'failed' ||
      (r.constituteAvailable && r.hadNetworkError && r.status !== 'constitute')
    ) {
      needsRetry.push(c);
    }
  }

  if (needsRetry.length > 0) {
    console.log(
      `\n${'─'.repeat(64)}\nRetrying ${needsRetry.length} countries that hit transient errors…\n${'─'.repeat(64)}`,
    );
    await sleep(5000);
    for (let i = 0; i < needsRetry.length; i++) {
      const c = needsRetry[i];
      const prefix = `[retry ${String(i + 1).padStart(2)}/${needsRetry.length}]`;
      const r = await processCountry(c, prefix);
      const oldStatus = firstStatus.get(c.cca2);
      const oldArticles = firstArticles.get(c.cca2) || 0;
      applyDelta(oldStatus, oldArticles, -1);
      applyDelta(r.status, r.articlesAdded, +1);
      firstStatus.set(c.cca2, r.status);
      firstArticles.set(c.cca2, r.articlesAdded);
    }
  }

  console.log('\n' + '='.repeat(64));
  console.log(`Total countries processed:        ${total}`);
  console.log(`Indexed via Constitute Project:   ${withConstitute}`);
  console.log(`Indexed via Wikipedia overview:   ${withWiki}`);
  console.log(`Indexed via country profile only: ${withProfileOnly}`);
  console.log(`Total article rows written:       ${articlesWritten}`);
  console.log(`Failed:                           ${failed}`);
  console.log('='.repeat(64));
  console.log(
    '\nThe app will pick these up automatically — no rebuild needed.\n',
  );
}

main().catch((err) => {
  console.error('\nFatal:', err);
  process.exit(1);
});
