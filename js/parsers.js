// Turns a book file into { title, author, format, paras: string[], chapters: [{ title, para }] }.
import { readZip } from './zip.js';

const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol',
  'blockquote', 'pre', 'tr', 'td', 'th', 'dd', 'dt', 'figcaption', 'header', 'footer', 'aside',
  // FB2
  'v', 'subtitle', 'title', 'text-author', 'epigraph', 'cite', 'poem', 'stanza', 'empty-line', 'annotation',
]);
const SKIP = new Set(['script', 'style', 'head', 'binary', 'svg', 'math', 'img', 'image', 'nav']);

const clean = (s) => s.replace(/­/g, '').replace(/\s+/g, ' ').trim();

export async function parseBook(file) {
  const name = file.name;
  const lower = name.toLowerCase();
  const buffer = await file.arrayBuffer();
  const baseTitle = name.replace(/\.(fb2\.zip|epub\.zip|epub|fb2|pdf|txt|zip)$/i, '');
  let book;

  if (lower.endsWith('.epub')) book = await parseZip(buffer);
  else if (lower.endsWith('.fb2')) book = parseFb2(buffer);
  else if (lower.endsWith('.zip')) book = await parseZip(buffer);
  else if (lower.endsWith('.pdf')) book = await parsePdf(buffer);
  else if (lower.endsWith('.txt')) book = parseTxt(buffer);
  else throw new Error('Этот формат не поддерживается. Подойдут EPUB, FB2, PDF и TXT');

  if (!book.paras.length) throw new Error('В файле не нашлось текста');
  book.title = book.title || baseTitle;
  book.author = book.author || '';
  if (!book.chapters.length || book.chapters[0].para > 0) {
    book.chapters.unshift({ title: 'Начало', para: 0 });
  }
  // Drop empty chapters (two headings in a row point at the same paragraph: keep the last).
  book.chapters = book.chapters.filter((c, i, a) => !a[i + 1] || a[i + 1].para > c.para);
  return book;
}

