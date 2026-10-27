// Offline support: online, files always come from the network (so an update shows up
// right away and old and new files never mix); offline, from the cache.
const VERSION = 'fr-v2';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'fonts/fonts.css',
  'fonts/literata-latin.woff2',
  'fonts/literata-latin-ext.woff2',
  'fonts/literata-cyrillic.woff2',
  'fonts/literata-cyrillic-ext.woff2',
  'fonts/inter-latin.woff2',
  'fonts/inter-latin-ext.woff2',
  'fonts/inter-cyrillic.woff2',
  'fonts/inter-cyrillic-ext.woff2',
  'js/app.js',
  'js/db.js',
  'js/parsers.js',
  'js/text.js',
  'js/zip.js',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
// pdf.js is large: cached the first time a PDF is opened.
const LAZY = ['vendor/pdfjs/'];
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.registration.scope).pathname));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    try {
      const res = await fetch(e.request, { cache: 'no-cache' });
      if (res.ok && (SHELL_PATHS.has(url.pathname) || LAZY.some((p) => url.pathname.includes(p)))) {
        cache.put(e.request, res.clone());
      }
      return res;
    } catch (err) {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  }));
});
