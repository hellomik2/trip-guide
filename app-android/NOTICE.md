# NOTICE

Trip Guide for Android (`app-android/`), written for the Firebase #BuildHybridAI 2026 hackathon (started 2026-11-23, this version 2026-11-26).

## What is inside the APK

- The trip page of the web version (`../app/trip.html`, `../app/src/ui/`, `../app/src/engine/`) and the travel pack (`../app/packs/`), copied at build time by `app/build.gradle.kts` (task `copyWebApp`). The web version is this project's own code (Apache License 2.0, `../app/LICENSE`).
- Three Android-only files replace or add to it: `web/sdk.js` (talks to the app's bridge instead of the Firebase JS SDK), `web/firebase-config.android.js` (no keys), `web/android.css`, and the text changes listed in `web/patches.json`.

## Code adapted from other projects

- **firebase/quickstart-android** (`firebase-ai/`), Copyright Google LLC, licensed under the Apache License 2.0.
  https://github.com/firebase/quickstart-android
  - The hybrid-inference calls in `AiBridge.kt` (creating the model with `OnDeviceConfig`, `onDeviceExtension.checkStatus()`, `download()` with `DownloadStatus`, reading `inferenceSource`) follow `feature/hybrid/HybridInferenceViewModel.kt`. No file was copied as is; the code was written for this app.
  - Plugin and library versions (AGP 9.4.1, Kotlin 2.4.21, Gradle 9.9.1, Firebase BoM 35.2.0, firebase-ai 18.2.0, firebase-ai-ondevice 16.0.0-beta08) and the App Check debug provider setup follow that project's `gradle/libs.versions.toml`, `gradle-wrapper.properties` and `MainActivity.kt`.

## Libraries (used as dependencies, not copied)

- Firebase AI Logic (`firebase-ai`, `firebase-ai-ondevice`), Firebase App Check debug provider: Google, see the Firebase terms.
- kotlinx.coroutines, kotlinx.serialization: JetBrains, Apache License 2.0.
- Gradle wrapper (`gradlew`, `gradle/wrapper/`): Gradle, Apache License 2.0.

## Data in the travel pack

The pack is the web version's pack, with its own credits shown in the app ("Credits and licences"): map and place data © OpenStreetMap contributors (ODbL), text adapted from Wikivoyage (CC BY-SA 4.0), facts from Wikidata (CC0), photos from Wikimedia Commons, each with its author and licence.
