// Opening hours of a trip-pack/2 place, worked out by code (the model never decides "open" or "closed").
//
// place.hours = {
//   status: 'official' | 'official-inside' | 'osm' | 'wikivoyage' | 'outdoor' | 'unknown',
//   rules: [{ open: ['09:00-17:00'], months?: [11,12], days?: ['mon',…], nth?: 'last', last?: '16:00' }],
//   closed?: { days?: ['tue'], dates?: ['01-01'], nth?: [{ n: 'last', day: 'mon' }], lunar?: true, text },
//   daysStated?: false   (Wikivoyage gave times without saying which days)
//   source?: { name, url, read }, note?, conflict?, inside?
// }
// Pure functions, so a phone version can use them as they are.
import { DAYS, LONG } from './pack.js';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
export const clock = (minute) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const span = (s) => { const [a, b] = s.split('-'); return [toMin(a), toMin(b)]; };
const pretty = (s) => s.replace('-', '–');

/** A moment as the hours code needs it: from a Date, or from 'YYYY-MM-DDTHH:MM' (local, no time zone). */
export function momentOf(at) {
  let d;
  if (at instanceof Date) d = at;
  else if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at)) { const [y, mo, da, h, mi] = at.match(/\d+/g).map(Number); d = new Date(y, mo - 1, da, h, mi); } else d = new Date();
  const wd = DAYS[(d.getDay() + 6) % 7];
  return { y: d.getFullYear(), month: d.getMonth() + 1, date: d.getDate(), day: wd, minute: d.getHours() * 60 + d.getMinutes(), d };
}

/** The same moment moved to another weekday (the next one, today included) and/or another time of day. */
export function shiftMoment(m, { day = null, minute = null } = {}) {
  let d = new Date(m.d);
  if (day) {
    const want = DAYS.indexOf(day);
    const now = (d.getDay() + 6) % 7;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + ((want - now + 7) % 7), d.getHours(), d.getMinutes());
  }
  if (minute != null) d = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(minute / 60), minute % 60);
  return momentOf(d);
}

export const momentText = (m) => `${LONG[m.day]} ${m.date} ${MONTH_SHORT[m.month - 1]}, ${clock(m.minute)}`;

function isLastWeekdayOfMonth(m) {
  const next = new Date(m.y, m.month - 1, m.date + 7);
  return next.getMonth() !== m.month - 1;
}

function ruleMatches(r, m) {
  if (r.months && !r.months.includes(m.month)) return false;
  if (r.days && !r.days.includes(m.day)) return false;
  if (r.nth === 'last' && !isLastWeekdayOfMonth(m)) return false;
  return true;
}
const specificity = (r) => (r.nth ? 4 : 0) + (r.days ? 2 : 0) + (r.months ? 1 : 0);

/** The rule that applies on that day, or null. */
function ruleFor(hours, m) {
  const list = (hours.rules ?? []).filter((r) => ruleMatches(r, m));
  if (!list.length) return null;
  return list.sort((a, b) => specificity(b) - specificity(a))[0];
}

function closedReason(hours, m) {
  const c = hours.closed;
  if (!c) return null;
  if (c.days?.includes(m.day)) return `closed on ${LONG[m.day]}s`;
  const mmdd = `${String(m.month).padStart(2, '0')}-${String(m.date).padStart(2, '0')}`;
  if (c.dates?.includes(mmdd)) return `closed on ${m.date} ${MONTH_SHORT[m.month - 1]}`;
  for (const x of c.nth ?? []) if (x.n === 'last' && x.day === m.day && isLastWeekdayOfMonth(m)) return `closed on the last ${LONG[m.day]} of the month`;
  return null;
}

const SOURCE_TEXT = { official: 'official website', 'official-inside': 'official website of Gyeongbokgung Palace', osm: 'OpenStreetMap', wikivoyage: 'Wikivoyage' };

/**
 * Is the place open at that moment?
 * { state: 'open'|'closed'|'unknown'|'outdoor', today: '09:00–17:00' | 'closed', closesAt, opensAt, last, reason, daysNotStated, source, conflict }
 */
