// Reader checks with real touch events (as on iPhone) in Chromium, plus import of every format.
// Needs the app served at http://localhost:8123 from the repo root and tests/make_books.py run first.
const path = require('path');
const { chromium, devices } = require('playwright');
const BOOKS = path.join(__dirname, 'books');
const res = [];
const check = (n, ok, info) => { res.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  -> ' + JSON.stringify(info))); };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  const cdp = await ctx.newCDPSession(p);
  const touch = async (pts, gap = 16) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1] }] });
    for (const [x, y, wait] of pts.slice(1)) { await p.waitForTimeout(wait ?? gap); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(450);
  };
  const tapAt = (x, y) => touch([[x, y]]);
  const hold = async (x, y, ms) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await p.waitForTimeout(ms); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(300); };
  const st = () => p.evaluate(() => { const box = document.getElementById('text').getBoundingClientRect();
    const vis = [...document.querySelectorAll('#pages [data-i]')].filter(e => { const r = e.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1; });
    return { first: vis[0] ? +vis[0].dataset.i : null, page: document.getElementById('page-no').textContent, controls: document.getElementById('reader').classList.contains('controls'), flow: !document.getElementById('flow').hidden, pct: document.getElementById('page-pct').textContent }; });
  await p.goto('http://localhost:8123/');
  for (const f of ['test.fb2', 'test.fb2.zip', 'test.txt', 'package.epub.zip', 'test.epub']) {
    await p.evaluate(() => { document.getElementById('toast').textContent = ''; });
    await p.setInputFiles('#file-input', path.join(BOOKS, f));
    await p.waitForFunction(() => { const t = document.getElementById('toast').textContent; return t && !/Загружаю/.test(t); });
    const t = await p.textContent('#toast');
    check('imports ' + f, t.startsWith('Добавлено'), t);
  }
  await p.click('.primary[data-open], [data-open]'); await p.waitForTimeout(500);
  const W = 390, Y = 250;
  let a = await st(); await tapAt(W / 2, Y); let b2 = await st();
  check('touch tap middle toggles controls, text still', a.controls && !b2.controls && a.first === b2.first, [a, b2]);
  await tapAt(W - 15, Y); let c = await st(); check('touch tap right turns page', c.page.startsWith('2'), c);
  await tapAt(15, Y); c = await st(); check('touch tap left turns back', c.page.startsWith('1'), c);
  await touch([[300, Y], [250, Y + 2], [180, Y + 3], [100, Y + 4], [60, Y + 4]]); c = await st(); check('touch swipe turns page', c.page.startsWith('2'), c);
  // long press a word in the middle
  const w = await p.evaluate(() => { const box = document.getElementById('text').getBoundingClientRect(); const e = [...document.querySelectorAll('#pages [data-i]')].find(e => { const r = e.getBoundingClientRect(); return r.top > box.top + 100 && r.left > 120 && r.right < 270; }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await hold(w[0], w[1], 600); c = await st(); check('touch long press starts flow and stays playing', c.flow, c);
  await p.waitForTimeout(800); c = await st(); check('flow keeps running after finger lifted', c.flow, c);
  await tapAt(W / 2, Y); c = await st(); check('touch tap pauses flow', !c.flow, c);
  const before = await st(); await tapAt(W - 15, Y); c = await st(); check('touch tap right after long-press flow turns page', c.first !== before.first, [before, c]);
  await touch([[300, Y], [200, Y + 3], [80, Y + 4]]); c = await st(); check('touch swipe after flow turns page', c.page !== before.page, [before, c]);
  // scroll mode with a real finger drag
  await tapAt(W / 2, Y); if (!(await st()).controls) await tapAt(W / 2, Y);
  await p.click('.top-bar [data-open-settings]'); await p.click('[data-setting="layout"] [data-value="scroll"]'); await p.click('#settings [data-close-sheet]'); await p.waitForTimeout(300);
  const s0 = await st();
  await tapAt(W / 2, Y); await touch([[200, 560], [200, 520], [200, 440], [200, 340], [200, 240], [200, 140]]); await p.waitForTimeout(2500);
  const s1 = await st(); const top = await p.evaluate(() => document.getElementById('text').scrollTop);
  check('finger drag scrolls text in scroll mode', top > 100 && s1.first !== s0.first, [s0, s1, top]);
  await tapAt(W / 2, Y); const s2 = await st(); check('tap in scroll mode shows controls, text still', s2.controls && s2.first === s1.first, [s1, s2]);
  check('no JS errors', errors.length === 0, errors);
  console.log(res.filter(Boolean).length + '/' + res.length + ' passed');
  await b.close();
  process.exit(res.every(Boolean) ? 0 : 1);
})();
