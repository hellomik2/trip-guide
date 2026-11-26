// Pick the lines of the travel pack that fit one question. Code only, no AI call.
//
// The whole pack does not fit the on-device model, and the model is weak at arithmetic, so code:
//   1. finds the places the question names, the kinds of place it asks for (pharmacy, cafe, …),
//      the tags it mentions (vegetarian, …) and a day or time if it gives one;
//   2. ranks places of the asked kind by straight-line distance from "here" (or from a named place);
//   3. adds the best word matches (BM25) from places and notes;
//   4. writes each chosen place as one line with the distance, direction, walking time and opening check
//      already calculated, so the model only has to read and copy.
import { leg } from './geo.js';
import { hoursText, openAt, dayValue, groupDays, LONG, clock, placeById } from './pack.js';

export const MAX_LINES = 6;
const RANK_PER_KIND = 2;

export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’‘]/g, "'");
export function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}
/** True for words that do not single out one place in a name ("pharmacy", "street", "central"). */
export const isGenericWord = (w) => GENERIC.has(stem(fold(w)));
export const words = (s) => fold(s).replace(/'s\b/g, '').split(/[^a-z0-9]+/).filter(Boolean);

export const STOP = new Set(('a an the is are was were be been am to of in on at for from by with and or not no do does did can could would should will '
  + 'i me my mine we us our you your it its this that these those there here where what whats when which who whom how much many any some '
  + 'get go going got take find want need please tell know about like than then also just still really thing place one ok okay '
  + 'nearest closest near nearby close around far distance walk walking way open opens opening close closes closing hour hours time '
  + 'today tonight tomorrow now day').split(' '));

const KIND_WORDS = {
  pharmacy: 'pharmacy pharmacies chemist chemists drugstore drugstores medicine medicines medication painkiller painkillers prescription aspirin ibuprofen paracetamol plaster plasters bandage bandages',
  hospital: 'hospital hospitals clinic clinics doctor doctors injury injured urgent emergency',
  hotel: 'hotel hotels hostel hostels inn guesthouse accommodation lodging sleep',
  station: 'station stations train trains rail railway bus buses tram trams ferry ferries boat boats terminal stop metro subway',
  restaurant: 'restaurant restaurants eat eating food dinner lunch breakfast brunch meal meals dine dining hungry',
  cafe: 'cafe cafes coffee tea espresso bakery bakeries pastry pastries',
  sight: 'sight sights sightseeing museum museums gallery galleries park parks view viewpoint attraction attractions tour church tower beach garden gardens monument lighthouse castle',
  shop: 'shop shops store stores market markets grocery groceries supermarket souvenir souvenirs convenience snack snacks',
};
const KIND_OF = new Map();
for (const [k, list] of Object.entries(KIND_WORDS)) for (const w of list.split(' ')) KIND_OF.set(stem(w), k);
// Words that say little about which place is meant when they appear in a name ("Harbour Cafe").
const GENERIC = new Set(['the', 'of', 'and', 'old', 'new', 'st', 'street', 'road', 'rd', 'lane', 'square', 'house', 'hall', 'centre', 'center', 'city', 'central', 'main', 'little', 'big', 'grand', 'north', 'south', 'east', 'west', 'upper', 'lower', ...KIND_OF.keys()].map(stem));

const NEAR_RE = /\b(nearest|closest|near|nearby|close to|close by|around|walking distance|next to|by the)\b/;
const ROUTE_RE = /\b(how (?:do|can|should|would) (?:i|we) (?:get|go|reach|walk)|get to|go to|getting to|way to|directions?|how far|walk to|route|which (?:bus|tram|train|ferry|boat)|take me|reach|head to|from .+ to )\b/;

const TIME_RE = /\b(open|opens|opening|close|closes|closing|closed|hours?|time|times|when|late|early|night|tonight|morning|evening|afternoon|breakfast|lunch|dinner|today|tomorrow|weekend|until|till|still)\b|\d\s*(am|pm)\b|\d[:.]\d\d/;
const TRANSIT_RE = /\b(tram|trams|bus|buses|train|trains|ferry|ferries|boat|boats|stop|transport|ride|line|route|walk|get to|getting to|reach|go to|get there)\b/;
const PHONE_RE = /\b(phone|call|number|contact|book|booking|reserve|reservation|ring)\b/;
const LOOKUP_RE =/\b(where|which|any|is there|are there|find|recommend|suggest|good|best|can i (?:get|buy|find|eat|see|go))\b/;
// A few everyday words that point at the city notes ("How do I pay for the tram?" -> tickets).
const EXPAND = new Map(Object.entries({
  pay: 'ticket cost cash card', fare: 'ticket cost', price: 'cost ticket', cost: 'ticket', cheap: 'cost budget', expensive: 'cost',
  money: 'currency cash card', cash: 'currency card', currency: 'cash card', card: 'cash', atm: 'cash',
  wifi: 'wifi sim', internet: 'wifi sim', sim: 'wifi', data: 'sim wifi', phone: 'sim wifi',
  water: 'drink fountain', drink: 'water', tip: 'tipping', tipping: 'tip',
  ambulance: 'emergency', police: 'emergency', fire: 'emergency', emergency: 'ambulance',
  holiday: 'holiday', timetable: 'time run', schedule: 'time run', often: 'every run', last: 'run time', first: 'run time',
}).map(([k, v]) => [stem(k), v.split(' ').map(stem)]));

const DAY_RE =/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)s?\b/g;
const DAY_KEY = { monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat', sunday: 'sun' };

/** Day(s) and minute of the day written in the question, if any. */
export function readWhen(q) {
  const t = fold(q);
  const days = [];
  for (const m of t.matchAll(DAY_RE)) {
    if (m[1] === 'weekend') days.push('sat', 'sun');
    else days.push(DAY_KEY[m[1]]);
  }
  let minute = null;
  const ampm = t.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  const h24 = t.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (/^p/.test(ampm[3])) h += 12;
    if (h < 24) minute = h * 60 + Number(ampm[2] ?? 0);
  } else if (h24) minute = Number(h24[1]) * 60 + Number(h24[2]);
  else if (/\b(noon|midday)\b/.test(t)) minute = 12 * 60;
  return { days: [...new Set(days)], minute };
}

