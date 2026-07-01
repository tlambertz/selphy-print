/* IndexedDB inbox shared between the service worker and the page.
   Schema must stay in sync with sw.js. */
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

export async function inboxAdd(files) {
  const db = await openDb();
  const ids = [];
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    for (const f of files) {
      const req = tx.objectStore(STORE).add({
        blob: f,
        name: f.name || 'image.jpg',
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

export async function inboxAll() {
  const db = await openDb();
  const items = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return items;
}

export async function inboxDelete(ids) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    for (const id of ids) tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function inboxClear() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
