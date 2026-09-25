// Genre aus dem Internet: iTunes-Suche (Genre des Songs/Albums) + MusicBrainz (gewichtete Genres
// des Interpreten), kombiniert mit der Audio-Analyse. Ergebnis wird dauerhaft gecacht – jeder Song
// wird nur einmal nachgeschlagen. Ohne Internet bleibt einfach die Audio-Einordnung.
//
// Liefert je Track:
//   genreWeb – eine der Mix-Richtungen (pop/rap/edm/hardstyle/uptempo), bestimmt die Mix-Technik
//   style    – feiner Stil zum Gruppieren der Reihenfolge (z. B. "Schlager", "Techno", "Deutschrap")

import { detectGenre } from '../mix/genre.js';
import { tidyMeta } from './metadata.js';

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const STORE = 'automix.webgenre.v1';
const ARTIST_STORE = 'automix.webartist.v1';
const RETRY_FAILED_MS = 24 * 3600 * 1000;

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
}
function save(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* Speicher voll/gesperrt – dann eben ohne Cache */
  }
}

// ------------------------------------------------------------------ Titel/Interpret säubern

const JUNK = [
  /(^|\s)[\w-]+\.(com|net|org|to|cc|io|me)\b\s*[-–]?\s*/gi, // "SpotiDownloader.com - "
  /\s*[([](official\s*)?(music\s*)?(video|audio|lyrics?|lyric video|visualizer|hq|hd|4k|explicit|clean|radio edit|extended mix|original mix)[)\]]/gi,
  /\s*[([]?\s*(lyrics?|official video)\s*[)\]]?$/i,
  /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, // Emojis
];

