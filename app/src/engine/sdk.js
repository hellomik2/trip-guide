// Firebase JS SDK, loaded as ES modules from the official CDN (no build step).
// Pinned to 13.3.0: the session store (session-store.js) was measured against this version.
// App Check is loaded later, only when the cloud is first needed (see cloud.js).
export { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
export { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-ai.js';

export const SDK_VERSION = '13.3.0';
export const APP_CHECK_URL = 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app-check.js';
