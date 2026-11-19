// db.js: on-device storage (IndexedDB). Nothing here touches the network.
export const DB_NAME = 'postmatch';
export const SCHEMA_VERSION = 1;

// One step per version, run in order on upgrade. Add a new step for each new
// version; never edit an old one, or phones already on that version will skip it.
const MIGRATIONS = {
  1: db => {
    const m = db.createObjectStore('matches', { keyPath: 'id', autoIncrement: true });
    m.createIndex('date', 'date');
    m.createIndex('hero', 'hero');
    db.createObjectStore('settings');
  },
};

let dbPromise = null;
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, SCHEMA_VERSION);
    req.onupgradeneeded = e => {
      for (let v = e.oldVersion + 1; v <= SCHEMA_VERSION; v++) MIGRATIONS[v](req.result, req.transaction);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Storage is busy in another tab.'));
  }).catch(e => { dbPromise = null; throw e; });
  return dbPromise;
}

const reqDone = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

async function run(store, mode, fn) {
  const db = await openDb();
  const t = db.transaction(store, mode);
  const finished = txDone(t);
  const result = await fn(t.objectStore(store));
  await finished;
  return result;
}

export const allMatches = () => run('matches', 'readonly', s => reqDone(s.getAll()));
export const putMatch = m => run('matches', 'readwrite', s => reqDone(s.put(m)));
export const deleteMatch = id => run('matches', 'readwrite', s => reqDone(s.delete(id)));
export const getSettings = () => run('settings', 'readonly', s => reqDone(s.get('app')));
export const putSettings = v => run('settings', 'readwrite', s => reqDone(s.put(v, 'app')));

// Replace everything in one transaction (used by restore): all or nothing.
export async function replaceAll(matches, settings) {
  const db = await openDb();
  const t = db.transaction(['matches', 'settings'], 'readwrite');
  const finished = txDone(t);
  const ms = t.objectStore('matches');
  ms.clear();
  for (const m of matches) ms.put(m);
  if (settings) t.objectStore('settings').put(settings, 'app');
  await finished;
}
