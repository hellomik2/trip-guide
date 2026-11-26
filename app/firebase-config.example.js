// Copy this file to local/firebase-config.js and fill in your own values.
// local/ is git-ignored. Never commit real values, and never commit an App Check debug token.

// Firebase console > Project settings > Your apps > Web app > SDK setup and configuration.
export const firebaseConfig = {
  apiKey: 'YOUR_WEB_API_KEY',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  storageBucket: 'your-project.firebasestorage.app',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:0000000000000000000000',
};

// App Check (required by Firebase AI Logic). For a deployed site, register a reCAPTCHA Enterprise
// site key in Firebase console > App Check and put it here.
export const recaptchaSiteKey = '';

// Local development only: an App Check debug token you registered in the console
// (App Check > Apps > Manage debug tokens). Leave empty for a deployed site.
export const appCheckDebugToken = '';

// Set to false only if App Check is not enforced for Firebase AI Logic in your project.
export const useAppCheck = true;

// Cloud model used when the on-device model can't run.
export const cloudModel = 'gemini-3.5-flash-lite';
