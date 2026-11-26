// PC check that the web engine's own safety rules still work through the Android bridge stand-in (web/sdk.js):
// a runaway on-device answer is cut (maxAnswerChars) and the request is cancelled in the app, Chrome-style unknown
// errors are retried once, then the cloud answers when online, and nothing is sent when offline.
// Runs the engine copied into the APK by the build (app/build/generated/webassets/web), with a fake TripBridge. No AI.
//   (build first)  node --test app-android/web/engine-bridge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WEB = new URL('../app/build/generated/webassets/web/', import.meta.url);
let online = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { get onLine() { return online; } } });
globalThis.location = { search: '', href: 'https://appassets.androidplatform.net/trip.html' };
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

const sent = [];
const cancelled = new Set();
let device = () => [];
const UNDERSTAND = JSON.stringify({ kind: 'route', place: 'Anguk Station Exit 2', from: '', food: '', time: 'any', also: '' });
globalThis.TripBridge = {
  statusNow: () => JSON.stringify({ status: 'AVAILABLE', option: 'preview', model: 'fake-nano' }),
  sdkVersion: () => 'fake',
  cancel: (id) => cancelled.add(id),
  generate(id, json) {
    const req = JSON.parse(json);
    sent.push({ id, req });
    const emit = (ev) => globalThis.__tripBridge.emit({ id, ...ev });
    if (req.parts[0]?.text === 'Reply with OK.') { setTimeout(() => { emit({ type: 'chunk', text: 'OK' }); emit({ type: 'done', source: 'ON_DEVICE' }); }, 1); return; }
    if (req.mode === 'only_in_cloud') { setTimeout(() => { emit({ type: 'chunk', text: UNDERSTAND }); emit({ type: 'done', source: 'IN_CLOUD' }); }, 5); return; }
    device(id, req, emit);
  },
};

const { startEngine } = await import(new URL('src/engine/index.js', WEB));
const pack = JSON.parse(readFileSync(new URL('packs/seoul-gogung/pack.json', WEB), 'utf8'));
const ask = (engine) => engine.process({ text: 'How do I walk back to Anguk Station Exit 2?', here: 'L17', pack, at: '2026-11-29T16:40', kind: null });
async function fresh() { const e = await startEngine('trip'); await e.warmUp(); return e; }

test('runaway on-device answer: cut, cancelled in the app, then the cloud answers', async () => {
  online = true;
  device = (id, req, emit) => { const t = setInterval(() => { if (cancelled.has(id)) return clearInterval(t); emit({ type: 'chunk', text: 'x'.repeat(200) }); }, 2); };
  const e = await fresh();
  const from = sent.length;
  const r = await ask(e);
  const mine = sent.slice(from);
  const dev = mine.find((s) => s.req.mode === 'prefer_on_device');
  assert.ok(dev, 'device-first request sent');
  assert.ok(cancelled.has(dev.id), 'runaway request cancelled in the app');
  assert.equal(r.attempts[0].error?.name, 'RunawayError');
  assert.equal(r.attempts.at(-1).where, 'cloud');
  assert.equal(r.status, 'done');
  assert.equal(r.source, 'in_cloud');
  assert.equal(r.view?.route?.to, 'S03');
});

test('unknown on-device error is tried once more, then the cloud', async () => {
  online = true;
  device = (id, req, emit) => setTimeout(() => emit({ type: 'error', name: 'UnknownError', message: 'on-device unknown' }), 2);
  const e = await fresh();
  const r = await ask(e);
  const devTries = r.attempts.filter((a) => a.where === 'device');
  assert.equal(devTries.length, 2);
  assert.equal(r.attempts.at(-1).where, 'cloud');
  assert.equal(r.status, 'done');
});

test('offline: the on-device failure is not sent to the cloud', async () => {
  online = false;
  device = (id, req, emit) => { const t = setInterval(() => { if (cancelled.has(id)) return clearInterval(t); emit({ type: 'chunk', text: 'y'.repeat(200) }); }, 2); };
  const e = await fresh();
  const from = sent.length;
  const r = await ask(e);
  const mine = sent.slice(from);
  assert.equal(mine.filter((s) => s.req.mode === 'only_in_cloud').length, 0, 'no cloud request');
  assert.equal(r.status, 'blocked');
  assert.equal(r.blockedBy, 'offline');
  online = true;
});

test('sign reader, one typed line on the device: sent as plain text, no JSON form', async () => {
  // The engine passes a regular expression for the on-device answer shape (Chrome's responseConstraint). On Android
  // that must not reach the app as a JSON form, or the model would be told to answer in JSON.
  online = true;
  device = (id, req, emit) => setTimeout(() => { emit({ type: 'chunk', text: '1. No entry\nTo do: Do not go in.' }); emit({ type: 'done', source: 'ON_DEVICE' }); }, 2);
  const e = await fresh();
  const from = sent.length;
  const r = await e.runTask('sign', { text: '출입금지' }, {});
  const mine = sent.slice(from).filter((s) => s.req.parts[0]?.text !== 'Reply with OK.');
  assert.equal(mine.length, 1, 'one request');
  assert.equal(mine[0].req.mode, 'prefer_on_device');
  assert.equal(mine[0].req.schema, null, 'no JSON form on a plain-text request');
  assert.equal(r.status, 'done');
  assert.equal(r.where, 'device');
  assert.equal(r.record.rows.length, 1);
  assert.equal(r.record.found, true);
});
