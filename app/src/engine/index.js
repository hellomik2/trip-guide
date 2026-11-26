// Hybrid engine: on-device first, cloud only when the device can't.
//
// Every inference goes through the Firebase AI Logic web SDK (firebase/ai):
//   - device first:      getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE, ... })
//   - on-device only:    InferenceMode.ONLY_ON_DEVICE, on a Firebase app without App Check (sends nothing)
//   - cloud (when sent): InferenceMode.ONLY_IN_CLOUD, model gemini-3.5-flash-lite by default
// The app itself only asks Chrome whether a model is there (availability) and how big the input is
// (measureContextUsage); neither is inference.
//
// Before each request the engine decides, in under a second, where it should run:
//   no on-device model            -> cloud   (the SDK would also do this, but we decide up front so the
//                                             "simulated no model" switch and the lock behave the same)
//   text too long for the device  -> cloud   (the SDK does not fall back on QuotaExceededError)
//   device error twice in a row   -> cloud   (kErrorUnknown: retried once first)
//   "On-device only" lock is on   -> never cloud; the result says why it could not run
import { initializeApp, getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, SDK_VERSION } from './sdk.js';
import * as store from './session-store.js';
import { hybridAI } from './cloud.js';
import { parseFinal, parsePartial } from './partial-json.js';
import { tripTask } from './tasks/trip.js';
import { signTask, PHOTO_OFFLINE_TEXT, PHOTO_LOCKED_TEXT } from './tasks/sign.js';

// trip: the guide (one JSON form per answer, process()). sign: the sign reader (plain text answers, runText()).
const TASKS = { trip: tripTask, sign: signTask };
const EN = { type: 'text', languages: ['en'] };
const IMG = { type: 'image' }; // Korean cannot be declared as an input language (NotSupportedError), so only the output is English
const LS_LOCK = 'hybrid-engine.deviceOnly';
const LIMITS = {
  availabilityWaitMs: 700, // routing must be decided within 1 s
  measureWaitMs: 250,
  softRatio: 0.6,          // above 60 % of the on-device window, use the cloud when allowed (long inputs were slow and error-prone on device)
  outputReserve: 400,      // tokens kept free for the answer
  maxAnswerChars: 3000,    // a one-row answer is about 200 characters
  stallMs: 45000,          // no new text for this long counts as a device error
  cloudFirstMs: 25000,     // the cloud must start answering within this time, or the row says it could not reach it
};

const DONE_TEXT = {
  device: 'Ran on this device',
  'no-model': 'No on-device model on this computer, so it ran in the cloud',
  'too-long': 'Too long for the on-device model, so it ran in the cloud',
  'device-error': 'The on-device model failed, so it ran in the cloud',
  'sdk-cloud': 'The SDK found no usable on-device model, so it ran in the cloud',
  mask: 'Names, addresses and phone numbers were hidden on this device first, then the row was made in the cloud',
};
const BLOCKED_TEXT = {
  'no-model': 'No on-device model on this computer. On-device only is on, so nothing was sent.',
  'too-long': 'Too long for the on-device model. On-device only is on, so nothing was sent.',
  'device-error': 'The on-device model failed. On-device only is on, so nothing was sent.',
};
// No internet: the cloud cannot be asked, so the engine stops here instead of trying (and waiting).
const OFFLINE_TEXT = {
  'no-model': 'No on-device AI on this computer and no internet connection, so this cannot be answered right now. Connect to the internet and ask again.',
  'too-long': 'Too long for the on-device AI, and there is no internet connection for the cloud. Try a shorter question, or connect and ask again.',
  'device-error': 'The on-device AI failed, and there is no internet connection for the cloud. Please try again.',
};
const isOnline = () => globalThis.navigator?.onLine !== false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([Promise.resolve(p), sleep(ms).then(() => null)]);
const errOf = (e) => ({ name: e?.name ?? 'Error', message: String(e?.message ?? e).slice(0, 600), status: e?.customErrorData?.status ?? null, code: e?.code ?? null });
const named = (name, message) => Object.assign(new Error(message), { name });

function classify(err) {
  const s = `${err.name} ${err.message}`;
  if (/QuotaExceeded|input is too large/i.test(s)) return 'too-long';
  if (/UnknownError|kErrorUnknown/i.test(s)) return 'unknown';
  return 'other';
}

/** One streamed request through the SDK. onText gets the whole text so far. */
async function streamOnce(model, text, onText, { firstMs = null } = {}) {
  const started = model.generateContentStream(text);
  const res = firstMs ? await Promise.race([started, sleep(firstMs).then(() => { throw named('CloudTimeout', 'The cloud did not answer in time.'); })]) : await started;
  const it = res.stream[Symbol.asyncIterator]();
  let all = '';
  for (;;) {
    const step = await Promise.race([it.next(), sleep(LIMITS.stallMs).then(() => 'stall')]);
    if (step === 'stall') { it.return?.(); throw named('StallError', 'The model stopped answering.'); }
    if (step.done) break;
    all += step.value.text();
    onText(all);
    if (all.length > LIMITS.maxAnswerChars) { it.return?.(); throw named('RunawayError', 'The answer was far longer than one row.'); }
  }
  const resp = await res.response;
  return { text: all, source: String(resp?.inferenceSource ?? '').toLowerCase() || null };
}

const LOOP = /([\s\S]{2,40}?)\1{7,}$/; // the same short piece eight times in a row at the end

