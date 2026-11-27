// Tests for "Get on-device AI" (src/ui/device-get.js): when the button shows and what the pill and ready list say.
// No AI, no browser.
//   node test/device-get.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getView, percent, GET_TEXT } from '../src/ui/device-get.js';

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('ok', name); };
const idle = { status: 'idle', loaded: null };

t('button shows only when Chrome says downloadable or downloading and the SDK can start it', () => {
  assert.equal(getView({ device: 'downloadable', canGet: true, getAI: idle }).show, true);
  assert.equal(getView({ device: 'downloading', canGet: true, getAI: idle }).show, true);
  for (const device of ['checking', 'warming', 'ready', 'unavailable', 'no-api', 'error']) assert.equal(getView({ device, canGet: true, getAI: idle }).show, false, device);
  assert.equal(getView({ device: 'downloadable', canGet: false, getAI: idle }).show, false); // Android stand-in: no initializeDeviceModel
  assert.equal(getView({ device: 'downloadable', canGet: true, simulated: 'no-model', getAI: idle }).show, false);
  assert.equal(getView({}).show, false);
});

t('nothing changes on a computer that has the model', () => {
  const v = getView({ device: 'ready', canGet: false, getAI: idle });
  assert.deepEqual({ show: v.show, busy: v.busy, pill: v.pill, ready: v.ready }, { show: false, busy: false, pill: null, ready: null });
});

t('while downloading: button hidden, pill and ready list show the percent', () => {
  const v = getView({ device: 'downloading', canGet: true, getAI: { status: 'downloading', loaded: 0.427 } });
  assert.equal(v.show, false);
  assert.equal(v.busy, true);
  assert.equal(v.pill, 'On-device AI: downloading 42%');
  assert.match(v.ready, /^downloading \(42%\)\. The cloud answers until it is ready\.$/);
  assert.equal(getView({ device: 'downloadable', canGet: true, getAI: { status: 'downloading', loaded: null } }).pill, 'On-device AI: downloading…');
  assert.equal(getView({ device: 'downloading', canGet: true, getAI: { status: 'downloading', loaded: 1 } }).pill, 'On-device AI: getting ready');
});

t('a download Chrome already runs (page opened again) says so in the pill, button still there', () => {
  const v = getView({ device: 'downloading', canGet: true, getAI: idle });
  assert.equal(v.show, true);
  assert.equal(v.pill, 'On-device AI: downloading…');
});

t('after a failed try the button comes back', () => {
  assert.equal(getView({ device: 'downloadable', canGet: true, getAI: { status: 'failed', loaded: null } }).show, true);
});

t('ready list: online and offline wording', () => {
  const s = { device: 'downloadable', canGet: true, getAI: idle };
  assert.match(getView(s, true).ready, /Press “Get on-device AI”.*several GB.*Until then the cloud answers\.$/);
  assert.equal(getView(s, false).ready, 'not downloaded yet. Connect to the internet to download it.');
});

t('percent is 0..100 and null without progress', () => {
  assert.equal(percent(null), null);
  assert.equal(percent(undefined), null);
  assert.equal(percent('x'), null);
  assert.equal(percent(0), 0);
  assert.equal(percent(0.999), 99);
  assert.equal(percent(1), 100);
  assert.equal(percent(1.5), 100);
});

t('the page has the button, hidden at first, with the same words', () => {
  const html = readFileSync(new URL('../trip.html', import.meta.url), 'utf8');
  const box = html.match(/<span id="ai-get-box"[^>]*>[\s\S]*?<\/span><\/span>/)?.[0] ?? '';
  assert.match(box, /\shidden[\s>]/);
  assert.ok(box.includes(`>${GET_TEXT.button}</button>`));
  assert.ok(box.includes(`>${GET_TEXT.note}</span>`));
});

t('the service worker keeps the new file for offline', () => {
  const sw = readFileSync(new URL('../sw-trip.js', import.meta.url), 'utf8');
  assert.match(sw, /'src\/ui\/device-get\.js'/);
});

console.log(`${n} tests passed`);
