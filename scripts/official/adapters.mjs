import {
  fetchHtml,
  fetchJson,
  fetchPdfText,
  fetchWikisource,
  htmlToLines,
  unwrapPdfLines,
  wikisourceSubpages,
} from './text.mjs';

function collector() {
  const articles = [];
  let current = null;
  return {
    articles,
    open(chapter, article_number, title) {
      current = { chapter, article_number, title: title || article_number, lines: [] };
      articles.push(current);
    },
    add(text) {
      if (current) current.lines.push(text);
    },
    get current() {
      return current;
    },
    done() {
      return articles
        .filter((a) => a.lines.length > 0)
        .map(({ lines, ...a }) => ({ ...a, content: lines.join('\n') }));
    },
  };
}

const roman = (s) => s.toUpperCase();

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);

const titleCase = (s) =>
  s !== s.toUpperCase()
    ? s
    : s
        .toLowerCase()
        .replace(/[a-z][a-z'’-]*/g, (w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w[0].toUpperCase() + w.slice(1)));

const US_NOISE = /^(Print This Page|Amendments 11-27|Back to .*Main Page|Passed by Congress|Originally proposed|Note:)/;

function parseUsConstitution(lines) {
  const c = collector();
  let i = lines.findIndex((l) => l.heading === 1 && /Constitution of the United States/i.test(l.text));
  let chapter = null;
  c.open('Preamble', 'Preamble');
  for (i += 1; i < lines.length; i++) {
    const { text, heading } = lines[i];
    if (US_NOISE.test(text)) continue;
    const art = heading && text.match(/^Article\.?\s+([IVX]+)\.?$/i);
    if (art) {
      chapter = `Article ${roman(art[1])}`;
      c.open(chapter, chapter);
      continue;
    }
    const sec = heading && chapter && text.match(/^Section\.?\s*(\d+)\.?$/i);
    if (sec) {
      c.open(chapter, `${chapter}, Section ${sec[1]}`);
      continue;
    }
    if (heading) break;
    c.add(text);
  }
  return c.done();
}

function parseUsBillOfRights(lines) {
  const c = collector();
  let i = lines.findIndex((l) => l.heading && /^The U\.S\. Bill of Rights$/i.test(l.text));
  for (i += 1; i < lines.length; i++) {
    const { text, heading } = lines[i];
    if (/^Note:/.test(text) && c.current) break;
    if (US_NOISE.test(text)) continue;
    const am = heading && text.match(/^Amendment\s+([IVX]+)$/i);
    if (am) {
      c.open('Bill of Rights', `Amendment ${roman(am[1])}`);
      continue;
    }
    if (heading) break;
    c.add(text);
  }
  return c.done();
}

function parseUsAmendments(lines) {
  const c = collector();
  let i = lines.findIndex((l) => l.heading === 1 && /Amendments/i.test(l.text));
  let chapter = null;
  for (i += 1; i < lines.length; i++) {
    const { text, heading } = lines[i];
    const am = heading && text.match(/^Amendment\s+([IVX]+)$/i);
    if (am) {
      chapter = `Amendment ${roman(am[1])}`;
      c.open(chapter, chapter);
      continue;
    }
    const sec = heading && chapter && text.match(/^Section\.?\s*(\d+)\.?$/i);
    if (sec) {
      c.open(chapter, `${chapter}, Section ${sec[1]}`);
      continue;
    }
    if (heading) {
      if (chapter) break;
      continue;
    }
    if (!chapter || US_NOISE.test(text)) continue;
    c.add(text);
  }
  return c.done();
}

async function usArchives(entry) {
  const [constitution, billOfRights, amendments] = await Promise.all(
    entry.pages.map((url) => fetchHtml(url)),
  );
  return {
    revision: null,
    articles: [
      ...parseUsConstitution(htmlToLines(constitution)),
      ...parseUsBillOfRights(htmlToLines(billOfRights)),
      ...parseUsAmendments(htmlToLines(amendments)),
    ],
  };
}

function parseAustralia(lines) {
  const c = collector();
  let i = lines.findIndex((l) => /^An Act to constitute the Commonwealth of Australia$/.test(l.text));
  let chapter = 'Covering clauses';
  let inConstitution = false;
  let last = 0;
  let seenFirst = false;
  let skipping = false;
  c.open('Preamble', 'Preamble');
  for (i += 1; i < lines.length; i++) {
    const { text } = lines[i];
    if (/^Notes to the Commonwealth of Australia Constitution Act$/.test(text)) break;
    if (/^\[\d+\w* \w+ \d{4}\]$/.test(text)) continue;
    if (/^The Constitution$/.test(text) && seenFirst && !inConstitution) {
      inConstitution = true;
      last = 0;
      skipping = true;
      continue;
    }
    if (inConstitution) {
      const ch = text.match(/^(Chapter [IVX]+)—(.+)$/);
      if (ch && lines[i].bold) {
        chapter = `${ch[1]} — ${ch[2]}`;
        skipping = false;
        continue;
      }
      if (skipping) continue;
      if (/^Part [IVX]+—/.test(text) && lines[i].bold) continue;
      if (/^Schedule$/.test(text) && lines[i].bold) {
        chapter = 'Schedule';
        c.open(chapter, 'Schedule', 'Oath and affirmation');
        continue;
      }
    }
    const sec = text.length < 120 && text.match(/^(\d+)([A-Z]?) (\[[^\]]+\]|[A-Z][^:;[]*?[^.:;[ ])((?: \[(?:see Notes? [\d, and]+|Repealed)\])*)$/);
    if (sec && Number(sec[1]) >= last && Number(sec[1]) <= last + 2) {
      last = Number(sec[1]);
      seenFirst = true;
      const num = `${sec[1]}${sec[2]}`;
      const repealed = /Repealed/.test(sec[3] + sec[4]);
      const label = inConstitution ? `Section ${num}` : `Covering clause ${num}`;
      const title = sec[3] === '[Repealed]' ? 'Repealed' : `${sec[3]}${repealed ? ' (repealed)' : ''}`;
      c.open(chapter, label, title);
      if (repealed) c.add('[Repealed]');
      continue;
    }
    c.add(text);
  }
  return c.done();
}

async function auWikisource(entry) {
  const page = await fetchWikisource(entry.pages[0]);
  return { revision: page.url, articles: parseAustralia(htmlToLines(page.html)) };
}

function parseKenyaPage(name, lines) {
  const c = collector();
  if (name === 'Preamble') {
    c.open('Preamble', 'Preamble');
    for (const { text } of lines) if (!/^PREAMBLE$/.test(text)) c.add(text);
    return c.done();
  }
  const schedule = /Schedule$/.test(name);
  let chapter = name;
  let titled = false;
  let pendingTitle = null;
  for (const { text, bold } of lines) {
    if (bold && /^(CHAPTER [A-Z -]+|[A-Z]+ SCHEDULE)$/.test(text)) continue;
    if (bold && !titled) {
      chapter = `${name} — ${titleCase(text)}`;
      titled = true;
      if (schedule) c.open(chapter, name, titleCase(text));
      continue;
    }
    if (bold && /^Part \d+—/.test(text)) continue;
    const num = bold && text.match(/^(\d+[A-Z]?)\.$/);
    if (num) {
      const label = schedule ? `${name}, section ${num[1]}` : `Article ${num[1]}`;
      c.open(chapter, label, pendingTitle || label);
      pendingTitle = null;
      continue;
    }
    if (bold) {
      if (pendingTitle) c.add(pendingTitle);
      pendingTitle = text;
      continue;
    }
    if (pendingTitle) {
      c.add(pendingTitle);
      pendingTitle = null;
    }
    c.add(text);
  }
  if (pendingTitle) c.add(pendingTitle);
  return c.done();
}

async function keWikisource(entry) {
  const { root, titles } = await wikisourceSubpages(entry.pages[0]);
  const articles = [];
  for (const title of titles) {
    const page = await fetchWikisource(title);
    articles.push(...parseKenyaPage(title.slice(root.title.length + 1), htmlToLines(page.html)));
  }
  return { revision: root.url, articles };
}

// Editorial notes ("[Sub-s. (3) substituted by ...]") are kept apart from the text and only
// survive as the content of a provision that has nothing else, e.g. a repealed schedule.
const NOTE_MARK = '\u0000';
const EDITORIAL_NOTE = /^\[(?=.*\b(amended|inserted|substituted|repealed|added|deleted|renumbered|Note|commencement)\b).*\]$/i;

function dropEditorialNotes(articles) {
  for (const a of articles) {
    const text = a.lines.filter((l) => !l.startsWith(NOTE_MARK));
    a.lines = text.length > 0 ? text : a.lines.map((l) => l.slice(NOTE_MARK.length));
  }
}

const indentOf = (line) => line.length - line.trimStart().length;

const isLaterNumber = (num, last, maxJump = 1) => {
  const n = parseInt(num, 10);
  return (n > last.n && n <= last.n + maxJump) || (n === last.n && /[A-Z]$/.test(num) && num !== last.num);
};

// <td> cells become separate lines in htmlToLines, so flatten each row to "a | b | c" first.
const flattenTables = (html) =>
  html.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    );
    return `<p>${cells.join(' | ')}</p>`;
  });