/** One streamed plain-text request (a task with output 'text'). A runaway answer is cut, not thrown away. */
async function streamText(model, parts, onText, { firstMs = null, maxChars = 4000 } = {}) {
  const started = model.generateContentStream(parts);
  const res = firstMs ? await Promise.race([started, sleep(firstMs).then(() => { throw named('CloudTimeout', 'The cloud did not answer in time.'); })]) : await started;
  const it = res.stream[Symbol.asyncIterator]();
  let all = '';
  let cut = false;
  for (;;) {
    const step = await Promise.race([it.next(), sleep(LIMITS.stallMs).then(() => 'stall')]);
    if (step === 'stall') { it.return?.(); throw named('StallError', 'The model stopped answering.'); }
    if (step.done) break;
    all += step.value.text();
    onText(all);
    // too long, or the model is repeating itself (seen once with a photo: one Korean word and " = " written over and over for 3 minutes)
    if (all.length > maxChars || (all.length > 400 && LOOP.test(all.slice(-300)))) { cut = true; it.return?.(); break; }
  }
  const resp = cut ? await withTimeout(res.response.catch(() => null), 1500) : await res.response;
  return { text: all, cut, source: String(resp?.inferenceSource ?? '').toLowerCase() || null };
}

// Plain-text task (sign reader): what the card says when nothing could answer, and how it was answered.
const TEXT_BLOCKED = {
  locked: {
    'no-model': 'No on-device AI on this computer. “Never use the cloud” is on, so nothing was sent.',
    'too-long': 'This is too long for the on-device AI. “Never use the cloud” is on, so nothing was sent. Try fewer lines.',
    'device-error': 'The on-device AI failed. “Never use the cloud” is on, so nothing was sent. Please try again.',
  },
  offline: {
    'no-model': 'No on-device AI on this computer and no internet connection, so this cannot be explained right now. Connect to the internet and try again.',
    'too-long': 'This is too long for the on-device AI, and there is no internet connection for the cloud. Try fewer lines.',
    'device-error': 'The on-device AI failed, and there is no internet connection for the cloud. Please try again.',
  },
};
const TEXT_DONE = {
  device: 'Read on this computer by the on-device AI',
  'sdk-cloud': 'The SDK found no usable on-device model, so the cloud AI read it',
  'no-model': 'No on-device AI on this computer, so the cloud AI read it',
  'too-long': 'Too long for the on-device AI, so the cloud AI read it',
  'device-error': 'The on-device AI failed, so the cloud AI read it',
  'photo-cloud': 'Photos are read by the cloud AI while you are online (it reads photos more reliably)',
  'photo-offline': 'No internet connection, so the on-device AI read the photo',
  'photo-locked': '“Never use the cloud” is on, so the on-device AI read the photo',
  'cloud-failed': 'Could not reach the cloud, so the on-device AI read the photo',
  'lines-cloud': 'Text with several lines is read by the cloud AI while you are online (it explains menus more reliably)',
  'lines-offline': 'No internet connection, so the on-device AI read it',
  'lines-locked': '“Never use the cloud” is on, so the on-device AI read it',
  'lines-cloud-failed': 'The cloud AI could not answer, so the on-device AI read it',
};

function readSettings() {
  const q = new URLSearchParams(location.search);
  let deviceOnly = false;
  try { deviceOnly = localStorage.getItem(LS_LOCK) === '1'; } catch { /* private mode */ }
  if (q.has('deviceOnly')) {
    deviceOnly = q.get('deviceOnly') === '1';
    try { localStorage.setItem(LS_LOCK, deviceOnly ? '1' : '0'); } catch { /* ignore */ }
  }
  const sim = q.get('simulate');
  // ?mix=review|mask|numbers, or the pair mask,numbers: ways to mix the two AIs, kept from an earlier
  // task. They apply only to a task that defines them (the trip guide does not). Off unless asked for.
  const mix = (q.get('mix') ?? '').split(',').map((x) => x.trim()).filter(Boolean).sort().join(',');
  return { simulate: ['no-model', 'device-error'].includes(sim) ? sim : null, sessionStore: q.get('store') !== 'off', deviceOnly, mix: ['review', 'mask', 'numbers', 'mask,numbers'].includes(mix) ? mix : null };
}

async function loadConfig() {
  try {
    const m = await import(new URL('../../local/firebase-config.js', import.meta.url).href);
    if (!m.firebaseConfig) throw new Error('firebaseConfig is missing');
    return m;
  } catch (cause) {
    throw Object.assign(new Error('Setup needed: local/firebase-config.js was not found.'), { code: 'no-config', cause });
  }
}

class Engine {
  constructor(task, config, settings) {
    this.task = task;
    this.config = config;
    this.columns = task.columns;
    this.dateLabel = task.dateLabel;
    this.listeners = new Set();
    this.models = new Map();
    this.state = {
      device: 'checking', simulated: settings.simulate, deviceOnly: settings.deviceOnly,
      sessionStore: settings.sessionStore, cloudModel: config.cloudModel || 'gemini-3.5-flash-lite',
      tokenLimit: null, sdkVersion: SDK_VERSION, online: isOnline(), mix: settings.mix && settings.mix.split(',').every((m) => task.mix?.[m]) ? settings.mix : null,
    };
    this.createOptions = this.optionsFor(task.system);
    store.setEnabled(settings.sessionStore);
    this.warm = { promise: null, ms: null, error: null };
  }

  /** Is this way of mixing turned on (?mix=…)? */
  mixHas(name) { return !!this.state.mix && this.state.mix.split(',').includes(name); }

  optionsFor(system) { return { expectedInputs: [EN], expectedOutputs: [EN], initialPrompts: [{ role: 'system', content: system }] }; }

  set(patch) {
    Object.assign(this.state, patch);
    for (const fn of this.listeners) { try { fn({ ...this.state }); } catch { /* listener error */ } }
  }
  onState(fn) { this.listeners.add(fn); fn({ ...this.state }); return () => this.listeners.delete(fn); }
  setDeviceOnly(on) {
    try { localStorage.setItem(LS_LOCK, on ? '1' : '0'); } catch { /* ignore */ }
    this.set({ deviceOnly: !!on });
    if (!on && isOnline()) hybridAI(this.config).catch(() => {});
  }
  display(record) { return this.task.display(record); }
  inspect(text) { return this.task.inspect(text); }
  stats() { return { store: { ...store.storeStats, createMs: [...store.storeStats.createMs] }, warmMs: this.warm.ms, warmError: this.warm.error }; }

