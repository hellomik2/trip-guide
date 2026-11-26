// The cloud side, started only when it is needed.
//
// App Check is required for Firebase AI Logic in the cloud. Turning it on loads the reCAPTCHA script
// and later exchanges a token with Google. In "On-device only" mode the page must not contact anyone,
// so this file is not run at all while the lock is on (index.js calls hybridAI() only when the lock
// is off). The on-device-only path uses its own Firebase app without App Check (see index.js).
import { initializeApp, getAI, GoogleAIBackend, APP_CHECK_URL } from './sdk.js';

let pending = null;

/** Firebase AI instance with App Check, for device-first (PREFER_ON_DEVICE) and cloud requests. */
export function hybridAI(config) {
  if (!pending) {
    pending = (async () => {
      const app = initializeApp(config.firebaseConfig, 'hybrid-engine-cloud');
      if (config.useAppCheck !== false) {
        const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import(APP_CHECK_URL);
        // Local development only: a debug token registered in the Firebase console.
        // Never commit it (local/ is git-ignored). Firebase prints it to the console in debug mode.
        if (config.appCheckDebugToken) self.FIREBASE_APPCHECK_DEBUG_TOKEN = config.appCheckDebugToken;
        initializeAppCheck(app, {
          provider: new ReCaptchaEnterpriseProvider(config.recaptchaSiteKey || 'debug-only-placeholder'),
          // Refresh the token in the background, as in the official setup example; otherwise a page left open
          // longer than the token lifetime (one hour by default) gets a new one only on its next cloud request.
          isTokenAutoRefreshEnabled: true,
        });
      }
      return getAI(app, { backend: new GoogleAIBackend() });
    })();
    pending.catch(() => { pending = null; });
  }
  return pending;
}

export const hybridStarted = () => pending !== null;