/** "On Sunday at 20:00: closed (Sunday hours: closed)." Calculated by code for the model to copy. */
function openingCheck(hours, when) {
  if (!hours || (!when.days.length && when.minute == null)) return '';
  if (when.days.length) {
    return when.days.map((d) => {
      const v = dayValue(hours, d);
      if (v == null) return `On ${LONG[d]}: hours not listed.`;
      if (when.minute == null) return `On ${LONG[d]}: ${v === 'closed' ? 'closed all day' : v}.`;
      const o = openAt(hours, d, when.minute);
      return `On ${LONG[d]} at ${clock(when.minute)}: ${o ? 'open' : 'closed'} (${LONG[d]} hours: ${v}).`;
    }).join(' ');
  }
  const groups = groupDays((d) => { const o = openAt(hours, d, when.minute); return o == null ? 'not listed' : o ? 'open' : 'closed'; });
  return `At ${clock(when.minute)}: ${groups.map((g) => `${g.value} ${g.span}`).join(', ')}.`;
}

function entriesOf(pack) {
  const places = (pack.places ?? []).map((p) => ({
    id: p.id, type: 'place', place: p,
    fields: [[p.name, 3], [`${p.kind} ${KIND_WORDS[p.kind] ? p.kind : ''}`, 2], [(p.tags ?? []).join(' '), 2], [p.about, 1], [p.transit, 1], [p.address, 1]],
  }));
  const notes = (pack.notes ?? []).map((n) => ({ id: n.id, type: 'note', note: n, fields: [[n.topic, 2], [n.text, 1]] }));
  for (const e of [...places, ...notes]) {
    e.tf = new Map();
    e.len = 0;
    for (const [text, w] of e.fields) for (const t of words(text).map(stem)) { if (STOP.has(t)) continue; e.tf.set(t, (e.tf.get(t) ?? 0) + w); e.len += w; }
  }
  return [...places, ...notes];
}