  start() {
    this.availability = this.checkDevice();
    // The cloud side (App Check, reCAPTCHA) is started only with a connection, so an offline page contacts no one.
    if (!this.state.deviceOnly && isOnline()) hybridAI(this.config).catch(() => {});
    globalThis.addEventListener?.('online', () => { this.set({ online: true }); if (!this.state.deviceOnly) hybridAI(this.config).catch(() => {}); });
    globalThis.addEventListener?.('offline', () => this.set({ online: false }));
    this.availability.then((a) => { if (a === 'available') this.warmUp(); });
  }

  async checkDevice() {
    if (this.state.simulated === 'no-model') { this.set({ device: 'unavailable' }); return 'unavailable'; }
    const LM = globalThis.LanguageModel;
    if (!LM) { this.set({ device: 'no-api' }); return 'no-api'; }
    try {
      const a = await LM.availability({ expectedInputs: [EN], expectedOutputs: [EN] });
      if (a !== 'available') this.set({ device: a });
      else if (this.state.device === 'checking' || this.state.device === 'downloading' || this.state.device === 'downloadable') this.set({ device: 'warming' });
      return a;
    } catch { this.set({ device: 'error' }); return 'error'; }
  }

  /** Availability for routing, within the time budget. A model that finished downloading is picked up here. */
  async currentAvailability() {
    if (this.state.simulated === 'no-model') return 'unavailable';
    const last = this.state.deviceOnly ? await this.availability : await withTimeout(this.availability, LIMITS.availabilityWaitMs);
    if (last == null) return 'timeout';
    if (last === 'available' || last === 'no-api') return last;
    this.availability = this.checkDevice();
    const again = await withTimeout(this.availability, 300);
    if (again === 'available') this.warmUp();
    return again ?? last;
  }

  /** Load the on-device model into memory before the first paste (a short request through the SDK). */
  warmUp() {
    if (this.warm.promise) return this.warm.promise;
    this.set({ device: 'warming' });
    this.warm.promise = (async () => {
      const s = performance.now();
      try {
        const base = store.baseSession(this.createOptions); // reused for measuring input size
        const model = await this.model('warm');
        const res = await model.generateContentStream('Reply with OK.');
        for await (const chunk of res.stream) chunk.text();
        await res.response;
        const b = await base;
        // mix=review|mask make a second kind of on-device request; read its system prompt ahead too.
        for (const m of ['review', 'mask']) {
          const aux = this.mixHas(m) ? this.task.mix?.[m]?.system : null;
          if (aux) await store.baseSession(this.optionsFor(aux)).catch(() => {});
        }
        // a task that reads the question first (trip guide) has a second system prompt: read it ahead too
        if (this.task.understandSystem) await store.baseSession(this.optionsFor(this.task.understandSystem)).catch(() => {});
        // plain-text tasks on the same page (the sign reader): their text session is read ahead too (photos only when used)
        for (const t of Object.values(TASKS)) if (t.output === 'text' && t !== this.task) await store.baseSession(this.textOptions(t.system, false)).catch(() => {});
        this.warm.ms = Math.round(performance.now() - s);
        this.set({ device: 'ready', tokenLimit: b.contextWindow ?? b.inputQuota ?? null });
      } catch (e) {
        this.warm.error = errOf(e);
        this.set({ device: 'error' });
      } finally {
        if (this.state.simulated === 'device-error') store.setFault('device-error');
      }
    })();
    return this.warm.promise;
  }

  deviceAI() {
    // A separate Firebase app with no App Check: on-device requests need nothing from the network.
    this._deviceAI ??= getAI(initializeApp(this.config.firebaseConfig, 'hybrid-engine-device'), { backend: new GoogleAIBackend() });
    return this._deviceAI;
  }

