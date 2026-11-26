// Service worker for the trip guide: keeps the app, the Firebase AI Logic SDK and the saved travel pack on
// this computer so the page opens and answers with no internet.
//
//   app files (same origin)        network first, saved copy when there is no connection
//   travel pack files (/packs/…)   saved copy first (the page saves them with "Save for offline");
//                                  a request with ?fresh=… always goes to the network (that is how the page updates them)
//   Firebase SDK (gstatic)         saved copy first (the URLs carry a fixed version)
//   everything else                not touched (Google API calls go out as usual when online)
//
// Registered by src/ui/trip.js with scope "./trip", so it only controls the trip page.
//
// The page is kept under its clean address "trip": Firebase Hosting (cleanUrls) answers /trip.html with a
// redirect to /trip, and a redirected response cannot be used to open a page. Any redirected response is
// stored as a plain copy for the same reason.
const APP_CACHE = 'trip-app-v9';
const SDK_CACHE = 'trip-sdk-13.3.0';
const APP_FILES = [
  'trip',
  'src/ui/trip.js', 'src/ui/trip.css', 'src/ui/map.js', 'src/ui/read.js',
  'src/engine/index.js', 'src/engine/sdk.js', 'src/engine/cloud.js', 'src/engine/session-store.js',
  'src/engine/partial-json.js', 'src/engine/tasks/trip.js', 'src/engine/tasks/sign.js',
  'src/engine/trip/geo.js', 'src/engine/trip/pack.js', 'src/engine/trip/pick.js', 'src/engine/trip/prompts.js',
  'src/engine/trip/hours.js', 'src/engine/trip/route.js', 'src/engine/trip/guide.js', 'src/engine/trip/names.js',
  'local/firebase-config.js', // the Firebase web settings of this deployment (not in the repository)
];
const SDK_FILES = ['firebase-app.js', 'firebase-ai.js', 'firebase-app-check.js'].map((f) => `https://www.gstatic.com/firebasejs/13.3.0/${f}`);
const NETWORK_WAIT_MS = 4000;

const base = new URL('./', self.location.href);
const appUrl = (f) => new URL(f, base).href;
const plain = async (res) => (res.redirected ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers }) : res);

async function precache() {
  const app = await caches.open(APP_CACHE);
  const sdk = await caches.open(SDK_CACHE);
  const missing = [];
  await Promise.all(APP_FILES.map(async (f) => {
    try {
      const res = await fetch(appUrl(f), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      await app.put(appUrl(f), await plain(res));
    } catch { if (!(await app.match(appUrl(f)))) missing.push(f); }
  }));
  await Promise.all(SDK_FILES.map(async (u) => {
    if (await sdk.match(u)) return;
    try {
      const res = await fetch(new Request(u, { mode: 'cors', credentials: 'omit' }));
      if (!res.ok) throw new Error(String(res.status));
      await sdk.put(u, res);
    } catch { missing.push(u); }
  }));
  const saved = (await app.keys()).length + (await sdk.keys()).length;
  return { saved, missing, total: APP_FILES.length + SDK_FILES.length };
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().catch(() => null).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if ((k.startsWith('trip-app-') || k.startsWith('trip-sdk-')) && k !== APP_CACHE && k !== SDK_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// The page asks for a fresh copy of the app before the trip ("Save for offline").
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'precache') return;
  event.waitUntil(precache().then((r) => event.source?.postMessage({ type: 'precache-done', ...r })).catch((e) => event.source?.postMessage({ type: 'precache-done', error: String(e) })));
});

async function networkFirst(req) {
  const url = new URL(req.url);
  const key = req.mode === 'navigate' ? new URL(url.pathname, url.origin).href : url.href;
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await Promise.race([fetch(req, { cache: 'no-store' }), new Promise((_, no) => setTimeout(() => no(new Error('slow')), NETWORK_WAIT_MS))]);
    if (res.ok && !res.redirected && APP_FILES.some((f) => appUrl(f) === key || (req.mode === 'navigate' && key.endsWith('/trip')))) cache.put(key, res.clone()).catch(() => {});
    return res;
  } catch {
    const hit = await cache.match(key, { ignoreSearch: true, ignoreVary: true });
    if (hit) return hit;
    if (req.mode === 'navigate') { const page = await cache.match(appUrl('trip')); if (page) return page; }
    return Response.error();
  }
}

async function packFile(req) {
  const url = new URL(req.url);
  if (url.searchParams.has('fresh')) return fetch(req, { cache: 'no-store' });
  const hit = await caches.match(new URL(url.pathname, url.origin).href, { ignoreVary: true });
  if (hit) return hit;
  return fetch(req);
}

async function cacheFirst(req) {
  const cache = await caches.open(SDK_CACHE);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req.url, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (SDK_FILES.includes(url.href)) event.respondWith(cacheFirst(req));
  else if (url.origin === self.location.origin && url.pathname.includes('/packs/')) event.respondWith(packFile(req));
  else if (url.origin === self.location.origin) event.respondWith(networkFirst(req));
});
