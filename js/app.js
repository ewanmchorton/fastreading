import { parseBook } from './parsers.js';
import { tokenize, focusIndex, wordWeight } from './text.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);
const SECTION_WORDS = 2500; // how many words the page view renders at once
const BREAK_AFTER_MS = 20 * 60 * 1000;
const CHAPTER_PAUSE_MS = 1500; // extra pause before a chapter starts, and after its title

/* ---------- Settings ---------- */

const DEFAULTS = { theme: 'night', size: 'M', font: 'literata', layout: 'pages', wpm: 300, punct: true, ramp: true, breaks: true };
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
  if (reader) {
    updateProgress();
    relayout();
  }
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

// The reading position is meta.pos: the word the flow starts from. It moves when the
// flow runs, when a page is turned (to the page's first word), when the text is
// scrolled (to the first visible word) and on a long press (to the pressed word).
// Showing or hiding the controls never moves the text: they are drawn over it.

let reader = null; // { meta, chapters, words, paraStart, paraMark, chapterMark, sections, section, spans, page, pageW, pageCount }
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
  // 1: a chapter starts at this word; 2: a short chapter title ends right before it.
  const chapterMark = new Uint8Array(words.length + 1);
  for (const c of content.chapters) {
    const at = paraStart[c.para];
    if (at > 0) chapterMark[at] = 1;
    const next = paraStart[c.para + 1];
    if (next !== undefined && next - at <= 8 && !chapterMark[next]) chapterMark[next] = 2;
  }
  reader = { meta, chapters: content.chapters, words, paraStart, paraMark, chapterMark, section: -1, page: 0 };
  meta.total = words.length;
  meta.pos = Math.min(meta.pos || 0, words.length - 1);
  meta.openedAt = Date.now();
  db.saveMeta(meta);
  buildSections();
  playedMs = 0;

  $('library').hidden = true;
  $('reader').hidden = false;
  setControls(true);
  await document.fonts?.ready;
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
  $('pages').innerHTML = '';
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

function setReadPos(i) {
  reader.meta.pos = Math.max(0, Math.min(i, reader.words.length - 1));
  updateProgress();
  schedulePersist();
}

/* Page view. Two layouts: "pages" puts the text in CSS columns, one column per screen,
   turned by taps on the edges or swipes; "scroll" is a plain scrolling column. */

const scrollMode = () => settings.layout === 'scroll';

function renderSection(k) {
  const { sections, paraStart, words, chapters } = reader;
  const s = sections[k];
  reader.section = k;
  let html = '';
  for (let p = s.start; p < s.end; p++) {
    const from = paraStart[p];
    const to = p + 1 < paraStart.length ? paraStart[p + 1] : words.length;
    let line = '';
    for (let i = from; i < to; i++) line += `<span data-i="${i}">${escapeHtml(words[i])}</span> `;
    html += `<p>${line}</p>`;
  }
  if (scrollMode()) {
    const title = (j) => escapeHtml(chapters[sections[j].chapter].title);
    if (k > 0) html = `<button class="nav-part" data-section="${k - 1}">↑ ${title(k - 1)}</button>` + html;
    if (k + 1 < sections.length) html += `<button class="nav-part" data-section="${k + 1}">Дальше: ${title(k + 1)} ↓</button>`;
  }
  $('pages').innerHTML = html;
  reader.spans = $('pages').querySelectorAll('[data-i]');
  $('chapter-title').textContent = chapters[s.chapter].title;
  $('page-head').textContent = chapters[s.chapter].title;
  layoutPages();
}

function layoutPages() {
  const box = $('text');
  const pages = $('pages');
  box.classList.toggle('scroll', scrollMode());
  if (scrollMode()) {
    for (const prop of ['width', 'height', 'marginLeft', 'columnWidth', 'columnGap', 'transform', 'transition']) pages.style[prop] = '';
    reader.pageCount = 1;
    $('page-no').textContent = '';
    return;
  }
  const width = box.clientWidth;
  const col = Math.min(width - 48, 640);
  const side = (width - col) / 2;
  reader.pageW = width;
  pages.style.width = `${col}px`;
  pages.style.height = `${box.clientHeight - parseFloat(getComputedStyle(box).paddingTop)}px`;
  pages.style.marginLeft = `${side}px`;
  pages.style.columnWidth = `${col}px`;
  pages.style.columnGap = `${side * 2}px`;
  const spans = reader.spans;
  reader.pageCount = spans.length ? pageOfSpan(spans[spans.length - 1]) + 1 : 1;
}

