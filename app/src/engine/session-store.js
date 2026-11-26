// Session store: a speed-up for on-device requests made through the Firebase AI Logic SDK.
//
// Why: for every on-device request the SDK asks Chrome for a brand-new LanguageModel session
// (ChromeAdapterImpl.createSession), so the model re-reads the system prompt each time
// (about 0.7 s for a short prompt, 1.8 s for a long one, measured on our test PC).
//
// How: while getGenerativeModel() runs, the SDK picks up window.LanguageModel. We hand it a
// stand-in with the same shape. Its create() makes one base session per set of options and then
// returns clones of it (a clone keeps the already-read system prompt). The request itself, the
// streaming and inferenceSource all stay inside the SDK. This file never runs inference.
//
// Switch: `?store=off` in the URL, or setEnabled(false) before the first model is made.
// If anything about the stand-in fails (for example clone() is missing in a future Chrome),
// create() falls back to a plain LanguageModel.create().

const real = () => globalThis.LanguageModel;
const keyOf = (o) => JSON.stringify(o ?? {}, (k, v) => (k === 'monitor' || k === 'signal' ? undefined : v));

let enabled = true;
let fault = null; // test switch: 'device-error' makes on-device calls fail like Chrome's kErrorUnknown
const bases = new Map(); // options key -> Promise<LanguageModel session>
export const storeStats = { creates: 0, clones: 0, fallbacks: 0, createMs: [] };

export function setEnabled(on) { enabled = !!on; }
export function isEnabled() { return enabled; }
export function setFault(kind) { fault = kind || null; }

/** One base session per set of create options. Also used to measure input size (device.js). */
export function baseSession(options) {
  const key = keyOf(options);
  if (!bases.has(key)) {
    const started = performance.now();
    const p = real().create(options).then((s) => {
      storeStats.creates += 1;
      storeStats.createMs.push(Math.round(performance.now() - started));
      return s;
    });
    p.catch(() => bases.delete(key));
    bases.set(key, p);
  }
  return bases.get(key);
}
export function hasBase(options) { return bases.has(keyOf(options)); }

// Names of the session methods the test fault replaces. Kept as data so the fault never calls them.
const FAULT_METHODS = ['prompt', 'promptStreaming'];
function unknownError() {
  try { return new DOMException('An unknown error occurred: kErrorUnknown', 'UnknownError'); } catch { const e = new Error('An unknown error occurred: kErrorUnknown'); e.name = 'UnknownError'; return e; }
}
function withFault(session) {
  if (!fault) return session;
  return new Proxy(session, {
    get(target, prop) {
      if (FAULT_METHODS.includes(prop)) return () => { throw unknownError(); };
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const standIn = {
  availability: (o) => real().availability(o),
  params: (...a) => real().params?.(...a),
  async create(options) {
    if (enabled) {
      try {
        const base = await baseSession(options);
        if (typeof base.clone === 'function') {
          const c = await base.clone();
          storeStats.clones += 1;
          return withFault(c);
        }
      } catch { /* fall through to a plain session */ }
      storeStats.fallbacks += 1;
    }
    return withFault(await real().create(options));
  },
};

/** Run fn (which calls getGenerativeModel) with the stand-in in place of window.LanguageModel. */
export function withSessionStore(fn) {
  const original = globalThis.LanguageModel;
  if (!original || (!enabled && !fault)) return fn();
  globalThis.LanguageModel = standIn;
  try { return fn(); } finally { globalThis.LanguageModel = original; }
}
