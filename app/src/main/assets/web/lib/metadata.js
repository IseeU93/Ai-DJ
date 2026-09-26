// Titel/Interpret aus ID3v2 (mp3) bzw. Vorbis-Comments (flac/ogg), sonst aus dem Dateinamen.

function decodeText(bytes, enc) {
  try {
    if (enc === 0) return new TextDecoder('latin1').decode(bytes);
    if (enc === 1) return new TextDecoder('utf-16').decode(bytes);
    if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

const clean = (s) => s.replace(/\u0000/g, '').trim();

function parseId3(view) {
  if (view.byteLength < 10 || view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return {};
  const ver = view.getUint8(3);
  const syncsafe = (o) => (view.getUint8(o) << 21) | (view.getUint8(o + 1) << 14) | (view.getUint8(o + 2) << 7) | view.getUint8(o + 3);
  const size = syncsafe(6);
  const end = Math.min(view.byteLength, 10 + size);
  const out = {};
  let o = 10;
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  while (o + hdrLen < end) {
    let id = '';
    for (let i = 0; i < idLen; i++) id += String.fromCharCode(view.getUint8(o + i));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let len;
    if (ver === 2) len = (view.getUint8(o + 3) << 16) | (view.getUint8(o + 4) << 8) | view.getUint8(o + 5);
    else if (ver === 4) len = syncsafe(o + 4);
    else len = view.getUint32(o + 4);
    const body = o + hdrLen;
    if (len <= 0 || body + len > end) break;
    const key = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist' }[id];
    if (key && !out[key]) {
      const enc = view.getUint8(body);
      out[key] = clean(decodeText(new Uint8Array(view.buffer, view.byteOffset + body + 1, len - 1), enc));
    }
    o = body + len;
  }
  return out;
}

function parseVorbis(bytes) {
  const out = {};
  const limit = Math.min(bytes.length, 256 * 1024);
  const find = (tag) => {
    const needle = new TextEncoder().encode(tag);
    outer: for (let i = 4; i < limit - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        const c = bytes[i + j];
        const n = needle[j];
        if (c !== n && c !== n + 32) continue outer; // Groß/klein
      }
      const len = bytes[i - 4] | (bytes[i - 3] << 8) | (bytes[i - 2] << 16) | (bytes[i - 1] << 24);
      if (len > needle.length && len < 1024) {
        return clean(new TextDecoder('utf-8').decode(bytes.subarray(i + needle.length, i + len)));
      }
    }
    return '';
  };
  const title = find('TITLE=');
  const artist = find('ARTIST=');
  if (title) out.title = title;
  if (artist) out.artist = artist;
  return out;
}

export function fromFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ')
    .replace(/^[\w-]+\.(com|net|org|to|cc|io|me)\s*[-–]\s*/i, '') // Download-Seite vorne dran ("xyz.com - ")
    .replace(/^\d{1,3}[\s.\-_]+/, '');
  const m = /^(.+?)\s+[-–]\s+(.+)$/.exec(base);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base.trim() };
}

// Zusätze aus YouTube-/Download-Titeln, die nicht zum Songnamen gehören
const TITLE_JUNK = [
  /\s*[([](official\s*)?(music\s*)?(video|audio|lyrics?|lyric video|visualizer|hq|hd|4k)[)\]]/gi,
  /\s*[([]\s*(lyrics?|official video|official audio)\s*[)\]]\s*$/i,
  /[\u{1F300}-\u{1FAFF}☀-➿]/gu, // Emojis
];

/**
 * Einheitliche Schreibweise: mehrere Interpreten ("A/B", "A; B", ID3-Nullbytes) als "A, B",
 * Download-Seiten, "(Lyrics)"/"(Official Video)", Emojis und doppelte Leerzeichen raus.
 * Gilt auch für schon analysierte (gecachte) Tracks.
 */
export function tidyMeta(meta) {
  const fix = (s) => {
    let out = String(s || '').replace(/\u0000+/g, '/').replace(/^[\w-]+\.(com|net|org|to|cc|io|me)\s*[-–]\s*/i, '');
    for (const re of TITLE_JUNK) out = out.replace(re, ' ');
    return out.replace(/\s+/g, ' ').trim();
  };
  const parts = fix(meta.artist).split(/\s*[/;]\s*/).filter(Boolean);
  // "AC/DC" bleibt zusammen: nur trennen, wenn alle Teile echte Namen sind
  const artist = parts.length > 1 && parts.every((x) => x.length >= 3) ? parts.join(', ') : fix(meta.artist);
  return { ...meta, title: fix(meta.title), artist };
}

export function readMetadata(buffer, filename) {
  const bytes = new Uint8Array(buffer);
  let meta = parseId3(new DataView(buffer));
  if (!meta.title) meta = { ...parseVorbis(bytes), ...meta };
  const fallback = fromFilename(filename);
  return tidyMeta({
    title: meta.title || fallback.title,
    artist: meta.artist || fallback.artist,
    tagged: !!meta.title, // echte Tags – sonst nur aus dem Dateinamen geraten (darf online korrigiert werden)
  });
}