function spanOf(i) {
  return reader.spans[i - reader.paraStart[reader.sections[reader.section].start]];
}

function pageOfSpan(el) {
  const base = $('pages').getBoundingClientRect().left;
  return Math.max(0, Math.floor((el.getBoundingClientRect().left - base + 1) / reader.pageW));
}

// First word on page n (binary search: words go left to right, page by page).
function firstWordOnPage(n) {
  const spans = reader.spans;
  let lo = 0;
  let hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pageOfSpan(spans[mid]) < n) lo = mid + 1; else hi = mid;
  }
  return Number(spans[lo].dataset.i);
}

function showPageNo(n, animate = true) {
  reader.page = n;
  const pages = $('pages');
  pages.style.transition = animate ? '' : 'none';
  pages.style.transform = `translateX(${-n * reader.pageW}px)`;
  $('page-no').textContent = `${n + 1} / ${reader.pageCount}`;
}

// Turns the page; past the first or last page, the previous or next part of the book loads.
function turnPage(dir) {
  if (scrollMode()) return;
  let n = reader.page + dir;
  if (n < 0) {
    if (reader.section === 0) return showPageNo(0);
    renderSection(reader.section - 1);
    n = reader.pageCount - 1;
    showPageNo(n, false);
  } else if (n >= reader.pageCount) {
    if (reader.section === reader.sections.length - 1) return showPageNo(reader.page);
    renderSection(reader.section + 1);
    n = 0;
    showPageNo(n, false);
  } else {
    showPageNo(n);
  }
  setReadPos(firstWordOnPage(n));
}

// Shows word i: the page that holds it, or, when scrolling, its line near the top.
function goTo(i, { force = false } = {}) {
  i = Math.max(0, Math.min(i, reader.words.length - 1));
  const k = sectionOf(i);
  if (force || k !== reader.section) renderSection(k);
  const el = spanOf(i);
  if (scrollMode()) {
    const box = $('text');
    reader.ignoreScrollUntil = performance.now() + 400;
    box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 4;
  } else {
    showPageNo(pageOfSpan(el), false);
  }
  setReadPos(i);
}

function showPage() {
  $('flow').hidden = true;
  $('page').hidden = false;
  goTo(reader.meta.pos, { force: true });
}

// Re-lays the text out (new size, font or layout) and keeps the reading position in view.
function relayout() {
  if (!reader || playing || $('page').hidden) return;
  goTo(reader.meta.pos, { force: true });
}

// The bars at the top and bottom are drawn over the text; toggling them moves nothing.
function setControls(on) {
  $('reader').classList.toggle('controls', on);
}

// When scrolling, the reading position follows the first line on screen.
function onTextScroll() {
  if (!reader || playing || !scrollMode() || performance.now() < (reader.ignoreScrollUntil || 0)) return;
  setControls(false);
  clearTimeout(onTextScroll.t);
  onTextScroll.t = setTimeout(() => {
    const top = $('text').getBoundingClientRect().top;
    const first = [...reader.spans].find((el) => el.getBoundingClientRect().top >= top);
    if (first) setReadPos(Number(first.dataset.i));
  }, 200);
}

function updateProgress() {
  const { pos, total } = reader.meta;
  const pct = `${Math.floor((pos / total) * 100)}%`;
  const width = `${(pos / total) * 100}%`;
  $('page-pct').textContent = pct;
  $('page-fill').style.width = width;
  $('page-left').textContent = `осталось ${formatLeft(total - pos)}`;
  $('page-foot-pct').textContent = pct;
  $('flow-pct').textContent = pct;
  $('flow-fill').style.width = width;
  $('flow-left').textContent = formatLeft(total - pos);
}

/* Touch on the text.
   Pages: a tap on the left or right third turns the page, in the middle shows or hides
   the controls; a swipe turns the page. Scroll: a tap shows or hides the controls.
   Both: holding a finger on a word starts the flow from that word. */

const LONG_PRESS_MS = 500;
// The finger that started the flow by a long press can end with a click on the flow
// screen; that click must not pause it. A real tap on the flow starts with its own
// pointerdown there, which clears the flag.
let flowClickFromLongPress = false;
const gesture = { id: null, x: 0, y: 0, dx: 0, moved: false, drag: false, long: false, timer: 0, word: null, nav: null };