export function bm25(entries, terms) {
  const N = entries.length;
  const avg = entries.reduce((a, e) => a + e.len, 0) / Math.max(1, N);
  const df = new Map(terms.map((t) => [t, entries.filter((e) => e.tf.has(t)).length]));
  const k1 = 1.2;
  const b = 0.5;
  return new Map(entries.map((e) => {
    let s = 0;
    for (const t of terms) {
      const f = e.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * e.len) / avg)));
    }
    return [e.id, s];
  }));
}

/** Places whose name the question uses, best first. */
export function mentions(pack, qWords, qText) {
  const qset = new Set(qWords.map(stem));
  // A word in many names (often the city's own name: "Quillhaven Ferry Terminal") does not point at one place.
  const freq = new Map();
  for (const p of pack.places ?? []) for (const w of new Set(words(p.name).map(stem))) freq.set(w, (freq.get(w) ?? 0) + 1);
  const city = new Set(words(`${pack.city ?? ''} ${pack.country ?? ''}`).map(stem));
  const out = [];
  for (const p of pack.places ?? []) {
    const nameWords = words(p.name).map(stem);
    const distinct = nameWords.filter((w) => !GENERIC.has(w) && !STOP.has(w) && !city.has(w) && (freq.get(w) ?? 0) <= 2);
    const full = fold(p.name).replace(/^the\s+/, '');
    const hit = distinct.filter((w) => qset.has(w)).length;
    const fullHit = qText.includes(full);
    const ratio = fullHit ? 1 : distinct.length ? hit / distinct.length : 0;
    if (fullHit || (hit > 0 && ratio >= 0.5)) out.push({ place: p, ratio, at: fullHit ? qText.indexOf(full) : Math.min(...distinct.filter((w) => qset.has(w)).map((w) => { const i = qText.search(new RegExp(`\\b${w}`)); return i < 0 ? Infinity : i; })) });
  }
  return out.sort((a, b) => b.ratio - a.ratio || a.at - b.at);
}

const ORD = ['Nearest', '2nd nearest', '3rd nearest', '4th nearest'];
const SELF = new Set(['here', 'me', 'us', 'my', 'our', 'i', 'you', 'this', 'where']);

/**
 * The place a phrase like "the museum" or "Central Station" points at: the place whose name holds the most
 * of its leading words (common words like "museum" count too); a tie goes to the place nearest to here.
 * Returns 'here' for "here", "me", "my hotel" and the like.
 */
export function placeFromPhrase(pack, phrase, here) {
  const ws = words(phrase).map(stem).filter((w) => !['the', 'a', 'an', 'of'].includes(w));
  if (!ws.length) return null;
  if (SELF.has(ws[0])) return 'here';
  const cut = [...new Set(ws.slice(0, 6))];
  const places = pack.places ?? [];
  // a word few names share ("changdeokgung") says more than a word many names share ("gate", "station")
  const freq = new Map();
  for (const p of places) for (const w of new Set(words(p.name).map(stem))) freq.set(w, (freq.get(w) ?? 0) + 1);
  const weight = (w) => (GENERIC.has(w) ? 0.5 : 1) * Math.log(1 + places.length / (freq.get(w) ?? 1));
  let best = [];
  let top = 0;
  for (const p of places) {
    const nw = words(p.name);
    const nameWs = new Set([...nw.map(stem), ...nw.slice(1).map((w, i) => nw[i] + w)]);
    let n = 0;
    for (const w of cut) if (nameWs.has(w)) n += nameWs.has(w) && freq.has(w) ? weight(w) : Math.log(1 + places.length);
    if (n > top + 1e-9) { top = n; best = [p]; } else if (n && Math.abs(n - top) <= 1e-9) best.push(p);
  }
  if (!best.length) return null;
  const extra = (p) => new Set(words(p.name).map(stem)).size;
  if (best.length > 1) best.sort((a, b) => extra(a) - extra(b) || (here ? leg(here, a).meters - leg(here, b).meters : 0));
  return best[0];
}

/**
 * Choose the data lines for one question.
 * @returns {{ here, lines: Array<{id, type, text, place?, legFromHere?}>, intents, when }}
 */
