// Musikwunsch in Worten ("was Ruhigeres", "Schlager", "härter", "Hip-Hop", "schneller", "130 BPM",
// "Helene Fischer") -> passende Songs, die als Nächstes kommen. Läuft komplett lokal: Stichworte
// werden auf das abgebildet, was über jeden Song bekannt ist (Richtung, Online-Stil, Tanzbarkeit,
// Energie, Tempo, Interpret/Titel).

import { danceability, transitionCost } from './order.js';

const GENRE_WORDS = [
  [/\b(hip[- ]?hop|hiphop|rap|deutschrap|trap|rnb|r&b|drill)\b/, 'rap'],
  [/\b(house|techno|edm|elektro|electro|electronic|club|trance|dance)\b/, 'edm'],
  [/\b(hardstyle|rawstyle|jumpstyle)\b/, 'hardstyle'],
  [/\b(uptempo|hardcore|frenchcore|terror|gabber|krach|hardtekk|tekk|schranz)\b/, 'uptempo'],
  [/\b(pop|charts?|hits?|mainstream|radio)\b/, 'pop'],
];
// feinere Stile: gegen Online-Stil/Tags/iTunes-Genre geprüft
const STYLE_WORDS = [
  [/\bschlager\b/, /schlager|german pop|volksmusik/],
  [/\b(deutsch|deutsche|german)\b/, /german|deutsch|schlager/],
  [/\brock\b/, /rock/],
  [/\b(latin|reggaeton|latino)\b/, /latin|reggaeton/],
  [/\b(disco|funk)\b/, /disco|funk/],
  [/\beurodance\b/, /eurodance|europop/],
  [/\b(80er|achtziger|80s)\b/, /80s|1980s|new wave|synth-?pop/],
  [/\b(90er|neunziger|90s)\b/, /90s|1990s|eurodance/],
];
const CALM = /\b(ruhig\w*|chill\w*|entspann\w*|langsam\w*|gefühl\w*|ballade\w*|romant\w*|kuschel\w*|traurig\w*|soft\w*|sanft\w*|emotional\w*|slow|runter\w*)\b/;
const PARTY = /\b(party|abgeh\w*|eskal\w*|stimmung|feier\w*|tanz\w*|banger|hype|knall\w*|action|abriss|mitsing\w*|gute laune)\b/;
const HARDER = /\b(härter|hart|harte|krass\w*|heftig\w*|power|mehr bass|lauter|energie|energischer|druck)\b/;
const SOFTER = /\b(weniger hart|softer|leiser|weicher|entspannter)\b/;
const FASTER = /\b(schneller|fast|speed|tempo hoch|mehr tempo)\b/;
const SLOWER = /\b(langsamer|weniger tempo|tempo runter)\b/;
const STOP = new Set(['was', 'etwas', 'mal', 'bitte', 'mehr', 'noch', 'jetzt', 'als', 'nächstes', 'naechstes', 'musik', 'lieder', 'songs', 'song', 'lied', 'und', 'oder', 'von', 'mit', 'ein', 'eine', 'einen', 'der', 'die', 'das', 'den', 'dem', 'wie', 'so', 'gerne', 'gern', 'ich', 'will', 'möchte', 'hätte', 'haben', 'spiel', 'spiele', 'spielen', 'richtung', 'art', 'sachen', 'zeug', 'weniger', 'viel', 'sehr', 'nur', 'auch', 'zu', 'zum', 'für', 'bpm', 'tempo']);

/** Wunsch-Text -> Kriterien. `summary` beschreibt, was verstanden wurde. */
export function parseWish(text) {
  const t = ` ${String(text || '').toLowerCase().replace(/[.,!?;:]+/g, ' ')} `;
  const w = { genres: new Set(), styles: [], mood: 0, energy: 0, tempo: 0, bpm: null, terms: [], summary: [] };
  for (const [re, g] of GENRE_WORDS) if (re.test(t)) w.genres.add(g);
  for (const [re, style] of STYLE_WORDS) if (re.test(t)) w.styles.push({ re: style, word: t.match(re)[0].trim() });
  // "schlager" allein ist kein Pop-Wunsch im Allgemeinen – der Stil reicht
  if (CALM.test(t) && !/\bnicht (so )?ruhig/.test(t)) w.mood = -1;
  if (PARTY.test(t)) w.mood = 1;
  if (SOFTER.test(t)) w.energy = -1;
  else if (HARDER.test(t)) w.energy = 1;
  if (SLOWER.test(t)) w.tempo = -1;
  else if (FASTER.test(t)) w.tempo = 1;
  const bpm = t.match(/(\d{2,3})\s*bpm/);
  if (bpm) w.bpm = +bpm[1];
  // übrige Wörter: Interpret/Titel ("helene fischer", "sub zero project")
  const known = [CALM, PARTY, HARDER, SOFTER, FASTER, SLOWER, ...GENRE_WORDS.map((x) => x[0]), ...STYLE_WORDS.map((x) => x[0])];
  for (const word of t.trim().split(/\s+/)) {
    if (word.length < 3 || STOP.has(word) || /^\d+$/.test(word)) continue;
    if (known.some((re) => re.test(` ${word} `))) continue;
    w.terms.push(word);
  }
  const G = { pop: 'Pop', rap: 'Rap/Hip-Hop', edm: 'House/EDM', hardstyle: 'Hardstyle', uptempo: 'Uptempo/Hardcore' };
  if (w.genres.size) w.summary.push([...w.genres].map((g) => G[g]).join(' / '));
  if (w.styles.length) w.summary.push(w.styles.map((s) => s.word[0].toUpperCase() + s.word.slice(1)).join(', '));
  if (w.mood) w.summary.push(w.mood < 0 ? 'ruhiger' : 'Party');
  if (w.energy) w.summary.push(w.energy > 0 ? 'härter' : 'weicher');
  if (w.tempo) w.summary.push(w.tempo > 0 ? 'schneller' : 'langsamer');
  if (w.bpm) w.summary.push(`um ${w.bpm} BPM`);
  if (w.terms.length) w.summary.push(`„${w.terms.join(' ')}“`);
  w.empty = !w.summary.length;
  return w;
}

