import { parseBook } from './parsers.js';
import { tokenize, focusIndex, wordWeight, isSentenceEnd } from './text.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);
const SECTION_WORDS = 2500; // how many words the page view renders at once
const BREAK_AFTER_MS = 20 * 60 * 1000;

/* ---------- Settings ---------- */

const DEFAULTS = { theme: 'night', size: 'M', font: 'literata', wpm: 300, punct: true, ramp: true, breaks: true };
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('fr-settings') || '{}')); } catch { /* private mode */ }

function saveSettings() {
  try { localStorage.setItem('fr-settings', JSON.stringify(settings)); } catch { /* private mode */ }
}

function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.size = settings.size;
  root.dataset.font = settings.font;
  document.querySelector('meta[name="theme-color"]').content = settings.theme === 'day' ? '#FFFFFF' : '#0B0B0D';
  for (const group of document.querySelectorAll('[data-setting]')) {
    for (const b of group.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.value === settings[group.dataset.setting]));
    }
  }
  for (const s of document.querySelectorAll('[data-toggle]')) {
    s.setAttribute('aria-checked', String(Boolean(settings[s.dataset.toggle])));
  }
  $('speed').value = settings.wpm;
  $('speed-value').textContent = settings.wpm;
  baseWordSize = 0;
  if (reader) updateProgress();
}

/* ---------- Helpers ---------- */

function toast(text, ms = 3500) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatLeft(words) {
  // Pauses on punctuation make real reading ~15% slower than the bare speed.
  const min = Math.max(1, Math.round((words / settings.wpm) * 1.15));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

function bookState(meta) {
  if (!meta.pos) return 'новая';
  if (meta.pos >= meta.total - 1) return 'прочитана';
  return `${Math.floor((meta.pos / meta.total) * 100)}%`;
}

/* ---------- Library ---------- */

async function renderLibrary() {
  const books = await db.listBooks();
  const current = books.find((b) => b.openedAt && b.pos < b.total - 1);
  const rest = books.filter((b) => b !== current);

  const cont = $('continue');
  cont.hidden = !current;
  if (current) {
    const pct = Math.floor((current.pos / current.total) * 100);
    cont.innerHTML = `
      <h2 class="label">Продолжить</h2>
      <div class="card">
        <div>
          <div class="card-title">${escapeHtml(current.title)}</div>
          ${current.author ? `<div class="card-sub">${escapeHtml(current.author)}</div>` : ''}
        </div>
        <div class="progress">
          <div class="track"><div class="fill" style="width:${pct}%"></div></div>
          <div class="progress-meta"><span>${pct}%</span><span>≈ ${formatLeft(current.total - current.pos)} при ${settings.wpm} сл/мин</span></div>
        </div>
        <button class="primary" data-open="${current.id}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg>Читать
        </button>
      </div>`;
  }

  $('shelf-label').hidden = !rest.length;
  $('shelf-label').textContent = `Библиотека · ${books.length}`;
  $('empty').hidden = books.length > 0;
  $('books').innerHTML = rest.map((b) => `
    <li class="book">
      <button class="book-open" data-open="${b.id}">
        <span class="book-text">
          <span class="book-title">${escapeHtml(b.title)}</span>
          <span class="book-sub">${escapeHtml([b.author, b.format].filter(Boolean).join(' · '))}</span>
        </span>
        <span class="book-state">${bookState(b)}</span>
      </button>
      <button class="book-del" data-delete="${b.id}" aria-label="Удалить «${escapeHtml(b.title)}»">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>
      </button>
    </li>`).join('');
}

async function importFiles(files) {
  for (const file of files) {
    toast(`Загружаю «${file.name}»…`, 60000);
    try {
      const book = await parseBook(file);
      const { words } = tokenize(book.paras);
      const meta = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        title: book.title,
        author: book.author,
        format: book.format,
        addedAt: Date.now(),
        openedAt: 0,
        pos: 0,
        total: words.length,
      };
      await db.addBook(meta, { paras: book.paras, chapters: book.chapters });
      toast(`Добавлено: «${book.title}»`);
    } catch (e) {
      console.error(e);
      toast(`«${file.name}»: ${e.message || 'не получилось прочитать файл'}`, 6000);
    }
  }
  navigator.storage?.persist?.();
  renderLibrary();
}