export function pick(pack, question, hereId) {
  const here = placeById(pack, hereId) ?? pack.places?.[0] ?? null;
  const qText = fold(question);
  const qWords = words(question);
  const terms = [...new Set(qWords.map(stem).filter((t) => !STOP.has(t)))];
  const when = readWhen(question);
  const near = NEAR_RE.test(qText);
  const route = ROUTE_RE.test(qText);
  const named = mentions(pack, qWords, qText).filter((m) => !here || m.place.id !== here.id || /\b(my|our|this) (hotel|hostel|inn|guesthouse|station)\b/.test(qText));
  // A tag counts when all its words are in the question ("late-night" needs "late" and "night").
  const qStems = new Set(qWords.map(stem));
  const tagHit = (t) => { const ws = words(t).map(stem); return ws.length > 0 && ws.every((w) => qStems.has(w)) && !ws.every((w) => KIND_OF.has(w)); };
  const tagsAsked = [...new Set((pack.places ?? []).flatMap((p) => (p.tags ?? []).filter(tagHit)))];

  // The place after "nearest … to" or "near" is where distance is measured from ("the nearest cafe to the museum").
  const nearTail = qText.match(/\b(?:nearest|closest)\b[^?]*?\b(?:to|from)\s+(.+)$/)?.[1] ?? qText.match(/\b(?:near|close to|next to|around)\s+(.+)$/)?.[1] ?? null;
  const refPlace = nearTail ? placeFromPhrase(pack, nearTail, here) : null;
  const ref = refPlace && refPlace !== 'here' ? refPlace : here;
  // "from A to B": the trip starts at A instead of here. "get to B", "go to B": B is the place asked about.
  const fromPart = qText.match(/\bfrom (.+?) to /)?.[1] ?? null;
  const fromPlace = fromPart ? placeFromPhrase(pack, fromPart, here) : null;
  const origin = fromPlace && fromPlace !== 'here' ? fromPlace : null;
  const toTail = route ? qText.match(/\b(?:to|towards|reach)\s+(?!get\b|go\b)(.+)$/)?.[1] ?? null : null;
  const target = toTail ? placeFromPhrase(pack, toTail, here) : null;
  for (const p of [target, refPlace]) if (p && p !== 'here' && !named.some((m) => m.place.id === p.id)) named.push({ place: p, ratio: 0.4, at: 0 });
  // Kinds asked for come from the words before such a phrase ("which bus goes to the museum" asks for a bus, not a museum).
  let head = qText;
  for (const t of [nearTail, toTail]) if (t && head.lastIndexOf(t) > 0) head = head.slice(0, head.lastIndexOf(t));
  const kinds = [...new Set(words(head).map(stem).filter((t) => !STOP.has(t)).map((t) => KIND_OF.get(t)).filter(Boolean))];

  const chosen = new Map(); // id -> { id, type, place|note, notes: [] }
  const add = (e, note) => {
    if (!e) return;
    if (!chosen.has(e.id)) chosen.set(e.id, { ...e, notes: [] });
    if (note) chosen.get(e.id).notes.push(note);
  };
  const placeEntry = (p) => ({ id: p.id, type: 'place', place: p });

  if (here) add(placeEntry(here), 'You are here.');
  for (const m of named.slice(0, 3)) { add(placeEntry(m.place)); chosen.get(m.place.id).named = true; }
  if (origin && origin.id !== here?.id) add(placeEntry(origin), 'Start of the trip asked about.');

  const dist = (a, b) => leg(a, b).meters;
  const others = (pack.places ?? []).filter((p) => p.id !== here?.id && p.id !== ref?.id);
  if (tagsAsked.length) {
    const tagged = others.filter((p) => (p.tags ?? []).some((t) => tagsAsked.includes(t))).sort((a, b) => dist(ref, a) - dist(ref, b));
    tagged.slice(0, RANK_PER_KIND).forEach((p) => { add(placeEntry(p)); chosen.get(p.id).tagged = true; });
  }
  // Places of the asked kind, nearest first, when the question looks for a place ("nearest", "where", "any", …).
  if (near || LOOKUP_RE.test(head)) {
    for (const k of kinds.slice(0, 2)) {
      const ranked = others.filter((p) => p.kind === k).sort((a, b) => dist(ref, a) - dist(ref, b));
      ranked.slice(0, RANK_PER_KIND).forEach((p, i) => add(placeEntry(p), `${ORD[i]} ${k} to ${ref === here ? 'you' : ref.name}.`));
    }
  }

  const entries = entriesOf(pack);
  const scores = bm25(entries, [...new Set([...terms, ...terms.flatMap((t) => EXPAND.get(t) ?? [])])]);
  const byScore = entries.filter((e) => scores.get(e.id) > 0).sort((a, b) => scores.get(b.id) - scores.get(a.id));
  // "Nearest pharmacy": the ranked list answers it; more lines only pull the model away from the first one.
  const rankedOnly = near && kinds.length > 0 && [...chosen.values()].some((c) => c.notes.some((n) => /^Nearest /.test(n)));
  for (const e of rankedOnly ? [] : byScore) {
    if (chosen.size >= MAX_LINES) break;
    add(e.type === 'place' ? placeEntry(e.place) : { id: e.id, type: 'note', note: e.note });
  }

  // Short lines answer faster on the device: a field goes in only when the question can need it.
  const want = {
    hours: TIME_RE.test(qText) || when.days.length > 0 || when.minute != null,
    transit: route || TRANSIT_RE.test(qText),
    phone: PHONE_RE.test(qText),
    tags: tagsAsked.length > 0,
  };
  // The "here" line is only kept when the question is about here or a trip from here (the header already says where).
  const keepHere = route || named.some((m) => m.place.id === here?.id) || origin;
  let picked = [...chosen.values()].filter((c) => keepHere || c.id !== here?.id).slice(0, MAX_LINES);
  if (!picked.length && here) picked = [chosen.get(here.id)]; // nothing matched: the model still sees one line and can say so
  const lines = picked.map((c) => render(c, { here, ref, origin, when, want }));
  return { here, lines, want, intents: { near, route, kinds, tags: tagsAsked, named: named.map((m) => m.place.id), ref: ref?.id ?? null, origin: origin?.id ?? null }, when, scores: Object.fromEntries(byScore.slice(0, 10).map((e) => [e.id, Number(scores.get(e.id).toFixed(2))])) };
}

