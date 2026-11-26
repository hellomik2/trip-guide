// Trip guide page. Talks to the engine (src/engine/index.js) for every answer; never to Firebase or Chrome's AI directly.
// The pure pack helpers (src/engine/trip/*.js: hours, routes) are used for drawing only; they make no AI call.
import { startEngine } from '../engine/index.js';
import { validatePack, placeById } from '../engine/trip/pack.js';
import { walk } from '../engine/trip/route.js';
import { createMap } from './map.js';
import { setupRead } from './read.js';

const INDEX_URL = 'packs/index.json';
const LS = { pack: 'trip.packId', saved: 'trip.packSavedAt', version: 'trip.packVersion', here: 'trip.here' };
const PACK_CACHE = (id) => `trip-pack-${id}`;
const SDK_PROBE = 'https://www.gstatic.com/firebasejs/13.3.0/firebase-ai.js';
const DEVICE_TEXT = {
  checking: 'Checking on-device AI…', warming: 'On-device AI: getting ready', ready: 'On-device AI: ready',
  unavailable: 'No on-device AI on this computer', 'no-api': 'No on-device AI on this computer',
  downloadable: 'On-device AI not installed', downloading: 'On-device AI not installed', error: 'On-device AI error',
};
const KIND_LABEL = { food: 'Food', route: 'Directions', sights: 'Sights nearby', identify: 'What is this?', hours: 'Opening hours', other: 'Question' };
const KIND_ORDER = ['food', 'route', 'sights', 'identify', 'hours', 'other'];
const GROUP_LABEL = { sight: 'Sights', station: 'Subway exits', restaurant: 'Food', cafe: 'Cafés and tea', info: 'Tourist information', toilet: 'Toilets', pharmacy: 'Pharmacy', atm: 'ATM', other: 'Other' };
const OPEN_CHIP = { open: ['Open now', 'ok'], closed: ['Closed now', 'bad'], unknown: ['Hours not in pack', 'muted'], outdoor: ['Outdoor space', 'muted'] };

const $ = (id) => document.getElementById(id);
const rk = (window.__rk = { engine: null, results: [], reads: [], ready: false, pack: null, mode: 'guide' });
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'className') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}

// ---------------------------------------------------------------- pack: saved in Cache Storage with its photos
let pack = null;
let packInfo = null;
let map = null;
const photoUrl = (id) => { const ph = photoById(id); return ph ? new URL(`packs/${pack.id}/${ph.file}`, location.href).href : null; };
const photoById = (id) => (pack?.photos ?? []).find((p) => p.id === id) ?? null;

async function packIndex() {
  try { const r = await fetch(`${INDEX_URL}?fresh=${Date.now()}`, { cache: 'no-store' }); if (r.ok) return r.json(); } catch { /* offline */ }
  try { const c = await caches.match(new URL(INDEX_URL, location.href).href); if (c) return c.json(); } catch { /* no cache */ }
  return null;
}

async function loadSavedPack(id) {
  try {
    const cache = await caches.open(PACK_CACHE(id));
    const hit = await cache.match(new URL(`packs/${id}/pack.json`, location.href).href);
    if (!hit) return null;
    const p = await hit.json();
    return validatePack(p).ok ? p : null;
  } catch { return null; }
}

/** The pack list entry is kept in the pack's own cache: a new service worker clears old trip-app-* caches, never trip-pack-*. */
async function keepIndex(info) {
  const cache = await caches.open(PACK_CACHE(info.id));
  await cache.put(new URL(INDEX_URL, location.href).href, new Response(JSON.stringify({ packs: [info] }), { headers: { 'content-type': 'application/json' } }));
}

