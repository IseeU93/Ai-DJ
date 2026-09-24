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

const GRID = 'automix.grid';

/** Manuelle Beatgrid-Korrektur pro Datei ({ bpmFactor, shiftSec, downbeatSec }) oder null. */
export function gridOverride(path) {
  try {
    return (JSON.parse(localStorage.getItem(GRID)) || {})[path] || null;
  } catch {
    return null;
  }
}

export function setGridOverride(path, ov) {
  try {
    const all = JSON.parse(localStorage.getItem(GRID)) || {};
    if (ov) all[path] = ov;
    else delete all[path];
    localStorage.setItem(GRID, JSON.stringify(all));
  } catch {
    /* egal */
  }
}

const GENRE = 'automix.genre';

/** Manuelle Musikrichtung: pro Datei (Schlüssel = Pfad) und pro Playlist (Schlüssel = "ordner|playlist"). */
export function genreOverrides() {
  try {
    return JSON.parse(localStorage.getItem(GENRE)) || {};
  } catch {
    return {};
  }
}

export function setGenreOverride(key, genre) {
  try {
    const all = genreOverrides();
    if (genre) all[key] = genre;
    else delete all[key];
    localStorage.setItem(GENRE, JSON.stringify(all));
  } catch {
    /* egal */
  }
}

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