function render(c, { here, ref, origin, when, want }) {
  if (c.type === 'note') return { id: c.id, type: 'note', text: `[${c.id}] ${c.note.topic ? `${c.note.topic}: ` : ''}${c.note.text}` };
  const p = c.place;
  const isHere = here && p.id === here.id;
  const lowerRank = c.notes.some((n) => /^(2nd|3rd|4th) nearest/.test(n)) && !c.named;
  const rank = c.notes.find((n) => /nearest /i.test(n));
  // The rank goes first so the model reads it before anything else: "[P18] Nearest pharmacy to you: Saltquay Pharmacy".
  const parts = [rank ? `[${p.id}] ${rank.replace(/\.$/, '')}: ${p.name} (${p.kind}).` : `[${p.id}] ${p.name} (${p.kind}).`];
  if (isHere) parts.push('You are here.');
  if (p.address) parts.push(`Address: ${p.address}.`);
  const h = hoursText(p.hours);
  if (h && want.hours) parts.push(`Hours: ${h}.`);
  const chk = openingCheck(p.hours, when);
  if (chk) parts.push(chk);
  if (p.about && !isHere && !lowerRank) parts.push(`About: ${p.about}`);
  if (p.transit && want.transit) parts.push(`Getting there: ${p.transit}`);
  if (p.phone && want.phone) parts.push(`Phone: ${p.phone}.`);
  if (p.tags?.length && (want.tags || c.tagged)) parts.push(`Tags: ${p.tags.join(', ')}.`);
  let legFromHere = null;
  if (here && !isHere) {
    legFromHere = leg(here, p);
    parts.push(`From you: ${legFromHere.text}.`);
  }
  if (ref && ref !== here && p.id !== ref.id) parts.push(`From ${ref.name}: ${leg(ref, p).text}.`);
  if (origin && origin !== here && p.id !== origin.id && p.id !== ref?.id) parts.push(`From ${origin.name}: ${leg(origin, p).text}.`);
  for (const n of c.notes.filter((x) => x !== 'You are here.' && x !== rank)) parts.push(n);
  return { id: p.id, type: 'place', text: parts.join(' ').replace(/\.\./g, '.'), place: p, legFromHere };
}
