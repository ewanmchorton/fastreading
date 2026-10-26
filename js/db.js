// Books live in IndexedDB on the device: "meta" holds the small per-book record
// (title, progress), "content" holds the text itself.

const DB_NAME = 'fastreading';
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta', { keyPath: 'id' });
        req.result.createObjectStore('content', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx);
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
  }));
}

export async function listBooks() {
  const all = await run('meta', 'readonly', (tx) => tx.objectStore('meta').getAll());
  return all.sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
}

export function getMeta(id) {
  return run('meta', 'readonly', (tx) => tx.objectStore('meta').get(id));
}

export function getContent(id) {
  return run('content', 'readonly', (tx) => tx.objectStore('content').get(id));
}

export function saveMeta(meta) {
  return run('meta', 'readwrite', (tx) => { tx.objectStore('meta').put(meta); });
}

export function addBook(meta, content) {
  return run(['meta', 'content'], 'readwrite', (tx) => {
    tx.objectStore('meta').put(meta);
    tx.objectStore('content').put({ id: meta.id, ...content });
  });
}

export function deleteBook(id) {
  return run(['meta', 'content'], 'readwrite', (tx) => {
    tx.objectStore('meta').delete(id);
    tx.objectStore('content').delete(id);
  });
}
