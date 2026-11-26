// Android build only. Replaces app/src/engine/sdk.js (the Firebase JS SDK from the CDN) in the copy of the web app
// that goes into the APK (app-android/app/build.gradle.kts, copyWebApp).
//
// It keeps the names and shapes the engine (src/engine/index.js) uses: getGenerativeModel(ai, { mode,
// onDeviceParams, inCloudParams }) -> model.generateContentStream(input) -> { stream, response }, and
// response.inferenceSource ('on_device' | 'in_cloud'). But nothing here runs a model or reaches the network:
// every request goes to the Firebase AI Logic Android SDK through the app's bridge (window.TripBridge,
// AiBridge.kt), and the source on each answer is the one the Android SDK reported.
//
// The engine also asks Chrome's LanguageModel whether an on-device model is there. On Android that question goes to
// the SDK's onDeviceExtension.checkStatus() (asked by AiBridge.kt, pushed here); see the stand-in at the end.
const B = globalThis.TripBridge ?? null;
const handlers = new Map();
let seq = 0;
let latest = null; // last on-device model status from the bridge
const statusWaiters = [];

globalThis.__tripBridge = {
  emit(ev) { handlers.get(ev?.id)?.(ev); },
  status(s) {
    latest = s;
    while (statusWaiters.length) statusWaiters.shift()(s);
    try { globalThis.dispatchEvent(new CustomEvent('trip-model-status', { detail: s })); } catch { /* old WebView */ }
  },
  current: () => latest,
};
try { if (B) latest = JSON.parse(B.statusNow()); } catch { /* bridge not ready */ }
if (latest?.status === 'CHECKING') latest = null;

export const SDK_VERSION = `android (${B ? B.sdkVersion() : 'no bridge'})`;
// App Check runs inside the Android SDK (TripActivity.kt). The page never loads the web App Check script.
export const APP_CHECK_URL = '';
export const InferenceMode = { PREFER_ON_DEVICE: 'prefer_on_device', ONLY_ON_DEVICE: 'only_on_device', PREFER_IN_CLOUD: 'prefer_in_cloud', ONLY_IN_CLOUD: 'only_in_cloud' };
export class GoogleAIBackend {}
export function initializeApp(options, name) { return { name, options }; }
export function getAI(app) { return { app }; }

const systemOf = (createOptions) => (createOptions?.initialPrompts ?? []).filter((p) => p.role === 'system').map((p) => p.content).join('\n') || null;

function bridgeError(ev) {
  const e = new Error(ev.message || 'The AI request failed.');
  e.name = ev.name || 'Error';
  e.customErrorData = { status: ev.status ?? null };
  return e;
}

function toParts(input) {
  if (typeof input === 'string') return [{ text: input }];
  if (Array.isArray(input)) return input.map((p) => (typeof p === 'string' ? { text: p } : p.inlineData ? { inlineData: { data: p.inlineData.data, mimeType: p.inlineData.mimeType } } : { text: String(p.text ?? '') }));
  return [{ text: String(input ?? '') }];
}

/** One request: resolves (like the web SDK) once the answer starts, or rejects if it fails before any text. */
function generateStream(spec, input) {
  if (!B) return Promise.reject(Object.assign(new Error('This page is not running inside the Trip Guide app.'), { name: 'NoBridge' }));
  const id = `q${(seq += 1)}`;
  const queue = [];
  let finished = null; // { source } | { error } | { cancelled: true }
  let wake = null;
  let started = false;
  let resolveStart;
  let rejectStart;
  const start = new Promise((res, rej) => { resolveStart = res; rejectStart = rej; });
  let resolveResp;
  let rejectResp;
  const response = new Promise((res, rej) => { resolveResp = res; rejectResp = rej; });
  response.catch(() => {});
  const poke = () => { const w = wake; wake = null; w?.(); };

  const stream = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          for (;;) {
            if (queue.length) { const t = queue.shift(); return { value: { text: () => t }, done: false }; }
            if (finished?.error) throw finished.error;
            if (finished) return { value: undefined, done: true };
            await new Promise((r) => { wake = r; });
          }
        },
        async return() {
          if (!finished) { finished = { cancelled: true }; handlers.delete(id); try { B.cancel(id); } catch { /* gone */ } resolveResp({ inferenceSource: null, text: () => '' }); }
          return { value: undefined, done: true };
        },
      };
    },
  };
  const begin = () => { if (!started) { started = true; resolveStart({ stream, response }); } };

  handlers.set(id, (ev) => {
    if (finished) return;
    if (ev.type === 'chunk') { queue.push(String(ev.text ?? '')); begin(); poke(); return; }
    handlers.delete(id);
    if (ev.type === 'done') {
      const source = ev.source ? String(ev.source).toLowerCase() : null; // ON_DEVICE -> on_device, IN_CLOUD -> in_cloud
      finished = { source };
      resolveResp({ inferenceSource: source, text: () => '' });
      begin();
      poke();
    } else {
      const err = bridgeError(ev);
      finished = { error: err };
      rejectResp(err);
      if (!started) { started = true; rejectStart(err); }
      poke();
    }
  });
  B.generate(id, JSON.stringify({ ...spec, parts: toParts(input) }));
  return start;
}

// The answer form sent to the app is a JSON Schema object or nothing. The web engine may also give an on-device
// request a regular expression as its answer shape (Chrome's responseConstraint; the sign reader's typed text). The
// Android SDK has nothing like it, and JSON.stringify would turn it into {} so that the app asked the model for JSON.
// Such a request goes out as plain text, without a form.
const jsonForm = (s) => (s && typeof s === 'object' && !(s instanceof RegExp) ? s : null);

export function getGenerativeModel(ai, { mode, onDeviceParams, inCloudParams } = {}) {
  const spec = {
    mode: mode ?? InferenceMode.PREFER_ON_DEVICE,
    system: inCloudParams?.systemInstruction ?? systemOf(onDeviceParams?.createOptions),
    schema: jsonForm(inCloudParams?.generationConfig?.responseJsonSchema) ?? jsonForm(onDeviceParams?.promptOptions?.responseConstraint),
    model: inCloudParams?.model ?? null,
  };
  return { generateContentStream: (input) => generateStream(spec, input) };
}

// ---------------------------------------------------------------- stand-in for Chrome's LanguageModel
// Only the two things the engine asks it: availability() and the size of the on-device window (create()).
// The on-device request limit is 4000 tokens for the whole request (Firebase docs, hybrid on Android); the longest
// system instruction plus the JSON form takes about 900 of them, so the engine gets a 3100-token window.
const WINDOW = 3100;
const AVAIL = { AVAILABLE: 'available', DOWNLOADABLE: 'downloadable', DOWNLOADING: 'downloading', UNAVAILABLE: 'unavailable' };
function waitStatus() {
  if (latest) return Promise.resolve(latest);
  return new Promise((r) => statusWaiters.push(r));
}
if (B) {
  globalThis.LanguageModel = {
    async availability() { const s = await waitStatus(); return AVAIL[s.status] ?? 'unavailable'; },
    async create() {
      const session = { contextWindow: WINDOW, inputQuota: WINDOW, contextUsage: 0, inputUsage: 0, async clone() { return session; }, destroy() {} };
      return session;
    },
  };
}