function parseZaPage(html) {
  const lines = htmlToLines(flattenTables(html));
  const [name, sub] = lines.filter((l) => l.heading === 1).map((l) => l.text);
  const body = lines.slice(
    lines.findIndex((l) => l.text === 'Translations') + 1,
    lines.findIndex((l) => /^Text as at/.test(l.text)),
  );
  const c = collector();
  if (name === 'Preamble') {
    c.open('Preamble', 'Preamble');
    for (const { text, bold } of body) if (!bold) c.add(text);
    return c.articles;
  }
  const chapter = `${sub.match(/^Chapter \d+/)[0]} — ${name}`;
  const last = { n: parseInt(sub.match(/Section (\d+)/)[1], 10) - 1, num: null };
  let pendingTitle = null;
  let pendingNotes = [];
  for (const { text, bold } of body) {
    if (bold) {
      if (pendingTitle) c.add(pendingTitle);
      pendingTitle = text;
      continue;
    }
    if (EDITORIAL_NOTE.test(text)) {
      if (pendingTitle) pendingNotes.push(NOTE_MARK + text);
      else c.add(NOTE_MARK + text);
      continue;
    }
    const sec = text.match(/^(\d+[A-Z]?)\.\s+(.*)$/);
    if (sec && isLaterNumber(sec[1], last)) {
      Object.assign(last, { n: parseInt(sec[1], 10), num: sec[1] });
      c.open(chapter, `Section ${sec[1]}`, pendingTitle);
      pendingNotes.forEach((n) => c.add(n));
      pendingTitle = null;
      pendingNotes = [];
      c.add(sec[2]);
      continue;
    }
    if (pendingTitle) c.add(pendingTitle);
    pendingTitle = null;
    c.add(text);
  }
  return c.articles;
}

