import { fetchHtml, fetchWikisource, htmlToLines, wikisourceSubpages } from './text.mjs';

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

export const ADAPTERS = {
  'us-archives': usArchives,
  'au-wikisource': auWikisource,
  'ke-wikisource': keWikisource,
};
