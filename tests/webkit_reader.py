"""Reader behaviour checks in WebKit, the engine of iPhone Safari.

Needs: the app served at http://localhost:8123 from the repo root, WebKitWebDriver
listening on port 4444 (see tests/README.md) and the test books (tests/make_books.py).
Exit code 0 when every check passes.
"""
import sys
import time

from selenium import webdriver
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.options import ArgOptions

def browser(w=390, h=844):
    opts = ArgOptions()
    opts.set_capability('browserName', 'MiniBrowser')
    opts.set_capability('webkitgtk:browserOptions', {
        'binary': '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser',
        'args': ['--automation', '--enable-write-console-messages-to-stdout=true'],
    })
    d = webdriver.Remote(command_executor='http://127.0.0.1:4444', options=opts)
    d.set_window_rect(0, 0, w, h)
    return d


def load_book(d, name='test.epub'):
    d.get('http://localhost:8123/')
    time.sleep(1)
    d.execute_script("""
      indexedDB.deleteDatabase('fastreading'); localStorage.clear();""")
    d.get('http://localhost:8123/')
    time.sleep(1)
    d.execute_async_script("""
      const done = arguments[arguments.length - 1];
      fetch('/tests/books/' + arguments[0]).then(r => r.blob()).then(b => {
        const dt = new DataTransfer(); dt.items.add(new File([b], arguments[0]));
        const inp = document.getElementById('file-input'); inp.files = dt.files;
        inp.dispatchEvent(new Event('change'));
        const t = setInterval(() => { if (/Добавлено|:/.test(document.getElementById('toast').textContent) && !/Загружаю/.test(document.getElementById('toast').textContent)) { clearInterval(t); done(document.getElementById('toast').textContent); } }, 100);
      });""", name)
    d.find_element('css selector', '[data-open]').click()
    time.sleep(1)

def tap(d, x, y):
    ActionChains(d).move_by_offset(0, 0).perform()
    d.execute_script("window.scrollTo(0,0)")
    ac = ActionChains(d); ac.w3c_actions.pointer_action.move_to_location(x, y); ac.w3c_actions.pointer_action.click(); ac.perform()
    time.sleep(0.5)

def swipe(d, x0, x1, y=400):
    ac = ActionChains(d); pa = ac.w3c_actions.pointer_action
    pa.move_to_location(x0, y); pa.pointer_down()
    for k in range(1, 7): pa.move_to_location(int(x0 + (x1 - x0) * k / 6), y + 3)
    pa.pointer_up(); ac.perform(); time.sleep(0.6)


results = []
def check(name, ok, info=''):
    results.append(ok)
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'   -> {info}'))

def st(d):
    return d.execute_script("""
      const box = document.getElementById('text').getBoundingClientRect();
      const vis = [...document.querySelectorAll('#pages [data-i]')].filter(e => { const r = e.getBoundingClientRect();
        return r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1; });
      return { first: vis[0] ? +vis[0].dataset.i : null, last: vis.length ? +vis[vis.length-1].dataset.i : null, nvis: vis.length,
        page: document.getElementById('page-no').textContent, controls: document.getElementById('reader').classList.contains('controls'),
        flow: !document.getElementById('flow').hidden, word: document.getElementById('word').textContent,
        pct: document.getElementById('page-pct').textContent, scroll: document.getElementById('text').classList.contains('scroll'),
        errors: window.__errors || [] };""")

def word_text(d, i):
    return d.execute_script("const e = document.querySelector('#pages [data-i=\"' + arguments[0] + '\"]'); return e && e.textContent;", i)

def press(d, x, y, ms):
    ac = ActionChains(d); pa = ac.w3c_actions.pointer_action
    pa.move_to_location(x, y); pa.pointer_down(); pa.pause(ms / 1000); pa.pointer_up(); ac.perform(); time.sleep(0.4)

def pos_of_visible(d, k):
    return d.execute_script("""
      const box = document.getElementById('text').getBoundingClientRect();
      const vis = [...document.querySelectorAll('#pages [data-i]')].filter(e => { const r = e.getBoundingClientRect();
        return r.left >= box.left + box.width * 0.35 && r.right <= box.left + box.width * 0.65 && r.top >= box.top + 40 && r.bottom <= box.bottom - 40; });
      const e = vis[arguments[0]]; const r = e.getBoundingClientRect(); return [+e.dataset.i, Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];""", k)