const ZA_BLOCKS = ['1', '1A', '2', '3', '4', '5', '6', 'A', 'B', 'C', 'D', '6A', '6B', '7'];

// Pages of the schedules PDF, minus the running header ("Schedule 4: Functional Areas of
// Concurrent National and" + its wrapped second line), the page number and blank lines.
function zaPdfLines(text) {
  const out = [];
  for (const page of text.split('\f')) {
    const lines = page.split('\n').filter((l) => l.trim());
    if (lines.length && /^\s*\d{1,3}\s*$/.test(lines[lines.length - 1])) lines.pop();
    if (lines.length && /^\s*(Schedule \d+[AB]?\b|Annexure [A-D]\b)/.test(lines[0])) {
      const header = lines.shift().trim();
      if (/\b(and|of|the|for|to)$/.test(header)) lines.shift();
    }
    out.push(...lines);
  }
  return out;
}

// Two items (Schedule 3 item 9 "Rules", Schedule 6 item 16 "Courts") are laid out with the
// heading and the subitem numbers in a left margin, so pdftotext prints "Rules   The Chief
// Justice…" / "9. (1)   (a) the procedure…" and drops "(2)" a few lines too early. Rebuild
// them as heading line + item line, and put each stray "(N)" in front of the first paragraph
// that follows a full stop and is not part of the current (a), (b)… list.
function zaMarginItems(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(\S.{0,20}?\S) {3,}(\S.*)$/);
    const num = head && lines[i + 1]?.match(/^(\d+[A-Z]?\.(?: \(\d+\))?) {2,}(\S.*)$/);
    if (!num) {
      out.push(lines[i]);
      continue;
    }
    const col = lines[i].length - head[2].length;
    out.push(head[1], `${num[1]} ${head[2]}`, `${' '.repeat(col)}${num[2]}`);
    const stray = [];
    let prev = num[2];
    for (i += 2; i < lines.length; i++) {
      const marker = lines[i].match(/^\s{0,10}(\(\d+\))(?:\s{2,}(\S.*))?$/);
      if (/^\s*Part [A-Z]\s*$/.test(lines[i]) || (!marker && indentOf(lines[i]) < col)) break;
      if (marker) stray.push(marker[1]);
      const text = marker ? marker[2] : lines[i].trim();
      if (!text) continue;
      if (stray.length && /\.$/.test(prev) && (/^\(a\)/.test(text) || !/^\(/.test(text))) {
        out.push(`${stray.shift()} ${text}`);
      } else {
        out.push(marker ? `${' '.repeat(col)}${text}` : lines[i]);
      }
      prev = text;
    }
    if (stray.length) throw new Error(`za schedules: unplaced margin numbers ${stray.join(' ')} after "${head[1]}"`);
    i--;
  }
  return out;
}