export function cleanName(s) {
  let out = String(s || '');
  for (const re of JUNK) out = out.replace(re, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

const tokens = (s) => cleanName(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9äöüß]+/).filter((w) => w.length > 1 && !['feat', 'ft', 'the', 'and', 'mix', 'remix', 'edit', 'version'].includes(w));

export function trackKey(t) {
  return tokens(`${t.artist || ''} ${t.title || ''}`).sort().join(' ');
}

// ------------------------------------------------------------------ Tags -> Richtung/Stil

// Reihenfolge wichtig: spezifisch vor allgemein ("dance-pop" ist Pop, nicht Dance)
const TAG_RULES = [
  [/uptempo|terror|frenchcore|speedcore|gabber|hardcore techno|^hardcore$|happy hardcore/, 'uptempo'],
  [/hardstyle|rawstyle|jumpstyle|hard dance|hardtekk|hard ?tek|^tekk|tekk$|hard techno|schranz|krach|hardbass|puzzycore|hard house/, 'hardstyle'],
  [/dance[- ]?pop|electropop|synth[- ]?pop|europop|teen pop|k-pop|schlager|volksmusik|pop|rock|indie|ballad|singer|soul|r&b|rnb|latin|reggaeton|country|folk|disco|funk/, 'pop'],
  [/hip[- ]?hop|rap|trap|drill|grime|boom bap/, 'rap'],
  [/house|techno|trance|edm|electro|big room|dubstep|drum and bass|drum & bass|dnb|bass music|future bass|eurodance|dance|electronic|club|garage/, 'edm'],
];

function bucketOf(tag) {
  const t = tag.toLowerCase();
  // "pop rap"/"pop-rap" ist Rap, "dance-pop" Pop, "hardcore hip hop" Rap (kein Uptempo)
  if (/pop[- ]?rap|hip[- ]?hop|hardcore rap/.test(t)) return 'rap';
  for (const [re, g] of TAG_RULES) if (re.test(t)) return g;
  return null;
}

const ITUNES_MAP = {
  'hip-hop/rap': 'rap', 'hip hop': 'rap', 'rap': 'rap', 'deutschrap': 'rap',
  dance: 'edm', electronic: 'edm', house: 'edm', techno: 'edm', trance: 'edm', hardstyle: 'hardstyle', hardcore: 'uptempo',
  pop: 'pop', schlager: 'pop', rock: 'pop', 'r&b/soul': 'pop', 'singer/songwriter': 'pop', alternative: 'pop', latin: 'pop', 'german pop': 'pop', volksmusik: 'pop',
};

/**
 * Kombiniert Audio-Einordnung und Online-Daten zu einer Richtung. Online bestimmt die Familie,
 * das Audio entscheidet innerhalb (Uptempo vs. Hardstyle über das Tempo; "Rap"-Interpret mit
 * durchgehender Four-on-the-floor-Kick ist Dance-Pop, kein Rap).
 */
export function combineGenre(a, web) {
  const score = { pop: 0, rap: 0, edm: 0, hardstyle: 0, uptempo: 0 };
  const audio = detectGenre(a);
  score[audio] += 1;
  const ff = a.fourFloor ?? 0.5;
  // Eindeutig harte Musik im Audio (durchgehende Kick ab 142 BPM): ein "Rap"/"Pop"-Tag aus dem Netz
  // ist dann meist eine Verwechslung (gleichnamiger Künstler, zu wenige Stimmen) – zählt kaum
  const hardAudio = ff >= 0.6 && a.bpm >= 142;
  const add = (g, w) => {
    if (!g) return;
    if (hardAudio && (g === 'rap' || g === 'pop')) w *= 0.25;
    // Four-on-the-floor zwischen 115 und 140 BPM: kein Rap, sondern Dance-Pop/Club
    if (g === 'rap' && ff >= 0.6 && a.bpm >= 112 && a.bpm < 142) g = 'pop';
    // harte Familie: Tempo entscheidet
    if (g === 'hardstyle' || g === 'uptempo') g = a.bpm >= 168 ? 'uptempo' : a.bpm >= 138 ? 'hardstyle' : g;
    score[g] += w;
  };
  if (web.itunes) add(ITUNES_MAP[web.itunes.toLowerCase()] ?? bucketOf(web.itunes), 0.9);
  const tags = (web.tags || []).filter((t) => bucketOf(t.name)); // "2010s", "french" usw. zählen nicht
  const total = tags.reduce((s, t) => s + t.count, 0) || 1;
  const trust = Math.min(1, total / 4); // ein einzelner Tag mit 1 Stimme ist kaum belastbar
  for (const t of tags) add(bucketOf(t.name), (1.4 * trust * t.count) / total);
  const [best, bestScore] = Object.entries(score).sort((x, y) => y[1] - x[1])[0];
  return { genre: best, confidence: bestScore / (1 + 0.9 + 1.4) };
}

/**
 * Feiner Stil zum Gruppieren – passend zur ermittelten Richtung: das Song-Genre von iTunes, wenn es
 * dazu passt, sonst das stärkste passende Genre des Interpreten.
 */
export function styleOf(web, genre = null) {
  const fits = (name) => !genre || (ITUNES_MAP[name.toLowerCase()] ?? bucketOf(name)) === genre || (genre === 'uptempo' && bucketOf(name) === 'hardstyle') || (genre === 'hardstyle' && bucketOf(name) === 'uptempo');
  if (web.itunes && !/^(music|pop|dance|electronic)$/i.test(web.itunes) && fits(web.itunes)) return web.itunes;
  const top = (web.tags || []).filter((t) => bucketOf(t.name) && fits(t.name)).sort((x, y) => y.count - x.count)[0];
  if (top) return top.name.replace(/\b\w/g, (c) => c.toUpperCase());
  return web.itunes && fits(web.itunes) ? web.itunes : null;
}

// ------------------------------------------------------------------ Abfragen

async function getJson(url) {
  try {
    return JSON.parse(await invoke('web_get', { url }));
  } catch {
    // gedrosselt (503) o. ä.: kurz warten, einmal wiederholen
    await sleep(2500);
    return JSON.parse(await invoke('web_get', { url }));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** iTunes: bester Treffer für Interpret+Titel (Wort-Überlappung), sonst null. */
async function itunes(t) {
  const q = cleanName(`${t.artist || ''} ${t.title || ''}`);
  const j = await getJson(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=8`);
  const want = new Set(tokens(q));
  let best = null;
  for (const r of j.results || []) {
    const have = tokens(`${r.artistName} ${r.trackName}`);
    const hit = have.filter((w) => want.has(w)).length / Math.max(1, have.length);
    const back = have.filter((w) => want.has(w)).length / Math.max(1, want.size);
    const sc = Math.min(hit, back);
    if (!best || sc > best.sc) best = { sc, r };
  }
  return best && best.sc >= 0.5 ? { genre: best.r.primaryGenreName, artist: best.r.artistName, name: best.r.trackName, sc: best.sc } : null;
}

/** MusicBrainz: Genres/Tags des Interpreten (gewichtet), gecacht pro Interpret. */
async function musicbrainz(artist, artistCache) {
  const name = String(artist || '').trim();
  if (!name) return [];
  const key = name.toLowerCase();
  if (artistCache[key]) return artistCache[key];
  const j = await getJson(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=1`);
  const a = j.artists?.[0];
  const tags = a && a.score >= 90 ? (a.tags || []).filter((x) => x.count > 0).map((x) => ({ name: x.name, count: x.count })) : [];
  artistCache[key] = tags;
  return tags;
}

/**
 * Hängt gecachte Online-Genres synchron an (vor dem ersten Sortieren) und schlägt die fehlenden
 * im Hintergrund nach. onUpdate(tracks) kommt gebündelt, wenn neue Ergebnisse da sind.
 */
export function createWebGenre({ onUpdate }) {
  const cache = load(STORE);
  const artists = load(ARTIST_STORE);
  let running = false;
  const queue = [];

  const apply = (t, e) => {
    if (!e || e.failed || !t.analysis) return false;
    const { genre } = combineGenre(t.analysis, e);
    const style = styleOf(e, genre);
    const changed = t.genreWeb !== genre || t.style !== style;
    t.genreWeb = genre;
    t.style = style;
    t.webInfo = e;
    // Datei ohne Tags: Namen aus dem Dateinamen nur geraten -> sicheren Online-Treffer übernehmen
    if (t.tagged === false && e.name && e.artist) {
      const title = tidyMeta({ title: e.name, artist: e.artist });
      if (t.title !== title.title || t.artist !== title.artist) {
        t.title = title.title;
        t.artist = title.artist;
        return true;
      }
    }
    return changed;
  };

  function attach(tracks) {
    for (const t of tracks) apply(t, cache[trackKey(t)]);
  }

  async function run() {
    if (running) return;
    running = true;
    let batch = [];
    let all = [];
    let lastFlush = Date.now();
    let fails = 0;
    // Zwischendurch gebündelt melden; am Ende einmal alle (für ein einmaliges Neusortieren)
    const flush = (final = false) => {
      all = all.concat(batch);
      if (final) onUpdate(all, true);
      else if (batch.length) onUpdate(batch, false);
      batch = [];
      lastFlush = Date.now();
    };
    while (queue.length) {
      const t = queue.shift();
      const key = trackKey(t);
      const c = cache[key];
      if (c && !(c.failed && Date.now() - c.at > RETRY_FAILED_MS)) {
        if (apply(t, c)) batch.push(t);
        continue;
      }
      try {
        const it = await itunes(t);
        await sleep(1100); // MusicBrainz: höchstens 1 Anfrage pro Sekunde
        // bei "A & B" den Interpreten nehmen, der auch in der eigenen Datei steht
        const want = new Set(tokens(`${t.artist || ''} ${t.title || ''}`));
        const parts = String(it?.artist || t.artist || '').split(/\s*(?:,|&|\/|;| x | feat\.? | ft\.? | und | and | vs\.? )\s*/i).filter(Boolean);
        const artist = parts.find((x) => tokens(x).some((w) => want.has(w))) || parts[0] || '';
        const tags = await musicbrainz(artist, artists);
        const e = { itunes: it?.genre || null, artist: it?.artist || t.artist || '', tags: tags.slice(0, 8), at: Date.now() };
        // sicherer Treffer: richtiger Titel/Interpret für Dateien ohne Tags ("Titel - Interpret.mp3")
        if (it && it.sc >= 0.75) e.name = it.name;
        if (!e.itunes && !e.tags.length) e.failed = true;
        cache[key] = e;
        save(STORE, cache);
        save(ARTIST_STORE, artists);
        if (apply(t, e)) batch.push(t);
        fails = 0;
      } catch (err) {
        // nicht cachen (nächstes Mal wieder versuchen); dreimal in Folge = offline -> aufhören
        console.warn('Genre online nicht verfügbar:', t.title, err?.message || err);
        if (++fails >= 3) {
          queue.length = 0;
          break;
        }
      }
      if (Date.now() - lastFlush > 4000 || batch.length >= 10) flush();
      await sleep(2000); // iTunes erlaubt ~20 Anfragen pro Minute
    }
    flush(true);
    running = false;
  }

  /** Fehlende nachschlagen (die zuerst übergebenen zuerst). */
  function lookup(tracks) {
    const known = new Set(queue.map((t) => t.id));
    for (const t of tracks) {
      if (!t.analysis || known.has(t.id)) continue;
      const c = cache[trackKey(t)];
      if (c && !c.failed) continue;
      queue.push(t);
    }
    run();
  }

  return { attach, lookup, cached: (t) => cache[trackKey(t)] || null };
}
