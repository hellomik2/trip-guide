// Android build only: copied to local/firebase-config.js inside the APK (app-android/app/build.gradle.kts).
// It holds no keys. On Android, Firebase is set up by the native SDK from google-services.json (never committed),
// App Check runs in the native SDK, and every AI request goes through the app's bridge (web/sdk.js, AiBridge.kt).
export const firebaseConfig = { platform: 'android' };
// The page itself never starts the web App Check (it is done natively).
export const useAppCheck = false;
// Cloud model used when the on-device model can't answer (the same as the web version).
export const cloudModel = 'gemini-3.5-flash-lite';
