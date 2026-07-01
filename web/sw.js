/* Service worker: app-shell cache + Web Share Target receiver.
   All URLs are resolved against the registration scope so the app works at
   any mount point (site root, path-prefix proxies, …). */
const CACHE = 'selphy-shell-v2';
const SCOPE = self.registration.scope; // absolute, ends with '/'
const scopeUrl = (p) => new URL(p, SCOPE).toString();

const SHELL = [
  './',
  'app.js',
  'style.css',
  'db.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/inter-400.woff2',
  'vendor/inter-500.woff2',
  'vendor/inter-600.woff2',
  'vendor/inter-700.woff2',
].map(scopeUrl);

const SHARE_PATH = new URL('share-target', SCOPE).pathname;
const API_PREFIX = new URL('api/', SCOPE).pathname;
const ROOT_PATH = new URL(SCOPE).pathname;

self.addEventListener('install', (evt) => {
  evt.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evt) => {
  const url = new URL(evt.request.url);

  // Web Share Target: Android POSTs the shared images here.
  if (evt.request.method === 'POST' && url.pathname === SHARE_PATH) {
    evt.respondWith(handleShare(evt));
    return;
  }

  if (evt.request.method !== 'GET') return;
  // Network-first for API, cache-first for the shell.
  if (url.pathname.startsWith(API_PREFIX)) return;

  evt.respondWith(
    caches.match(evt.request, { ignoreSearch: url.pathname === ROOT_PATH }).then(
      (hit) =>
        hit ||
        fetch(evt.request).then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(evt.request, copy));
          }
          return res;
        })
    )
  );
});

async function handleShare(evt) {
  // Persist files to IndexedDB *before* redirecting, so the opening page
  // reliably finds them (waitUntil-after-redirect races the page load).
  try {
    const formData = await evt.request.formData();
    const files = formData.getAll('images').filter((f) => f && f.size > 0);
    if (files.length) {
      const stored = await storeShared(files);
      notifyClients(stored);
    }
  } catch (err) {
    // Fall through to the app; it will show an empty state.
    console.error('share-target error', err);
  }
  return Response.redirect(scopeUrl('./?shared=' + Date.now()), 303);
}

function notifyClients(ids) {
  try {
    new BroadcastChannel('selphy-share').postMessage({ type: 'shared', ids });
  } catch {}
}

/* Minimal IndexedDB access — kept in sync with ./db.js (same DB/schema). */
const DB_NAME = 'selphy';
const STORE = 'inbox';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeShared(files) {
  const db = await openDb();
  const ids = [];
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const f of files) {
      const req = store.add({
        blob: f,
        name: f.name || 'shared.jpg',
        type: f.type || 'image/jpeg',
        addedAt: Date.now(),
      });
      req.onsuccess = () => ids.push(req.result);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return ids;
}