/* ---------- Reader ---------- */

let reader = null; // { meta, chapters, words, paraStart, paraMark, sections, section }
let playing = false;
let timer = 0;
let rampStart = 0;
let playStartedAt = 0;
let playedMs = 0;
let lastPausedAt = 0;
let wakeLock = null;
let saveTimer = 0;
let baseWordSize = 0;

function paraOf(i) {
  const ps = reader.paraStart;
  let lo = 0;
  let hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ps[mid] <= i) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function chapterOf(para) {
  const ch = reader.chapters;
  let k = 0;
  while (k + 1 < ch.length && ch[k + 1].para <= para) k++;
  return k;
}

// Chapters cut into parts of at most SECTION_WORDS words, at paragraph boundaries.
function buildSections() {
  const { chapters, paraStart } = reader;
  const nParas = paraStart.length;
  const sections = [];
  chapters.forEach((ch, k) => {
    const end = k + 1 < chapters.length ? chapters[k + 1].para : nParas;
    let start = ch.para;
    while (start < end) {
      let stop = start + 1;
      const limit = paraStart[start] + SECTION_WORDS;
      while (stop < end && paraStart[stop] < limit) stop++;
      sections.push({ chapter: k, start, end: stop });
      start = stop;
    }
  });
  if (!sections.length) sections.push({ chapter: 0, start: 0, end: nParas });
  reader.sections = sections;
}

function sectionOf(i) {
  const p = paraOf(i);
  return reader.sections.findIndex((s) => p >= s.start && p < s.end);
}

async function openBook(id) {
  const [meta, content] = await Promise.all([db.getMeta(id), db.getContent(id)]);
  if (!meta || !content) return;
  const { words, paraStart } = tokenize(content.paras);
  const paraMark = new Uint8Array(words.length + 1);
  for (const s of paraStart) paraMark[s] = 1;
  reader = { meta, chapters: content.chapters, words, paraStart, paraMark, section: -1 };
  meta.total = words.length;
  meta.pos = Math.min(meta.pos || 0, words.length - 1);
  meta.openedAt = Date.now();
  db.saveMeta(meta);
  buildSections();
  playedMs = 0;

  $('library').hidden = true;
  $('reader').hidden = false;
  showPage();
  history.pushState({ reader: true }, '');
}

function closeBook() {
  if (!reader) return;
  pause();
  persistPos();
  reader = null;
  $('reader').hidden = true;
  $('library').hidden = false;
  $('text').innerHTML = '';
  renderLibrary();
}

function persistPos() {
  clearTimeout(saveTimer);
  if (reader) db.saveMeta(reader.meta);
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistPos, 1500);
}

/* Page view */

function renderSection(k) {
  const { sections, paraStart, words, chapters } = reader;
  const s = sections[k];
  reader.section = k;
  let html = '';
  if (k > 0) html += `<button class="nav-part" data-section="${k - 1}">↑ Назад: ${escapeHtml(chapters[sections[k - 1].chapter].title)}</button>`;
  for (let p = s.start; p < s.end; p++) {
    const from = paraStart[p];
    const to = p + 1 < paraStart.length ? paraStart[p + 1] : words.length;
    let line = '';
    for (let i = from; i < to; i++) line += `<span data-i="${i}">${escapeHtml(words[i])}</span> `;
    html += `<p>${line}</p>`;
  }
  if (k + 1 < sections.length) html += `<button class="nav-part" data-section="${k + 1}">Дальше: ${escapeHtml(chapters[sections[k + 1].chapter].title)} ↓</button>`;
  $('text').innerHTML = html;
  $('chapter-title').textContent = chapters[s.chapter].title;
}

function highlight(scroll) {
  const text = $('text');
  text.querySelector('.cur')?.classList.remove('cur');
  const el = text.querySelector(`[data-i="${reader.meta.pos}"]`);
  if (!el) return;
  el.classList.add('cur');
  if (scroll) el.scrollIntoView({ block: 'center' });
}

function setPos(i, { scroll = true } = {}) {
  i = Math.max(0, Math.min(i, reader.words.length - 1));
  reader.meta.pos = i;
  const k = sectionOf(i);
  if (k !== reader.section) renderSection(k);
  highlight(scroll);
  updateProgress();
  schedulePersist();
}

