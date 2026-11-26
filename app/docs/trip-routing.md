# Where an answer runs (trip guide)

The trip guide answers from the saved travel pack ([trip-pack.md](trip-pack.md)). Every AI call goes through
the Firebase AI Logic web SDK (`firebase/ai`) inside the engine (`src/engine/index.js`). This page is the rule
the engine follows, written so a phone version can follow the same rule.

## Steps for one question

1. **The AI reads the question** into a short form (`UNDERSTAND_SYSTEM` and `UNDERSTAND_SCHEMA` in
   `src/engine/trip/prompts.js`): the kind (food, route, sights, identify, hours, other), the place name exactly as
   written, the start of a route, the food asked for, the time condition (now, later, any) and a second question if
   there is one. It runs where every AI request runs (table below). Code keeps a name only if it is really written in
   the question, and "now" only if the question has a word about time.
2. **Code matches the names to the pack** (`src/engine/trip/names.js`, no AI): case, hyphens, possessives, common
   spellings of Korean names, one or two wrong letters, initials (MMCA) and English place words for Korean endings
   (Jogye Temple = Jogyesa) are allowed. A name that fits no saved place is answered with "Your saved travel pack does
   not include …" and the closest names as buttons; the app never shows another place's walk or intro instead.
3. **Code works out the answer** (`src/engine/trip/guide.js`): walks, steps, distances, opening checks, the nearest
   places, the "what is this" candidates. Food, sights and routes are answered by code alone (the pack's dish or
   one-line intro, the walk, the opening state). The AI is asked a second time only to pick "what is this" among
   the candidates and to word an answer about one place's other facts.
4. **The screen shows what was understood** above the answer ("Understood as: Directions · to Anguk Station Exit 6")
   with a menu for the kind and one for the place. Changing either answers again from the pack at once, without AI.
5. **Where each AI request runs** (under a second to decide, before any AI call):

| on-device model | internet | lock "Never use the cloud" | where it runs | what the person sees |
|---|---|---|---|---|
| available | any | any | on this device (`PREFER_ON_DEVICE`; `ONLY_ON_DEVICE` when offline or locked) | answer, badge **On-device** |
| not available | online | off | cloud (`ONLY_IN_CLOUD`, `gemini-3.5-flash-lite`) | answer, badge **Cloud** |
| not available | offline | off | nowhere; no request is tried | **Not answered**: "No on-device AI on this computer and no internet connection, so this cannot be answered right now. Connect to the internet and ask again." |
| not available | any | on | nowhere | **Not answered**: "No on-device model on this computer. On-device only is on, so nothing was sent." |

   The rules shared with the other faces stay as they are: input too long for the device goes to the cloud,
   Chrome's unknown device error is retried once and then goes to the cloud. When the cloud would be next but
   the browser is offline, the engine stops with a "Not answered" message instead of trying.
   With no on-device model and no internet, the question cannot be read, so the notice above is the answer. Below it
   the app shows what older word rules guess (marked "Guessed without AI"); choosing the kind and place in the menus
   then answers food, sights and routes from the pack without AI. When the cloud answers, two cloud requests for one
   question (reading it, then picking "what is this") are at least 6.5 seconds apart, for the free tier.
6. **If the cloud cannot be reached although the browser says it is online** (for example a captive portal),
   the request fails at once or after 25 seconds without a first answer, and the row says "Could not reach the
   cloud. Check the internet connection and try again." The page never waits forever.
7. **The model writes a short answer** (only for "what is this" and other questions) with `found: true|false` (shape and instructions:
   `src/engine/trip/prompts.js`, the same for device and cloud). `found: false` is shown as "Your saved travel
   pack does not include this." Code then lists the data lines the answer names as "Based on your saved travel
   pack" and flags numbers in the answer that are in neither the question nor the given lines.

## Read a Korean sign

The sign reader (`src/engine/tasks/sign.js`, run by the engine's `runText()`) decides before any AI call which AI
tries first (`tryOrder`) and whether photos may be read on this device (`devicePhotos: false`):

| input | online, cloud allowed | offline | "Never use the cloud" on |
|---|---|---|---|
| one line of typed text | this device first; the cloud if the device cannot answer | this device | this device |
| two or more lines (a menu, a notice) | the cloud first; this device if the cloud fails | this device, with a note that dish names may be explained less well | this device, with the same note |
| a photo | the cloud only | not read: a notice asks for the typed text | not read: a notice asks for the typed text |

Measured on menus (11-26, ten menus and notices), the cloud got the meaning right 10/10 and the on-device AI 5/10,
so text of two or more lines goes to the cloud first while it can. Photos read on this device were right 5/10 at
best (11-24), so they are not read on this device. With no on-device model, text is read by the cloud while online
and allowed; otherwise the card shows a notice instead of an answer. Cloud requests of the sign reader are at least
6.7 seconds apart (`cloudGapMs`), for the free tier.

## Offline start

- `sw-trip.js` (a service worker for `/trip` only) keeps the app files, the Firebase web settings of this
  deployment and the three Firebase SDK files (`firebase-app.js`, `firebase-ai.js`, `firebase-app-check.js`,
  version 13.3.0 from `www.gstatic.com`) in the browser's Cache Storage. App files are network-first (a copy is
  used only when the network fails), the SDK files are cache-first (their URLs carry a fixed version).
- While offline the engine does not start App Check or reCAPTCHA, so an offline page sends no request to Google.
- The SDK files are not copied into this repository; the browser downloads and caches them from the official
  CDN on the first online visit. (They are Apache-2.0; if they are ever bundled into the repository, keep their
  license headers and list them in a NOTICE file.)
