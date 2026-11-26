# Trip Guide for Android (experimental)

**Status.** This Android build is an experiment. The platform submitted to the hackathon is Web (Chrome on desktop,
`../app/`), not this build. On a phone we measured only the cloud path and the no-internet notice, with an earlier
version of the web code; the on-device path has not been run on a supported phone. The root README, section
"Android build (experimental)", lists what was measured and what was not.

The same travel guide as the PC Chrome version (`../app/`), as an Android app. The travel pack for Seoul's old palace
quarter (61 places, 58 photos) is inside the APK, so the app opens and shows places, the walking map and photos with no
internet. The app is written so that questions are answered by the on-device model when the phone has one (Gemini
Nano through Android AICore), and by the cloud model when it does not and the phone is online. Every answer is
labelled with the source the SDK reports (On-device AI / Cloud AI). With no model and no internet, nothing is sent and
the app says why.

## How it works

- `app/src/main/java/app/tripguide/hybrid/TripActivity.kt`: a WebView that shows the trip page from the APK
  (`https://appassets.androidplatform.net/trip.html`). Requests to any other host are blocked and logged.
- `AiBridge.kt`: the only place that runs AI. It uses the **Firebase AI Logic Android SDK** (`firebase-ai` 18.2.0 and
  `firebase-ai-ondevice` 16.0.0-beta08) with `OnDeviceConfig(mode = PREFER_ON_DEVICE | ONLY_ON_DEVICE | ONLY_IN_CLOUD,
  modelOption = PREVIEW)`, streams the answer with `generateContentStream`, and passes `inferenceSource` to the page.
  At start it checks the on-device model (`checkStatus()`, Gemini Nano 4 preview first, then the stable model) and
  downloads it in the background when it is downloadable and the phone is online.
- `web/`: what changes in the web page for Android (see `web/README.md`). The page's routing rules are the web
  version's: on-device first; the cloud only when there is no model, the text is too long for it, or it failed.

## Build

Command-line tools only (no Android Studio). We built with JDK 21, Android SDK platform 37 and build-tools 36.0.0
(the version the Android Gradle plugin 9.4.1 used), and the Gradle wrapper in this folder (Gradle 9.9.1). Build inside
a checkout of the whole repository: the build copies the web app from `../app/`.

```
./gradlew assembleDebug        (Windows: gradlew.bat assembleDebug)
```

You need your own Firebase project with Firebase AI Logic (Gemini Developer API) and App Check. Register an Android
app with the package name `app.tripguide.hybrid` in it and put its `google-services.json` (Firebase console > Project
settings > your Android app) into `app/`. That file is never committed. Without it the app builds and shows the pack,
and says the AI is not set up.

Test builds limit their own cloud use: at most 45 requests that may reach the cloud per install, at least 6.5 s apart
(`-PcloudCap=<n>` changes the first, 0 means no limit).

## Tests on a PC

No phone and no AI call is needed:

```
node --test app-android/web/sdk.test.mjs              (from the repository root)
node --test app-android/web/engine-bridge.test.mjs    (after a build: it runs the engine copied into the APK)
```

Both use a made-up bridge in place of the app. They check how the page talks to the bridge, not the Android SDK.

## App Check

Firebase AI Logic needs App Check. Debug builds use the App Check debug provider: register the debug token the app
prints to logcat in the Firebase console (App Check > Apps > Manage debug tokens). A build for other people needs
either the Play Integrity provider (the app in Play Console, the Cloud project linked, the signing certificate's
SHA-256 in Firebase, and for an APK installed outside Google Play the advanced setting "Exclusively outside Google
Play") or a debug token built in with `-PappCheckDebugTokenFile=<file outside the repo>` (deleted in the console after
use). Never commit a token.

## On-device model (Gemini Nano 4)

Supported phones are listed at https://developers.google.com/ml-kit/genai (for example Pixel 10, Galaxy S25/S26,
Z Fold7/Fold8, Z Flip7/Flip8). Gemini Nano 4 is a preview model: on the phone, turn on Developer options > AICore
Settings > "Enable AICore Developer Preview". On other phones the app answers with the cloud model while online.
We have not run the app on a phone where the SDK reported an on-device model.