async function savePack(info, onProgress) {
  const cache = await caches.open(PACK_CACHE(info.id));
  const url = new URL(info.url, location.href).href;
  const res = await fetch(`${url}?fresh=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not download the travel pack (${res.status}).`);
  const text = await res.text();
  const p = JSON.parse(text);
  const v = validatePack(p);
  if (!v.ok) throw new Error(`This travel pack is not valid: ${v.errors.slice(0, 3).join(' ')}`);
  const files = p.photos.map((ph) => new URL(`packs/${p.id}/${ph.file}`, location.href).href);
  let done = 0;
  const missing = [];
  for (let i = 0; i < files.length; i += 6) {
    await Promise.all(files.slice(i, i + 6).map(async (f) => {
      try { const r = await fetch(`${f}?fresh=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) throw new Error(String(r.status)); await cache.put(f, r); } catch { missing.push(f); }
      done += 1;
      onProgress?.(done, files.length);
    }));
  }
  await cache.put(url, new Response(text, { headers: { 'content-type': 'application/json' } }));
  await keepIndex(info);
  ls.set(LS.pack, p.id);
  ls.set(LS.saved, new Date().toISOString());
  ls.set(LS.version, info.version ?? '');
  return { pack: p, photos: files.length, missing };
}

async function precacheApp() {
  if (!('serviceWorker' in navigator)) return { error: 'This browser cannot keep the app offline.' };
  const reg = await navigator.serviceWorker.ready;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ error: 'timeout' }), 30000);
    navigator.serviceWorker.addEventListener('message', function on(ev) {
      if (ev.data?.type !== 'precache-done') return;
      navigator.serviceWorker.removeEventListener('message', on);
      clearTimeout(t);
      resolve(ev.data);
    });
    reg.active.postMessage({ type: 'precache' });
  });
}

async function appSaved() {
  try {
    const page = await caches.match(new URL('trip', location.href).href);
    const sdk = await caches.match(SDK_PROBE);
    return !!(page && sdk);
  } catch { return false; }
}

async function onSave() {
  const btn = $('pack-save');
  if (!navigator.onLine) { toast(rk.packState?.saved ? 'You are offline. The saved pack keeps working here; update it when you are online again.' : 'You are offline. Connect to the internet to save the travel pack.'); return; }
  if (!packInfo) { toast('No travel pack is available to save right now. Connect to the internet and try again.'); return; }
  btn.disabled = true;
  try {
    const r = await savePack(packInfo, (d, n) => { btn.textContent = `Saving photos ${d}/${n}…`; });
    btn.textContent = 'Saving the app…';
    const app = await precacheApp();
    rk.precache = app;
    usePack(r.pack);
    const ok = !r.missing.length && !app.error && !app.missing?.length;
    toast(ok ? `Saved for offline: ${r.pack.places.length} places, ${r.photos} photos and the app.` : `Saved, but some files are missing (${r.missing.length + (app.missing?.length ?? 0)}). Try again while online.`);
    rk.saveResult = { photos: r.photos, missingPhotos: r.missing.length, app };
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    await renderPackState();
    await renderReady(); // the ready list on the first screen reads rk.packState, so it changes with it
  }
}

async function renderPackState() {
  const saved = ls.get(LS.pack) === pack?.id && (await loadSavedPack(pack.id));
  const app = await appSaved();
  const at = ls.get(LS.saved);
  const st = $('pack-state');
  if (saved && app) { st.textContent = `saved for offline${at ? ` · ${new Date(at).toLocaleDateString('en', { month: 'short', day: 'numeric' })}` : ''}`; st.className = 'mini ok'; }
  else if (saved) { st.textContent = 'pack saved, app not fully saved'; st.className = 'mini warn'; }
  else { st.textContent = pack ? 'not saved yet (online only)' : 'not saved'; st.className = 'mini warn'; }
  $('pack-save').textContent = saved ? 'Update' : 'Save for offline';
  rk.packState = { saved: !!saved, app };
}

function usePack(p) {
  pack = p;
  rk.pack = p;
  $('pack-title').textContent = p.title;
  fillHere();
  map = createMap($('map'), p);
  renderCredits();
  showHome();
}

// ---------------------------------------------------------------- "I am here" and time
function fillHere() {
  const sel = $('here');
  sel.replaceChildren();
  const groups = new Map();
  for (const p of pack.places) { const g = p.kind; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
  for (const k of ['sight', 'station', 'restaurant', 'cafe', 'info', 'toilet', 'pharmacy', 'atm', 'other'].filter((x) => groups.has(x))) {
    const g = el('optgroup', { label: GROUP_LABEL[k] ?? k });
    for (const p of groups.get(k).sort((a, b) => a.name.localeCompare(b.name))) g.append(el('option', { value: p.id, text: p.name }));
    sel.append(g);
  }
  const saved = ls.get(LS.here);
  sel.value = placeById(pack, saved) ? saved : 'L10';
}
const hereId = () => $('here').value;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Day list: today and the next six days, in English whatever the browser's language. */
function fillDays(from = new Date()) {
  const sel = $('day');
  const keep = sel.value;
  sel.replaceChildren();
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const today = new Date();
    const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    const label = `${diff === 0 ? 'Today · ' : ''}${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`;
    sel.append(el('option', { value: ymd(d), text: label }));
  }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}
function setNow() { const d = new Date(); fillDays(d); $('day').value = ymd(d); $('time').value = `${pad(d.getHours())}:${pad(d.getMinutes())}`; syncAt(); }
/** A day and time set from outside (tests, or a link): 'YYYY-MM-DDTHH:MM'. */
function setAt(v) {
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  fillDays(d);
  $('day').value = ymd(d);
  $('time').value = `${m[4]}:${m[5]}`;
  syncAt();
}
function syncAt() {
  const t = /^([01]\d|2[0-3]):[0-5]\d$/.test($('time').value) ? $('time').value : null;
  $('at').value = t && $('day').value ? `${$('day').value}T${t}` : '';
}
function atValue() { syncAt(); return $('at').value || null; }

// ---------------------------------------------------------------- status pills
function renderNet() {
  const on = navigator.onLine;
  const n = $('net-status');
  n.textContent = on ? 'Online' : 'Offline';
  n.className = `pill ${on ? 'pill-online' : 'pill-offline'}`;
}
function renderDevice(state) {
  const n = $('device-status');
  n.textContent = `${DEVICE_TEXT[state.device] ?? state.device}${state.simulated === 'no-model' ? ' (simulated)' : ''}`;
  n.className = `pill ${state.device === 'ready' ? 'pill-device' : ['checking', 'warming'].includes(state.device) ? 'pill-wait' : 'pill-muted'}`;
  $('device-only').checked = !!state.deviceOnly;
}

// ---------------------------------------------------------------- kinds
let chosenKind = null;
function renderKinds() {
  for (const b of document.querySelectorAll('.kind')) {
    const k = b.dataset.kind;
    b.classList.toggle('on', chosenKind === k);
    b.setAttribute('aria-pressed', chosenKind === k ? 'true' : 'false');
  }
}

// ---------------------------------------------------------------- photos
function credit(ph) {
  return `Photo: ${ph.author}, ${ph.license}, via Wikimedia Commons`;
}
function photoFigure(id, { big = false, caption = null } = {}) {
  const ph = photoById(id);
  if (!ph) return null;
  const note = ph.kind === 'dish' ? 'The kind of dish served here. Not taken at this restaurant.' : ph.kind === 'real' ? 'Taken at this restaurant.' : null;
  return el('figure', { className: big ? 'ph big' : 'ph', 'data-photo': id },
    el('img', { src: photoUrl(id), alt: caption ?? ph.title, loading: 'lazy', width: ph.w, height: ph.h }),
    el('figcaption', {}, caption ? el('strong', { text: caption }) : null, note ? el('span', { className: 'ph-note', text: note }) : null,
      el('button', { type: 'button', className: 'ph-credit link', text: credit(ph), title: 'Show the photo credit and licence', onclick: () => openCredits(id) })));
}
let photoSet = [];
function showPhotos(items, index = 0) {
  photoSet = items.filter((x) => photoById(x.id));
  const box = $('photo');
  box.replaceChildren();
  if (!photoSet.length) { box.append(el('div', { className: 'ph-empty', text: 'No photo in the pack for this answer.' })); return; }
  const cur = photoSet[Math.min(index, photoSet.length - 1)];
  const strip = el('div', { className: 'ph-strip' }, photoSet.map((x, i) => el('button', { type: 'button', className: `ph-thumb${i === index ? ' on' : ''}`, 'aria-label': x.caption ?? '', onclick: () => showPhotos(items, i) }, el('img', { src: photoUrl(x.id), alt: '' }))));
  box.append(...[photoFigure(cur.id, { big: true, caption: cur.caption }), photoSet.length > 1 ? strip : null].filter(Boolean));
}

// ---------------------------------------------------------------- answer view
function badgeOf(r) {
  if (r.status === 'done' && r.source === 'on_device') return { text: 'On-device AI', cls: 'b-device' };
  if (r.status === 'done' && r.source === 'in_cloud') return { text: 'Cloud AI', cls: 'b-cloud' };
  if (r.status === 'done' && r.source === 'app') return { text: 'On this computer, no AI needed', cls: 'b-app' };
  return { text: 'Not answered', cls: 'b-none' };
}
const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '');

function openChip(open) {
  const [t, c] = OPEN_CHIP[open.state] ?? OPEN_CHIP.unknown;
  let text = t;
  if (open.state === 'open' && open.closesAt) text = `Open now · closes ${open.closesAt}`;
  if (open.state === 'closed' && open.opensAt) text = `Closed now · opens ${open.opensAt}`;
  if (open.state === 'open' && /does not say which days/.test(open.text)) return el('span', { className: 'chip warn', title: open.text, text: `Hours not confirmed · listed ${open.today}` });
  return el('span', { className: `chip ${c}`, title: open.text, text });
}

function stepPhoto(s, view) {
  const p = s.passes.find((x) => placeById(pack, x.id)?.photos?.length);
  if (s.arrive) { const d = placeById(pack, s.arrive); if (d?.photos?.length) return { id: d.photos[0], caption: `${d.name} (where you arrive)` }; }
  if (p) return { id: placeById(pack, p.id).photos[0], caption: `${p.name}, on your ${p.side}` };
  if (s.street) { const st = pack.places.find((x) => x.kind === 'sight' && x.photos?.length && x.name.toLowerCase().includes(s.street.toLowerCase())); if (st) return { id: st.photos[0], caption: st.name }; }
  return null;
}

function stepsList(route, view) {
  const ol = el('ol', { id: 'steps', className: 'steps' });
  const photos = [];
  for (const s of route.steps) {
    const ph = stepPhoto(s, view);
    if (ph) photos.push({ ...ph, step: s.n });
    const li = el('li', { 'data-step': s.n, className: s.kind === 'arrive' ? 'arrive' : '', tabindex: 0 },
      el('span', { className: 'sn', text: s.kind === 'arrive' ? '' : String(s.n) }),
      el('div', { className: 'st' },
        el('div', { className: 'st-text' }, s.text, s.length ? el('span', { className: 'st-len', text: ` · ${s.length}` }) : null),
        s.passes.length ? el('div', { className: 'st-pass', text: `Pass ${s.passes.map((x) => `${x.name} on your ${x.side}`).join(', ')}` }) : null),
      ph ? el('img', { className: 'st-ph', src: photoUrl(ph.id), alt: ph.caption, title: ph.caption }) : null);
    const pick = () => { map?.highlightStep(s.n); for (const x of ol.children) x.classList.toggle('on', x === li); if (ph) showPhotos(photos, photos.findIndex((x) => x.step === s.n)); };
    li.addEventListener('mouseenter', pick);
    li.addEventListener('focus', pick);
    li.addEventListener('click', pick);
    ol.append(li);
  }
  return { ol, photos };
}

function placeCard(c, view, { onPick } = {}) {
  const ph = c.photos?.[0];
  const isFood = c.kind === 'restaurant' || c.kind === 'cafe';
  return el('article', { className: `place${c.id === view.focus ? ' focus' : ''}`, 'data-id': c.id, tabindex: 0, onclick: () => onPick?.(c) },
    ph ? el('img', { className: 'pl-ph', src: photoUrl(ph), alt: '' }) : el('div', { className: 'pl-ph none', text: 'No photo' }),
    el('div', { className: 'pl-body' },
      el('div', { className: 'pl-head' }, c.rank ? el('span', { className: 'rank', text: String(c.rank) }) : null, el('strong', { text: c.name }), c.nameKo ? el('span', { className: 'ko', text: ` ${c.nameKo}` }) : null),
      el('div', { className: 'pl-meta' }, c.walkText ? el('span', { text: `${c.walkText}${c.dir ? ` ${c.dir}` : ''}` }) : null, openChip(c.open)),
      isFood && c.dish ? el('div', { className: 'pl-line', text: `Serves: ${c.dish}` }) : null,
      c.intro ? el('div', { className: 'pl-line muted', text: c.intro }) : null,
      c.price ? el('div', { className: 'pl-line muted', text: `Price: ${c.price}` }) : null));
}

function hereCard(view) {
  const p = placeById(pack, view.here?.id);
  return p ? { id: p.id, name: p.name, lat: p.lat, lon: p.lon, kind: p.kind } : null;
}

function renderView(box, r) {
  const v = r.view ?? {};
  const here = hereCard(v);
  const extra = el('div', { className: 'extra' });
  let photos = [];
  if (v.kind === 'route' && v.route?.steps) {
    const dest = v.places?.[0];
    extra.append(el('div', { className: 'route-sum' }, el('strong', { text: `${v.origin?.name ?? here?.name ?? ''} → ${dest?.name ?? ''}` }), el('span', { text: ` · ${v.route.summary}` }), v.route.ticketArea ? el('span', { className: 'chip warn', text: 'Part of the walk needs a palace ticket' }) : null, dest ? openChip(dest.open) : null));
    const { ol, photos: ps } = stepsList(v.route, v);
    extra.append(ol);
    // the place you start from is part of the answer too: its photo comes after the ones along the walk
    const start = placeById(pack, v.origin?.id) ?? here;
    photos = [...ps, ...(start?.photos?.length && !ps.some((x) => x.id === start.photos[0]) ? [{ id: start.photos[0], caption: `${start.name} (where you start)` }] : [])];
    // a walk to a walled palace ends at its main gate: the marker goes where the walk ends
    const doorPlace = v.route.door ? placeById(pack, v.route.door) : null;
    map?.show({ route: v.route, places: doorPlace ? [{ ...doorPlace, name: `${doorPlace.name}, main gate of ${dest?.name ?? ''}` }] : v.places ?? [], here: placeById(pack, v.origin?.id) ?? here, focus: doorPlace ? doorPlace.id : v.focus });
  } else if (v.kind === 'identify' && (v.places?.length)) {
    const picked = v.places.find((c) => c.id === v.focus);
    const list = el('div', { id: 'places', className: 'places' });
    const show = picked ? [picked, ...v.places.filter((c) => c.id !== picked.id)] : v.places;
    if (picked) {
      extra.append(el('div', { className: 'ident' }, el('div', { className: 'ident-h', text: 'This looks like' }), placeCard(picked, v), el('p', { className: 'looks', text: picked.looks }),
        el('button', { type: 'button', className: 'btn primary small', id: 'set-here', text: `I am here: set “${picked.name}” as my place`, onclick: () => { $('here').value = picked.id; ls.set(LS.here, picked.id); toast(`Your place is now ${picked.name}.`); } })));
      if (show.length > 1) extra.append(el('div', { className: 'sub-h', text: 'Other close matches' }));
    } else extra.append(el('div', { className: 'sub-h', text: 'Is it one of these? Pick one to set where you are.' }));
    for (const c of picked ? show.slice(1) : show) list.append(placeCard(c, v, { onPick: (x) => { $('here').value = x.id; ls.set(LS.here, x.id); toast(`Your place is now ${x.name}.`); } }));
    extra.append(list);
    photos = show.filter((c) => c.photos?.length).map((c) => ({ id: c.photos[0], caption: c.name }));
    map?.show({ places: show, here, focus: v.focus });
  } else if (v.places?.length) {
    const list = el('div', { id: 'places', className: 'places' });
    let route = v.route ?? null;
    const pickPlace = (c) => {
      const w = walk(pack, placeById(pack, v.ref?.id ?? here?.id), placeById(pack, c.id));
      for (const x of list.children) x.classList.toggle('focus', x.dataset.id === c.id);
      map?.show({ route: w, places: v.places, here: v.ref ? placeById(pack, v.ref.id) : here, focus: c.id, stepNumbers: false });
      if (c.photos?.length) showPhotos(photos, Math.max(0, photos.findIndex((x) => x.id === c.photos[0])));
      renderRouteMini(w, c);
    };
    for (const c of v.places) list.append(placeCard(c, v, { onPick: pickPlace }));
    extra.append(list);
    if (v.note) extra.append(el('p', { className: 'muted small', text: v.note }));
    const mini = el('div', { id: 'route-mini', className: 'route-mini' });
    extra.append(mini);
    const renderRouteMini = (w, c) => {
      mini.replaceChildren();
      if (!w?.steps?.length) return;
      mini.append(el('div', { className: 'sub-h', text: `Walk to ${c.name}: ${w.summary}` }));
      const { ol } = stepsList(w, v);
      ol.id = 'steps';
      mini.append(ol);
    };
    photos = v.places.filter((c) => c.photos?.length).map((c) => ({ id: c.photos[0], caption: c.kind === 'restaurant' || c.kind === 'cafe' ? `${c.name}: ${c.dish ?? ''}` : c.name }));
    map?.show({ route, places: v.places, here: v.ref ? placeById(pack, v.ref.id) : here, focus: v.focus, stepNumbers: false });
    if (route && v.places[0]) renderRouteMini(route, v.places[0]);
  } else {
    map?.show({ places: [], here, focus: null });
    const hp = placeById(pack, here?.id);
    if (hp?.photos?.length) photos = [{ id: hp.photos[0], caption: `${hp.name} (where you are)` }];
  }
  box.append(extra);
  showPhotos(photos, 0);
}

function renderAnswer(r, live) {
  const box = $('answer');
  box.className = 'answer';
  if (live) {
    const a = box.querySelector('.a');
    if (a) { a.textContent = live.answer || (live.phase === 'understand' ? 'Reading your question…' : live.where === 'cloud' ? 'Asking the cloud AI…' : 'Thinking on this computer…'); a.className = 'a pending'; }
    return;
  }
  box.replaceChildren();
  box.dataset.id = r.id;
  const b = badgeOf(r);
  const kind = r.view?.kind ?? r.record?.kind ?? 'other';
  box.append(el('div', { className: 'q-row' }, el('span', { className: `kind-tag k-${kind}`, text: KIND_LABEL[kind] ?? 'Question' }), el('span', { className: 'q', text: r.input?.text ?? '' })));
  const und = r.record?.understood ?? r.view?.understood ?? null;
  if (und) box.append(understoodLine(r, und));
  const a = el('div', { className: 'a' });
  if (r.status === 'done' && r.record?.found) { a.textContent = r.record.answer; }
  else if (r.status === 'done') { a.textContent = r.record?.gated ? r.record.answer : 'Your saved travel pack does not include this.'; a.className = 'a notfound'; }
  else { a.textContent = r.reasonText || r.error?.message || 'Could not answer.'; a.className = `a ${r.blockedBy === 'offline' ? 'offline' : 'failed'}`; }
  box.append(a);
  // the cloud turned down this page's security check: only a fresh page starts it again
  if (r.reload) box.append(el('button', { type: 'button', className: 'reload-page', id: 'reload-page', text: 'Reload the page', onclick: () => location.reload() }));
  if (und?.status === 'none' && und.candidates?.length) {
    box.append(el('div', { className: 'similar' }, el('span', { className: 'muted small', text: 'Similar names in your pack: ' }),
      und.candidates.map((c) => el('button', { type: 'button', className: 'chip-btn', 'data-place': c.id, text: c.name, onclick: () => reask(r, { placeId: c.id }) }))));
  }
  if (und?.also) box.append(el('div', { className: 'also' }, el('span', { className: 'muted small', text: 'You also asked: ' }), el('button', { type: 'button', className: 'link also-ask', text: `“${und.also}” · Ask this`, onclick: () => { $('question').value = und.also; ask(und.also); } })));
  if (r.check?.includes('answer')) box.append(el('p', { className: 'warn', text: 'Some numbers in this answer are not in your saved pack. Please check.' }));
  if (r.status !== 'done' && r.view?.places?.length) box.append(el('p', { className: 'muted small', text: 'Below is what the app worked out from your pack without AI.' }));
  box.append(el('div', { className: 'meta' },
    el('span', { className: `badge-source ${b.cls}`, text: b.text }),
    r.timing?.totalMs != null ? el('span', { className: 'muted', text: secs(r.timing.totalMs) }) : null,
    el('span', { className: 'muted net-at', text: r.offlineAtAsk ? 'Asked offline' : 'Asked online' }),
    r.view?.moment ? el('span', { className: 'muted', text: `Time used: ${r.view.moment.text}` }) : null,
    el('details', { className: 'given' }, el('summary', { text: 'What the AI was given' }), el('pre', { text: givenText(r) }))));
  renderView(box, r);
}

/** What the AI saw and wrote, for the "What the AI was given" box. */
function givenText(r) {
  const out = [];
  if (r.understood) out.push(`1. Read the question (${r.understood.source === 'in_cloud' ? 'cloud AI' : 'on-device AI'}, ${secs(r.understood.ms)}):`, `   ${JSON.stringify(Object.fromEntries(Object.entries(r.understood.value ?? {}).filter(([k, v]) => k !== 'dropped' && v !== '')))}`);
  else if (r.record?.understood?.by === 'user') out.push('1. Kind and place chosen on screen (no AI call).');
  const lines = (r.record?.lines ?? []).map((l) => l.text);
  if (lines.length) out.push('2. Lines from your saved pack, for the AI to word:', ...lines);
  else if (r.status === 'done') out.push('2. The app worked out the answer from your saved pack (no further AI call).');
  return out.join('\n') || '(nothing)';
}

function showHome() {
  const box = $('answer');
  box.className = 'answer empty';
  box.removeAttribute('data-id');
  const here = placeById(pack, hereId());
  box.replaceChildren(
    el('h2', { text: 'Ask like you would ask a local guide' }),
    el('p', { className: 'muted', text: 'Pick where you are, then ask. Routes, distances and opening hours are worked out on this computer from your saved pack; the AI only words the answer.' }),
    el('ul', { className: 'examples' }, [
      ['food', 'Where can I eat dumplings near here?'], ['route', 'How do I get to Jogyesa Temple?'], ['sights', 'What is worth seeing around here?'], ['identify', 'I see a red-brick building with a tall tower and a small dome. What is it?'],
    ].map(([k, q]) => el('li', {}, el('button', { type: 'button', className: 'link ex', onclick: () => { $('question').value = q; chosenKind = null; renderKinds(); $('question').focus(); } }, el('span', { className: `kind-tag k-${k}`, text: KIND_LABEL[k] }), ` ${q}`)))),
    el('ul', { id: 'ready', className: 'ready' }),
  );
  map?.show({ places: [], here: here ? { ...here } : null });
  showPhotos(here?.photos?.length ? [{ id: here.photos[0], caption: `${here.name} (where you are)` }] : []);
  renderReady();
}

async function renderReady() {
  const ul = $('ready');
  if (!ul) return;
  const saved = !!rk.packState?.saved;
  const app = await appSaved();
  const d = rk.engine?.state.device;
  const item = (ok, t, x) => el('li', { className: ok === true ? 'ok' : ok === false ? 'no' : 'wait' }, el('strong', { text: t }), ` ${x}`);
  ul.replaceChildren(
    item(saved, 'Travel pack:', saved ? `${pack.places.length} places and ${pack.photos.length} photos saved on this computer.` : 'not saved yet. Press “Save for offline” while online.'),
    item(app, 'App:', app ? 'saved on this computer.' : 'not saved yet.'),
    item(d ? ['ready', 'warming'].includes(d) || (d === 'checking' ? null : false) : null, 'On-device AI:', !d || d === 'checking' ? 'checking…' : ['ready', 'warming'].includes(d) ? 'available, so answers work offline.' : 'not on this computer. The cloud answers when you are online.'),
  );
}

async function ask(question) {
  const q = question.trim();
  if (!q) return;
  if (!pack) { toast('Save the travel pack first.'); return; }
  const kind = chosenKind;
  const box = $('answer');
  box.className = 'answer';
  box.removeAttribute('data-id');
  box.replaceChildren(el('div', { className: 'q-row' }, kind ? el('span', { className: `kind-tag k-${kind}`, text: KIND_LABEL[kind] }) : null, el('span', { className: 'q', text: q })), el('div', { className: 'a pending', text: 'Reading your question…' }), el('div', { className: 'meta' }, el('span', { className: 'badge-source b-wait', text: 'Working' })));
  const offlineAtAsk = !navigator.onLine;
  const r = await rk.engine.process({ text: q, here: hereId(), pack, at: atValue(), kind }, { onPartial: (p) => renderAnswer(null, { answer: p.record?.answer, where: p.where, phase: p.phase }) });
  r.offlineAtAsk = offlineAtAsk;
  renderAnswer(r);
  rk.results.push(r);
}

/** The person corrects what the app understood (kind or place): the app answers again from the pack, without asking the AI to read it again. */
async function reask(prev, change) {
  const u0 = prev.record?.understood ?? prev.view?.understood ?? {};
  const raw = prev.understood?.value ?? {};
  const kind = change.kind ?? u0.kind ?? prev.view?.kind ?? 'other';
  const understood = {
    kind, by: 'user', food: raw.food ?? u0.food ?? '', time: raw.time ?? u0.time ?? 'any', also: '',
    place: '', from: '', placeId: change.placeId !== undefined ? change.placeId : (u0.place?.id ?? ''),
    fromId: kind === 'route' ? (u0.from?.id ?? null) : null,
  };
  const q = prev.input?.text ?? '';
  const box = $('answer');
  box.querySelector('.a')?.replaceChildren(document.createTextNode('Working it out again…'));
  const offlineAtAsk = !navigator.onLine;
  const r = await rk.engine.process({ text: q, here: prev.view?.here?.id ?? hereId(), pack, at: atValue(), understood }, {});
  r.offlineAtAsk = offlineAtAsk;
  r.correctedFrom = prev.id;
  renderAnswer(r);
  rk.results.push(r);
}

/** "Understood as: Directions · Anguk Station Exit 6": two menus to change the kind or the place with one click each. */
function understoodLine(r, u) {
  const kindSel = el('select', { className: 'u-kind', 'aria-label': 'Kind of question the app understood' },
    KIND_ORDER.map((k) => el('option', { value: k, text: KIND_LABEL[k], selected: k === u.kind })));
  kindSel.addEventListener('change', () => reask(r, { kind: kindSel.value }));
  const parts = [el('span', { className: 'u-h', text: u.by === 'rules' ? 'Guessed without AI:' : 'Understood as:' }), kindSel];
  if (u.kind !== 'identify') {
    const placeSel = el('select', { className: 'u-place', 'aria-label': 'Place the app understood' });
    const cur = u.place?.id ?? '';
    placeSel.append(el('option', { value: '', text: u.status === 'none' ? `“${u.placeText}” · not in your pack` : 'No place named', selected: !cur }));
    const cands = (u.candidates ?? []).filter((c) => c && c.id !== cur);
    if (cur) placeSel.append(el('option', { value: cur, text: u.place.name, selected: true }));
    if (cands.length) placeSel.append(el('optgroup', { label: 'Close matches' }, cands.map((c) => el('option', { value: c.id, text: c.name }))));
    const groups = new Map();
    for (const p of pack.places) { if (!groups.has(p.kind)) groups.set(p.kind, []); groups.get(p.kind).push(p); }
    for (const [k, list] of groups) placeSel.append(el('optgroup', { label: GROUP_LABEL[k] ?? k }, list.sort((a, b) => a.name.localeCompare(b.name)).map((p) => el('option', { value: p.id, text: p.name }))));
    placeSel.addEventListener('change', () => reask(r, { placeId: placeSel.value }));
    parts.push(el('span', { className: 'u-sep', text: u.kind === 'route' ? '· to' : u.kind === 'food' || u.kind === 'sights' ? '· near' : '·' }), placeSel);
  }
  const rest = String(u.label ?? '').split(' · ').slice(1).filter((x) => !/^(to|from|near) /.test(x) && x !== u.place?.name && !/not in your pack/.test(x));
  if (u.kind === 'route' && u.from) rest.unshift(`from ${u.from.name}`);
  if (rest.length) parts.push(el('span', { className: 'u-rest', text: `· ${rest.join(' · ')}` }));
  return el('div', { className: 'understood', id: 'understood', 'data-label': u.label ?? '' }, parts);
}

// ---------------------------------------------------------------- credits
const LICENCE_URL = { odbl: 'https://opendatacommons.org/licenses/odbl/1-0/', ccBySa4: 'https://creativecommons.org/licenses/by-sa/4.0/', osm: 'https://www.openstreetmap.org/copyright' };
const extLink = (href, text) => el('a', { href, target: '_blank', rel: 'noopener', text });
/** A credit line with its web address (like "openstreetmap.org/copyright") as a link. */
function creditLine(text) {
  const parts = String(text).split(/((?:www\.)?openstreetmap\.org\/copyright)/);
  return el('li', {}, parts.map((s, i) => (i % 2 ? extLink(LICENCE_URL.osm, s) : s)));
}
/** The Wikivoyage article and revision named in the pack credits, as a link to that revision. */
function wikivoyageLink() {
  const m = (pack.credits ?? []).join(' ').match(/Wikivoyage, "([^"]+)" \(revision (\d+)\)/);
  if (!m) return null;
  const title = encodeURIComponent(m[1].replace(/ /g, '_')).replace(/%2F/g, '/');
  return extLink(`https://en.wikivoyage.org/w/index.php?title=${title}&oldid=${m[2]}`, `“${m[1]}” (revision ${m[2]})`);
}
function renderCredits() {
  const body = $('credits-body');
  const packUrl = new URL(packInfo?.url ?? `packs/${pack.id}/pack.json`, location.href).href;
  const wv = wikivoyageLink();
  body.replaceChildren(
    el('ul', { className: 'credit-lines' }, pack.credits.map(creditLine)),
    el('p', { className: 'muted small' }, 'This travel pack is a database derived from OpenStreetMap and is available under the ',
      extLink(pack.licence?.dataUrl ?? LICENCE_URL.odbl, 'Open Database License (ODbL) 1.0'), '. You can download the whole pack: ',
      extLink(packUrl, 'pack.json'), ' (photos are listed below).'),
    el('p', { className: 'muted small' }, 'Text adapted from the Wikivoyage article ', wv ?? 'used for this pack', ' by Wikivoyage contributors, available under ',
      extLink(pack.licence?.textUrl ?? LICENCE_URL.ccBySa4, 'CC BY-SA 4.0'), '. Changes were made.'),
    el('h3', { text: `Photos (${pack.photos.length})` }),
    el('table', { className: 'credit-table' }, el('thead', {}, el('tr', {}, ['', 'Photo', 'Author', 'Licence', 'Source'].map((h) => el('th', { text: h })))),
      el('tbody', {}, pack.photos.map((ph) => el('tr', { id: `cr-${ph.id}` },
        el('td', {}, el('img', { src: photoUrl(ph.id), alt: '', loading: 'lazy' })),
        el('td', {}, el('div', { text: ph.title }), el('div', { className: 'muted small', text: `${ph.kind === 'dish' ? 'Kind of dish, not taken at the restaurant. ' : ''}Used for: ${ph.for.map((id) => placeById(pack, id)?.name ?? id).join(', ')}. ${ph.changes}` })),
        el('td', { text: ph.author }),
        el('td', {}, ph.licenseUrl ? el('a', { href: ph.licenseUrl, target: '_blank', rel: 'noopener', text: ph.license }) : ph.license),
        el('td', {}, el('a', { href: ph.page, target: '_blank', rel: 'noopener', text: 'Wikimedia Commons' })))))),
  );
}
function openCredits(photoId) {
  const d = $('credits');
  if (!d.open) d.showModal();
  if (photoId) { const row = document.getElementById(`cr-${photoId}`); row?.scrollIntoView({ block: 'center' }); row?.classList.add('flash'); setTimeout(() => row?.classList.remove('flash'), 1600); }
}

let toastTimer = null;
function toast(text) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('div', { className: 'toast', role: 'alert' }); document.body.append(t); }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}

// ---------------------------------------------------------------- two modes: the guide, and "Read a Korean sign" (#read)
function setMode(mode, { push = true } = {}) {
  const read = mode === 'read';
  rk.mode = read ? 'read' : 'guide';
  document.body.classList.toggle('reading', read);
  $('guide-ask').hidden = read;
  document.querySelector('.stage').hidden = read;
  $('read-view').hidden = !read;
  for (const [id, on] of [['tab-guide', !read], ['tab-read', read]]) { $(id).classList.toggle('on', on); $(id).setAttribute('aria-selected', on ? 'true' : 'false'); }
  if (push) history.replaceState(null, '', `${location.pathname}${location.search}${read ? '#read' : ''}`);
  if (!read) map?.refit();
}

// ---------------------------------------------------------------- start
async function main() {
  renderNet();
  $('tab-guide').addEventListener('click', () => setMode('guide'));
  $('tab-read').addEventListener('click', () => { setMode('read'); $('read-text').focus(); });
  addEventListener('hashchange', () => setMode(location.hash === '#read' ? 'read' : 'guide', { push: false }));
  setupRead({ $, el, toast, engine: () => rk.engine, results: rk.reads });
  if (location.hash === '#read') setMode('read', { push: false });
  addEventListener('online', () => { renderNet(); renderReady(); });
  addEventListener('offline', () => { renderNet(); renderReady(); });
  $('pack-save').addEventListener('click', onSave);
  $('here').addEventListener('change', () => { ls.set(LS.here, hereId()); if ($('answer').classList.contains('empty')) showHome(); });
  $('at-now').addEventListener('click', setNow);
  $('day').addEventListener('change', syncAt);
  $('time').addEventListener('change', syncAt);
  setNow();
  rk.setAt = setAt;
  for (const b of document.querySelectorAll('.kind')) b.addEventListener('click', () => { chosenKind = chosenKind === b.dataset.kind ? null : b.dataset.kind; renderKinds(); $('question').focus(); });
  $('ask-form').addEventListener('submit', (e) => { e.preventDefault(); const q = $('question').value; ask(q).finally(() => { chosenKind = null; renderKinds(); }); });
  $('credits-open').addEventListener('click', () => openCredits());
  $('credits').addEventListener('click', (e) => { if (e.target.matches('[data-close]') || e.target === $('credits')) $('credits').close(); });
  for (const b of document.querySelectorAll('.mt')) b.addEventListener('click', () => map?.zoom(b.dataset.zoom));
  let drag = null;
  $('map').addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; $('map').setPointerCapture(e.pointerId); });
  $('map').addEventListener('pointermove', (e) => { if (!drag) return; map?.pan(e.clientX - drag.x, e.clientY - drag.y); drag = { x: e.clientX, y: e.clientY }; });
  $('map').addEventListener('pointerup', () => { drag = null; });
  $('map').addEventListener('wheel', (e) => { e.preventDefault(); map?.zoom(e.deltaY < 0 ? 'in' : 'out'); }, { passive: false });
  addEventListener('resize', () => map?.refit());

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw-trip.js', { scope: './trip' }).catch(() => {});
    navigator.serviceWorker.startMessages?.();
  }

  const idx = await packIndex();
  packInfo = idx?.packs?.[0] ?? null;
  if (packInfo && navigator.onLine && ls.get(LS.pack) === packInfo.id) keepIndex(packInfo).catch(() => {}); // packs saved by an older version kept it elsewhere
  const savedId = ls.get(LS.pack) ?? packInfo?.id;
  let p = savedId ? await loadSavedPack(savedId) : null;
  if (!p && packInfo && navigator.onLine) {
    try { const res = await fetch(`${packInfo.url}?fresh=${Date.now()}`, { cache: 'no-store' }); if (res.ok) p = await res.json(); } catch { /* offline */ }
  }
  if (p) usePack(p);
  else $('answer').replaceChildren(el('h2', { text: 'No travel pack on this computer yet' }), el('p', { text: 'Connect to the internet and press “Save for offline” to save the pack, its photos and the app.' }));
  await renderPackState();

  try {
    rk.engine = await startEngine('trip');
  } catch (e) {
    $('answer').prepend(el('p', { className: 'a failed', text: e.code === 'no-config' ? 'Setup needed: copy firebase-config.example.js to local/firebase-config.js. See README.' : `Could not start: ${e.message}` }));
    rk.ready = true;
    return;
  }
  let lastDevice = null;
  rk.engine.onState((s) => { renderDevice(s); if (s.device !== lastDevice) { lastDevice = s.device; renderReady(); } });
  $('device-only').addEventListener('change', (e) => rk.engine.setDeviceOnly(e.target.checked));
  await renderReady();
  rk.ready = true;
}

main();