function showPage() {
  $('flow').hidden = true;
  $('page').hidden = false;
  reader.section = -1;
  setPos(reader.meta.pos);
}

function updateProgress() {
  const { pos, total } = reader.meta;
  const pct = `${Math.floor((pos / total) * 100)}%`;
  const width = `${(pos / total) * 100}%`;
  const left = `осталось ${formatLeft(total - pos)}`;
  $('page-pct').textContent = pct;
  $('page-fill').style.width = width;
  $('page-left').textContent = left;
  $('flow-pct').textContent = pct;
  $('flow-fill').style.width = width;
  $('flow-left').textContent = formatLeft(total - pos);
}

// When the highlighted word scrolls out of sight, the reading position follows the scroll.
function onTextScroll() {
  if (playing || !reader) return;
  clearTimeout(onTextScroll.t);
  onTextScroll.t = setTimeout(() => {
    const text = $('text');
    const box = text.getBoundingClientRect();
    const cur = text.querySelector('.cur');
    if (cur) {
      const r = cur.getBoundingClientRect();
      if (r.bottom > box.top && r.top < box.bottom) return;
    }
    for (const p of text.querySelectorAll('p')) {
      const r = p.getBoundingClientRect();
      if (r.bottom > box.top + 8) {
        const first = [...p.querySelectorAll('[data-i]')].find((s) => s.getBoundingClientRect().top >= box.top);
        if (first) setPos(Number(first.dataset.i), { scroll: false });
        return;
      }
    }
  }, 250);
}

function sentenceStart(i) {
  const { words, paraMark } = reader;
  while (i > 0 && !paraMark[i] && !isSentenceEnd(words[i - 1])) i--;
  return i;
}

function prevSentence() {
  let s = sentenceStart(reader.meta.pos);
  if (reader.meta.pos - s < 2 && s > 0) s = sentenceStart(s - 1);
  setPos(s);
}

function nextSentence() {
  const { words, paraMark } = reader;
  let j = reader.meta.pos;
  while (j < words.length - 1 && !isSentenceEnd(words[j]) && !paraMark[j + 1]) j++;
  setPos(j + 1);
}

/* Flow */

function renderWord(i) {
  const word = reader.words[i];
  const f = focusIndex(word);
  const left = $('w-left');
  const focus = $('w-focus');
  const right = $('w-right');
  left.textContent = word.slice(0, f);
  focus.textContent = word[f] || '';
  right.textContent = word.slice(f + 1);

  // Long words would overflow the screen: shrink until both halves fit around the focus letter.
  const el = $('word');
  if (!baseWordSize) {
    el.style.fontSize = '';
    baseWordSize = parseFloat(getComputedStyle(el).fontSize);
  }
  el.style.fontSize = `${baseWordSize}px`;
  const half = el.clientWidth / 2 - 12;
  const need = Math.max(left.offsetWidth, right.offsetWidth) + focus.offsetWidth / 2;
  if (need > half) el.style.fontSize = `${Math.max(10, baseWordSize * (half / need))}px`;
}

function tick() {
  if (!playing) return;
  const { words, paraMark, meta } = reader;
  const i = meta.pos;
  renderWord(i);
  updateProgress();
  $('flow-chapter').textContent = reader.chapters[chapterOf(paraOf(i))].title;

  let speed = settings.wpm;
  if (settings.ramp) {
    const t = (performance.now() - rampStart) / 5000;
    if (t < 1) speed *= 0.55 + 0.45 * t;
  }
  const delay = (60000 / speed) * wordWeight(words[i], paraMark[i + 1] === 1, settings.punct);

  timer = setTimeout(() => {
    if (i + 1 >= words.length) {
      pause();
      toast('Книга прочитана');
      return;
    }
    meta.pos = i + 1;
    if (settings.breaks && playedMs + (performance.now() - playStartedAt) >= BREAK_AFTER_MS) {
      pause();
      playedMs = 0;
      toast('20 минут в потоке. Моргни, посмотри вдаль секунд двадцать', 8000);
      return;
    }
    if ((meta.pos & 31) === 0) schedulePersist();
    tick();
  }, delay);
}

