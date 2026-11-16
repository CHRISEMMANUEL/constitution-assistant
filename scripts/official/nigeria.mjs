// Nigeria: the Federal Ministry of Justice PDF is the 1999 text with the First to Third
// Alteration Acts (2010) appended as amending instructions. This module parses both parts and
// applies the alterations (ALTERATIONS below) so the result is the consolidated text.

import { fetchPdfPages } from './text.mjs';

// Running headers sit above this baseline on every page of the 1999 text, and above
// ACT_HEADER_Y in the Acts.
const HEADER_Y = 655;
const ACT_HEADER_Y = 698;

function rowsOf(items) {
  const rows = [];
  for (const it of items) {
    let row = rows.find((r) => Math.abs(r.y - it.y) < 2.5);
    if (!row) rows.push((row = { y: it.y, items: [] }));
    row.items.push(it);
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows.sort((a, b) => b.y - a.y);
}

// Small capitals are a capital and the rest of the word as separate items with no gap
// (under 0.3pt); a word space is at least 0.45pt.
function joinItems(items) {
  let out = '';
  let prevX = null;
  for (const it of items) {
    if (prevX !== null && it.x - prevX > 0.4 && !out.endsWith(' ')) out += ' ';
    out += it.s;
    prevX = it.X;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// The body's left edge: the 1999 text alternates two page layouts.
const leftEdge = (pageNo) => (pageNo % 2 ? 120 : 163);

// Margin notes are 8pt, beside a 10pt body: right of it on odd pages, left of it on even ones.
export function pageLines(items, pageNo, left = leftEdge(pageNo)) {
  const rows = rowsOf(items).filter((r) => r.y < HEADER_Y);
  const isMargin = (it) => it.h < 9 && (it.x >= left + 315 || it.X <= left - 4);
  const body = [];
  const margin = [];
  for (const r of rows) {
    const b = r.items.filter((it) => !isMargin(it));
    const m = r.items.filter(isMargin);
    if (b.length) body.push({ page: pageNo, y: r.y, x: b[0].x, rel: b[0].x - left, right: b.at(-1).X - left, text: joinItems(b), items: b, left });
    if (m.length) margin.push({ page: pageNo, y: r.y, text: joinItems(m) });
  }
  return { body, margin, left };
}

// The Acts: 11pt body, 9pt margin notes, 10pt running heads.
function actLines(items, pageNo) {
  const keep = items.filter((it) => it.y < ACT_HEADER_Y && it.h > 6 && !(it.h > 8.5 && it.h < 9.5));
  const left = Math.min(...keep.filter((it) => it.h > 10.5).map((it) => it.x));
  return rowsOf(keep).map((r) => ({ page: pageNo, y: r.y, rel: r.items[0].x - left, right: r.items.at(-1).X - left, text: joinItems(r.items) }));
}

const BODY_WIDTH = 312;
// A paragraph starts with one of these when it is not indented past the line above it.
const MARKER = /^(\(\s?[a-z]{1,5}\s?\)|\(\d{1,2}[A-Z]?\)|\d{1,3}[A-F]?\.|[A-Z]\.?—|[“"]|Provided)/;
const SECTION = /^(\d{1,3})\.\s?—?\s?(.*)$/;

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);
const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/[a-z][a-z'’]*/g, (w, i, all) => (i > 0 && all[i - 1] !== '-' && SMALL_WORDS.has(w) ? w : w[0].toUpperCase() + w.slice(1)));

// Headings the PDF prints without spaces or misspelt.
const HEADING_FIXES = new Map([
  ['FEDERAL CAPITAL TERRITORY, ABUJAAND GENERAL SUPPLEMENTARY PROVISIONS', 'FEDERAL CAPITAL TERRITORY, ABUJA AND GENERAL SUPPLEMENTARY PROVISIONS'],
  ['TRASITIONAL PROVISIONS AND SAVINGS', 'TRANSITIONAL PROVISIONS AND SAVINGS'],
]);

// Section numbers the PDF misprints: [number, the line where it starts].
const MISNUMBERED = [[281, /^285\.—\(1\) The appointment of a person to the office of President of a$/]];

// Sections printed without a margin note; titles from the table of contents.
const UNTITLED = new Map([[267, 'Jurisdiction']]);
const TITLE_FIXES = new Map([
  ['Interpretaation', 'Interpretation'],
  ['Complusory acquisition of property', 'Compulsory acquisition of property'],
]);

// Words the PDF runs together or misprints, as [article, wrong, right]; each must still occur.
const TEXT_FIXES = [
  ['Section 285', 'Legislative Houses ElectionTribunals', 'Legislative Houses Election Tribunals'],
  ['Section 304', 'necessaIy', 'necessary'],
  ['Section 305', 'when eachHouse', 'when each House'],
];

// Centred, and either clearly indented or in capitals (long chapter titles fill the line).
const isHeading = (l) =>
  Math.abs((l.rel + l.right) / 2 - BODY_WIDTH / 2) < 18 &&
  !/^(\(\s?\w{1,5}\s?\)|\d{1,3}[A-F]?\.)/.test(l.text) &&
  (l.rel >= 30 || (l.text === l.text.toUpperCase() && /[A-Z]{4}/.test(l.text) && !/[.;:,]$/.test(l.text)));

function startsParagraph(l, prev) {
  if (!prev) return true;
  if (l.rel > prev.rel + 4) return true;
  return l.rel >= 17 && MARKER.test(l.text) && (/[.;:—,]$/.test(prev.text) || /\b(and|or)$/.test(prev.text));
}

// Words that occur whole somewhere decide whether a line-end hyphen is kept ("Vice-President")
// or was only typesetting ("Constitu-tion"). A capitalised first half keeps it unless the
// joined word occurs ("President-elect", but "Presi-dent").
function wordSet(lines) {
  const words = new Set();
  for (const l of lines) for (const w of l.text.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) ?? []) words.add(w);
  return words;
}

export function joinLines(lines, words) {
  let out = lines[0];
  for (const l of lines.slice(1)) {
    const end = out.match(/([A-Za-z]+)-$/);
    const next = l.match(/^([A-Za-z]+)/);
    if (end && next) {
      const whole = (end[1] + next[1]).toLowerCase();
      const hyphenated = `${end[1]}-${next[1]}`.toLowerCase();
      const drop = words.has(whole) || (!words.has(hyphenated) && /^[a-z]/.test(end[1]) && /^[a-z]/.test(next[1]));
      out = drop ? out.slice(0, -1) + l : out + l;
    } else if (/\/$/.test(out)) out += l;
    else out += ` ${l}`;
  }
  return out;
}

function marginBlocks(margin) {
  const blocks = [];
  for (const m of margin) {
    const last = blocks.at(-1);
    // A note runs on until its closing full stop; the next note may start one line below.
    if (last && last.page === m.page && last.bottom - m.y <= 13 && !/\.$/.test(last.lines.at(-1))) {
      last.lines.push(m.text);
      last.bottom = m.y;
    } else blocks.push({ page: m.page, top: m.y, bottom: m.y, lines: [m.text] });
  }
  return blocks;
}

function titleFinder(blocks, words) {
  return (l) => {
    const near = blocks
      .filter((b) => !b.used && b.page === l.page && b.top >= l.y - 8 && b.top <= l.y + 20)
      .sort((a, b) => Math.abs(a.top - l.y) - Math.abs(b.top - l.y))[0];
    if (!near) return null;
    near.used = true;
    const title = joinLines(near.lines, words)
      .replace(/([a-z]+)-([a-z]+)/g, (m, a, b) => (words.has(a + b) ? a + b : m))
      // A cross-reference printed straight after the note ("lands. Part II First Schedule.").
      .replace(/(?<!\betc)\.\s.*$/, '')
      .replace(/\s+(Part [IVX]+ )?(First|Second|Third|Fourth|Fifth|Sixth|Seventh) Schedule\.?$/, '')
      .replace(/\.$/, '');
    return TITLE_FIXES.get(title) ?? title;
  };
}

// Groups lines into paragraphs by indentation and joins each one. Lines in capitals are
// headings and get a paragraph of their own. byMarker is for hanging indents, where only a
// marker after a finished line starts a paragraph.
const isCaps = (l) => /[A-Z]{3}.* [A-Z]{2}/.test(l.text) && l.text === l.text.toUpperCase();
// The Acts wrap at any indent and close quotations at paragraph ends, so there a marker after
// a finished line or a closing quote always starts one.
function paragraphs(lines, words, { byMarker = false, act = false } = {}) {
  const paras = [];
  let prev = null;
  for (const l of lines) {
    const finished = (p) => p && (/[.;:—,]$/.test(p.text) || /\b(and|or)$/.test(p.text) || (act && /[”"]$/.test(p.text)));
    const starts = byMarker
      ? MARKER.test(l.text) && (!prev || finished(prev))
      : act
        ? !prev || l.rel > prev.rel + 4 || ((MARKER.test(l.text) || /^\d{1,3}[A-F]—/.test(l.text)) && finished(prev))
        : startsParagraph(l, prev);
    const heading = prev && (isCaps(l) || isCaps(prev)) ? isCaps(l) !== isCaps(prev) : starts;
    if (!paras.length || heading) paras.push([l.text]);
    else paras.at(-1).push(l.text);
    prev = l;
  }
  return paras.map((p) => joinLines(p, words));
}

// Sections 1-320 of the 1999 text, with margin notes as titles.
export function parseSections(lines, margin, words = wordSet(lines)) {
  const titleFor = titleFinder(marginBlocks(margin), words);
  const sections = [];
  const dropped = [];
  let chapter = null;
  let chapterTitle = [];
  let part = null;
  let partTitle = [];
  let sub = []; // lettered subheading within a Part ("A—Composition and Staff of …")
  let pending = null; // 'chapter' | 'part' | 'sub' while their title lines follow
  let current = null;
  let para = null;
  let prev = null;
  let last = 0;
  const label = () => {
    const fix = (t) => titleCase(HEADING_FIXES.get(t) ?? t);
    const c = `Chapter ${chapter} — ${fix(chapterTitle.join(' '))}`;
    const p = part ? `${c}, Part ${part} — ${fix(partTitle.join(' '))}` : c;
    return sub.length ? `${p}, ${sub.join(' ').replace(/^([A-Z]{1,2})\.?—\s?/, '$1 — ')}` : p;
  };
  const preamble = { article_number: 'Preamble', title: 'Preamble', chapter: 'Preamble', paras: [] };
  for (const l of lines) {
    if (isHeading(l)) {
      const ch = l.text.match(/^CHAPTER\s*([IVX]+)$/);
      const pt = l.text.match(/^PART\s*([IVX]+)$/i);
      if (ch) [chapter, chapterTitle, part, partTitle, sub, pending] = [ch[1], [], null, [], [], 'chapter'];
      else if (pt) [part, partTitle, sub, pending] = [pt[1], [], [], 'part'];
      else if (/^[A-Z]\.?—/.test(l.text)) [sub, pending] = [[l.text], 'sub'];
      else if (pending === 'chapter' && l.text === l.text.toUpperCase()) chapterTitle.push(l.text);
      else if (pending === 'part' && l.text === l.text.toUpperCase()) partTitle.push(l.text);
      else if (pending === 'sub') sub.push(l.text);
      else {
        pending = null;
        dropped.push(l.text);
      }
      prev = null;
      continue;
    }
    pending = null;
    if (!chapter) {
      // Preamble: each recital ends with a colon.
      if (!prev || /:$/.test(prev.text)) preamble.paras.push((para = [l.text.replace(/^W e the P eople\s*of/, 'We the People of')]));
      else para.push(l.text);
      prev = l;
      continue;
    }
    const misnumbered = MISNUMBERED.find(([n, re]) => n === last + 1 && re.test(l.text));
    if (misnumbered) misnumbered.used = true;
    const head = startsParagraph(l, prev) && l.text.match(SECTION);
    if (head && (Number(head[1]) === last + 1 || misnumbered)) {
      last += 1;
      current = { chapter: label(), article_number: `Section ${last}`, title: titleFor(l) ?? UNTITLED.get(last), paras: [] };
      sections.push(current);
      current.paras.push((para = [head[2]]));
    } else if (startsParagraph(l, prev)) current.paras.push((para = [l.text]));
    else para.push(l.text);
    prev = l;
  }
  for (const m of MISNUMBERED) if (!m.used) throw new Error(`ng: misnumbered section ${m[0]} no longer found, recheck`);
  const articles = [preamble, ...sections].map(({ paras, ...a }) => ({
    ...a,
    content: paras.map((p) => joinLines(p, words)).filter(Boolean).join('\n'),
  }));
  return { articles, dropped };
}

const ORDINALS = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH'];
const SCHEDULE_HEAD = new RegExp(`^(${ORDINALS.join('|')}) SCHEDULE`);
// Cross-references printed at the right of a heading ("Section 4", "Sections 3 and 297").
const REF = /^(Sections? \d+( and \d+)?|and \d+)$/;

// Concurrent List subject headings sit in a 60pt column left of the paragraphs. Splits each
// line into that column and the rest; on some pages the column is set as margin notes.
function splitColumn(lines, margin, width) {
  const head = margin.map((m) => ({ page: m.page, y: m.y, text: m.text }));
  const body = [];
  for (const l of lines) {
    const h = l.items.filter((it) => it.x - l.left < width && (it.h < 9.5 || it.X - l.left < width + 2));
    const b = l.items.filter((it) => !h.includes(it));
    if (h.length) head.push({ page: l.page, y: l.y, text: joinItems(h) });
    if (b.length) body.push({ ...l, x: b[0].x, rel: b[0].x - l.left, text: joinItems(b), items: b });
  }
  return { head, body };
}

// Exclusive List items have no titles; the first clause stands in for one.
function itemTitle(text) {
  const t = text.replace(/[,;:.—(].*$/, '').trim();
  return t.length > 80 ? `${t.slice(0, 80).replace(/\s\S*$/, '')}…` : t;
}

// The seven Schedules: one row per State, list item, executive body, Code of Conduct
// paragraph or oath, and one per remaining Part.
export function parseSchedules(lines, margin, words = wordSet(lines)) {
  const titleFor = titleFinder(marginBlocks(margin.filter((m) => !/^Sections? \d/.test(m.text))), words);
  const rows = [];
  const dropped = [];
  // Split into schedules and parts, keeping each part's title lines.
  const parts = [];
  let schedule = null;
  let part = null;
  let pending = null;
  for (const raw of lines) {
    const right = raw.items.filter((it) => it.x - raw.left > 180);
    const l = { ...raw, items: REF.test(joinItems(right)) ? raw.items.filter((it) => !right.includes(it)) : raw.items };
    if (!l.items.length) continue;
    l.text = joinItems(l.items);
    const sch = l.text.match(SCHEDULE_HEAD);
    if (sch) {
      schedule = { name: `${titleCase(sch[1])} Schedule`, title: [] };
      parts.push((part = { schedule, part: null, title: [], lines: [] }));
      pending = schedule.title;
      continue;
    }
    if (!schedule) continue;
    const pt = isHeading(l) && l.text.match(/^PART\s*([IVX]+)$/i);
    if (pt) {
      parts.push((part = { schedule, part: pt[1], title: [], lines: [] }));
      pending = part.title;
      continue;
    }
    if (pending && isHeading(l) && l.text === l.text.toUpperCase() && !/^([A-N]\.?—|\([a-z]|OATHS? OF)/.test(l.text)) {
      pending.push(l.text);
      continue;
    }
    pending = null;
    part.lines.push(l);
  }
  for (const p of parts) {
    const s = p.schedule;
    const head = `${s.name}${p.part ? `, Part ${p.part}` : ''}`;
    const named = (label, title) => (title.length ? `${label} — ${titleCase(title.join(' '))}` : label);
    const chapter = [named(s.name, s.title), p.part && named(`Part ${p.part}`, p.title)]
      .filter(Boolean)
      .join(', ');
    const add = (number, title, ls, opts = {}) => {
      if (ls.length) rows.push({ chapter: opts.chapter ?? chapter, article_number: number, title, content: paragraphs(ls, words, opts).join('\n') });
    };
    const ls = p.lines;
    const key = `${s.name}/${p.part ?? ''}`;
    if (key === 'First Schedule/I') {
      // Table: State | Local Government Areas | Capital City, split by column.
      let st = null;
      for (const l of ls) {
        if (/continued|^State Local Government Areas/i.test(l.text)) continue;
        const col = (lo, hi) => joinItems(l.items.filter((it) => it.x - l.left >= lo && it.x - l.left < hi));
        const [state, lga, capital] = [col(-10, 50), col(50, 250), col(250, 400)];
        if (state) rows.push((st = { chapter, article_number: `${head}, ${state}`, title: state, lga: [], capital: [] }));
        if (!st) throw new Error(`ng First Schedule: table row before the first State: ${l.text}`);
        if (lga) st.lga.push(lga);
        if (capital) st.capital.push(capital);
      }
      for (const r of rows.filter((r) => r.lga)) {
        r.content = `Local Government Areas: ${joinLines(r.lga, words)}\nCapital City: ${r.capital.join(' ')}`;
        delete r.lga;
        delete r.capital;
      }
    } else if (key === 'First Schedule/II') {
      // Fractions are set as a raised "1" over "/2".
      const kept = ls.filter((l) => l.text !== '1');
      const table = kept.findIndex((l) => l.text === 'Area Councils');
      const council = kept.slice(table + 2).map((l) => {
        const [name, hq] = [l.items.filter((it) => it.x - l.left < 120), l.items.filter((it) => it.x - l.left >= 120)].map(joinItems);
        return `${name}: ${hq}`;
      });
      const paras = paragraphs(kept.slice(0, table), words).map((t) => t.replace(/(\d) \/2 ?'/g, '$1½\''));
      rows.push({ chapter, article_number: head, title: 'Federal Capital Territory, Abuja', content: [...paras, 'Area Council: Area Council Headquarters', ...council].join('\n') });
    } else if (key === 'Second Schedule/I') {
      let n = 0;
      let cur = null;
      for (const l of ls) {
        if (l.text === 'Item') continue;
        const m = l.rel < 5 && l.text.match(/^(\d{1,2})\.\s(.*)$/);
        if (m && Number(m[1]) === n + 1) {
          n += 1;
          cur = { n, title: itemTitle(m[2]), lines: [] };
          rows.push(cur);
        }
        if (!cur) throw new Error(`ng Second Schedule: text before item 1: ${l.text}`);
        cur.lines.push(l);
      }
      for (const r of rows.filter((r) => r.lines)) {
        Object.assign(r, { chapter, article_number: `${head}, item ${r.n}`, content: paragraphs(r.lines, words, { byMarker: true }).join('\n') });
        delete r.n;
        delete r.lines;
      }
    } else if (key === 'Second Schedule/II') {
      const pages = new Set(ls.map((l) => l.page));
      // The column heading over the paragraphs ("Item | Extent of Federal and State Legislative Powers").
      const extent = ls.find((l) => /^Item Extent of Federal/.test(l.text));
      const listChapter = extent ? `${chapter} (${extent.text.replace(/^Item /, '')})` : chapter;
      const col = splitColumn(
        ls.filter((l) => !/^Item Extent of Federal/.test(l.text)),
        margin.filter((m) => pages.has(m.page)),
        60,
      );
      // Headings start "A—"; a block runs until the next one.
      const heads = [];
      for (const h of col.head.sort((a, b) => a.page - b.page || b.y - a.y)) {
        if (/^[A-N]—/.test(h.text) || !heads.length) heads.push({ page: h.page, y: h.y, lines: [h.text] });
        else heads.at(-1).lines.push(h.text);
      }
      const units = heads.map((h) => {
        const t = joinLines(h.lines, words).match(/^([A-N])—\s?(.*?)\.?$/);
        if (!t) throw new Error(`ng Concurrent List: heading "${h.lines.join(' ')}"`);
        return { ...h, letter: t[1], title: t[2], lines: [] };
      });
      units.forEach((u, i) => {
        if (u.letter !== String.fromCharCode(65 + i)) throw new Error(`ng Concurrent List: heading ${u.letter} out of order`);
      });
      for (const l of col.body) {
        const u = units.findLast((h) => h.page < l.page || (h.page === l.page && h.y >= l.y - 3)) ?? units[0];
        u.lines.push(l);
      }
      for (const u of units) add(`${head}, ${u.letter}`, u.title, u.lines, { byMarker: true, chapter: listChapter });
    } else if (key === 'Third Schedule/I' || key === 'Third Schedule/II') {
      let cur = null;
      const units = [];
      for (const l of ls) {
        const m = isHeading(l) && l.text.match(/^([A-N])\.?—(.*)$/);
        if (m) {
          const letter = String.fromCharCode(65 + units.length);
          if (m[1] !== letter && !LETTER_MISPRINTS.has(`${head}, ${m[1]}—${m[2]}`)) throw new Error(`ng ${head}: heading ${m[1]} where ${letter} was expected`);
          units.push((cur = { letter, title: m[2].trim(), lines: [] }));
        } else if (cur) cur.lines.push(l);
        else dropped.push(l.text);
      }
      for (const u of units) add(`${head}, ${u.letter}`, u.title, u.lines);
    } else if (key === 'Fifth Schedule/I') {
      let n = 0;
      let cur = null;
      let sub = null;
      const units = [];
      for (const l of ls) {
        // Subheadings ("General", "Code of Conduct Tribunal", "Interpretation").
        if (isHeading(l) && !MARKER.test(l.text)) {
          sub = l.text;
          continue;
        }
        const m = l.text.match(/^(\d{1,2})\.\s?—?\s?(.*)$/);
        if (m && Number(m[1]) === n + 1 && l.rel > 17) {
          n += 1;
          units.push((cur = { n, title: titleFor(l), sub, lines: [] }));
        }
        if (!cur) throw new Error(`ng Fifth Schedule: text before paragraph 1: ${l.text}`);
        cur.lines.push(l);
      }
      for (const u of units) add(`${head}, paragraph ${u.n}`, u.title, u.lines, { chapter: u.sub ? `${chapter}, ${u.sub}` : chapter });
    } else if (key === 'Seventh Schedule/') {
      let cur = null;
      const units = [];
      for (const l of ls) {
        if (isHeading(l) && l.text === l.text.toUpperCase()) {
          if (cur && !cur.lines.length) cur.title.push(l.text);
          else units.push((cur = { title: [l.text], lines: [] }));
        } else if (cur) cur.lines.push(l);
        else dropped.push(l.text);
      }
      for (const u of units) {
        const title = titleCase(u.title.join(' ')).replace(/ ,/g, ',');
        add(`${head}, ${title}`, title, u.lines);
      }
    } else if (key === 'Sixth Schedule/') {
      // Replaced as a whole by the Second Alteration (see ALTERATIONS).
      rows.push({ chapter, article_number: head, title: titleCase(s.title.join(' ')), content: paragraphs(ls, words).join('\n') });
    } else {
      // One row for the Part; centred mixed-case lines at its start name the body it sets up.
      const named = [];
      while (ls.length && isHeading(ls[0]) && ls[0].text !== ls[0].text.toUpperCase() && !MARKER.test(ls[0].text)) named.push(ls.shift().text);
      const title = named.length ? named.join(' ') : titleCase(p.title.join(' ') || s.title.join(' '));
      add(head, title, ls);
    }
  }
  return { articles: rows, dropped };
}

// Executive body headings the PDF letters wrongly ("I" twice; the second is J).
const LETTER_MISPRINTS = new Set(['Third Schedule, Part I, I—National Population Commission']);

// The text of each Act, as paragraphs.
function actParagraphs(pages) {
  const acts = { 1: [], 2: [], 3: [] };
  // The running head names the Act; a page without one (an Act's first page) continues the last.
  let act = null;
  pages.forEach((items, i) => {
    const head = joinItems(items.filter((it) => it.y >= ACT_HEADER_Y).sort((a, b) => a.x - b.x));
    const m = head.match(/\((First|Second|Third) Alteration\)/);
    if (m) act = { First: 1, Second: 2, Third: 3 }[m[1]];
    if (act) acts[act].push(...actLines(items, i + 1));
  });
  const words = wordSet(Object.values(acts).flat());
  const out = {};
  for (const [n, lines] of Object.entries(acts)) {
    if (!lines.length) throw new Error(`ng: Alteration Act ${n} not found in the PDF`);
    out[n] = paragraphs(lines, words, { act: true }).map((p) => p.replace(/^\(\s*(\w+)\s*\)/, '($1)'));
  }
  return out;
}

export function parseNigeria(pages) {
  const body = [];
  const margin = [];
  const schedBody = [];
  const schedMargin = [];
  let where = null;
  pages.forEach((items, i) => {
    const r = pageLines(items, i + 1);
    const texts = r.body.map((l) => l.text);
    if (!where && texts.some((t) => /^W e the P eople/.test(t))) where = 'sections';
    if (where === 'sections' && texts.includes('SCHEDULES')) where = 'schedules';
    if (where === 'sections') [body.push(...r.body), margin.push(...r.margin)];
    if (where === 'schedules') {
      // The Seventh Schedule ends the 1999 text; the Gazette with the Acts follows.
      const oath = texts.indexOf('JUDICIAL OATH');
      const end = oath >= 0 ? texts.indexOf('So help me God.', oath) : -1;
      schedBody.push(...(end >= 0 ? r.body.slice(0, end + 1) : r.body));
      schedMargin.push(...r.margin);
      if (end >= 0) where = 'acts';
    }
  });
  if (where !== 'acts') throw new Error(`ng: could not find the end of the Seventh Schedule (stopped in ${where})`);
  const words = wordSet([...body, ...schedBody]);
  const sec = parseSections(body, margin, words);
  const sch = parseSchedules(schedBody, schedMargin, words);
  const articles = [...sec.articles, ...sch.articles];
  for (const [at, wrong, right] of TEXT_FIXES) {
    const a = articles.find((x) => x.article_number === at);
    if (!a || a.content.split(wrong).length !== 2) throw new Error(`ng: text fix "${wrong}" no longer found once in ${at}`);
    a.content = a.content.replace(wrong, right);
  }
  const acts = actParagraphs(pages);
  return { articles: alter(articles, acts), dropped: [...sec.dropped, ...sch.dropped], acts };
}

export async function ngJustice(entry) {
  const { articles, dropped } = parseNigeria(await fetchPdfPages(entry.pages[0]));
  if (dropped.length) {
    console.log(`\n  ng: ${dropped.length} headings left out (check they are not text):`);
    for (const d of dropped) console.log(`    ${d.slice(0, 120)}`);
  }
  return { revision: entry.pages[0], articles };
}

// The three Alteration Acts as edits, in order. Each edit names the Act it comes from; text
// longer than a phrase is copied from the Act (quote: [start, end text or paragraph count]),
// and a short phrase the Act inserts (words) must appear in that Act. Every find must match
// exactly once, so a change in the PDF stops the import instead of altering the wrong place.
// The Second Alteration replaces sections 233, 239, 246 and 285 and the Sixth Schedule, with
// the First Alteration's edits to them, so only its versions are applied.
const ACT_NAMES = { 1: 'First', 2: 'Second', 3: 'Third' };
const DELETED = '[Deleted by the Constitution of the Federal Republic of Nigeria (First Alteration) Act, 2010.]';
const INEC_SIGNATURES = 'and which signatures are duly verified by the Independent National Electoral Commission';
const ELECTORAL_ACT = 'in accordance with the Electoral Act';
const FIRST_DATES = 'one hundred and fifty days and not later than one hundred and twenty days before';
const SECOND_DATES = 'one hundred and fifty days and not later than thirty days before';
const NIC = 'the National Industrial Court';

const ALTERATIONS = [
  { act: 1, in: 'Section 66', find: /^\(h\) he has been indicted.*$/m, put: `(h) ${DELETED}` },
  { act: 1, in: 'Section 69', find: 'loss of confidence in that member ;', put: `loss of confidence in that member ${INEC_SIGNATURES} ;`, words: INEC_SIGNATURES },
  { act: 1, in: 'Section 75', find: 'the 1991 census of the population of Nigeria or the latest', put: 'the latest' },
  { act: 1, in: 'Section 75', find: 'National Assembly after the coming into force of the provisions of this Part of this Chapter of this Constitution.', put: 'National Assembly.' },
  { act: 1, in: 'Section 76', find: 'Independent National Electoral Commission.', put: `Independent National Electoral Commission ${ELECTORAL_ACT}.`, words: ELECTORAL_ACT },
  { act: 1, in: 'Section 76', find: 'sixty days before and not later than the date on which the House stands dissolved', put: FIRST_DATES, words: FIRST_DATES },
  { act: 1, in: 'Section 76', find: 'more than three months before', put: 'more than ninety days before', words: 'ninety days' },
  { act: 1, in: 'Section 76', find: 'not later than one month after', put: 'not later than thirty days after', words: 'thirty days' },
  { act: 1, in: 'Section 81', find: /^\(3\) Any amount standing to the credit of the judiciary.*$/m, quote: ['(3) The amount standing to the credit of the', 'under section 6 of this Constitution'] },
  // The Act adds (8) after "the existing subsection (7)"; this print numbers that subsection (6).
  { act: 1, in: 'Section 84', find: /^\(6\) The recurrent expenditure of judicial offices.*$/m, after: true, quote: ['(8) The recurrent expenditure of the Independent National Electoral', 1] },
  { act: 1, in: 'Section 107', find: /^\(h\) he has been indicted.*$/m, put: `(h) ${DELETED}` },
  { act: 1, in: 'Section 110', find: 'loss of confidence in that member ;', put: `loss of confidence in that member ${INEC_SIGNATURES} ;`, words: INEC_SIGNATURES },
  { act: 1, in: 'Section 116', find: 'Independent National Electoral Commission.', put: `Independent National Electoral Commission ${ELECTORAL_ACT}.`, words: ELECTORAL_ACT },
  { act: 1, in: 'Section 116', find: 'sixty days before and not later than the date on which the House of Assembly stands dissolved', put: FIRST_DATES, words: FIRST_DATES },
  { act: 1, in: 'Section 116', find: 'more than three months before', put: 'more than ninety days before', words: 'ninety days' },
  { act: 1, in: 'Section 116', find: 'not later than one month after', put: 'not later than thirty days after', words: 'thirty days' },
  { act: 1, in: 'Section 132', find: 'Independent National Electoral Commission.', put: `Independent National Electoral Commission ${ELECTORAL_ACT}.`, words: ELECTORAL_ACT },
  { act: 1, in: 'Section 132', find: 'sixty days and not later than thirty', put: 'one hundred and fifty days and not later than one hundred and twenty', words: 'one hundred and fifty days and not later than one hundred and twenty' },
  { act: 1, in: 'Section 135', find: /^\(b\) in any other case, the person last elected to that office.*$/m, after: true, quote: ['(2A) In the determination of the four year term', 'spent in the office before'] },
  { act: 1, in: 'Section 137', find: /^\(i\) he has been indicted.*$/m, put: `(i) ${DELETED}` },
  { act: 1, in: 'Section 145', all: true, quote: ['145.—(1) Whenever the President is proceeding on vacation', 2], strip: /^145\.—/ },
  {
    act: 1,
    in: 'Section 156',
    find: 'as a member of the House of Representatives ;',
    put: 'as a member of the House of Representatives provided that a member of any of these bodies shall not be required to belong to a political party, and in the case of the Independent National Electoral Commission, he shall not be a member of a political party ;',
    words: 'provided that a member of any of these bodies shall not be required to belong to a political party, and in the case of the Independent National Electoral Commission, he shall not be a member of a political party',
  },
  {
    act: 1,
    in: 'Section 160',
    find: 'for the purpose of discharging its functions.',
    put: 'for the purpose of discharging its functions provided that in the case of the Independent National Electoral Commission, its powers to make its own rules or otherwise regulate its own procedure shall not be subject to the approval or control of the President.',
    words: 'provided that in the case of the Independent National Electoral Commission, its powers to make its own rules or otherwise regulate its own procedure shall not be subject to the approval or control of the President',
  },
  { act: 1, in: 'Section 178', find: 'Independent National Electoral Commission.', put: `Independent National Electoral Commission ${ELECTORAL_ACT}.`, words: ELECTORAL_ACT },
  { act: 1, in: 'Section 178', find: 'sixty days and not later than thirty', put: 'one hundred and fifty days and not later than one hundred and twenty', words: 'one hundred and fifty days and not later than one hundred and twenty' },
  { act: 1, in: 'Section 180', find: /^\(b\) the person last elected to that office took the Oath.*$/m, after: true, quote: ['(2A) In the determination of the four year term', 'spent in office before'] },
  { act: 1, in: 'Section 182', find: /^\(i\) he has been indicted.*$/m, put: `(i) ${DELETED}` },
  { act: 1, in: 'Section 190', all: true, quote: ['190.—(1) Whenever the Governor is proceeding on vacation', 2], strip: /^190\.—/ },
  {
    act: 1,
    in: 'Section 200',
    find: 'as a member of a House of Assembly ;',
    put: 'as a member of a House of Assembly provided that a member of any of the said bodies shall not be required to belong to a political party and, in the case of the State Independent Electoral Commission, he shall not be a member of a political party ;',
    words: 'provided that a member of any of the said bodies shall not be required to belong to a political party and, in the case of the State Independent Electoral Commission, he shall not be a member of a political party',
  },
  { act: 1, in: 'Section 228', find: /^\(a\) for the punishment of any person.*\n\(b\) for the disqualification of any person.*$/m, quote: ['(a) guidelines and rules to ensure internal democracy', 2] },
  { act: 1, in: 'Section 229', find: / ‘‘association’’ means any body of persons.*$/m, put: '' },
  { act: 1, in: 'Section 251', find: /^\(3\) The Federal High Court shall also have.*$/m, after: true, quote: ['(4) The Federal High Court shall have and exercise jurisdiction', 1] },
  { act: 1, in: 'Section 272', find: /^\(2\) The reference to civil and criminal proceedings.*$/m, after: true, quote: ['(3) Subject to the provisions of section 251 and other provisions', 1] },
  { act: 1, in: 'Second Schedule, Part I, item 56', find: '56. Regulation of political parties.', put: '56. Formation and Regulation of political parties.', words: 'Formation and' },
  { act: 1, in: 'Second Schedule, Part I, item 56', title: ['Regulation of political parties', 'Formation and Regulation of political parties'] },
  { act: 1, in: 'Third Schedule, Part I, F', find: /^14\.—\(1\)[\s\S]*?(?=\n15\. )/, quote: ['14 (1) The Independent National Electoral Commission shall comprise', 'not be less than 35 years of age'] },
  { act: 1, in: 'Third Schedule, Part I, F', find: 'including their finances ;', put: 'including their finances, conventions, congresses and party primaries ;', words: 'conventions, congresses and party primaries' },

  { act: 2, in: 'Section 76', find: FIRST_DATES, put: SECOND_DATES, words: SECOND_DATES },
  { act: 2, in: 'Section 116', find: FIRST_DATES, put: SECOND_DATES, words: SECOND_DATES },
  { act: 2, in: 'Section 132', find: FIRST_DATES, put: SECOND_DATES, words: SECOND_DATES },
  { act: 2, in: 'Section 178', find: FIRST_DATES, put: SECOND_DATES, words: SECOND_DATES },
  // The replaced sections take the Act's headings as titles (this print's note for 233 reads
  // "Appeals from the Constitutional Court").
  { act: 2, in: 'Section 233', all: true, quote: ['(1) The Supreme Court shall have jurisdiction, to the exclusion', 'such other cases as may be prescribed'] },
  { act: 2, in: 'Section 233', title: ['Appeals from the Constitutional Court', 'Appellate jurisdiction'], words: 'APPELLATE JURISDICTION' },
  { act: 2, in: 'Section 239', all: true, quote: ['(1) Subject to the provisions of this Constitution, the Court of Appeal shall', 'at least three Justices of the Court of Appeal'] },
  { act: 2, in: 'Section 246', all: true, quote: ['(1) An appeal to the Court of Appeal shall lie as of right from', 'election petitions shall be final'] },
  { act: 2, in: 'Section 285', all: true, quote: ['(1) There shall be established for the each State', 'reasons therefore to a later date'] },
  {
    act: 2,
    in: 'Section 285',
    title: ['Establishment and jurisdiction of election tribunals', 'Establishment of election tribunals and time for determination of election petitions'],
    words: 'ESTABLISHMENT OF ELECTION TRIBUNALS AND TIME FOR DETERMINATION OF ELECTION PETITIONS',
  },
  { act: 2, in: 'Sixth Schedule', all: true, quote: ['SIXTH SCHEDULE A—NATIONAL AND STATE HOUSES OF ASSEMBLY', 8], strip: /^SIXTH SCHEDULE\s*/ },

  { act: 3, in: 'Section 6', find: /^\(c\) the Federal High Court ;$/m, after: true, text: '(cc) the National Industrial Court', words: '(cc) the National Industrial Court' },
  {
    act: 3,
    in: 'Section 84',
    find: 'Judge of the Federal High Court, Chief Judge and Judge',
    put: 'Judge of the Federal High Court, President of the National Industrial Court, Judge of the National Industrial Court, Chief Judge and Judge',
    words: 'President of the National Industrial Court, Judge of the National Industrial Court',
  },
  { act: 3, in: 'Section 240', find: 'appeals from the Federal High Court,', put: `appeals from the Federal High Court, ${NIC},`, words: NIC },
  { act: 3, in: 'Section 243', title: ['from the Federal High Court or', 'from the Federal High Court, National Industrial Court or'], words: 'National Industrial Court' },
  { act: 3, in: 'Section 243', find: /^Any right of appeal/, put: '(1) Any right of appeal' },
  { act: 3, in: 'Section 243', append: true, quote: ['(2) An appeal shall lie from the decision of the National Industrial', 'Court shall be final'] },
  {
    act: 3,
    sections: ['254A—(1) There shall be a National Industrial Court of Nigeria', 'Evidence Act shall apply'],
    after: 'Section 254',
    heading: 'CC—The National Industrial Court of Nigeria',
    // The Act's margin notes.
    titles: {
      '254A': 'Establishment and composition of National Industrial Court',
      '254B': 'Appointment of President and Judges of the National Industrial Court',
      '254C': 'Jurisdiction',
      '254D': 'Powers',
      '254E': 'Constitution of the Court',
      '254F': 'Practice and procedure',
    },
  },
  { act: 3, in: 'Section 287', find: 'The decisions of the Federal High Court,', put: `The decisions of the Federal High Court, ${NIC},`, words: NIC },
  { act: 3, in: 'Section 287', find: 'to that of the Federal High Court,', put: `to that of the Federal High Court, ${NIC},`, words: NIC },
  { act: 3, in: 'Section 289', find: 'a Judge of a Federal High Court or', put: 'a Judge of a Federal High Court or Judge of the National Industrial Court or', words: 'Judge of the National Industrial Court' },
  { act: 3, in: 'Section 292', find: 'the Chief Judge of the Federal High Court,', put: 'the Chief Judge of the Federal High Court, President of the National Industrial Court,', words: 'President of the National Industrial Court' },
  { act: 3, in: 'Section 294', find: 'the Supreme Court or the Court of Appeal shall', put: `the Supreme Court or the Court of Appeal or ${NIC} shall`, words: `or ${NIC}` },
  { act: 3, in: 'Section 295', find: 'the Federal High Court or a High Court)', put: `the Federal High Court or ${NIC} or a High Court)`, words: NIC },
  { act: 3, in: 'Section 295', find: 'refer the question to the Federal High Court or a High Court', put: `refer the question to the Federal High Court or ${NIC} or a High Court`, words: NIC },
  // "Line 7" holds two of these; both take the insertion, as in other consolidations.
  { act: 3, in: 'Section 295', find: 'and the Federal High Court or the High Court shall', put: `and the Federal High Court or ${NIC} or the High Court shall`, words: NIC },
  { act: 3, in: 'Section 295', find: 'as the Federal High Court or the High Court may', put: 'as the Federal High Court or National Industrial Court or the High Court may', words: 'National Industrial Court or' },
  { act: 3, in: 'Section 295', find: 'proceedings in the Federal High Court or a High Court,', put: 'proceedings in the Federal High Court or National Industrial Court or a High Court,', words: 'National Industrial Court or' },
  { act: 3, in: 'Section 316', append: true, quote: ['(5) Notwithstanding the provisions of this section, the National Industrial Court Act', 1] },
  {
    act: 3,
    in: 'Section 318',
    find: 'a Judge of the Federal High Court, the office',
    put: 'a Judge of the Federal High Court, the office of the President or Judge of the National Industrial Court, the office',
    words: 'the office of the President or Judge of the National Industrial Court',
  },
  { act: 3, in: 'Section 318', find: 'the Court of Appeal, the Federal High Court, the High Court of the Federal Capital Territory, Abuja, the Sharia', put: `the Court of Appeal, the Federal High Court, ${NIC}, the High Court of the Federal Capital Territory, Abuja, the Sharia`, words: NIC },
  { act: 3, in: 'Third Schedule, Part I, E', find: /^\(d\) the Chief Judge of the Federal High Court ;$/m, after: true, text: '(dd) the President of the National Industrial Court', words: 'the President of the National Industrial Court' },
  {
    act: 3,
    in: 'Third Schedule, Part I, E',
    find: /^\(vi\) a Judge of the Federal High Court, and$/m,
    after: true,
    text: '(via) the President of the National Industrial Court\n(vib) a Judge of the National Industrial Court, and',
    words: '(vib) a Judge of the National Industrial Court, and',
  },
  { act: 3, in: 'Third Schedule, Part I, E', find: 'the Court of Appeal, the Federal High Court and all other', put: `the Court of Appeal, the Federal High Court, ${NIC} and all other`, words: NIC },
  { act: 3, in: 'Third Schedule, Part I, I', find: /^\(e\) the Chief Judge of the Federal High Court ;$/m, after: true, text: '(ee) The President of the National Industrial Court', words: 'The President of the National Industrial Court' },
  { act: 3, in: 'Third Schedule, Part I, I', find: 'Judges of the Federal High Court,', put: 'Judges of the Federal High Court, the President and Judges of the National Industrial Court,', words: 'the President and Judges of the National Industrial Court' },
  { act: 3, in: 'Seventh Schedule, Judicial Oath', find: 'Judge of the Federal High Court/', put: 'Judge of the Federal High Court/President/Judge of the National Industrial Court/', words: 'President/Judge of the National Industrial Court' },
];

const norm = (s) =>
  s
    .replace(/[“”‘’]{2}|[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+([;:,.])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

// Paragraphs of an Act from the one starting `first` to the one containing `last` (or `last`
// paragraphs in all), without the quotation marks around them.
function quoted(paras, first, last, where) {
  const starts = paras.flatMap((p, i) => (norm(p).replace(/^"\s*/, '').startsWith(first) ? [i] : []));
  const blocks = starts
    .map((i) => {
      const j = typeof last === 'number' ? i + last - 1 : paras.findIndex((p, k) => k >= i && norm(p).includes(last));
      return j >= i && !starts.some((s) => s > i && s <= j) ? paras.slice(i, j + 1) : null;
    })
    .filter(Boolean);
  if (blocks.length !== 1) throw new Error(`${where}: Act text "${first}" … "${last}" found ${blocks.length} times`);
  const out = blocks[0].map((p) => p.trim());
  out[0] = out[0].replace(/^[“"]\s*/, '');
  out[out.length - 1] = out
    .at(-1)
    .replace(/[”"]\s*(?:;\s*(?:and)?|—)?\s*$/, '')
    .replace(/[”"]\.$/, '.');
  return out;
}

function once(text, find, put, where) {
  const n = typeof find === 'string' ? text.split(find).length - 1 : (text.match(new RegExp(find.source, `${find.flags}g`)) || []).length;
  if (n !== 1) throw new Error(`${where}: "${String(find).slice(0, 70)}" found ${n} times`);
  return text.replace(find, typeof put === 'function' ? put : () => put);
}

function alter(articles, acts) {
  const out = articles.map((a) => ({ ...a }));
  const get = (n, where) => out.find((a) => a.article_number === n) ?? fail(`${where}: no ${n}`);
  const fail = (msg) => {
    throw new Error(msg);
  };
  for (const op of ALTERATIONS) {
    const where = `ng ${ACT_NAMES[op.act]} Alteration, ${op.in ?? op.after}`;
    if (op.words && !norm(acts[op.act].join(' ')).includes(norm(op.words))) fail(`${where}: "${op.words}" is not in the Act`);
    const quote = op.quote && quoted(acts[op.act], ...op.quote, where);
    if (quote && op.strip) quote[0] = quote[0].replace(op.strip, '');
    const text = quote ? quote.join('\n') : op.text;
    if (op.sections) {
      let at = out.indexOf(get(op.after, where));
      if (!norm(acts[op.act].join(' ')).includes(norm(op.heading))) fail(`${where}: heading "${op.heading}" is not in the Act`);
      const chapter = `${out[at].chapter.replace(/, [A-Z]{1,2} — [^,]*$/, '')}, ${op.heading.replace(/—/, ' — ')}`;
      for (const p of quoted(acts[op.act], ...op.sections, where)) {
        const m = p.match(/^(\d{1,3}[A-F])—(.*)$/);
        if (m) out.splice(++at, 0, { chapter, article_number: `Section ${m[1]}`, title: op.titles[m[1]] ?? fail(`${where}: no title for ${m[1]}`), content: m[2] });
        else out[at].content += `\n${p}`;
      }
      continue;
    }
    const a = get(op.in, where);
    if (op.title) a.title = once(a.title, op.title[0], op.title[1], where);
    else if (op.all) a.content = text;
    else if (op.append) a.content += `\n${text}`;
    else if (op.after) a.content = once(a.content, op.find, (m) => `${m}\n${text}`, where);
    else a.content = once(a.content, op.find, op.put ?? text, where);
  }
  return out;
}