export function hoursAt(hours, m) {
  if (!hours || hours.status === 'unknown') return { state: 'unknown', note: hours?.note ?? null };
  if (hours.status === 'outdoor') return { state: 'outdoor' };
  const base = { source: SOURCE_TEXT[hours.status] ?? hours.status, read: hours.source?.read ?? null, conflict: hours.conflict ?? null, daysNotStated: hours.daysStated === false, note: hours.note ?? null };
  const why = closedReason(hours, m);
  if (why) return { ...base, state: 'closed', today: 'closed', reason: why, opensAt: null };
  const r = ruleFor(hours, m);
  if (!r) {
    // Days are listed but not this one (OpenStreetMap: days not named are closed).
    const listsDays = (hours.rules ?? []).some((x) => x.days);
    return listsDays ? { ...base, state: 'closed', today: 'closed', reason: `not open on ${LONG[m.day]}s` } : { ...base, state: 'unknown' };
  }
  const spans = r.open.map(span);
  const today = r.open.map(pretty).join(', ');
  const now = spans.find(([a, b]) => m.minute >= a && m.minute < b);
  if (now) return { ...base, state: 'open', today, closesAt: clock(now[1]), last: r.last ?? null, rule: r };
  const later = spans.find(([a]) => m.minute < a);
  if (later) return { ...base, state: 'closed', today, reason: `opens at ${clock(later[0])}`, opensAt: clock(later[0]), last: r.last ?? null, rule: r };
  return { ...base, state: 'closed', today, reason: `closed for the day (hours ${today})`, last: r.last ?? null, rule: r };
}

/** One line for the model and the screen. Code writes every time and every "open" or "closed". */
export function hoursLine(place, m) {
  const h = hoursAt(place.hours, m);
  const when = momentText(m);
  if (h.state === 'unknown') return { ...h, text: `Opening hours: not in the saved pack${place.hours?.status === 'unknown' ? ' (not found in the sources)' : ''}.`, short: shortOpen(place, h) };
  if (h.state === 'outdoor') return { ...h, text: 'Outdoor public space; the pack lists no opening hours.', short: shortOpen(place, h) };
  const src = `(${h.source}${h.read ? `, checked ${h.read}` : ''})`;
  let text;
  if (place.hours?.visit) {
    // Bukchon Red Zone: these are the hours tourists may walk the lanes, not opening hours of a building.
    text = h.state === 'open' ? `At ${when}: tourist visits are allowed now, until ${h.closesAt} ${src}.` : `At ${when}: tourist visits are not allowed now; they are allowed ${h.today} ${src}.`;
  } else if (h.state === 'open') {
    text = h.daysNotStated
      ? `At ${when}: within the listed hours ${h.today}; the source does not say which days it opens ${src}.`
      : `At ${when}: open now. Closes at ${h.closesAt} today${h.last ? ` (last entry ${h.last})` : ''} ${src}.`;
  } else if (h.reason?.startsWith('closed on') || h.reason?.startsWith('not open')) {
    text = `At ${when}: closed today, ${h.reason} ${src}.`;
  } else if (h.opensAt) {
    text = `At ${when}: not open yet; ${h.reason} today (hours ${h.today}${h.last ? `, last entry ${h.last}` : ''}) ${src}.`;
  } else {
    text = `At ${when}: closed now; ${h.reason} ${src}.`;
  }
  if (h.conflict) text += ` Sources differ: ${h.conflict}`;
  return { ...h, text, short: shortOpen(place, h) };
}

/** A few words for the answer sentence ("it is open at that time, until 20:50"). */
export function shortOpen(place, h) {
  if (h.state === 'unknown') return 'its opening hours are not in your pack';
  if (h.state === 'outdoor') return 'it is an outdoor space with no listed hours';
  if (place.hours?.visit) return h.state === 'open' ? `tourist visits are allowed until ${h.closesAt}` : `tourist visits are allowed only ${h.today}`;
  if (h.state === 'open') return h.daysNotStated ? `its listed hours are ${h.today} (the source does not say which days)` : `it is open at that time, until ${h.closesAt}${h.last ? ` (last entry ${h.last})` : ''}`;
  if (h.opensAt) return `it is not open yet at that time; it opens at ${h.opensAt}`;
  if (h.reason?.startsWith('closed on') || h.reason?.startsWith('not open')) return `it is closed that day (${h.reason})`;
  return `it is closed by then (hours ${h.today})`;
}

/** Week summary for the place card: "Mon 09:00–17:00 · Tue closed · …" for the month of the moment. */
export function weekText(place, m) {
  const h = place.hours;
  if (!h || h.status === 'unknown') return 'Opening hours not in the pack';
  if (h.status === 'outdoor') return 'Outdoor space, no opening hours listed';
  const parts = [];
  for (const d of DAYS) {
    const mm = shiftMoment(m, { day: d });
    const x = hoursAt(h, { ...mm, minute: 0 });
    parts.push([d, x.today ?? (x.state === 'unknown' ? '?' : 'closed')]);
  }
  const out = [];
  for (const [d, v] of parts) {
    const last = out[out.length - 1];
    if (last && last.v === v) last.to = d; else out.push({ from: d, to: d, v });
  }
  const S = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const txt = out.map((g) => `${g.from === g.to ? S[g.from] : `${S[g.from]}–${S[g.to]}`} ${g.v}`).join(' · ');
  return h.daysStated === false ? `${txt} (days not stated by the source)` : txt;
}
