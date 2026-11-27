# Trip Guide app

This folder is the web app: an offline travel guide for Seoul's old palace quarter (Gyeongbokgung, Bukchon and
Insa-dong) for Chrome on desktop. It has two tabs. **Ask the guide** answers questions from a travel pack saved
before the trip; **Read a Korean sign** explains Korean signs, menus and notices in English. The AI built into
Chrome does this on the computer itself, with no internet; a computer without the on-device model asks the cloud
while it is online. Every AI request goes through the Firebase AI Logic web SDK.

The repository's root `README.md` tells the whole story: the problem, how one question is answered, where each AI
request runs, the measured results and the known limits. This file is only about running and deploying the app.

## Run it locally

You need Chrome on desktop with the built-in Prompt API and its on-device model (without it the app still works
online through the cloud), Node.js 20 or later, and your own Firebase project with Firebase AI Logic (Gemini
Developer API) and App Check.

1. In this folder, make your own settings file from the template:
   ```sh
   mkdir local
   cp firebase-config.example.js local/firebase-config.js
   ```
   Fill in **your own** Firebase web app settings. For local development, register an App Check debug token in the
   Firebase console (App Check > Apps > Manage debug tokens) and put it in `appCheckDebugToken`. `local/` is
   git-ignored; never commit it.
2. Start a local server from this folder, in one of two ways:
   ```sh
   node tools/serve.mjs            # http://localhost:8790/  simple: /trip serves trip.html, no redirects
   node tools/serve.mjs --hosting  # http://localhost:8791/  behaves like Firebase Hosting with firebase.json
   ```
   The `--hosting` way follows `firebase.json`: `/` redirects to `/trip`, `/trip.html` redirects to `/trip`
   (`cleanUrls`), files in `ignore` are not served, and the `headers` rules are applied.
3. Open `/trip` on that address in Chrome.
4. While online, press **Save for offline**. If the page shows **Get on-device AI** next to the on-device AI pill,
   Chrome can download its on-device model but has not yet: press it while online (Chrome downloads several GB; the
   pill shows the percent and turns to "On-device AI: ready" when it is done). Until then the cloud answers.
   Then turn the network off, open `/trip` again (a new tab is fine) and ask a question, or open
   **Read a Korean sign** and paste one line of Korean.

### URL switches

| Switch | Effect |
|---|---|
| `?simulate=no-model` | Behave as if this computer had no on-device model (to see the cloud path). |
| `?simulate=device-error` | Make on-device requests fail with Chrome's unknown error, to see the retry and the cloud fallback. |
| `?deviceOnly=1` | Turn on **Never use the cloud** and remember it (`?deviceOnly=0` turns it off). The switch at the bottom of the page does the same. |
| `?store=off` | Turn off the reuse of a prepared on-device session (`src/engine/session-store.js`). |

### Checks without AI

```sh
node test/names.test.mjs       # place-name matching
node test/sign.test.mjs        # reading the sign reader's answers into card lines
node test/device-get.test.mjs  # when "Get on-device AI" shows and what the pill says while it downloads
node tools/scan-secrets.mjs    # keys, tokens and direct prompt() calls
```

`scan-secrets.mjs` checks the files git would commit, so run it in a git checkout, after you have filled in
`local/firebase-config.js` (it also looks for your own setting values in those files).

## How it is put together

- `trip.html` and `src/ui/trip.js` are the page; `src/ui/read.js` is the **Read a Korean sign** tab. The page
  talks only to the engine, never to Firebase or Chrome's model directly. `src/ui/device-get.js` decides when the
  **Get on-device AI** button shows and what the pill says while the model downloads (`docs/trip-routing.md`).
- `src/engine/index.js` decides before every AI request where it runs (on this computer, in the cloud, or not at
  all) and calls Firebase AI Logic with `InferenceMode.PREFER_ON_DEVICE`, `ONLY_ON_DEVICE` or `ONLY_IN_CLOUD`.
  The guide's rule is in `docs/trip-routing.md`.
- `src/engine/cloud.js` starts App Check (reCAPTCHA Enterprise) only when the cloud may be used and there is a
  connection; with **Never use the cloud** on, or offline, it is not started and the page contacts no one.
- `src/engine/tasks/trip.js` and `src/engine/trip/` do the guide's work: the AI reads the question into a short
  form, and code matches the place, works out the walking route, distances and opening hours from the pack.
- `src/engine/tasks/sign.js` is the sign reader: its prompts, which AI tries first (`tryOrder`), and reading the
  plain-text answer into the lines of the card. The engine runs it with `runText()`: one line of text on this
  computer first; two or more lines, and photos, on the cloud first while online and allowed; offline, text is read
  on this computer and photos are not read (`devicePhotos: false`).
- `sw-trip.js` keeps the app, the three Firebase SDK files and the travel pack for offline use. The page is kept
  under its clean address `/trip`, because Firebase Hosting answers `/trip.html` with a redirect, and a redirected
  response cannot be used to open a page offline.
- `packs/` holds the travel pack (`docs/trip-pack.md` describes its format). It is built from open data by
  `data-src/build_pack.py` at the root of the repository.

## Deploy

`firebase.json` serves this folder with Firebase Hosting (`firebase deploy --only hosting`). `/` redirects to
`/trip`. The `ignore` list keeps tools, tests and docs off the site; it also names files of earlier prototypes that
are not part of the public repository (earlier tries for this hackathon, written during the submission period).

For a public site, register a reCAPTCHA Enterprise key for your domain in App Check, put it in
`recaptchaSiteKey`, and leave `appCheckDebugToken` empty. `local/firebase-config.js` is uploaded with the site (the
page needs the Firebase web settings), so anything in it is public once deployed: it must never hold a debug token.

## Data and licences

The code is under the Apache License 2.0. The travel pack is a database derived from OpenStreetMap data under the
ODbL 1.0, with text adapted from Wikivoyage (CC BY-SA 4.0), facts from Wikidata (CC0) and photos from Wikimedia
Commons (each with its own author and licence). The page shows these credits, with links, under
**Credits and licences**.
