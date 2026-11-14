import { parse as parseHtml } from 'node-html-parser';
import { fetchWithRetry, sleep } from '../lib/db.mjs';

const HEADERS = {
  'User-Agent': 'ConstIntell/1.0 (educational; contact via repo)',
};

const DROP = [
  'style',
  'script',
  'link',
  's',
  'del',
  'strike',
  'sup.reference',
  '.reference',
  '.mw-editsection',
  '.ws-noexport',
  '.pagenum',
  '#headertemplate',
  '.ws-header',
  '.wst-header-structure',
  '.licenseContainer',
  '.wst-license-container',
  '#toc',
  '.toc',
  '.noprint',
];

const BLOCK = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'DD', 'DT', 'TR',
  'BLOCKQUOTE', 'TABLE', 'UL', 'OL', 'DL', 'BR', 'CENTER', 'SECTION', 'TD',
]);

const BOLD = new Set(['B', 'STRONG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

const clean = (s) =>
  s
    .replace(/[​‎‏﻿]/g, '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ');

export function htmlToLines(html, rootSelector) {
  const doc = parseHtml(html);
  const root = (rootSelector && doc.querySelector(rootSelector)) || doc;
  for (const sel of DROP) {
    for (const el of root.querySelectorAll(sel)) el.remove();
  }

  const lines = [];
  let text = '';
  let boldChars = 0;
  let plainChars = 0;
  let heading = null;

  const flush = () => {
    const t = clean(text).trim();
    if (t) {
      lines.push({ text: t, bold: plainChars === 0 && boldChars > 0, heading });
    }
    text = '';
    boldChars = 0;
    plainChars = 0;
    heading = null;
  };

  const walk = (node, inBold, level) => {
    if (node.nodeType === 3) {
      const t = node.text;
      text += t;
      const n = t.replace(/\s/g, '').length;
      if (inBold) boldChars += n;
      else plainChars += n;
      if (level && n) heading = level;
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    const block = BLOCK.has(tag);
    if (block) flush();
    const h = /^H[1-6]$/.test(tag) ? Number(tag[1]) : level;
    for (const child of node.childNodes) walk(child, inBold || BOLD.has(tag), h);
    if (block) flush();
  };

  walk(root, false, null);
  flush();
  return lines;
}

export async function fetchHtml(url) {
  const res = await fetchWithRetry(url, {
    headers: { ...HEADERS, Accept: 'text/html' },
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

const WIKISOURCE_API = 'https://en.wikisource.org/w/api.php';

export async function fetchWikisource(title) {
  const params = new URLSearchParams({
    action: 'parse',
    page: title,
    prop: 'text|revid',
    redirects: '1',
    format: 'json',
    formatversion: '2',
  });
  let res;
  for (let i = 0; i < 6; i++) {
    try {
      res = await fetchWithRetry(`${WIKISOURCE_API}?${params}`, {
        headers: { ...HEADERS, Accept: 'application/json' },
        signal: AbortSignal.timeout(90000),
      });
    } catch (err) {
      if (i === 5) throw err;
      await sleep(5000 * 2 ** i);
      continue;
    }
    if (res.status !== 429 && res.status !== 503) break;
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * 2 ** i);
  }
  if (!res.ok) throw new Error(`Wikisource ${title} → HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Wikisource ${title} → ${data.error.info}`);
  await sleep(1000);
  return {
    title: data.parse.title,
    revid: data.parse.revid,
    url: `https://en.wikisource.org/w/index.php?oldid=${data.parse.revid}`,
    html: data.parse.text,
  };
}

export async function wikisourceSubpages(root) {
  const page = await fetchWikisource(root);
  const doc = parseHtml(page.html);
  const prefix = `/wiki/${encodeURIComponent(root.replace(/ /g, '_'))}/`;
  const seen = new Set();
  const titles = [];
  for (const a of doc.querySelectorAll('a')) {
    const href = a.getAttribute('href') || '';
    const raw = href.replace(/#.*$/, '');
    if (!raw.startsWith(prefix) && !decodeURIComponent(raw).startsWith(`/wiki/${root.replace(/ /g, '_')}/`)) continue;
    const title = decodeURIComponent(raw.slice('/wiki/'.length)).replace(/_/g, ' ');
    if (seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
  }
  return { root: page, titles };
}
