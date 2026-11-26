// Unit tests for web/sdk.js (the Android bridge stand-in), run on a PC with a fake window.TripBridge. No AI is called.
//   node --test app-android/web/sdk.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
const cancelled = [];
let script = null; // (id, req) => events to send back
globalThis.TripBridge = {
  statusNow: () => JSON.stringify({ status: 'UNAVAILABLE', option: 'preview', model: null }),
  sdkVersion: () => 'fake',
  cancel: (id) => cancelled.push(id),
  generate(id, json) {
    const req = JSON.parse(json);
    sent.push({ id, req });
    const evs = script ? script(id, req) : [];
    evs.forEach((ev, i) => setTimeout(() => globalThis.__tripBridge.emit({ id, ...ev }), 5 * (i + 1)));
  },
};
const sdk = await import(new URL('./sdk.js', import.meta.url));

async function collect(res) { let all = ''; for await (const c of res.stream) all += c.text(); return all; }

test('device-first request: spec, parts and streamed text, source from the bridge', async () => {
  script = () => [{ type: 'chunk', text: '{"found":' }, { type: 'chunk', text: 'true}' }, { type: 'done', source: 'ON_DEVICE' }];
  const m = sdk.getGenerativeModel({}, {
    mode: sdk.InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: { createOptions: { initialPrompts: [{ role: 'system', content: 'SYS' }] }, promptOptions: { responseConstraint: { type: 'object' } } },
    inCloudParams: { model: 'gemini-3.5-flash-lite', systemInstruction: 'SYS', generationConfig: { responseJsonSchema: { type: 'object' } } },
  });
  const res = await m.generateContentStream('hello');
  assert.equal(await collect(res), '{"found":true}');
  assert.equal((await res.response).inferenceSource, 'on_device');
  const req = sent.at(-1).req;
  assert.equal(req.mode, 'prefer_on_device');
  assert.equal(req.system, 'SYS');
  assert.deepEqual(req.schema, { type: 'object' });
  assert.deepEqual(req.parts, [{ text: 'hello' }]);
});

test('on-device-only model takes its system prompt and schema from onDeviceParams', async () => {
  script = () => [{ type: 'chunk', text: 'OK' }, { type: 'done', source: 'ON_DEVICE' }];
  const m = sdk.getGenerativeModel({}, { mode: sdk.InferenceMode.ONLY_ON_DEVICE, onDeviceParams: { createOptions: { initialPrompts: [{ role: 'system', content: 'S2' }] }, promptOptions: { responseConstraint: { type: 'object', properties: {} } } } });
  await collect(await m.generateContentStream('x'));
  const req = sent.at(-1).req;
  assert.equal(req.mode, 'only_on_device');
  assert.equal(req.system, 'S2');
  assert.deepEqual(req.schema, { type: 'object', properties: {} });
  assert.equal(req.model, null);
});

test('photo parts keep inline data', async () => {
  script = () => [{ type: 'done', source: 'IN_CLOUD' }];
  const m = sdk.getGenerativeModel({}, { mode: sdk.InferenceMode.ONLY_IN_CLOUD, inCloudParams: { systemInstruction: 'S' } });
  const res = await m.generateContentStream([{ text: 'read' }, { inlineData: { data: 'AAAA', mimeType: 'image/png' } }]);
  assert.equal(await collect(res), '');
  assert.deepEqual(sent.at(-1).req.parts, [{ text: 'read' }, { inlineData: { data: 'AAAA', mimeType: 'image/png' } }]);
  assert.equal((await res.response).inferenceSource, 'in_cloud');
});

test('an error before any text rejects the request with the engine-readable name and status', async () => {
  script = () => [{ type: 'error', name: 'ResourceExhausted', message: 'quota', status: 429 }];
  const m = sdk.getGenerativeModel({}, { mode: sdk.InferenceMode.ONLY_IN_CLOUD, inCloudParams: {} });
  await assert.rejects(m.generateContentStream('q'), (e) => e.name === 'ResourceExhausted' && e.customErrorData.status === 429);
});

test('an error after some text is thrown by the stream', async () => {
  script = () => [{ type: 'chunk', text: 'par' }, { type: 'error', name: 'UnknownError', message: 'kErrorUnknown' }];
  const m = sdk.getGenerativeModel({}, { mode: sdk.InferenceMode.ONLY_ON_DEVICE, onDeviceParams: {} });
  const res = await m.generateContentStream('q');
  await assert.rejects(collect(res), (e) => e.name === 'UnknownError');
});

test('stopping the stream cancels the request in the app', async () => {
  script = () => [{ type: 'chunk', text: 'a' }, { type: 'chunk', text: 'b' }, { type: 'chunk', text: 'c' }, { type: 'done', source: 'ON_DEVICE' }];
  const m = sdk.getGenerativeModel({}, { mode: sdk.InferenceMode.ONLY_ON_DEVICE, onDeviceParams: {} });
  const res = await m.generateContentStream('q');
  const it = res.stream[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.text(), 'a');
  await it.return();
  assert.ok(cancelled.includes(sent.at(-1).id));
});

test('LanguageModel stand-in: availability follows the bridge status; window fits 4000 tokens', async () => {
  assert.equal(await globalThis.LanguageModel.availability(), 'unavailable');
  globalThis.__tripBridge.status({ status: 'DOWNLOADING', option: 'preview' });
  assert.equal(await globalThis.LanguageModel.availability(), 'downloading');
  globalThis.__tripBridge.status({ status: 'AVAILABLE', option: 'preview', model: 'nano' });
  assert.equal(await globalThis.LanguageModel.availability(), 'available');
  const s = await globalThis.LanguageModel.create({});
  assert.ok(s.contextWindow > 2000 && s.contextWindow < 4000);
  assert.equal(await s.clone(), s);
});

test('no web App Check script and no CDN in the stand-in', async () => {
  assert.equal(sdk.APP_CHECK_URL, '');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./sdk.js', import.meta.url), 'utf8');
  assert.ok(!/https?:\/\//.test(src.replace(/\/\/.*$/gm, '')), 'no URL outside comments');
});

test('a regular-expression answer shape (Chrome only) is not sent to the app as a JSON form', async () => {
  // The web engine gives the sign reader's on-device request a RegExp as responseConstraint. The Android SDK has
  // nothing like it; sent as it is, JSON.stringify would make it {} and the app would then ask the model for JSON.
  script = () => [{ type: 'chunk', text: '1. No entry\nTo do: Stay out.' }, { type: 'done', source: 'ON_DEVICE' }];
  const m = sdk.getGenerativeModel({}, {
    mode: sdk.InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: { createOptions: { initialPrompts: [{ role: 'system', content: 'S' }] }, promptOptions: { responseConstraint: /^1\. .+\nTo do: .+$/ } },
    inCloudParams: { model: 'gemini-3.5-flash-lite', systemInstruction: 'S' },
  });
  await collect(await m.generateContentStream('x'));
  assert.equal(sent.at(-1).req.schema, null);
});
