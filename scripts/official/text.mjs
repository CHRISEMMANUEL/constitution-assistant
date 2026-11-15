import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

export async function fetchJson(url) {
  const res = await fetchWithRetry(url, {
    headers: { ...HEADERS, Accept: 'application/json' },
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// Git for Windows ships pdftotext in mingw64\bin, which only Git Bash puts on PATH.
function pdftotextBin() {
  if (process.platform !== 'win32') return 'pdftotext';
  const roots = [process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
  for (const root of roots.filter(Boolean)) {
    const bin = path.join(root, 'Git', 'mingw64', 'bin', 'pdftotext.exe');
    if (fs.existsSync(bin)) return bin;
  }
  return 'pdftotext';
}

export async function fetchPdfText(url) {
  const res = await fetchWithRetry(url, {
    headers: { ...HEADERS, Accept: 'application/pdf' },
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'official-'));
  const file = path.join(dir, 'source.pdf');
  try {
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return execFileSync(pdftotextBin(), ['-enc', 'UTF-8', '-layout', file, '-'], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    }).replace(/\r\n/g, '\n');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('pdftotext not found: install poppler-utils (Git for Windows ships it)');
    }
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GAP = /\S {3,}\S/;

const STARTS_PARAGRAPH = /^(\d{1,3}\[)*(\([0-9a-zA-Z]{1,6}\)|\d{1,3}[A-Z]{0,3}\.\s|[•“"[*]|Provided|Explanation|Illustration)/;

// firstLineIndent: for PDFs that start each paragraph with an indented first line and wrap
// at the margin (India), a line only starts a paragraph when it is indented, so a wrapped
// line that happens to begin with "(a)" or "1. " stays joined.
export function unwrapPdfLines(lines, { firstLineIndent = false } = {}) {
  const out = [];
  let prevIndent = 0;
  for (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    const indent = raw.length - raw.trimStart().length;
    const last = out.length - 1;
    const table = GAP.test(text) || (last >= 0 && GAP.test(out[last]));
    const starts = firstLineIndent
      ? indent >= 4 && (STARTS_PARAGRAPH.test(text) || /[.;:—\]]$/.test(out[last]))
      : STARTS_PARAGRAPH.test(text) || (indent > prevIndent + 2 && /[.;:—]$/.test(out[last]));
    const join = last >= 0 && !table && !starts;
    if (join) out[last] = /[-—]$/.test(out[last]) ? `${out[last]}${text}` : `${out[last]} ${text}`;
    else out.push(table ? text.replace(/ {3,}/g, '   ') : text);
    prevIndent = indent;
  }
  return out;
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
