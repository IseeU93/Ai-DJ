// IndexedDB-Cache für Analysen (Schlüssel: Pfad + Größe + Änderungsdatum + Analyse-Version).
const DB = 'automix';
const STORE = 'analysis';

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const cacheGet = (key) => tx('readonly', (s) => s.get(key)).catch(() => undefined);
export const cachePut = (key, value) => tx('readwrite', (s) => s.put(value, key)).catch(() => {});

const SETTINGS = 'automix.settings';

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS)) || {};
  } catch {
    return {};
  }
}

export function saveSettings(patch) {
  try {
    localStorage.setItem(SETTINGS, JSON.stringify({ ...loadSettings(), ...patch }));
  } catch {
    /* privater Modus o.ä. – egal */
  }
}