// iOS never sends pointerup when a long press hides the page to start the flow,
// so a gesture is also forgotten on the next touch and whenever the flow starts.
function resetGesture() {
  clearTimeout(gesture.timer);
  gesture.id = null;
}

function onPointerDown(e) {
  if (!e.isPrimary || !reader) return;
  resetGesture();
  Object.assign(gesture, {
    id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, moved: false, drag: false, long: false,
    word: e.target.closest('[data-i]'), nav: e.target.closest('[data-section]'),
  });
  if (!scrollMode()) $('text').setPointerCapture(e.pointerId);
  if (gesture.word) {
    gesture.timer = setTimeout(() => {
      gesture.long = true;
      flowClickFromLongPress = true;
      setReadPos(Number(gesture.word.dataset.i));
      play();
    }, LONG_PRESS_MS);
  }
}

function onPointerMove(e) {
  if (e.pointerId !== gesture.id) return;
  const dx = e.clientX - gesture.x;
  const dy = e.clientY - gesture.y;
  if (!gesture.moved && Math.hypot(dx, dy) > 10) {
    gesture.moved = true;
    clearTimeout(gesture.timer);
    gesture.drag = !scrollMode() && Math.abs(dx) > Math.abs(dy);
  }
  if (gesture.drag) {
    gesture.dx = dx;
    const pages = $('pages');
    pages.style.transition = 'none';
    pages.style.transform = `translateX(${-reader.page * reader.pageW + dx}px)`;
  }
}

function onPointerUp(e) {
  if (e.pointerId !== gesture.id) return;
  resetGesture();
  if (gesture.long || !reader || playing) return;
  if (e.type === 'pointercancel') {
    if (gesture.drag) showPageNo(reader.page);
    return;
  }
  if (gesture.drag) {
    setControls(false);
    if (Math.abs(gesture.dx) > 50) turnPage(gesture.dx < 0 ? 1 : -1);
    else showPageNo(reader.page);
    return;
  }
  if (gesture.moved) return;
  // A tap.
  if (gesture.nav) {
    goTo(reader.paraStart[reader.sections[Number(gesture.nav.dataset.section)].start]);
    return;
  }
  const x = (e.clientX - $('text').getBoundingClientRect().left) / $('text').clientWidth;
  if (!scrollMode() && x < 0.3) {
    setControls(false);
    turnPage(-1);
  } else if (!scrollMode() && x > 0.7) {
    setControls(false);
    turnPage(1);
  } else {
    setControls(!$('reader').classList.contains('controls'));
  }
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
  let delay = (60000 / speed) * wordWeight(words[i], paraMark[i + 1] === 1, settings.punct);
  if (reader.chapterMark[i + 1]) delay += CHAPTER_PAUSE_MS;

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
  resetGesture();
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
  setControls(false);
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
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.open) openBook(t.dataset.open);
  else if (t.dataset.delete) deleteBook(t.dataset.delete);
  else if (t.hasAttribute('data-open-settings')) openSheet('settings');
  else if (t.hasAttribute('data-close-sheet')) closeSheets();
  else if (t.dataset.chapter !== undefined) {
    closeSheets();
    goTo(reader.paraStart[reader.chapters[Number(t.dataset.chapter)].para]);
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
$('flow').addEventListener('pointerdown', () => { flowClickFromLongPress = false; });
$('flow').addEventListener('click', () => {
  if (flowClickFromLongPress) flowClickFromLongPress = false;
  else pause();
});
$('text').addEventListener('pointerdown', onPointerDown);
$('text').addEventListener('pointermove', onPointerMove);
$('text').addEventListener('pointerup', onPointerUp);
$('text').addEventListener('pointercancel', onPointerUp);
$('text').addEventListener('lostpointercapture', (e) => { if (e.pointerId === gesture.id) resetGesture(); });
$('text').addEventListener('contextmenu', (e) => e.preventDefault());
$('text').addEventListener('scroll', onTextScroll, { passive: true });
window.addEventListener('resize', relayout);
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
  else if (!playing && e.key === 'ArrowLeft') turnPage(-1);
  else if (!playing && e.key === 'ArrowRight') turnPage(1);
});

/* ---------- Start ---------- */

applySettings();
renderLibrary();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW not registered', e));
}
