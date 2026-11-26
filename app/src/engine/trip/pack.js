// The travel pack: one JSON file saved before the trip (shape: docs/trip-pack.md).
// Pure functions only, so the same code can move to a phone app later.

export const PACK_FORMAT = 'trip-pack/2';
export const FORMATS = ['trip-pack/1', 'trip-pack/2'];
export const KINDS = ['hotel', 'station', 'restaurant', 'cafe', 'pharmacy', 'hospital', 'sight', 'shop', 'info', 'toilet', 'atm', 'other'];
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
export const LONG = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const SPAN = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-4]):[0-5]\d$/;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isStr = (x) => typeof x === 'string' && x.trim() !== '';

/** Check a pack before saving it. Returns { ok, errors } (errors are short English strings). */
export function validatePack(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return { ok: false, errors: ['Not a JSON object.'] };
  if (!FORMATS.includes(p.format)) errors.push(`format must be one of ${FORMATS.join(', ')}.`);
  const v2 = p.format === 'trip-pack/2';
  if (!isStr(p.city)) errors.push('city is missing.');
  if (!Array.isArray(p.places) || p.places.length === 0) errors.push('places is empty.');
  const ids = new Set();
  for (const [i, pl] of (p.places ?? []).entries()) {
    const at = `places[${i}]`;
    if (!isStr(pl?.id)) errors.push(`${at}.id is missing.`);
    else if (ids.has(pl.id)) errors.push(`${at}.id "${pl.id}" is used twice.`);
    else ids.add(pl.id);
    if (!isStr(pl?.name)) errors.push(`${at}.name is missing.`);
    if (!KINDS.includes(pl?.kind)) errors.push(`${at}.kind "${pl?.kind}" is not one of ${KINDS.join(', ')}.`);
    if (!isNum(pl?.lat) || !isNum(pl?.lon) || Math.abs(pl.lat) > 90 || Math.abs(pl.lon) > 180) errors.push(`${at} needs numeric lat and lon.`);
    if (v2 && pl?.hours != null) {
      if (!['official', 'official-inside', 'osm', 'wikivoyage', 'outdoor', 'unknown'].includes(pl.hours.status)) errors.push(`${at}.hours.status "${pl.hours.status}" is not known.`);
      for (const r of pl.hours.rules ?? []) if (!Array.isArray(r.open) || !r.open.every((s) => SPAN.test(s))) errors.push(`${at}.hours.rules has an opening time that is not "HH:MM-HH:MM".`);
    } else if (pl?.hours != null) {
      for (const [d, v] of Object.entries(pl.hours)) {
        if (!DAYS.includes(d)) errors.push(`${at}.hours has an unknown day "${d}".`);
        else if (!(v === 'closed' || v === '24h' || String(v).split(',').every((s) => SPAN.test(s.trim())))) errors.push(`${at}.hours.${d} "${v}" is not "HH:MM-HH:MM", "closed" or "24h".`);
      }
    }
  }
  for (const [i, n] of (p.notes ?? []).entries()) {
    if (!isStr(n?.id) || ids.has(n.id)) errors.push(`notes[${i}].id is missing or used twice.`);
    else ids.add(n.id);
    if (!isStr(n?.text)) errors.push(`notes[${i}].text is missing.`);
  }
  if (v2) {
    const photoIds = new Set((p.photos ?? []).map((x) => x.id));
    for (const ph of p.photos ?? []) if (!isStr(ph.author) || !isStr(ph.license)) errors.push(`photo ${ph.id} has no author or licence.`);
    for (const pl of p.places ?? []) for (const id of pl.photos ?? []) if (!photoIds.has(id)) errors.push(`${pl.id} names photo ${id}, which is not in photos.`);
    if (p.net && (!Array.isArray(p.net.nodes) || !Array.isArray(p.net.edges) || p.net.edges.length % 4)) errors.push('net is not a node and edge list.');
    if (!Array.isArray(p.credits) || !p.credits.length) errors.push('credits are missing.');
  }
  return { ok: errors.length === 0, errors };
}

export const placeById = (pack, id) => (pack?.places ?? []).find((p) => p.id === id) ?? null;

const pretty = (v) => (v === 'closed' ? 'closed' : v === '24h' ? 'open 24 hours' : String(v).split(',').map((s) => s.trim().replace('-', '–')).join(', '));

/** Join days that share a value: "Mon–Fri 08:00–20:00; Sat 09:00–14:00; Sun closed". */
export function groupDays(valueOf) {
  const out = [];
  let start = 0;
  for (let i = 1; i <= DAYS.length; i += 1) {
    if (i === DAYS.length || valueOf(DAYS[i]) !== valueOf(DAYS[start])) {
      const v = valueOf(DAYS[start]);
      const span = i - 1 === start ? SHORT[DAYS[start]] : `${SHORT[DAYS[start]]}–${SHORT[DAYS[i - 1]]}`;
      out.push({ span, value: v });
      start = i;
    }
  }
  return out;
}

export function hoursText(hours) {
  if (!hours || typeof hours !== 'object') return '';
  return groupDays((d) => (hours[d] == null ? 'not listed' : pretty(hours[d]))).map((g) => `${g.span} ${g.value}`).join('; ');
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Is the place open on that day at that minute of the day? null when the pack does not say. */
export function openAt(hours, day, minute) {
  const v = hours?.[day];
  if (v == null) return null;
  if (v === 'closed') return false;
  if (v === '24h') return true;
  return String(v).split(',').some((s) => { const [a, b] = s.trim().split('-'); return minute >= toMin(a) && minute < toMin(b); });
}

export const dayValue = (hours, day) => (hours?.[day] == null ? null : pretty(hours[day]));
export const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