// Walks a DOM tree and splits it into paragraphs at block elements.
function collect(root, paras, onElement) {
  let buf = '';
  const flush = () => {
    const t = clean(buf);
    if (t) paras.push(t);
    buf = '';
  };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3 || child.nodeType === 4) { buf += child.data; continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.localName.toLowerCase();
      if (SKIP.has(tag)) continue;
      if (isNoteRef(child, tag)) continue;
      if (tag === 'br') { buf += ' '; continue; }
      if (BLOCK.has(tag)) {
        flush();
        if (onElement) onElement(child, tag, paras.length);
        walk(child);
        flush();
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  flush();
}

// Footnote markers like <sup>12</sup> or FB2 <a type="note">[3]</a> would flash as words.
function isNoteRef(el, tag) {
  if (tag === 'a' && el.getAttribute('type') === 'note') return true;
  if (tag === 'sup' && /^[\s\d\[\]()*]*$/.test(el.textContent)) return true;
  return false;
}

function parseXml(text, type = 'application/xml') {
  const doc = new DOMParser().parseFromString(text, type);
  if (doc.getElementsByTagName('parsererror').length) {
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

function firstText(doc, tag) {
  const el = doc.getElementsByTagNameNS('*', tag)[0] || doc.getElementsByTagName(tag)[0];
  return el ? clean(el.textContent) : '';
}

function resolvePath(base, href) {
  const url = new URL(href, 'http://book/' + base);
  return decodeURIComponent(url.pathname.slice(1));
}

/* ---------- EPUB ---------- */

async function parseEpub(source) {
  const zip = source instanceof ArrayBuffer ? await readZip(source) : source;
  const container = await zip.text('META-INF/container.xml');
  if (!container) throw new Error('Это не похоже на EPUB');
  const opfPath = parseXml(container).getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  const opfText = opfPath && await zip.text(opfPath);
  if (!opfText) throw new Error('EPUB повреждён');
  if (zip.has('META-INF/encryption.xml') && (await zip.text('META-INF/encryption.xml')).includes('EncryptedData')) {
    throw new Error('Книга защищена DRM, такую прочитать нельзя');
  }

  const opf = parseXml(opfText);
  const manifest = new Map();
  for (const item of opf.getElementsByTagNameNS('*', 'item')) {
    manifest.set(item.getAttribute('id'), {
      path: resolvePath(opfPath, item.getAttribute('href')),
      type: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || '',
    });
  }
  const spineEl = opf.getElementsByTagNameNS('*', 'spine')[0];
  const spine = [...opf.getElementsByTagNameNS('*', 'itemref')]
    .map((r) => manifest.get(r.getAttribute('idref')))
    .filter((it) => it && /html|xml/.test(it.type));

  const tocTitles = await readEpubToc(zip, manifest, spineEl);

  const paras = [];
  const chapters = [];
  for (const item of spine) {
    const text = await zip.text(item.path);
    if (!text) continue;
    const doc = parseXml(text, 'application/xhtml+xml');
    const body = doc.body || doc.getElementsByTagName('body')[0];
    if (!body) continue;
    const start = paras.length;
    let heading = '';
    collect(body, paras, (el, tag) => {
      if (!heading && /^h[1-3]$/.test(tag)) heading = clean(el.textContent);
    });
    if (paras.length === start) continue;
    const title = tocTitles.get(item.path) || heading;
    // Files without their own title are usually a chapter split in parts: keep them in the previous chapter.
    if (title || !chapters.length) chapters.push({ title: title || 'Начало', para: start });
  }

  return {
    title: firstText(opf, 'title'),
    author: firstText(opf, 'creator'),
    format: 'EPUB',
    paras,
    chapters,
  };
}

async function readEpubToc(zip, manifest, spineEl) {
  const titles = new Map();
  const add = (base, href, label) => {
    if (!href || !label) return;
    const path = resolvePath(base, href.split('#')[0]);
    if (!titles.has(path)) titles.set(path, clean(label));
  };
  try {
    const nav = [...manifest.values()].find((it) => it.props.split(' ').includes('nav'));
    if (nav) {
      const doc = parseXml(await zip.text(nav.path), 'application/xhtml+xml');
      const navs = [...doc.getElementsByTagName('nav')];
      const toc = navs.find((n) => (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type')) === 'toc') || navs[0];
      if (toc) for (const a of toc.getElementsByTagName('a')) add(nav.path, a.getAttribute('href'), a.textContent);
    }
    if (!titles.size) {
      const ncxId = spineEl?.getAttribute('toc');
      const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((it) => it.type.includes('ncx'));
      if (ncx) {
        const doc = parseXml(await zip.text(ncx.path));
        for (const point of doc.getElementsByTagNameNS('*', 'navPoint')) {
          const label = point.getElementsByTagNameNS('*', 'text')[0]?.textContent;
          const src = point.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src');
          add(ncx.path, src, label);
        }
      }
    }
  } catch (e) {
    console.warn('TOC not read', e);
  }
  return titles;
}

/* ---------- FB2 ---------- */

function decodeXmlBytes(bytes) {
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 200));
  const enc = (head.match(/encoding=["']([\w-]+)["']/i) || [])[1] || 'utf-8';
  try {
    return new TextDecoder(enc).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function parseFb2(buffer) {
  const doc = parseXml(decodeXmlBytes(new Uint8Array(buffer)));
  const info = doc.getElementsByTagName('title-info')[0] || doc;
  const authorEl = info.getElementsByTagName('author')[0];
  const author = authorEl
    ? clean(['first-name', 'last-name'].map((t) => authorEl.getElementsByTagName(t)[0]?.textContent || '').join(' '))
    : '';
  const title = info.getElementsByTagName('book-title')[0]?.textContent || '';

  const bodies = [...doc.getElementsByTagName('body')];
  const body = bodies.find((b) => !b.getAttribute('name')) || bodies[0];
  if (!body) throw new Error('Это не похоже на FB2');

  const paras = [];
  const chapters = [];
  collect(body, paras, (el, tag, at) => {
    if (tag !== 'section') return;
    const t = [...el.children].find((c) => c.localName.toLowerCase() === 'title');
    if (t) chapters.push({ title: clean(t.textContent), para: at });
  });
  return { title: clean(title), author, format: 'FB2', paras, chapters };
}

// A .zip can hold an FB2, an EPUB file, or an EPUB package folder ("Book.epub/…",
// which is how macOS and iOS share EPUBs from Apple Books).
async function parseZip(buffer) {
  const zip = await readZip(buffer);
  if (zip.has('META-INF/container.xml')) return parseEpub(zip);
  const names = zip.names.filter((n) => !n.startsWith('__MACOSX/'));
  const container = names.find((n) => n.endsWith('/META-INF/container.xml'));
  if (container) return parseEpub(zip.folder(container.slice(0, -'META-INF/container.xml'.length)));
  const toBuffer = (d) => d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
  const epub = names.find((n) => n.toLowerCase().endsWith('.epub'));
  if (epub) return parseEpub(toBuffer(await zip.read(epub)));
  const fb2 = names.find((n) => n.toLowerCase().endsWith('.fb2'));
  if (fb2) return parseFb2(toBuffer(await zip.read(fb2)));
  throw new Error('В архиве не нашлось книги EPUB или FB2');
}

/* ---------- TXT ---------- */

function parseTxt(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder('windows-1251').decode(buffer);
  }
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n').filter((l) => l.trim()).length;
  let blocks = text.split(/\n\s*\n/);
  // Many .txt books use one line per paragraph without blank lines between.
  if (blocks.length < lines / 4) blocks = text.split('\n');

  const paras = [];
  const chapters = [];
  for (const b of blocks) {
    const t = clean(b);
    if (!t) continue;
    if (t.length < 80 && /^(глава|часть|книга|пролог|эпилог|предисловие|chapter|part|prologue|epilogue)(?=$|[\s.:\d])/i.test(t)) {
      chapters.push({ title: t, para: paras.length });
    }
    paras.push(t);
  }
  return { title: '', author: '', format: 'TXT', paras, chapters };
}

/* ---------- PDF ---------- */

async function parsePdf(buffer) {
  const pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error('PDF защищён паролем');
    throw new Error('Не получилось открыть PDF');
  }

  const paras = [];
  const pageStartPara = [];
  let buf = '';
  let lineGap = 0;
  const flush = () => {
    const t = clean(buf);
    if (t) paras.push(t);
    buf = '';
  };
  const appendLine = (line) => {
    if (/[A-Za-zА-Яа-яЁё]-$/.test(buf) && /^[a-zа-яё]/.test(line)) buf = buf.slice(0, -1) + line;
    else buf += (buf ? ' ' : '') + line;
  };

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pageStartPara[n - 1] = paras.length + (buf ? 1 : 0);
    const lines = [];
    let cur = null;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      if (cur && item.str && Math.abs(item.transform[5] - cur.y) > item.height * 0.6) { lines.push(cur); cur = null; }
      if (!cur) cur = { text: '', x: item.transform[4], y: item.transform[5], h: item.height, w: 0 };
      cur.text += item.str;
      cur.w += item.width;
      if (item.hasEOL) { lines.push(cur); cur = null; }
    }
    if (cur) lines.push(cur);

    const body = lines.filter((l) => l.text.trim() && !/^\d{1,4}$/.test(l.text.trim())); // drop page numbers
    const minX = Math.min(...body.map((l) => l.x));
    const fullW = Math.max(...body.map((l) => l.w));
    let prev = null;
    for (const l of body) {
      const text = l.text.trim();
      if (prev) {
        const gap = Math.abs(prev.y - l.y);
        if (gap > 0 && gap < l.h * 3) lineGap = lineGap ? Math.min(lineGap, gap) : gap;
        const bigGap = lineGap && gap > lineGap * 1.5;
        const indented = l.x > minX + l.h * 0.8;
        const shortEnd = prev.w < fullW * 0.8 && /[.!?…:»"”]$/.test(prev.text.trim());
        if (bigGap || indented || shortEnd) flush();
      }
      appendLine(text);
      prev = l;
    }
    page.cleanup();
  }
  flush();

  if (paras.join(' ').length < pdf.numPages * 20) {
    throw new Error('В этом PDF нет текстового слоя (скан страниц), его не прочитать');
  }

  // Merge the very short fragments PDF layouts tend to produce into the previous paragraph.
  const merged = [];
  const remap = [];
  for (let i = 0; i < paras.length; i++) {
    const prev = merged[merged.length - 1];
    if (prev && !/[.!?…:»"”]$/.test(prev) && /^[a-zа-яё,;—–-]/.test(paras[i])) {
      merged[merged.length - 1] = prev + ' ' + paras[i];
    } else {
      merged.push(paras[i]);
    }
    remap[i] = merged.length - 1;
  }

  const chapters = [];
  try {
    const outline = await pdf.getOutline();
    for (const item of outline || []) {
      let dest = item.dest;
      if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest)) continue;
      const pageIndex = await pdf.getPageIndex(dest[0]);
      const p = Math.min(pageStartPara[pageIndex] ?? 0, paras.length - 1);
      chapters.push({ title: clean(item.title), para: remap[p] ?? 0 });
    }
    chapters.sort((a, b) => a.para - b.para);
  } catch (e) {
    console.warn('PDF outline not read', e);
  }

  let title = '';
  let author = '';
  try {
    const meta = await pdf.getMetadata();
    title = clean(meta.info?.Title || '');
    author = clean(meta.info?.Author || '');
  } catch { /* metadata is optional */ }
  pdf.destroy();

  return { title, author, format: 'PDF', paras: merged, chapters };
}