  /** A model per kind, answer schema and system prompt (a task may give a different schema or system prompt per request). */
  async model(kind, schema = this.task.schema, system = this.task.system) {
    const key = `${kind}|${system === this.task.system ? '' : system}|${kind === 'warm' ? '' : JSON.stringify(schema)}`;
    if (this.models.has(key)) return this.models.get(key);
    const onDeviceParams = { createOptions: system === this.task.system ? { ...this.createOptions } : this.optionsFor(system), promptOptions: kind === 'warm' ? {} : { responseConstraint: schema } };
    const inCloudParams = { model: this.state.cloudModel, systemInstruction: system, generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema } };
    let m;
    if (kind === 'device' || kind === 'warm') {
      m = store.withSessionStore(() => getGenerativeModel(this.deviceAI(), { mode: InferenceMode.ONLY_ON_DEVICE, onDeviceParams }));
    } else if (kind === 'hybrid' && !isOnline()) {
      return this.model('device', schema, system); // offline: on-device only, nothing is started for the cloud
    } else if (kind === 'hybrid') {
      let ai = null;
      try { ai = await hybridAI(this.config); } catch { /* App Check could not start: stay on device */ }
      if (!ai) return this.model('device', schema, system);
      m = store.withSessionStore(() => getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE, onDeviceParams, inCloudParams }));
    } else {
      const ai = await hybridAI(this.config);
      m = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams });
    }
    this.models.set(key, m);
    return m;
  }

  /** Create options for a plain-text task: no answer schema; image input declared only for photos. */
  textOptions(system, image = false) { return { expectedInputs: image ? [EN, IMG] : [EN], expectedOutputs: [EN], initialPrompts: [{ role: 'system', content: system }] }; }

  /** A model for a plain-text task (sign reader): same three ways as model(), without JSON. */
  async textModel(kind, system, image = false) {
    const key = `text|${kind}|${image ? 'image' : 'text'}|${system}`;
    if (this.models.has(key)) return this.models.get(key);
    const onDeviceParams = { createOptions: this.textOptions(system, image) };
    const inCloudParams = { model: this.state.cloudModel, systemInstruction: system };
    let m;
    if (kind === 'device') {
      m = store.withSessionStore(() => getGenerativeModel(this.deviceAI(), { mode: InferenceMode.ONLY_ON_DEVICE, onDeviceParams }));
    } else if (kind === 'hybrid') {
      if (!isOnline()) return this.textModel('device', system, image); // offline: nothing is started for the cloud
      let ai = null;
      try { ai = await hybridAI(this.config); } catch { /* App Check could not start: stay on device */ }
      if (!ai) return this.textModel('device', system, image);
      m = store.withSessionStore(() => getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE, onDeviceParams, inCloudParams }));
    } else {
      const ai = await hybridAI(this.config);
      m = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams });
    }
    this.models.set(key, m);
    return m;
  }

  /** Size of the input on the device model, if a session is ready within the budget. */
  async measure(text, schema = this.task.schema) {
    try {
      const base = await withTimeout(store.baseSession(this.createOptions), LIMITS.measureWaitMs);
      if (!base) return null;
      const fn = base.measureContextUsage ? 'measureContextUsage' : base.measureInputUsage ? 'measureInputUsage' : null;
      if (!fn) return null;
      const tokens = await withTimeout(base[fn](text, { responseConstraint: schema }), LIMITS.measureWaitMs);
      if (!Number.isFinite(tokens)) return null;
      return { tokens, window: base.contextWindow ?? base.inputQuota ?? null, system: base.contextUsage ?? base.inputUsage ?? 0 };
    } catch { return null; }
  }

  async decide(prep) {
    const avail = await this.currentAvailability();
    if (avail !== 'available') return { route: 'cloud', reason: 'no-model', availability: avail };
    const chars = prep.userText.length;
    const estimate = Math.ceil(chars / 3.2);
    const limit = this.state.tokenLimit ?? 9216;
    if (chars / 4.5 > limit) return { route: 'cloud', reason: 'too-long', tokens: estimate, window: limit, estimated: true };
    const m = await this.measure(prep.userText, prep.schema ?? this.task.schema);
    const tokens = m?.tokens ?? estimate;
    const window = m?.window ?? limit;
    const hard = window - (m?.system ?? 0) - LIMITS.outputReserve;
    const base = { tokens, window, estimated: !m };
    if (tokens > hard) return { ...base, route: 'cloud', reason: 'too-long' };
    if (!this.state.deviceOnly && tokens > window * LIMITS.softRatio) return { ...base, route: 'cloud', reason: 'too-long', soft: true };
    return { ...base, route: 'device', reason: 'device' };
  }

  /** Wait so two cloud requests of a task that asks for spacing (free tier) are at least task.cloudGapMs apart. */
  async cloudSpacing(gap = this.task.cloudGapMs ?? 0) {
    const wait = gap && this.lastCloudAt ? this.lastCloudAt + gap - performance.now() : 0;
    if (wait > 0) await sleep(wait);
    this.lastCloudAt = performance.now();
    return Math.max(0, Math.round(wait));
  }

  /**
   * One extra AI request before the main one (a task's "understand" step), with the same routing as every request:
   * on this device first, the cloud only when the device cannot and there is a connection, nothing otherwise.
   * Returns { value, source, reason } or { blocked: 'device-only'|'offline', reason } or { failed: error, reason }.
   */
  async askOnce(req, attempts, ms, step) {
    const decision = await this.decide({ userText: req.userText, schema: req.schema }).catch(() => ({ route: 'cloud', reason: 'no-model' }));
    let reason = decision.reason;
    if (decision.route === 'device') {
      const kind = this.state.deviceOnly ? 'device' : 'hybrid';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const s = ms();
        try {
          const model = await this.model(kind, req.schema, req.system);
          const a = await streamOnce(model, req.userText, () => {});
          const value = parseFinal(a.text).value;
          if (!value) throw named('BadAnswer', 'The on-device answer was not a form.');
          attempts.push({ where: 'device', kind, step, startMs: s, ms: ms() - s, source: a.source });
          if (a.source === 'in_cloud') this.lastCloudAt = performance.now();
          return { value, source: a.source, reason, raw: a.text.slice(0, 600) };
        } catch (e) {
          const err = errOf(e);
          const cls = classify(err);
          attempts.push({ where: 'device', kind, step, startMs: s, ms: ms() - s, error: err, class: cls });
          reason = cls === 'too-long' ? 'too-long' : 'device-error';
          if (cls !== 'unknown') break;
        }
      }
    }
    if (this.state.deviceOnly) return { blocked: 'device-only', reason };
    if (!isOnline()) return { blocked: 'offline', reason };
    const waited = await this.cloudSpacing();
    const s = ms();
    try {
      const model = await this.model('cloud', req.schema, req.system);
      const a = await streamOnce(model, req.userText, () => {}, { firstMs: LIMITS.cloudFirstMs });
      attempts.push({ where: 'cloud', step, startMs: s, ms: ms() - s, waitedMs: waited, source: a.source });
      const value = parseFinal(a.text).value;
      if (!value) return { failed: named('BadAnswer', 'The cloud answer was not a form.'), reason };
      return { value, source: a.source, reason, raw: a.text.slice(0, 600) };
    } catch (e) {
      attempts.push({ where: 'cloud', step, startMs: s, ms: ms() - s, waitedMs: waited, error: errOf(e) });
      return { failed: e, reason };
    }
  }

  /** Turn one paste into one row. Never rejects. */
  async process(input, { onPartial } = {}) {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    // A task may first ask the AI to read the input into a short form (trip guide: the kind of question and the
    // names in it). Same routing as the main request. Without any AI, the row says why, as for the main request.
    const early = [];
    let understood = null;
    if (this.task.understand) {
      let req = null;
      try { req = this.task.understand(input ?? {}); } catch (e) {
        return { id: `r_${Date.now().toString(36)}`, task: this.task.id, status: 'failed', record: null, source: null, reason: null, reasonText: e?.message ?? 'Could not read the input.', timing: { decideMs: null, firstMs: null, totalMs: ms(), cloudAtMs: null }, check: [], candidates: [], input: { text: String(input?.text ?? ''), date: null }, error: errOf(e), attempts: [] };
      }
      if (req) {
        if (onPartial) { try { onPartial({ record: {}, where: null, phase: 'understand' }); } catch { /* UI error */ } }
        const s = ms();
        const u = await this.askOnce(req, early, ms, 'understand');
        const understandMs = ms() - s;
        if (!u.value) {
          const view = this.task.guess?.(input ?? {}) ?? null;
          const base = { id: `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, task: this.task.id, record: null, source: null, check: [], candidates: [], input: { text: String(input?.text ?? '').trim(), date: null }, attempts: early, simulated: this.state.simulated, deviceOnly: this.state.deviceOnly, sessionStore: this.state.sessionStore, view, timing: { decideMs: null, firstMs: null, totalMs: ms(), cloudAtMs: null, understandMs, wordMs: null }, error: null };
          if (u.blocked === 'device-only') return { ...base, status: 'blocked', reason: u.reason, reasonText: this.withSim(BLOCKED_TEXT[u.reason] ?? BLOCKED_TEXT['device-error'], u.reason) };
          if (u.blocked === 'offline') return { ...base, status: 'blocked', blockedBy: 'offline', reason: u.reason, reasonText: this.withSim(OFFLINE_TEXT[u.reason] ?? OFFLINE_TEXT['device-error'], u.reason) };
          return this.cloudFailed({ ...base, status: 'failed' }, u.failed, u.reason, ms, null);
        }
        understood = { value: this.task.readUnderstood ? this.task.readUnderstood(u.value, input) : u.value, source: u.source, reason: u.reason, ms: understandMs, raw: u.raw };
        input = { ...input, understood: { ...understood.value, by: u.source === 'in_cloud' ? 'cloud' : 'device' }, understoodSource: u.source };
      }
    }
    const wordStart = ms();
    let prep;
    try { prep = this.task.prepare(input ?? {}); } catch (e) {
      return { id: `r_${Date.now().toString(36)}`, task: this.task.id, status: 'failed', record: null, source: null, reason: null, reasonText: e?.message ?? 'Could not read the input.', timing: { decideMs: null, firstMs: null, totalMs: ms(), cloudAtMs: null }, check: [], candidates: [], input: { text: String(input?.text ?? ''), date: null }, error: errOf(e), attempts: [] };
    }
    const out = {
      id: `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, task: this.task.id,
      status: 'failed', record: null, source: null, reason: null, reasonText: '',
      timing: { decideMs: null, firstMs: null, totalMs: null, cloudAtMs: null },
      tokens: null, tokenWindow: null, estimated: null, check: [], candidates: [],
      input: { text: prep.text, date: prep.date }, error: null, attempts: [],
      simulated: this.state.simulated, deviceOnly: this.state.deviceOnly, sessionStore: this.state.sessionStore,
      view: prep.view ?? null,
    };
    if (prep.planMs != null) out.timing.planMs = prep.planMs;
    if (early.length) out.attempts.push(...early);
    if (understood) { out.understood = understood; out.timing.understandMs = understood.ms; }
    const wordDone = () => { if (understood) out.timing.wordMs = ms() - wordStart; };
    // The task's own code already has the answer (trip guide: the pack does not hold it, or code found it all):
    // answered on this computer at once, no AI call and nothing sent.
    if (prep.direct) {
      // after the AI read the question, the answer still counts as made with that AI (its badge)
      const by = prep.direct.source ?? null;
      Object.assign(out, { status: 'done', record: prep.direct.record, source: by ?? 'app', reason: by ? understood.reason : 'app', reasonText: this.withSim(prep.direct.reasonText, understood?.reason), check: [] });
      wordDone();
      out.timing.decideMs = 0;
      out.timing.totalMs = ms();
      out.timing.firstMs = out.timing.totalMs;
      return out;
    }
    let firstAt = null;
    const onText = (where, shape = (r) => r) => (text) => {
      if (firstAt === null && text) firstAt = ms();
      if (!onPartial) return;
      const rec = parsePartial(text);
      if (rec) { try { onPartial({ record: this.task.partial ? this.task.partial(shape(rec), prep) : shape(rec), where }); } catch { /* UI error */ } }
    };
    const M = this.task.mix ?? {};
    let mixInfo = null;
    let unmap = null; // mix=mask: placeholders -> real values
    if (onPartial) { try { onPartial({ record: this.task.partial ? this.task.partial({}, prep) : {}, where: null }); } catch { /* UI error */ } }

    const decision = await this.decide(prep).catch(() => ({ route: 'cloud', reason: 'no-model' }));
    out.timing.decideMs = ms();
    Object.assign(out, { tokens: decision.tokens ?? null, tokenWindow: decision.window ?? null, estimated: decision.estimated ?? null, softLimit: !!decision.soft });
    let reason = decision.reason;
    let answer = null;

    // mix=mask (method 2): the device lists names, addresses and phone numbers, code masks them, and only
    // the masked text goes to the cloud. If the device step fails, nothing is sent this way and the row
    // takes the normal path below. With the lock on, nothing may go to the cloud, so the normal path too.
    if (this.mixHas('mask') && decision.route === 'device' && !this.state.deviceOnly) {
      mixInfo = { kind: 'mask', maskedBy: [], found: null, counts: null, maskedText: null, map: null, deviceMs: null, cloudMs: null, error: null };
      const s = ms();
      try {
        const model = await this.model('device', M.mask.schema, M.mask.system);
        const a = await streamOnce(model, M.mask.text(prep.sourceText), () => {});
        const found = parseFinal(a.text).value;
        if (!found) throw named('BadAnswer', 'The on-device answer was not a list.');
        Object.assign(mixInfo, { found, deviceMs: ms() - s });
        mixInfo.maskedBy.push('device');
        out.attempts.push({ where: 'device', kind: 'mask', startMs: s, ms: ms() - s, source: a.source });
      } catch (e) {
        mixInfo.error = errOf(e);
        out.attempts.push({ where: 'device', kind: 'mask', startMs: s, ms: ms() - s, error: mixInfo.error });
      }
      if (mixInfo.maskedBy.includes('device')) {
        const m = M.mask.mask(prep.sourceText, mixInfo.found);
        mixInfo.maskedBy.push('code');
        Object.assign(mixInfo, { maskedText: m.masked, map: m.map, counts: m.counts });
        unmap = m.map;
        const maskedUserText = prep.userText.replace(prep.sourceText, () => m.masked);
        out.timing.cloudAtMs = ms();
        if (onPartial) { try { onPartial({ record: this.task.partial ? this.task.partial({}, prep) : {}, where: 'cloud' }); } catch { /* UI */ } }
        const c = ms();
        try {
          const model = await this.model('cloud', prep.schema ?? this.task.schema, M.mask.cloudSystem);
          answer = await streamOnce(model, maskedUserText, onText('cloud', (r) => M.mask.unmask(r, unmap)));
          mixInfo.cloudMs = ms() - c;
          out.attempts.push({ where: 'cloud', kind: 'mask', startMs: c, ms: ms() - c, source: answer.source });
          reason = 'mask';
        } catch (e) {
          out.attempts.push({ where: 'cloud', kind: 'mask', startMs: c, ms: ms() - c, error: errOf(e) });
          out.mix = mixInfo;
          return this.cloudFailed(out, e, reason, ms, firstAt);
        }
      }
    }

    if (!answer && decision.route === 'device') {
      const kind = this.state.deviceOnly ? 'device' : 'hybrid';
      if (onPartial) { try { onPartial({ record: this.task.partial ? this.task.partial({}, prep) : {}, where: 'device' }); } catch { /* UI */ } }
      for (let attempt = 0; attempt < 2 && !answer; attempt += 1) {
        const s = ms();
        try {
          const model = await this.model(kind, prep.schema ?? this.task.schema);
          const a = await streamOnce(model, prep.userText, onText(kind === 'hybrid' ? 'device' : 'device'));
          if (!parseFinal(a.text).value) throw named('BadAnswer', 'The on-device answer was not a record.');
          answer = a;
          out.attempts.push({ where: 'device', kind, startMs: s, ms: ms() - s, source: a.source });
        } catch (e) {
          const err = errOf(e);
          const cls = classify(err);
          out.attempts.push({ where: 'device', kind, startMs: s, ms: ms() - s, error: err, class: cls });
          reason = cls === 'too-long' ? 'too-long' : 'device-error';
          if (cls !== 'unknown') break; // only Chrome's unknown error is worth one more try
        }
      }
    }

    if (!answer) {
      if (this.state.deviceOnly) {
        Object.assign(out, { status: 'blocked', reason, reasonText: this.withSim(BLOCKED_TEXT[reason] ?? BLOCKED_TEXT['device-error'], reason) });
        out.timing.totalMs = ms();
        return out;
      }
      if (!isOnline()) {
        Object.assign(out, { status: 'blocked', blockedBy: 'offline', reason, reasonText: this.withSim(OFFLINE_TEXT[reason] ?? OFFLINE_TEXT['device-error'], reason) });
        out.timing.totalMs = ms();
        return out;
      }
      out.timing.cloudAtMs = ms();
      if (onPartial) { try { onPartial({ record: this.task.partial ? this.task.partial({}, prep) : {}, where: 'cloud' }); } catch { /* UI */ } }
      const waited = this.task.cloudGapMs ? await this.cloudSpacing() : 0;
      if (waited) out.timing.cloudWaitMs = waited;
      const s = ms();
      try {
        const model = await this.model('cloud', prep.schema ?? this.task.schema);
        answer = await streamOnce(model, prep.userText, onText('cloud'), { firstMs: LIMITS.cloudFirstMs });
        out.attempts.push({ where: 'cloud', startMs: s, ms: ms() - s, source: answer.source });
      } catch (e) {
        out.attempts.push({ where: 'cloud', startMs: s, ms: ms() - s, error: errOf(e) });
        if (mixInfo) out.mix = mixInfo;
        return this.cloudFailed(out, e, reason, ms, firstAt);
      }
    }

    const parsed = parseFinal(answer.text);
    out.raw = answer.text.slice(0, 2000);
    out.source = answer.source;
    out.timing.firstMs = firstAt;
    out.timing.totalMs = ms();
    if (!parsed.value) {
      if (mixInfo) out.mix = mixInfo;
      Object.assign(out, { status: 'failed', reason, reasonText: 'The answer could not be read as a row.', error: { name: 'BadAnswer', message: 'The answer could not be read as a row.' } });
      return out;
    }
    let value = parsed.value;
    if (unmap) value = M.mask.unmask(value, unmap);

    // mix=review (method 1): the device reads the message and its own row again and fixes wrong or empty
    // fields. Always on the device (ONLY_ON_DEVICE), lock or not: nothing leaves this computer.
    if (this.mixHas('review') && answer.source === 'on_device') {
      mixInfo = { kind: 'review', first: value, fixes: null, changed: [], ms: null, error: null };
      const s0 = ms();
      for (let attempt = 0; attempt < 2 && !mixInfo.fixes; attempt += 1) {
        const s = ms();
        try {
          const model = await this.model('device', M.review.schema(prep), M.review.system);
          const a = await streamOnce(model, M.review.text(prep, value), () => {});
          const fixes = parseFinal(a.text).value;
          if (!fixes) throw named('BadAnswer', 'The on-device check was not a record.');
          const merged = M.review.merge(value, fixes, prep);
          Object.assign(mixInfo, { fixes, changed: merged.changed, raw: a.text.slice(0, 1000), error: null });
          value = merged.value;
          out.attempts.push({ where: 'device', kind: 'review', startMs: s, ms: ms() - s, source: a.source });
        } catch (e) {
          mixInfo.error = errOf(e);
          out.attempts.push({ where: 'device', kind: 'review', startMs: s, ms: ms() - s, error: mixInfo.error });
          if (classify(mixInfo.error) !== 'unknown') break; // same rule as the first pass: retry only Chrome's unknown error
        }
      }
      mixInfo.ms = ms() - s0;
    }

    const fin = this.task.finish(value, prep);

    // mix=numbers (method 3): code reads the amounts and quantity changes in the message and fixes or
    // flags a unit price written as the total and a quantity from before a change. No model call.
    // With mix=mask,numbers it runs on the cloud row after the real values are back.
    if (this.mixHas('numbers')) {
      const n = M.numbers(fin.record, prep);
      const info = { kind: 'numbers', before: { items: fin.record.items, total: fin.record.total }, changed: n.changed, flagged: n.flagged, notes: n.notes, amounts: n.amounts, corrections: n.corrections };
      if (mixInfo) Object.assign(mixInfo, { kind: `${mixInfo.kind}+numbers`, numbers: info });
      else mixInfo = info;
      fin.record = n.record;
      fin.check = [...new Set([...fin.check, ...n.flagged])];
    }
    out.timing.totalMs = ms();
    if (mixInfo) out.mix = mixInfo;
    wordDone();
    const textKey = reason === 'device' && answer.source === 'in_cloud' ? 'sdk-cloud' : reason;
    Object.assign(out, { status: 'done', record: fin.record, check: fin.check, candidates: fin.candidates, reason, reasonText: this.withSim(DONE_TEXT[textKey] ?? DONE_TEXT.device, reason) });
    return out;
  }

  /** Run a task by id on this engine: the page's own task (process) or a plain-text task such as 'sign' (runText). */
  runTask(id, input, opts) {
    const task = TASKS[id];
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (task.output === 'text') return this.runText(task, input, opts);
    if (task !== this.task) throw new Error(`Task ${id} needs its own engine.`);
    return this.process(input, opts);
  }

  /**
   * A task that answers in plain text (the sign reader). Never rejects.
   *   text:  one line on this device first; two or more lines the cloud first (task.order). The other one when the
   *          first cannot answer, as far as there is a model, a connection and the cloud is allowed
   *   photo: the cloud first when there is a connection and the cloud is allowed; this device otherwise
   *          (or when the cloud fails), unless the task turned photos on this device off (devicePhotos: false)
   *   "Never use the cloud" on: only this device, nothing is sent. No model and no connection: a notice, no error.
   */
  async runText(task, input, { onPartial } = {}) {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    const out = {
      id: `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, task: task.id,
      status: 'failed', kind: null, record: null, source: null, where: null, reason: null, reasonText: '',
      timing: { decideMs: null, firstMs: null, totalMs: null, cloudAtMs: null }, input: null, attempts: [], raw: null, error: null,
      simulated: this.state.simulated, deviceOnly: this.state.deviceOnly, online: isOnline(),
    };
    const tell = (p) => { if (onPartial) { try { onPartial(p); } catch { /* UI error */ } } };
    let prep;
    try { prep = await task.prepare(input ?? {}); } catch (e) {
      return Object.assign(out, { status: 'invalid', reasonText: e?.message ?? 'Could not read the input.', error: errOf(e), code: e?.code ?? null, timing: { ...out.timing, totalMs: ms() } });
    }
    out.kind = prep.kind;
    out.input = prep.input;
    const photo = prep.kind === 'photo';
    const avail = await this.currentAvailability();
    const online = isOnline();
    const locked = this.state.deviceOnly;
    const fits = Math.ceil(String(prep.measureText ?? '').length / 3.2) < (this.state.tokenLimit ?? 9216) * LIMITS.softRatio;
    const photoOff = photo && task.devicePhotos === false;
    const deviceOk = avail === 'available' && fits && !photoOff;
    const cloudOk = !locked && online;
    let reason = avail !== 'available' ? 'no-model' : !fits ? 'too-long' : 'device';
    Object.assign(out, { availability: avail, online, devicePhotos: task.devicePhotos !== false });
    out.timing.decideMs = ms();

    // the task says which AI tries first (sign reader: photos and text of two or more lines go to the cloud first)
    const order = task.order ? task.order({ cloudFirst: !!prep.cloudFirst, online, locked }) : photo && cloudOk ? ['cloud', 'device'] : ['device', 'cloud'];
    let answer = null;
    let where = null;
    let cloudError = null;
    let firstAt = null;
    const onText = (w) => (text) => { if (firstAt === null && text) firstAt = ms(); tell({ where: w, text, card: task.partial(text, prep) }); };
    for (const w of order) {
      if (answer) break;
      if (w === 'device') {
        if (!deviceOk) continue;
        // after the cloud was tried first (or could not be), this device only: the cloud is not asked twice
        const kind = locked || !online || photo || prep.cloudFirst ? 'device' : 'hybrid';
        tell({ where: 'device', text: '', card: null });
        for (let attempt = 0; attempt < 2 && !answer; attempt += 1) {
          const s = ms();
          try {
            const model = await this.textModel(kind, task.system, prep.image);
            const a = await streamText(model, prep.deviceParts ?? prep.parts, onText('device'));
            if (!a.text.trim()) throw named('EmptyAnswer', 'The on-device AI gave an empty answer.');
            answer = a;
            where = a.source === 'in_cloud' ? 'cloud' : 'device';
            out.attempts.push({ where: 'device', kind, startMs: s, ms: ms() - s, source: a.source, cut: a.cut });
          } catch (e) {
            const err = errOf(e);
            const cls = classify(err);
            out.attempts.push({ where: 'device', kind, startMs: s, ms: ms() - s, error: err, class: cls });
            reason = cls === 'too-long' ? 'too-long' : 'device-error';
            if (cls !== 'unknown') break; // only Chrome's unknown error is worth one more try
          }
        }
      } else {
        if (!cloudOk) continue;
        out.timing.cloudAtMs = ms();
        tell({ where: 'cloud', text: '', card: null });
        const waited = await this.cloudSpacing(task.cloudGapMs ?? 0);
        if (waited) out.timing.cloudWaitMs = waited;
        const s = ms();
        try {
          const model = await this.textModel('cloud', task.system, prep.image);
          const a = await streamText(model, prep.parts, onText('cloud'), { firstMs: LIMITS.cloudFirstMs });
          if (!a.text.trim()) throw named('EmptyAnswer', 'The cloud AI gave an empty answer.');
          answer = a;
          where = 'cloud';
          out.attempts.push({ where: 'cloud', startMs: s, ms: ms() - s, waitedMs: waited, source: a.source, cut: a.cut });
        } catch (e) {
          cloudError = e;
          out.attempts.push({ where: 'cloud', startMs: s, ms: ms() - s, waitedMs: waited, error: errOf(e) });
        }
      }
    }

    out.timing.firstMs = firstAt;
    if (!answer) {
      out.timing.totalMs = ms();
      if (cloudError) return this.cloudFailed(out, cloudError, reason, ms, firstAt);
      const why = photoOff && avail === 'available' ? 'photo-off' : reason === 'device' ? 'device-error' : reason;
      if (locked) return Object.assign(out, { status: 'blocked', blockedBy: 'locked', reason: why, reasonText: why === 'photo-off' ? PHOTO_LOCKED_TEXT : this.withSim(TEXT_BLOCKED.locked[why] ?? TEXT_BLOCKED.locked['device-error'], why) });
      if (!online) return Object.assign(out, { status: 'blocked', blockedBy: 'offline', reason: why, reasonText: why === 'photo-off' ? PHOTO_OFFLINE_TEXT : this.withSim(TEXT_BLOCKED.offline[why] ?? TEXT_BLOCKED.offline['device-error'], why) });
      return Object.assign(out, { status: 'failed', reason: why, reasonText: 'Could not explain this. Please try again.' });
    }
    out.raw = answer.text.slice(0, 4000);
    out.source = answer.source ?? (where === 'cloud' ? 'in_cloud' : 'on_device');
    out.where = out.source === 'in_cloud' ? 'cloud' : 'device';
    if (photo) reason = out.where === 'cloud' ? 'photo-cloud' : cloudError ? 'cloud-failed' : locked ? 'photo-locked' : 'photo-offline';
    else if (prep.cloudFirst) reason = out.where === 'cloud' ? (reason === 'device' ? 'lines-cloud' : reason) : cloudError ? 'lines-cloud-failed' : locked ? 'lines-locked' : 'lines-offline';
    else if (out.where === 'cloud' && reason === 'device') reason = 'sdk-cloud';
    out.record = task.finish(answer.text, prep, out.where);
    out.timing.totalMs = ms();
    return Object.assign(out, { status: 'done', reason, reasonText: this.withSim(TEXT_DONE[reason] ?? TEXT_DONE.device, reason) });
  }

  /** A cloud request failed: the row says why and keeps its Retry button. */
  cloudFailed(out, e, reason, ms, firstAt) {
    out.error = errOf(e);
    // Free tier allows a few requests per minute. On 429 we do not retry by ourselves (that would
    // only use up more of the limit); the row says so and keeps its Retry button.
    const busy = out.error.status === 429 || /429|RESOURCE_EXHAUSTED/i.test(out.error.message);
    // The cloud turned down this page's App Check token (seen 11-26 on the live site: the token exchange got 403 once,
    // App Check then waits a day before trying again in that page, and every request got 401 "Firebase App Check token
    // is invalid"). The connection is fine, so the notice does not blame it; reloading the page starts App Check again.
    const refused = !busy && (out.error.status === 401 || /app ?check/i.test(`${out.error.code ?? ''} ${out.error.message}`));
    if (refused) {
      Object.assign(out, { status: 'failed', reason, reload: true, reasonText: 'The cloud AI did not accept this page’s security check, so nothing was answered. Reload the page and try again.' });
      out.timing.firstMs = firstAt;
      out.timing.totalMs = ms();
      return out;
    }
    const unreachable = !busy && (out.error.name === 'CloudTimeout' || !isOnline() || /Failed to fetch|NetworkError|ERR_INTERNET|ERR_NAME|fetch-error|network/i.test(`${out.error.name} ${out.error.message}`));
    Object.assign(out, { status: 'failed', reason, reasonText: busy ? 'The cloud is busy right now. Nothing was retried automatically.' : unreachable ? 'Could not reach the cloud. Check the internet connection and try again.' : 'The cloud request failed.' });
    if (unreachable) out.unreachable = true;
    if (busy) out.error = { ...out.error, name: 'CloudBusy', message: 'The cloud is busy right now (too many requests). Please try this row again in a minute.', detail: out.error.message };
    out.timing.firstMs = firstAt;
    out.timing.totalMs = ms();
    return out;
  }

  withSim(text, reason) {
    return this.state.simulated && ((reason === 'no-model' && this.state.simulated === 'no-model') || (reason === 'device-error' && this.state.simulated === 'device-error')) ? `${text} (simulated)` : text;
  }
}

export async function startEngine(taskId) {
  const task = TASKS[taskId];
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const config = await loadConfig();
  const engine = new Engine(task, config, readSettings());
  engine.start();
  return engine;
}