d = browser()
try:
    d.get('http://localhost:8123/'); time.sleep(0.5)
    load_book(d)
    d.execute_script("window.__errors=[]; addEventListener('error', e => __errors.push(e.message)); addEventListener('unhandledrejection', e => __errors.push(String(e.reason)));")
    W = d.execute_script('return innerWidth'); H = d.execute_script('return innerHeight'); Y = H // 2
    s0 = st(d)
    check('opens on page 1 with controls', s0['page'].startswith('1 /') and s0['controls'] and s0['nvis'] > 20, s0)

    tap(d, W // 2, Y); s1 = st(d)
    check('tap middle hides controls', not s1['controls'], s1)
    check('hiding controls does not move text', s1['first'] == s0['first'] and s1['last'] == s0['last'], (s0, s1))
    tap(d, W // 2, Y); s2 = st(d)
    check('tap middle shows controls', s2['controls'], s2)
    check('showing controls does not move text', s2['first'] == s0['first'] and s2['last'] == s0['last'], (s0, s2))

    tap(d, W - 20, Y); s3 = st(d)
    check('tap right edge turns page (even with controls shown)', s3['page'].startswith('2 /') and s3['first'] == s0['last'] + 1, (s0, s3))
    tap(d, 20, Y); s4 = st(d)
    check('tap left edge turns back', s4['page'].startswith('1 /') and s4['first'] == s0['first'], s4)
    swipe(d, int(W * 0.8), int(W * 0.2), Y); s5 = st(d)
    check('swipe turns page', s5['page'].startswith('2 /'), s5)

    tap(d, W // 2, Y); d.find_element('css selector', '#play').click(); time.sleep(0.3); s6 = st(d)
    check('play starts from first word of the page', s6['flow'] and s6['word'].replace(' ', '') == word_text(d, s5['first']).replace(' ', ''), (s6['word'], word_text(d, s5['first'])))
    time.sleep(2.5)
    d.find_element('css selector', '#flow').click(); time.sleep(0.5); s7 = st(d)
    stopped = d.execute_script("return document.getElementById('word').textContent")
    check('pause returns to pages', not s7['flow'], s7)
    tap(d, W // 2, Y); d.find_element('css selector', '#play').click(); time.sleep(0.15); s8 = st(d)
    check('play after pause continues from the same word', s8['word'] == stopped, (stopped, s8['word']))
    d.find_element('css selector', '#flow').click(); time.sleep(0.5)
    s8b = st(d)
    check('page after pause shows the stopped word', s8b['first'] is not None, s8b)

    swipe(d, int(W * 0.8), int(W * 0.2), Y); s9 = st(d)
    check('swipe works after flow', s9['page'] != s8b['page'], (s8b['page'], s9['page']))

    i, x, y = pos_of_visible(d, 3)
    target = word_text(d, i)
    d.execute_script("window.__firstWord=null; new MutationObserver((m, o) => { if (!window.__firstWord) { window.__firstWord = document.getElementById('word').textContent; o.disconnect(); } }).observe(document.getElementById('word'), {subtree: true, childList: true, characterData: true});")
    press(d, x, y, 560); s10 = st(d); first = d.execute_script("return window.__firstWord")
    check('long press starts flow from pressed word', s10['flow'] and first.replace(' ', '') == target.replace(' ', ''), (target, first))
    d.find_element('css selector', '#flow').click(); time.sleep(0.5)
    tap(d, W - 20, Y); s11 = st(d)
    before = st(d); tap(d, W - 20, Y); after = st(d)
    check('page turns after long-press flow', after['first'] != before['first'], (before, after))

    # Scroll mode
    tap(d, W // 2, Y)
    if not st(d)['controls']: tap(d, W // 2, Y)
    d.find_element('css selector', '.top-bar [data-open-settings]').click(); time.sleep(0.4)
    d.find_element('css selector', '[data-setting="layout"] [data-value="scroll"]').click(); time.sleep(0.4)
    d.find_element('css selector', '#settings [data-close-sheet]').click(); time.sleep(0.4)
    s12 = st(d); m = d.execute_script("const t=document.getElementById('text'); return [t.scrollHeight, t.clientHeight, getComputedStyle(t).overflowY]")
    check('scroll mode switches on and is scrollable', s12['scroll'] and m[0] > m[1] * 2 and m[2] == 'auto', (s12, m))
    check('scroll mode keeps the reading place in view', s12['first'] is not None and s12['first'] <= after['first'] <= s12['last'], (after['first'], s12))
    d.execute_script("document.getElementById('text').scrollTop += 900"); time.sleep(0.8); s13 = st(d)
    check('scrolling hides controls and moves the reading place', not s13['controls'] and s13['pct'] != s12['pct'], (s12, s13))
    tap(d, W // 2, Y); s14 = st(d)
    check('tap in scroll mode shows controls without moving text', s14['controls'] and s14['first'] == s13['first'], (s13, s14))
    d.find_element('css selector', '#play').click(); time.sleep(0.15); s15 = st(d)
    check('play in scroll mode starts from first visible word', s15['flow'] and s15['word'].replace(' ', '') == word_text(d, s13['first']).replace(' ', ''), (s15['word'], word_text(d, s13['first'])))
    d.find_element('css selector', '#flow').click(); time.sleep(0.5)

    # back to pages, reopen
    tap(d, W // 2, Y)
    if not st(d)['controls']: tap(d, W // 2, Y)
    d.find_element('css selector', '.top-bar [data-open-settings]').click(); time.sleep(0.4)
    d.find_element('css selector', '[data-setting="layout"] [data-value="pages"]').click(); time.sleep(0.2)
    d.find_element('css selector', '[data-setting="size"] [data-value="L"]').click(); time.sleep(0.4)
    d.find_element('css selector', '#settings [data-close-sheet]').click(); time.sleep(0.4)
    s16 = st(d)
    check('back to pages with bigger text keeps place', (not s16['scroll']) and s16['page'] != '' and s16['nvis'] > 5, s16)
    d.find_element('css selector', '#back').click(); time.sleep(0.6)
    d.find_element('css selector', '[data-open]').click(); time.sleep(1); s17 = st(d)
    check('reopened book shows text at the same place', s17['nvis'] > 5 and s17['pct'] == s16['pct'], (s16, s17))
    check('no JavaScript errors', not s17['errors'], s17['errors'])
finally:
    d.quit()
print(f'{sum(results)}/{len(results)} passed')
sys.exit(0 if all(results) else 1)
