// Match a place name, as the traveller wrote it, to a place in the saved travel pack. Code only, no AI call.
//
// The AI copies the name from the question as written ("gyeongbuk palace", "Anguk stn exit 6", "MMCA",
// "n seoul tower"). This file decides which saved place it is, or that the pack has no such place:
//   - case, accents, hyphens, spaces and possessives do not matter ("Insa-dong" = "insadong" = "Insadong's");
//   - common spellings of Korean names are folded together ("eo"/"o", "oo"/"u", "k"/"g" at the start, double letters);
//   - one wrong letter in a word of 5 or more letters, two in a word of 9 or more, and swapped letters are allowed;
//   - an English place word joins the name as its Korean ending ("Jogye Temple" = "Jogyesa", "Gyeongbok Palace" =
//     "Gyeongbokgung", "Gwanghwa Gate" = "Gwanghwamun"); short forms like "stn" and "sq" are read out;
//   - initials of a name count as the name ("MMCA", "NFMK").
// Every word of the phrase must be found in one name of the place, except small words (the, of, old, main …) and the
// city's name. A place word the place lacks ("tower" for a museum) rules the place out. When nothing fits, the result
// says so and gives the closest names, so the app never answers about another place as if it were the one asked for.
import { fold, stem } from './pick.js';
import { leg } from './geo.js';

const SOFT = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'at', 'in', 'on', 'near', 'by', 'please', 'my', 'our', 'this', 'that', 'there', 'some', 'any',
  'old', 'main', 'big', 'great', 'famous', 'royal', 'nice', 'little', 'small', 'front', 'entrance', 'area', 'place', 'spot', 'one', 'called', 'named',
  'seoul', 'korea', 'korean', 'south', 'city', 'downtown', 'nearest', 'closest', 'local', 'nearby', 'around', 'close', 'good', 'best', 'cheap', 'open', 'anywhere', 'somewhere', 'anything', 'something', 'everywhere',
  // words for where the traveller is and words of the asking, never part of a name: the on-device model sometimes
  // copies them as the place ("near me", "from here", "where could we go"); a phrase made only of them names no place.
  // ("can" is left out: it is a name here, "Can Dumplings")
  'here', 'i', 'me', 'us', 'we', 'you', 'myself', 'where', 'what', 'which', 'how', 'is', 'are', 'am', 'do', 'does', 'could', 'should', 'would', 'will',
  'go', 'going', 'head', 'heading', 'get', 'find', 'from', 'for', 'right', 'now', 'today', 'tonight', 'still', 'early']);
// Place words in English: a phrase word of this kind must be in the place's name or type.
const PLACE_WORDS = new Set(['palace', 'temple', 'gate', 'village', 'street', 'road', 'hall', 'pavilion', 'museum', 'station', 'exit', 'park', 'square',
  'library', 'house', 'tower', 'market', 'bridge', 'mountain', 'statue', 'shrine', 'garden', 'alley', 'lane', 'observatory', 'center', 'centre',
  'information', 'restaurant', 'cafe', 'teahouse', 'bakery', 'bank', 'pharmacy', 'toilet', 'restroom', 'art', 'gallery', 'plaza', 'building', 'church',
  'cathedral', 'mall', 'hotel', 'university', 'hospital', 'airport', 'stadium', 'river', 'stream', 'lake', 'pond', 'watchtower', 'residence', 'hanok',
  'viewpoint', 'lookout', 'school', 'office', 'shop', 'store', 'theater', 'theatre', 'cinema', 'zoo', 'tea', 'bar', 'pub', 'monument', 'memorial', 'atm',
  'subway', 'metro', 'line', 'terminal', 'stop', 'complex', 'gil', 'ro', 'dong']);