// Item headings sit at the left margin with no closing punctuation; long ones wrap onto
// lines ending in a comma ("…of the National Assembly," / "permanent delegates…").
const isZaHeadingLine = (line) =>
  indentOf(line) <= 1 && !/\S {3,}\S/.test(line) && !/[.;:—–-]$/.test(line.trim()) && !/^[•(“"[\d]/.test(line.trim());

const isTitleCase = (text) => text.split(/\s+/).every((w) => w.length <= 3 || /^[[(]?[A-Z]/.test(w));

// Schedule 7 is a two-column table whose columns pdftotext prints out of step, so read the
// "Act No. …" column and the title column separately and pair them in order.
function zaRepealedLaws(lines) {
  const col = lines.find((l) => /^NUMBER AND\s+TITLE/.test(l)).indexOf('TITLE');
  const acts = [];
  const titles = [];
  for (const line of lines) {
    if (/^(NUMBER AND|YEAR OF LAW)/.test(line)) continue;
    const left = line.slice(0, col).trim();
    const right = line.slice(col).trim();
    if (left) acts.push(left);
    if (!right) continue;
    if (titles.length && !/\d{4}$/.test(titles[titles.length - 1])) titles[titles.length - 1] += ` ${right}`;
    else titles.push(right);
  }
  if (acts.length !== titles.length) {
    throw new Error(`za Schedule 7: ${acts.length} act numbers but ${titles.length} titles`);
  }
  return acts.map((act, i) => `${act} — ${titles[i]}`);
}

function parseZaSchedules(text) {
  const lines = zaMarginItems(zaPdfLines(text));
  const c = collector();
  let block = null;
  let part = null;
  let opened = false;
  let pendingNotes = [];
  let segment = [];
  let next = 0;
  const last = { n: 0, num: null };

  const scopeLabel = () => (part ? `${block.label}, Part ${part.letter}` : block.label);
  const openScope = (label, title) => {
    c.open(block.chapter, label, title);
    pendingNotes.forEach((n) => c.add(n));
    pendingNotes = [];
    opened = true;
  };
  const flush = () => {
    if (!segment.length) return;
    const paragraphs =
      block.name === '7'
        ? zaRepealedLaws(segment)
        : block.name === '1A'
          ? segment.map((l) => l.trim().replace(/\s+/g, ' '))
          : unwrapPdfLines(segment);
    if (!opened) openScope(scopeLabel(), part ? part.title || `${block.title}, Part ${part.letter}` : block.title);
    paragraphs.forEach((p) => c.add(p));
    segment = [];
  };
  const endBlock = () => {
    flush();
    if (block && pendingNotes.length) openScope(scopeLabel(), block.title);
  };
  const titleLines = (i, ok) => {
    const parts = [];
    while (i < lines.length && parts.length < 3 && ok(lines[i], parts.length)) parts.push(lines[i++].trim());
    return { title: parts.join(' '), i };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = line.match(/^\s{10,}(?:SCHEDULE|Schedule|ANNEXURE) (\d+[AB]?|[A-D])\s*$/);
    if (start && start[1] === ZA_BLOCKS[next]) {
      endBlock();
      next++;
      const name = start[1];
      const label = /^[A-D]$/.test(name) ? `Schedule 6, Annexure ${name}` : `Schedule ${name}`;
      const t = titleLines(i + 1, (l) => indentOf(l) >= 3 && !/^\s*(\[|Part [A-Z]\s*$)/.test(l));
      const title = titleCase(t.title) || null;
      block = { name, label, title, chapter: title ? `${label} — ${title}` : label };
      part = null;
      opened = false;
      Object.assign(last, { n: 0, num: null });
      i = t.i - 1;
      continue;
    }
    if (!block) continue;

    if (line.trim().startsWith('[')) {
      flush();
      let note = line.trim();
      while (!note.endsWith(']') && i + 1 < lines.length) {
        const more = lines[++i].trim();
        note = /[a-z]-$/.test(note) && /^[a-z]/.test(more) ? note.slice(0, -1) + more : `${note} ${more}`;
      }
      if (!EDITORIAL_NOTE.test(note)) segment.push(note);
      else if (opened) c.add(NOTE_MARK + note);
      else pendingNotes.push(NOTE_MARK + note);
      continue;
    }

    const partStart = line.match(/^\s*Part ([A-Z])\s*$/);
    if (partStart) {
      flush();
      const t = titleLines(i + 1, (l, n) =>
        n === 0
          ? !/[.;:,—–-]$/.test(l.trim()) &&
            isTitleCase(l.trim()) &&
            !/^[•(“"[\d]/.test(l.trim()) &&
            !(isZaHeadingLine(l) && /^\s?\d+[A-Z]?\.\s/.test(lines[i + 2] || ''))
          : indentOf(l) >= 5,
      );
      part = { letter: partStart[1], title: t.title || null };
      opened = false;
      Object.assign(last, { n: 0, num: null });
      i = t.i - 1;
      continue;
    }

    if (isZaHeadingLine(line) && /^[A-Z]/.test(line.trim())) {
      const t = titleLines(i, (l) => isZaHeadingLine(l));
      const item = lines[t.i]?.match(/^\s?(\d+[A-Z]?)\.\s/);
      if (item && isLaterNumber(item[1], last)) {
        flush();
        Object.assign(last, { n: parseInt(item[1], 10), num: item[1] });
        openScope(`${scopeLabel()}, item ${item[1]}`, t.title);
        segment.push(lines[t.i].replace(/^\s?\d+[A-Z]?\.\s+/, ''));
        i = t.i;
        continue;
      }
    }
    segment.push(line);
  }
  endBlock();
  if (next !== ZA_BLOCKS.length) throw new Error(`za schedules: stopped before Schedule ${ZA_BLOCKS[next]}`);
  return c.articles;
}

async function zaJustice(entry) {
  const pdf = entry.pages.find((url) => url.endsWith('.pdf'));
  const articles = [];
  for (const url of entry.pages.filter((u) => u !== pdf)) articles.push(...parseZaPage(await fetchHtml(url)));
  articles.push(...parseZaSchedules(await fetchPdfText(pdf)));
  dropEditorialNotes(articles);
  return {
    revision: null,
    articles: articles
      .filter((a) => a.lines.length > 0)
      .map(({ lines, ...a }) => ({ ...a, content: lines.join('\n') })),
  };
}

// Footnotes start at the left margin with their number ("1. Subs. by…", "1 Subs.", "* Cl.
// (4) shall stand substituted…"), while numbered provisions in the text are indented. The
// footnotes begin at the first such line that uses amendment wording and after which the
// footnote numbers only go up.
const IN_FOOTNOTE_START = /^\s{0,2}(\d{1,3}\.\s?\S|\d{1,3}\s+[A-Z]|\*)/;
const IN_FOOTNOTE_WORDS =
  /\b(Subs|Ins|Omitted|omitted|Rep|w\.e\.f|Amendment|notified|ibid|added|ins|subs|renumbered|deleted|substituted|inserted|vide|See)\b/;

function inFootnoteStart(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (indentOf(lines[i]) > 2 || !IN_FOOTNOTE_START.test(lines[i]) || /^.{0,30}\S {3,}\S/.test(lines[i])) continue;
    if (!IN_FOOTNOTE_WORDS.test(lines.slice(i, i + 4).join(' '))) continue;
    const nums = lines
      .slice(i)
      .filter((l) => indentOf(l) <= 2 && /^\s{0,2}\d{1,3}\.?\s+[A-Z“"*]/.test(l))
      .map((l) => parseInt(l, 10));
    if (nums.every((n, k) => k === 0 || n > nums[k - 1])) return i;
  }
  return lines.length;
}

// Amendment markers: the superscript footnote number before "[" or "***" ("1[(2) The
// States", "2***", "**1[370."), before a clause letter that opens a paragraph ("8(f) * * *"),
// and asterisk footnote references after a word ("Governor* of").
const stripInMarkers = (line) =>
  line
    .replace(/\*+(?=\d{1,2}\[)/g, '')
    .replace(/(?<=[A-Za-z\])])\*+(?=[\s,.;:)]|$)/g, '')
    .replace(/(^|[\s(“"'—[])\d{1,2}(?=\[|\*)/g, '$1')
    .replace(/^(\s{4,})\d{1,2}(?=\([a-z]{1,4}\))/, '$1');

// Body lines from the Preamble to Appendix I, without running headers, page numbers and
// footnotes, re-indented against each page's own left margin.
function inBodyLines(text) {
  const from = [...text.matchAll(/^\s*PREAMBLE\s*$/gm)][1];
  if (!from) throw new Error('in: second PREAMBLE heading not found');
  const to = text.slice(from.index).search(/^\s*APPENDIX I\s*$/m);
  if (to < 0) throw new Error('in: APPENDIX I not found');
  const out = [];
  for (const page of text.slice(from.index, from.index + to).split('\f')) {
    // U+F02A is the Symbol-font asterisk used for footnote marks.
    const lines = page.split('\n').filter((l) => l.trim()).map((l) => l.replace(//g, '*'));
    if (lines.length && /^\s*\d{1,3}\s*$/.test(lines[lines.length - 1])) lines.pop();
    if (lines.length && /^\s*(\d{1,3}\s+)?THE CONSTITUTION OF INDIA\s*$/.test(lines[0])) {
      lines.shift();
      if (lines.length && /^\s*\((Part|.*Schedule|Appendix)[^)]*\)\s*$/.test(lines[0])) lines.shift();
    }
    const cut = inFootnoteStart(lines);
    const body = lines.slice(0, cut);
    // A full stop that ends the page's text is sometimes printed below the footnotes.
    const stray = lines.slice(cut).filter((l) => /^\s*[.,;:]\s*$/.test(l));
    if (body.length && stray.length) body[body.length - 1] += stray.map((l) => l.trim()).join('');
    const margin = Math.min(...body.map(indentOf));
    out.push(...body.map((l) => l.slice(margin)), '\f');
  }
  return out;
}

// The First Schedule is a Name | Territories table whose cells pdftotext interleaves
// ("…section 3 of Pradesh the Andhra State Act…"). Read the columns apart and pair the
// "N. Name" entries with the territory descriptions (each starts "The territor…") in
// order. The territories column moves from row to row, so a line that starts with a name
// is split before "The territor…" or else at its first run of spaces; lines are split
// before the amendment markers are stripped, which would shift the columns.
function splitFirstScheduleLine(line) {
  if (indentOf(line) >= 8) return ['', line.trim()];
  const text = line.trim();
  const the = text.search(/(\d{1,2}\[)?The territor/);
  if (the > 0) return [text.slice(0, the).trim(), text.slice(the)];
  const gap = text.match(/^(.*?\S) {2,}(\S.*)$/);
  if (gap) return [gap[1], gap[2]];
  // "and Nicobar commencement of this…": names are capitalised words joined by "and".
  const word = text.match(/^(.*?\S) ((?!and\b|of\b)[a-z].*)$/);
  return word ? [word[1], word[2]] : [text, ''];
}

const IN_DELETED_ROW = /^\[*\*/;

function inFirstSchedule(lines) {
  const out = [];
  let names = [];
  let territories = '';
  const finish = () => {
    if (!names.length && !territories) return;
    // Deleted rows ("[* * * * *]") have stars in both columns and no territory.
    const terr = territories
      .replace(/(\s\*)+\s*\]/g, '')
      .replace(/(\s+\*)+(?=\s+\[?The territor|\s*$)/g, '')
      .trim()
      .split(/\s(?=\[?The territor)/)
      .map((t) => t.trim());
    const rows = names.filter((n) => !IN_DELETED_ROW.test(n));
    if (rows.length === terr.length) {
      let k = 0;
      for (const n of names) out.push(IN_DELETED_ROW.test(n) ? '* * * * *' : `${unbracket(n)}: ${terr[k++]}`);
    } else {
      console.log(`\n  in First Schedule: ${rows.length} names but ${terr.length} territory entries, kept as two lists`);
      out.push(...names, ...terr);
    }
    names = [];
    territories = '';
  };
  for (const line of lines) {
    const text = stripInMarkers(line.trim()).replace(/^Name\s+/, '');
    if (line === '\f' || /^(Name|Territories|Extent)$/.test(text)) continue;
    if (/^\[Articles 1 and 4\]$|^I{1,2}\. THE (STATES|UNION TERRITORIES)$/.test(text)) {
      finish();
      out.push(text);
      continue;
    }
    const [left, right] = splitFirstScheduleLine(line).map((cell) => stripInMarkers(cell).trim());
    if (left) {
      if (/^\[*(\d+\.\]?|\*)/.test(left) || !names.length) names.push(left);
      else names[names.length - 1] += ` ${left}`;
    }
    if (right) territories += /-$/.test(territories) ? right : ` ${right}`;
  }
  finish();
  return out.map((text) => ({ text: text.replace(/ {2,}/g, ' '), heading: false }));
}

const isInHeading = (line) => {
  const text = line.trim();
  if (indentOf(line) < 10 || !/^\[?[A-Z]/.test(text) || text.length > 80) return false;
  const caps = text === text.toUpperCase();
  return caps
    ? !/[;:]$/.test(text) && (!/\.$/.test(text) || /ETC\.$/.test(text))
    : !/[.;:,]$/.test(text) && !/[;*]/.test(text) && isTitleCase(text);
};

// Oaths print "solemnly affirm" on the line under "swear in the name of God", so unwrapping
// drops it a few words later ("…God that I will bear true faith solemnly affirm and…").
const fixInOath = (text) =>
  text.replace(
    /swear in the name of God\s*(.*?)\s*solemnly affirm\s*/g,
    (_, between) => `swear in the name of God/solemnly affirm ${between}${between ? ' ' : ''}`,
  );

// Centred headings become their own paragraphs; everything else is unwrapped.
function inParagraphs(lines) {
  const out = [];
  let segment = [];
  const flush = () => {
    out.push(
      ...unwrapPdfLines(segment, { firstLineIndent: true }).map((text) => ({ text: fixInOath(text), heading: false })),
    );
    segment = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '\f') continue;
    const line = stripInMarkers(lines[i]);
    if (isInHeading(line) && !/\S {3,}\S/.test(line.trim())) {
      flush();
      out.push({ text: line.trim(), heading: true });
      if (/^\[?FIRST SCHEDULE$/.test(line.trim())) {
        const end = lines.findIndex((l, k) => k > i && /^\s*(\d{1,2}\[)?\[?SECOND SCHEDULE\s*$/.test(l));
        out.push(...inFirstSchedule(lines.slice(i + 1, end)));
        i = end - 1;
      }
    } else segment.push(line);
  }
  flush();
  return out;
}

// Part titles are capitals under "PART N", sometimes indented too little to count as centred.
const isInPartTitle = (text) =>
  Boolean(text) &&
  text.length <= 90 &&
  /[A-Z]{3}/.test(text) &&
  text === text.toUpperCase() &&
  !/^\[?(CHAPTER|PART) /.test(text) &&
  !/^[[*-]?\d/.test(text);

const IN_SCHEDULES = {
  FIRST: 'The States and the Union Territories',
  SECOND: null,
  THIRD: 'Forms of Oaths or Affirmations',
  FOURTH: 'Allocation of Seats in the Council of States',
  FIFTH: 'Provisions as to the Administration and Control of Scheduled Areas and Scheduled Tribes',
  SIXTH: 'Provisions as to the Administration of Tribal Areas in the States of Assam, Meghalaya, Tripura and Mizoram',
  SEVENTH: null,
  EIGHTH: 'Languages',
  NINTH: null,
  TENTH: 'Provisions as to Disqualification on Ground of Defection',
  ELEVENTH: null,
  TWELFTH: null,
};
const IN_PARAGRAPH_SCHEDULES = new Set(['FIFTH', 'SIXTH', 'TENTH']);
const IN_LISTS = { I: 'Union List', II: 'State List', III: 'Concurrent List' };

const unbracket = (s) => s.replace(/[[\]]/g, '').trim();

// Accept "N." only as the next number in sequence, allowing one number to be missing
// (Article 238 went with Part VII; Tenth Schedule paragraph 3 is printed as "* * *").
// A footnote marker glued to the number ("731D." for 31D, "21." for 1) is dropped.
function nextNumber(raw, last) {
  for (const num of [raw, raw.slice(1), raw.slice(2)]) {
    if (/^[1-9]\d*[A-Z]*$/.test(num) && isLaterNumber(num, last, 2)) return num;
  }
  return null;
}

// "[2A. [Sikkim…].—Omitted…", "*7. Bar of…", "[18.* * *]"; the title runs to the first ".—".
const IN_NUMBERED = /^[[*-]?(\d{1,4}[A-Z]{0,3})\.(?:\s+|(?=\*))([\s\S]*)$/;

function splitInTitle(rest) {
  const split = rest.match(/^(\[[^\]]*\]|[^—]*?)\.?\s*—\s*([\s\S]*)$/);
  if (!split) return { title: null, content: rest };
  let title = unbracket(split[1]).replace(/\.$/, '');
  if (/\betc$/.test(title)) title += '.';
  return { title: title || null, content: split[2] };
}

function parseIndia(paragraphs) {
  const c = collector();
  const dropped = [];
  const last = { n: 0, num: null };
  let part = null;
  let chapter = null;
  let schedule = null;
  let open = false;
  let pending = [];

  const heading = () => (part && chapter ? `${part}, ${chapter}` : part || 'Preamble');
  const startScope = (label, title) => {
    c.open(schedule ? schedule.chapter : heading(), label, title);
    pending.forEach((p) => c.add(p));
    pending = [];
    open = true;
  };

  for (let i = 0; i < paragraphs.length; i++) {
    const { text, heading: isHeading } = paragraphs[i];
    const nextText = () => paragraphs[i + 1]?.heading && paragraphs[i + 1].text;
    // A centred subheading ("Right to Equality") is left out only when a heading or the next
    // numbered provision follows it; otherwise it is an indented line of text and is kept.
    const beforeStructure = () => {
      const next = paragraphs[i + 1];
      const m = next && next.text.match(IN_NUMBERED);
      return !next || next.heading || Boolean(m && nextNumber(m[1], last));
    };

    if (!part && !schedule && text === 'PREAMBLE') {
      c.open('Preamble', 'Preamble');
      open = true;
      continue;
    }

    const sched = text.match(/^\[?(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ELEVENTH|TWELFTH) SCHEDULE\]?$/);
    if (isHeading && sched) {
      const name = sched[1];
      const label = `${titleCase(name)} Schedule`;
      const title = IN_SCHEDULES[name];
      schedule = { name, label, title, chapter: title ? `${label} — ${title}` : label };
      Object.assign(last, { n: 0, num: null });
      open = false;
      pending = [];
      if (!IN_PARAGRAPH_SCHEDULES.has(name) && name !== 'SEVENTH') startScope(label, title);
      continue;
    }

    if (!schedule) {
      const partHead = isHeading && text.match(/^\[?PART ([IVXL]+[A-C]?)\]?$/);
      if (partHead) {
        const titles = [];
        while (isInPartTitle(paragraphs[i + 1]?.text)) titles.push(paragraphs[++i].text);
        part = `Part ${partHead[1]}${titles.length ? ` — ${titleCase(unbracket(titles.join(' ')))}` : ''}`;
        chapter = null;
        open = false;
        continue;
      }
      const chap = isHeading && text.match(/^\[?CHAPTER ([IVXL]+[A-C]?)\.?\s*—\s*(.*)$/);
      if (chap) {
        let title = chap[2];
        while (/,$/.test(title) && nextText()) title += ` ${paragraphs[++i].text}`;
        chapter = `Chapter ${chap[1]}: ${titleCase(unbracket(title))}`;
        open = false;
        continue;
      }
      const art = text.match(IN_NUMBERED);
      const num = art && part && nextNumber(art[1], last);
      if (num) {
        Object.assign(last, { n: parseInt(num, 10), num });
        const { title, content } = splitInTitle(art[2]);
        c.open(heading(), `Article ${num}`, title);
        open = true;
        c.add(content);
        continue;
      }
      // "[Saving of Certain Laws]" is a subheading indented like a paragraph.
      const subheading =
        isHeading || (/^\[[A-Z][^\]]{2,80}\]$/.test(text) && /[a-z]{3}/.test(text) && isTitleCase(unbracket(text)));
      if ((subheading && beforeStructure()) || !open) {
        dropped.push(`${part || 'before Part I'}: ${text}`);
        continue;
      }
      c.add(text);
      continue;
    }

    if (schedule.name === 'SEVENTH') {
      const list = text.match(/^List (I{1,3})\s*—\s*(.*)$/);
      if (list) {
        startScope(`Seventh Schedule, List ${list[1]}`, IN_LISTS[list[1]]);
        continue;
      }
    }
    if (IN_PARAGRAPH_SCHEDULES.has(schedule.name)) {
      const para = text.match(IN_NUMBERED);
      const num = para && nextNumber(para[1], last);
      if (num) {
        Object.assign(last, { n: parseInt(num, 10), num });
        const { title, content } = splitInTitle(para[2]);
        startScope(`${schedule.label}, paragraph ${num}`, title);
        c.add(content);
        continue;
      }
      if ((isHeading && beforeStructure()) || !open) {
        dropped.push(`${schedule.label}: ${text}`);
        continue;
      }
    }
    if (!open) {
      dropped.push(`${schedule.label}: ${text}`);
      continue;
    }
    c.add(text);
  }
  // An omitted provision keeps the "]" that closed its amendment bracket before the number.
  const articles = c.done().map((a) => {
    const open = (a.content.match(/\[/g) || []).length;
    const close = (a.content.match(/\]/g) || []).length;
    return close > open && a.content.endsWith(']') ? { ...a, content: a.content.slice(0, -1) } : a;
  });
  return { articles, dropped };
}

async function inLegislative(entry) {
  const page = await fetchJson(entry.pages[0]);
  const url = page.posts?.acf_data?.pdf?.url;
  if (!url) throw new Error('in: no PDF url in posts.acf_data.pdf');
  const { articles, dropped } = parseIndia(inParagraphs(inBodyLines(await fetchPdfText(url))));
  if (dropped.length) {
    console.log(`\n  in: ${dropped.length} headings/lines left out (check they are not text):`);
    for (const d of dropped) console.log(`    ${d.slice(0, 120)}`);
  }
  return { revision: url, articles };
}

// The OSP copy is Oceana's consolidation to the 1996 Amendment Act: every amended passage is
// wrapped as N[“...”] with endnote N. Only the markers go; the amended text stays.
function stripGhAmendmentMarks(text, expected) {
  let out = text;
  for (let n = 1; n <= expected; n++) {
    const open = out.search(new RegExp(`(?<!\\d)${n}\\[`));
    if (open < 0) throw new Error(`gh: amendment marker ${n}[ not found`);
    let depth = 0;
    let close = -1;
    for (let i = open + String(n).length; i < out.length; i++) {
      if (out[i] === '[') depth++;
      else if (out[i] === ']' && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) throw new Error(`gh: amendment marker ${n}[ is never closed`);
    const inner = out
      .slice(open + String(n).length + 1, close)
      .replace(/^“/, '')
      .replace(/”(\.?)$/, '$1');
    out = out.slice(0, open) + inner + out.slice(close + 1);
  }
  if (/(?<![\d(])\d{1,2}\[/.test(out)) throw new Error('gh: amendment marker left after stripping');
  return out;
}

// Paragraphs are separated by blank lines; a page break inside a sentence joins the halves.
function ghParagraphs(text) {
  const out = [];
  let block = [];
  const flush = () => {
    if (block.length) out.push(block.join(' '));
    block = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\f/g, '').trim();
    if (!line) {
      flush();
      continue;
    }
    // pdftotext puts the form feed on the first line of the next page, often with no blank
    // line before it.
    const pageBreak = raw.includes('\f');
    const starts = STARTS_GH_BLOCK.test(line);
    const heading = GH_HEADING.test(line) || GH_ARTICLE_LINE.test(line);
    const item = starts && /([.;:—,]|\b(and|or))$/.test(block.at(-1) ?? '');
    if (heading || item) flush();
    const continues = pageBreak && !block.length && out.length && !/[.;:—”]$/.test(out.at(-1));
    if (continues && !starts) block = [out.pop()];
    block.push(line);
  }
  flush();
  return out;
}

// Checked against the enacted text of Act 527 (1996): Oceana's 11 integrated passages match it
// except article 199(4), where s. 6 of the Act says "sixty years", not "sixty-five".
const GH_CORRECTIONS = [
  [/after\s+attaining\s+the\s+age\s+of\s+sixty-five\s+years\s+may,\s+where\s+the\s+exigencies/, 'after attaining the age of sixty years may, where the exigencies'],
];

const GH_HEADING = /^(CHAPTER [A-Z-]+|(FIRST|SECOND) SCHEDULE)$/;

const GH_ARTICLE_LINE = /^\d{1,3}\.\s+“?[A-Z][A-Z,.'’ -]{3,}/;

// "40. INTERNATIONAL RELATIONS. In its dealings ..." — the heading can share its line with text.
const GH_ARTICLE = /^(\d{1,3})\.\s+“?([A-Z][A-Z0-9 ,.'’()&/-]*?[A-Z)])\.{0,2}(?:\s+(?=[A-Z][a-z]|[(“])(.*))?$/;

const STARTS_GH_BLOCK = /^(\(\w{1,5}\)|\d{1,3}[A-Z]?\.\s|CHAPTER |PART [IVX]+$|[A-Z]+ SCHEDULE$)/;

function parseGhana(text) {
  const start = text.search(/^IN THE NAME OF THE ALMIGHTY GOD$/m);
  const end = text.search(/^Made this \d+\w* day of May, 1992\.$/m);
  if (start < 0 || end < 0) throw new Error('gh: preamble or closing "Made this ..." line not found');
  let body = stripGhAmendmentMarks(text.slice(start, end), 11);
  for (const [wrong, right] of GH_CORRECTIONS) {
    if (!wrong.test(body)) throw new Error(`gh: correction no longer applies, recheck: ${wrong}`);
    body = body.replace(wrong, right);
  }
  const chapterOne = body.search(/^CHAPTER ONE$/m);
  const c = collector();
  const dropped = [];
  let chapter = 'Preamble';
  let schedule = null;
  let last = 0;
  // Preamble lines are one recital each; a line only wraps when it has no closing punctuation.
  c.open('Preamble', 'Preamble');
  let prev = '';
  for (const line of body.slice(0, chapterOne).split('\n').map((l) => l.trim()).filter(Boolean)) {
    const wraps = prev && !/[.;:,]$/.test(prev) && (prev !== prev.toUpperCase() || line === line.toUpperCase());
    if (wraps) c.current.lines.push(`${c.current.lines.pop()} ${line}`);
    else c.add(line);
    prev = line;
  }
  const paragraphs = ghParagraphs(body.slice(chapterOne));
  for (const [i, p] of paragraphs.entries()) {
    const chap = p.match(/^CHAPTER ([A-Z-]+) (.+)$/);
    if (chap && !schedule) {
      chapter = `Chapter ${titleCase(chap[1])} — ${titleCase(chap[2])}`;
      continue;
    }
    const sched = p.match(/^(FIRST|SECOND) SCHEDULE (.+)$/);
    if (sched) {
      const name = `${titleCase(sched[1])} Schedule`;
      const title = titleCase(sched[2]);
      schedule = name;
      chapter = `${name} — ${title}`;
      last = 0;
      if (name === 'Second Schedule') c.open(chapter, name, title);
      continue;
    }
    if (schedule === 'First Schedule' && /^PART [IVX]+ /.test(p)) continue;
    if (schedule === 'Second Schedule') {
      if (/^THE [A-Z -]*OATH[A-Z -]*$/.test(p)) {
        c.add(titleCase(p));
        continue;
      }
      c.add(p);
      continue;
    }
    const head = p.match(GH_ARTICLE);
    if (head && Number(head[1]) === last + 1) {
      last = Number(head[1]);
      const label = schedule ? `${schedule}, section ${head[1]}` : `Article ${head[1]}`;
      c.open(chapter, label, titleCase(head[2].replace(/ETC$/, 'ETC.')));
      if (head[3]) c.add(head[3]);
      continue;
    }
    // Centred group headings ("The Audit Service") sit just above an article heading.
    const subheading = !/[.;:—,]$/.test(p) && p.length < 80 && GH_ARTICLE.test(paragraphs[i + 1] ?? '');
    if (subheading || (p === p.toUpperCase() && /[A-Z]{3}/.test(p) && !/[.;:]$/.test(p) && !/^\(/.test(p))) {
      dropped.push(p);
      continue;
    }
    c.add(p);
  }
  return { articles: c.done(), dropped };
}

async function ghOsp(entry) {
  const { articles, dropped } = parseGhana(await fetchPdfText(entry.pages[0]));
  if (dropped.length) {
    console.log(`\n  gh: ${dropped.length} headings left out (check they are not text):`);
    for (const d of dropped) console.log(`    ${d.slice(0, 120)}`);
  }
  return { revision: entry.pages[0], articles };
}

export const ADAPTERS = {
  'us-archives': usArchives,
  'au-wikisource': auWikisource,
  'ke-wikisource': keWikisource,
  'za-justice': zaJustice,
  'in-legislative': inLegislative,
  'gh-osp': ghOsp,
};
