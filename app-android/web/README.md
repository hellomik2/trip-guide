# Android overlay for the web app

The Android app shows the same trip page as the PC Chrome version. At build time `app/build.gradle.kts`
(task `copyWebApp`) copies the page, its code and the travel pack from `../../app/` into the APK and applies this folder:

| File | Becomes | Why |
|---|---|---|
| `sdk.js` | `src/engine/sdk.js` | Same exports as the web file, but every AI request goes to the Firebase AI Logic **Android** SDK through `window.TripBridge` (`AiBridge.kt`). It also stands in for Chrome's `LanguageModel` (model status from `checkStatus()`, a 4000-token on-device window). |
| `firebase-config.android.js` | `local/firebase-config.js` | No keys. Firebase and App Check run natively from `google-services.json` (never committed). |
| `android.css` | `src/ui/android.css` | Small phone tweaks on top of the web page's own narrow-screen rules. |
| `patches.json` | text changes | "this computer" -> "this phone"; the pack is inside the app (no "Save for offline", no service worker). Each `find` must occur exactly `count` times or the build stops. |

Nothing from `../../app/local/` is copied.

`sdk.test.mjs` and `engine-bridge.test.mjs` are PC tests with a made-up bridge (no phone, no AI call); they are not
copied into the APK. Run them from the repository root with `node --test` (the second one after a build).
