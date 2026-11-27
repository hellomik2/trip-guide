// "Get on-device AI": the button next to the on-device AI pill, shown only when Chrome says its model can be downloaded.
// This file only decides what the pill, the button and the ready list say, from the engine state (src/engine/index.js:
// device, canGet, getAI). No DOM and no AI call here, so it is tested in Node (test/device-get.test.mjs).
// The download itself is started by the engine through the Firebase AI Logic SDK (engine.getDeviceModel()).

export const GET_TEXT = {
  button: 'Get on-device AI',
  note: 'Chrome downloads the model, several GB',
  offline: 'You are offline. Connect to the internet to download the on-device AI.',
  done: 'On-device AI is ready. Answers now work offline too.',
  failed: 'The on-device AI could not be downloaded. The cloud keeps answering while you are online.',
};

const CAN_DOWNLOAD = ['downloadable', 'downloading'];

/** Percent of the download (0 to 100), or null before Chrome reports any progress. */
export function percent(loaded) {
  const n = Number(loaded);
  if (loaded == null || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.floor(n * 100)));
}

/**
 * What the screen shows for the on-device model download.
 *   show:  the button is visible (Chrome says downloadable or downloading, this SDK can start it, not simulated, not running)
 *   busy:  a download started from this page is running
 *   pill:  text for the on-device AI pill while downloading, or null to keep the normal text
 *   ready: text for the "On-device AI:" line of the ready list, or null to keep the normal text
 */
export function getView(state = {}, online = true) {
  const g = state.getAI ?? {};
  const busy = g.status === 'downloading';
  const can = CAN_DOWNLOAD.includes(state.device) && !!state.canGet && state.simulated !== 'no-model';
  const show = can && !busy;
  const pct = busy ? percent(g.loaded) : null;
  let pill = null;
  if (busy) pill = pct == null ? 'On-device AI: downloading…' : pct >= 100 ? 'On-device AI: getting ready' : `On-device AI: downloading ${pct}%`;
  else if (can && state.device === 'downloading') pill = 'On-device AI: downloading…';
  let ready = null;
  if (busy) ready = `downloading${pct == null ? '' : ` (${pct}%)`}. The cloud answers until it is ready.`;
  else if (show) ready = online ? `not downloaded yet. Press “${GET_TEXT.button}” to keep answers working offline (${GET_TEXT.note}). Until then the cloud answers.` : 'not downloaded yet. Connect to the internet to download it.';
  return { show, busy, pct, pill, ready };
}