async function play() {
  if (playing || !reader) return;
  playing = true;
  if (Date.now() - lastPausedAt > 2 * 60 * 1000) playedMs = 0; // a long pause counts as rest
  rampStart = playStartedAt = performance.now();
  $('page').hidden = true;
  $('flow').hidden = false;
  baseWordSize = 0;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  tick();
}

function pause() {
  if (!playing) return;
  playing = false;
  clearTimeout(timer);
  playedMs += performance.now() - playStartedAt;
  lastPausedAt = Date.now();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  persistPos();
  showPage();
}

/* ---------- Sheets ---------- */

function openSheet(id) {
  closeSheets();
  if (id === 'chapters') renderChapters();
  $('backdrop').hidden = false;
  $(id).hidden = false;
}

function closeSheets() {
  $('backdrop').hidden = true;
  $('settings').hidden = true;
  $('chapters').hidden = true;
}

function renderChapters() {
  const current = reader.sections[reader.section]?.chapter ?? 0;
  $('chapter-list').innerHTML = reader.chapters.map((c, k) =>
    `<li><button data-chapter="${k}" aria-current="${k === current}">${escapeHtml(c.title)}</button></li>`).join('');
  requestAnimationFrame(() => $('chapter-list').querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' }));
}

/* ---------- Events ---------- */

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-i]');
  if (!t) return;
  if (t.dataset.open) openBook(t.dataset.open);
  else if (t.dataset.delete) deleteBook(t.dataset.delete);
  else if (t.hasAttribute('data-open-settings')) openSheet('settings');
  else if (t.hasAttribute('data-close-sheet')) closeSheets();
  else if (t.dataset.i !== undefined) setPos(Number(t.dataset.i), { scroll: false });
  else if (t.dataset.section !== undefined) {
    const s = reader.sections[Number(t.dataset.section)];
    setPos(reader.paraStart[s.start]);
    $('text').scrollTop = 0;
  } else if (t.dataset.chapter !== undefined) {
    closeSheets();
    setPos(reader.paraStart[reader.chapters[Number(t.dataset.chapter)].para]);
    $('text').scrollTop = 0;
  } else if (t.dataset.value !== undefined) {
    const key = t.closest('[data-setting]').dataset.setting;
    settings[key] = t.dataset.value;
    saveSettings();
    applySettings();
  } else if (t.dataset.toggle) {
    settings[t.dataset.toggle] = !settings[t.dataset.toggle];
    saveSettings();
    applySettings();
  }
});

async function deleteBook(id) {
  const meta = await db.getMeta(id);
  if (!meta || !confirm(`Удалить «${meta.title}»?`)) return;
  await db.deleteBook(id);
  renderLibrary();
}

$('theme-quick').addEventListener('click', () => {
  settings.theme = settings.theme === 'day' ? 'night' : 'day';
  saveSettings();
  applySettings();
});
$('file-input').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importFiles(files);
});
$('backdrop').addEventListener('click', closeSheets);
$('back').addEventListener('click', () => history.back());
$('chapter-btn').addEventListener('click', () => openSheet('chapters'));
$('play').addEventListener('click', play);
$('prev').addEventListener('click', prevSentence);
$('next').addEventListener('click', nextSentence);
$('flow').addEventListener('click', pause);
$('text').addEventListener('scroll', onTextScroll, { passive: true });
$('speed').addEventListener('input', (e) => {
  settings.wpm = Number(e.target.value);
  $('speed-value').textContent = settings.wpm;
  updateProgress();
  saveSettings();
});

// The iPhone back swipe and the in-app back button both go through history.
window.addEventListener('popstate', () => {
  if (reader) closeBook();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pause();
    persistPos();
  }
});

document.addEventListener('keydown', (e) => {
  if (!reader || !$('settings').hidden || !$('chapters').hidden) {
    if (e.key === 'Escape') closeSheets();
    return;
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (playing) pause(); else play();
  } else if (e.key === 'Escape') pause();
  else if (!playing && e.key === 'ArrowLeft') prevSentence();
  else if (!playing && e.key === 'ArrowRight') nextSentence();
});

/* ---------- Start ---------- */

applySettings();
renderLibrary();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW not registered', e));
}