const styleText = (t) => [t.style, t.webInfo?.itunes, ...(t.webInfo?.tags || []).map((x) => x.name)].filter(Boolean).join(' ').toLowerCase();
const nameText = (t) => `${t.artist || ''} ${t.title || ''}`.toLowerCase();

/**
 * Wie gut passt Track t zum Wunsch (ausgehend vom laufenden Track cur)? null = passt nicht.
 * Harte Kriterien (Richtung, Stil, Interpret) müssen passen, weiche (Stimmung, Energie, Tempo)
 * sortieren innerhalb.
 */
export function wishScore(t, w, cur) {
  let s = 0;
  if (w.genres.size) {
    if (!w.genres.has(t.genre)) return null;
    s += 2;
  }
  if (w.styles.length) {
    const st = styleText(t);
    const hit = w.styles.filter((x) => x.re.test(st)).length;
    if (!hit) return null;
    s += 2 * hit;
  }
  if (w.terms.length) {
    const n = nameText(t);
    const hit = w.terms.filter((x) => n.includes(x)).length;
    if (!hit) {
      // unbekannte Wörter sind vielleicht ein Stil ("reggae"), kein Name
      const st = styleText(t);
      if (!w.terms.some((x) => st.includes(x))) return null;
      s += 1;
    } else s += 3 * hit;
  }
  const d = danceability(t);
  const e0 = t.energy ?? 0.5;
  if (w.mood < 0) {
    // "ruhig" heißt nie Hardstyle/Uptempo, nichts Rasendes und nichts mit voller Wucht –
    // egal wie die Tanzbarkeit ausfällt
    if (['hardstyle', 'uptempo', 'edm'].includes(t.genre) || (t.analysis?.bpm ?? 120) >= 145 || e0 >= 0.72) return null;
    const st = styleText(t);
    if (/house|techno|electro|trance|eurodance|club|dance|hardstyle|party|schlager-?party|après/.test(st) && !/ballad|acoustic|singer|folk/.test(st)) return null;
    const bpm0 = t.analysis?.bpm ?? 120;
    s += (0.55 - d) * 5 + (0.5 - e0) * 3
      - (bpm0 >= 125 ? 1.2 : 0) - ((t.analysis?.fourFloor ?? 0.5) >= 0.75 ? 0.8 : 0)
      + (/ballad|acoustic|singer|folk|soul|piano/.test(st) ? 1 : 0);
  }
  if (w.mood > 0) s += (d - 0.5) * 5;
  const e = t.energy ?? 0.5;
  const ce = cur?.energy ?? 0.5;
  if (w.energy > 0) s += (e - ce) * 4 + (['hardstyle', 'uptempo'].includes(t.genre) ? 1 : 0);
  if (w.energy < 0) s += (ce - e) * 4;
  const bpm = t.analysis?.bpm ?? 120;
  const cb = cur?.analysis?.bpm ?? 120;
  if (w.tempo > 0) s += Math.max(-2, Math.min(2, (bpm - cb) / 10));
  if (w.tempo < 0) s += Math.max(-2, Math.min(2, (cb - bpm) / 10));
  if (w.bpm) s -= Math.min(3, Math.abs(bpm - w.bpm) / 8);
  // nur weiche Kriterien: klar in die gewünschte Richtung, sonst nicht
  const hard = w.genres.size || w.styles.length || w.terms.length;
  if (!hard && s <= 0.4) return null;
  // bei Gleichstand lieber gut mixbare Songs
  if (cur) s -= 0.1 * transitionCost(cur, t);
  return s;
}

/**
 * Wählt bis zu `max` passende Songs und bringt sie in eine gut mixbare Reihenfolge (jeweils der
 * am besten anschließende zuerst, beginnend beim laufenden Track).
 */
export function pickWish(candidates, w, cur, max = 8) {
  const scored = candidates.map((t) => ({ t, s: wishScore(t, w, cur) })).filter((x) => x.s !== null);
  scored.sort((x, y) => y.s - x.s);
  const chosen = scored.slice(0, max).map((x) => x.t);
  const out = [];
  let prev = cur;
  const pool = [...chosen];
  while (pool.length) {
    let bi = 0;
    if (prev) {
      let bc = Infinity;
      pool.forEach((t, i) => {
        const c = transitionCost(prev, t);
        if (c < bc) {
          bc = c;
          bi = i;
        }
      });
    }
    prev = pool.splice(bi, 1)[0];
    out.push(prev);
  }
  return out;
}