// English place word -> the Korean ending it stands for in a name.
const ENDING = { palace: 'gung', temple: 'sa', gate: 'mun', street: 'gil', road: 'ro', village: 'maeul', hall: 'jeon', pavilion: 'jeong', market: 'sijang' };
const SHORT = { stn: 'station', sta: 'station', st: 'street', sq: 'square', rd: 'road', mus: 'museum', ave: 'avenue', ctr: 'center', mt: 'mountain', nat: 'national', natl: 'national', no: 'number' };
const CITY = new Set(['seoul', 'korea', 'korean']);
const SELF = /^(here|me|us|my (place|hotel|hostel|room)|where (i|we) (am|are)|this place|current location|my location)$/;

const tokens = (s) => fold(s).replace(/['’]s\b/g, '').replace(/&/g, ' and ').replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z]{3,})/g, '$1 $2')
  .split(/[^a-z0-9가-힣]+/).filter(Boolean).map((w) => SHORT[w] ?? w);
/** A spelling key: folds common ways of writing the same Korean sound. */
export const key = (w) => {
  let k = String(w).toLowerCase();
  k = k.replace(/eo/g, 'o').replace(/eu/g, 'u').replace(/oo/g, 'u').replace(/ae/g, 'e').replace(/ee/g, 'i').replace(/ie/g, 'i').replace(/wo/g, 'o');
  k = k.replace(/([a-z])\1+/g, '$1');
  k = k.replace(/^k(?=[a-z])/, 'g').replace(/^ch/, 'j').replace(/^p(?=[aeiouy])/, 'b').replace(/^t(?=[aeiouy])/, 'd');
  return k;
};
/** Edit distance with swapped neighbours counted as one (Damerau, optimal string alignment). */
function dist(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
/**
 * How well one written word fits one word of a name: 1 same, 0.9 a clear start of it ("kimchi" for "Kimchikan"),
 * 0.8 a small typo, 0 not. A start counts only between single words (`prefix`), never for words written together.
 * Two wrong letters are allowed only in words of 12 or more letters: Korean palace names differ by two letters
 * ("Changgyeonggung" is not "Changdeokgung").
 */
export function wordFit(q, a, prefix = true) {
  if (q === a) return 1;
  if (/^\d+$/.test(q) || /^\d+$/.test(a)) return q.replace(/(st|nd|rd|th)$/, '') === a.replace(/(st|nd|rd|th)$/, '') ? 1 : 0;
  if (stem(q) === stem(a)) return 1;
  const kq = key(q);
  const ka = key(a);
  if (kq === ka) return 1;
  const short = Math.min(kq.length, ka.length);
  if (prefix && short >= 5 && (ka.startsWith(kq) || kq.startsWith(ka))) return 0.9;
  if (kq[0] !== ka[0] || short < 5) return 0;
  const d = dist(kq, ka);
  if (d <= 1 || (d <= 2 && short >= 12)) return 0.8;
  return 0;
}

// ---------------------------------------------------------------- names of the pack
const cache = new WeakMap();
function namesOf(pack) {
  if (cache.has(pack)) return cache.get(pack);
  const places = pack.places ?? [];
  // area words: a word (or joined pair) in three or more names says where, not which place ("insadong", "anguk")
  const seen = new Map();
  for (const p of places) {
    const ts = tokens(p.name);
    const all = new Set([...ts, ...ts.slice(1).map((w, i) => ts[i] + w)]);
    for (const w of all) seen.set(w, (seen.get(w) ?? 0) + 1);
  }
  const area = new Set([...seen].filter(([w, n]) => n >= 3 && !PLACE_WORDS.has(w) && !/^\d/.test(w)).map(([w]) => w));
  const entries = [];
  for (const p of places) {
    const typeWords = new Set(tokens(p.type));
    const aliases = [];
    const name = String(p.name ?? '');
    const main = name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    aliases.push({ text: main, how: 'name' });
    for (const m of name.matchAll(/\(([^)]*)\)/g)) {
      const inner = m[1].trim();
      const compact = tokens(inner).join('');
      const its = tokens(inner);
      if (!inner || area.has(compact) || its.every((w) => area.has(w)) || its.every((w) => PLACE_WORDS.has(w))) continue; // "(Insadong)", "(Anguk)", "(ATM)": where or what, not a name
      aliases.push({ text: inner, how: 'name' });
    }
    if (main.includes(':')) for (const part of main.split(':')) if (part.trim()) aliases.push({ text: part.trim(), how: 'name' });
    // initials of a name of three or more words ("National Folk Museum of Korea" -> "nfmk")
    for (const a of [...aliases]) {
      const caps = a.text.split(/[^A-Za-z]+/).filter((w) => w && !/^(of|the|and)$/i.test(w));
      if (caps.length >= 3) aliases.push({ text: caps.map((w) => w[0]).join(''), how: 'initials', single: true });
      if (/^[A-Z]{3,6}$/.test(caps[0] ?? '')) aliases.push({ text: caps[0], how: 'initials', single: true });
    }
    // fixed-time events and the hours note name things a traveller may ask for ("the guard changing ceremony")
    const facts = [...(p.events ?? []).map((e) => e.name)].filter(Boolean);
    entries.push({ p, typeWords, aliases: aliases.map((a) => ({ ...a, ts: tokens(a.text) })), facts: facts.map((f) => tokens(f)), ko: String(p.nameKo ?? '').replace(/\s+/g, '') });
  }
  const out = { entries, area, freq: seen };
  cache.set(pack, out);
  return out;
}

/** Units of a word list: each word, and two or three neighbouring words written as one ("insa dong" -> "insadong"). */
function units(ts) {
  const out = ts.map((w, i) => ({ w, from: i, to: i }));
  for (let n = 2; n <= 3; n += 1) for (let i = 0; i + n <= ts.length; i += 1) out.push({ w: ts.slice(i, i + n).join(''), from: i, to: i + n - 1 });
  return out;
}

/** How one alias of a place covers the phrase. Returns null when a phrase word is not in the alias. */
function cover(qts, alias, typeWords, freq, nPlaces) {
  const qUnits = units(qts);
  // an English place word after a name word also stands for its Korean ending ("jogye temple" -> "jogyesa")
  for (let i = 1; i < qts.length; i += 1) if (ENDING[qts[i]]) qUnits.push({ w: qts[i - 1] + ENDING[qts[i]], from: i - 1, to: i });
  const aUnits = units(alias.ts);
  const qDone = new Array(qts.length).fill(0);
  const aDone = new Array(alias.ts.length).fill(0);
  for (const qu of qUnits) {
    for (const au of aUnits) {
      const f = wordFit(qu.w, au.w, qu.from === qu.to && au.from === au.to);
      if (!f) continue;
      for (let i = qu.from; i <= qu.to; i += 1) qDone[i] = Math.max(qDone[i], f);
      for (let j = au.from; j <= au.to; j += 1) aDone[j] = Math.max(aDone[j], f);
    }
  }
  // every phrase word must be found, except small words; a place word may also be found in the place's type
  let fit = 1;
  for (let i = 0; i < qts.length; i += 1) {
    const w = qts[i];
    if (qDone[i]) { fit = Math.min(fit, qDone[i]); continue; }
    if (SOFT.has(w) || (w.length === 1 && !/\d/.test(w))) continue;
    if (PLACE_WORDS.has(stem(w)) || PLACE_WORDS.has(w)) { if (typeWords.has(w) || typeWords.has(stem(w))) continue; return null; }
    return null;
  }
  // how much of the alias the phrase names: rare words weigh more; the place's own type words and small words weigh little
  const weight = (w) => (typeWords.has(w) ? 0.1 : SOFT.has(w) || PLACE_WORDS.has(w) ? 0.25 : 1) * Math.log(1 + nPlaces / (freq.get(w) ?? 1));
  let got = 0;
  let all = 0;
  alias.ts.forEach((w, j) => { const x = weight(w); all += x; got += x * aDone[j]; });
  // the phrase names this place when a found word is a name word ("folk", "jogyesa"), or when two or more place words
  // are found and one of them is not the place's own type ("palace museum"); "seoul station" alone does not
  const isPlaceWord = (w) => PLACE_WORDS.has(w) || PLACE_WORDS.has(stem(w));
  const found = qts.filter((w, i) => qDone[i] && !SOFT.has(w));
  const placeFound = found.filter(isPlaceWord);
  const named = found.some((w) => !isPlaceWord(w)) || (placeFound.length >= 2 && placeFound.some((w) => !typeWords.has(w) && !typeWords.has(stem(w))));
  const left = alias.ts.filter((w, j) => !aDone[j] && !typeWords.has(w) && !SOFT.has(w)).length;
  return { fit, cover: all ? got / all : 0, named, left };
}

const compact = (s) => tokens(s).join('');

/**
 * True when the phrase holds only small words and English place words ("art museums", "the tea house", "old palaces"),
 * plus any word `alsoKind` accepts: it says a kind of place, even when one saved name holds the same words.
 */
export function kindWordsOnly(phrase, alsoKind = () => false) {
  const ts = tokens(phrase);
  const small = (w) => SOFT.has(w) || SOFT.has(stem(w));
  return ts.some((w) => !small(w)) && ts.every((w) => small(w) || PLACE_WORDS.has(w) || PLACE_WORDS.has(stem(w)) || alsoKind(w));
}

/** Is this phrase written in the question (word by word, small typos allowed)? The AI must copy names, not invent them. */
export function inQuestion(phrase, question) {
  const ps = tokens(phrase).filter((w) => !SOFT.has(w));
  if (!ps.length) return true;
  const qs = units(tokens(question)).map((u) => u.w);
  return ps.every((w) => qs.some((x) => wordFit(w, x, true) >= 0.8)) || qs.includes(ps.join(''));
}
/** Letter-pair likeness of two names (0..1), for "did you mean" suggestions only. */
function likeness(a, b) {
  const grams = (s) => { const k = key(compact(s)); const g = new Map(); for (let i = 0; i + 1 < k.length; i += 1) g.set(k.slice(i, i + 2), (g.get(k.slice(i, i + 2)) ?? 0) + 1); return g; };
  const A = grams(a);
  const B = grams(b);
  let both = 0;
  let n = 0;
  for (const [g, c] of A) { both += Math.min(c, B.get(g) ?? 0); n += c; }
  for (const [, c] of B) n += c;
  return n ? (2 * both) / n : 0;
}

/**
 * Which saved place a written name points at.
 * @returns {{ status: 'exact'|'close'|'guess'|'none'|'here'|'empty', place: object|null, how, candidates: object[] }}
 *   exact: the name as written (after folding) is a name of the place; close: all its words fit one place better than
 *   any other; guess: several places fit about as well (the nearest one is used, the others are offered);
 *   none: no saved place has this name (candidates are only suggestions, never the answer).
 */
export function matchPlace(pack, phrase, { here = null, kinds = null, explain = null } = {}) {
  const raw = String(phrase ?? '').trim();
  const qts0 = tokens(raw);
  const qts = qts0.filter((w, i) => !(i === 0 && ['the', 'a', 'an'].includes(w)));
  if (SELF.test(qts.join(' '))) return { status: 'here', place: here, candidates: [] };
  if (!qts.length || qts.every((w) => SOFT.has(w))) return { status: 'empty', place: null, candidates: [] };
  const { entries, freq } = namesOf(pack);
  const pool = entries.filter((e) => !kinds || kinds.includes(e.p.kind));
  const N = (pack.places ?? []).length;
  const scored = [];
  const qc = qts.join('');
  const ko = raw.replace(/\s+/g, '');
  for (const e of pool) {
    let best = null;
    if (/[가-힣]/.test(ko) && e.ko && (e.ko.includes(ko) || ko.includes(e.ko))) best = { fit: 1, cover: 1, named: true, how: 'korean', exact: e.ko === ko };
    for (const a of e.aliases) {
      if (a.single) {
        if (qts.length === 1 && qts[0] === a.text.toLowerCase()) best = { fit: 1, cover: 1, named: true, how: 'initials', exact: true };
        continue;
      }
      const c = cover(qts, a, e.typeWords, freq, N);
      if (!c || !c.named) continue;
      const exact = key(qc) === key(a.ts.join(''));
      const s = { ...c, how: a.how, exact };
      if (!best || (s.exact && !best.exact) || (s.exact === best.exact && s.cover * s.fit > best.cover * best.fit)) best = s;
    }
    // an event or a fact the place holds, named in full ("changing of the guard ceremony")
    if (!best && qts.filter((w) => !SOFT.has(w)).length >= 2) {
      for (const f of e.facts) {
        const c = cover(qts.filter((w) => !SOFT.has(w)), { ts: f }, new Set(), freq, N);
        if (c && c.fit >= 0.8) { best = { fit: c.fit * 0.9, cover: 0.3, named: true, how: 'event', exact: false }; break; }
      }
    }
    // each word of the name the phrase leaves out costs a little, so "Bukchon village" is the village, not its information centre
    if (best) scored.push({ p: e.p, ...best, score: (best.exact ? 2 : 0) + best.fit * (0.5 + best.cover) - 0.05 * (best.left ?? 0) });
  }
  const near = (p) => (here ? leg(here, p).meters : 0);
  scored.sort((a, b) => b.score - a.score || near(a.p) - near(b.p));
  if (explain) explain.push(...scored.slice(0, 6).map((x) => ({ id: x.p.id, score: Number(x.score.toFixed(3)), fit: x.fit, cover: Number(x.cover.toFixed(3)), how: x.how, exact: x.exact })));
  // only place words ("the palace", "the museum", "the station"): the places of that kind, the plainest match and the nearest first
  const core = qts.filter((w) => !SOFT.has(w) && !(w.length === 1 && !/\d/.test(w)));
  if (!scored.length && core.length && core.every((w) => PLACE_WORDS.has(w) || PLACE_WORDS.has(stem(w)))) {
    const hits = pool.map((e) => {
      const ws = new Set([...e.typeWords, ...e.aliases.filter((a) => !a.single).flatMap((a) => a.ts)].map(stem));
      // a city word in the phrase must be in the name too ("Seoul Station" is not any station of the pack)
      if (!core.every((w) => ws.has(stem(w))) || !qts.filter((w) => CITY.has(w)).every((w) => ws.has(w))) return null;
      return { p: e.p, extra: qts.filter((w) => ws.has(stem(w))).length, typeExact: fold(e.p.type) === core.join(' ') ? 1 : 0 };
    }).filter(Boolean).sort((a, b) => b.extra - a.extra || b.typeExact - a.typeExact || near(a.p) - near(b.p));
    if (hits.length) return { status: hits.length === 1 ? 'close' : 'guess', place: hits[0].p, how: 'kind', phrase: raw, candidates: hits.slice(1, 5).map((x) => x.p) };
  }
  if (!scored.length) {
    // suggestions compare the name words only: "n seoul tower" shares "seoul" with many names but is like none of them
    const bare = (x) => tokens(x).filter((w) => !SOFT.has(w) && !PLACE_WORDS.has(w)).join(' ');
    const qb = bare(raw);
    const sugg = !qb ? [] : pool.map((e) => ({ p: e.p, s: Math.max(...e.aliases.filter((a) => !a.single).map((a) => likeness(qb, bare(a.text) || a.text))) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.p);
    return { status: 'none', place: null, phrase: raw, candidates: sugg };
  }
  const top = scored[0];
  const ties = scored.filter((x) => top.score - x.score <= 0.08);
  // the same event at several places (a palace tour held at every hall): the place that holds it, nearest first
  if (top.how === 'event') ties.sort((a, b) => near(a.p) - near(b.p));
  else if (ties.length > 1) ties.sort((a, b) => near(a.p) - near(b.p));
  const place = ties[0].p;
  const others = scored.filter((x) => x.p.id !== place.id).slice(0, 4).map((x) => x.p);
  const status = top.exact && ties.length === 1 ? 'exact' : ties.length === 1 ? 'close' : 'guess';
  return { status, place, how: ties[0].how, phrase: raw, candidates: others };
}
