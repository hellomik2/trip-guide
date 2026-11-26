# Travel pack format (`trip-pack/2`)

A travel pack is one JSON file plus its photos, saved before the trip while online. Everything the trip guide
answers offline comes from it. The same files are meant to work unchanged in a later phone version.
The checker is `validatePack()` in `src/engine/trip/pack.js` (it still reads the older `trip-pack/1` shape).

The Seoul pack is built from the raw data in `data-src/gogung/` by

```
python -I data-src/build_pack.py gogung
```

which writes `app/packs/seoul-gogung/pack.json`, the photos in `app/packs/seoul-gogung/img/`, `app/packs/index.json`
(the list of packs the app offers) and a report `data-src/gogung/build-report.json`. Run it again after editing the raw
files; it rebuilds the pack and the photos from scratch. Nothing is invented by the build: a missing value stays
missing (opening hours "unknown"), and sources that disagree are kept as a `conflict` text.

## Top level

| field | meaning |
|---|---|
| `format` | `"trip-pack/2"` |
| `id`, `title`, `city`, `area`, `country`, `language`, `updated` | names shown in the app |
| `center` `{lat, lon}`, `bbox` `[south, west, north, east]` | the area of the pack |
| `credits[]` | attribution lines shown in the app (data, text, photos, hours, "not affiliated") |
| `licence` | licences of the pack as a whole (ODbL for the OpenStreetMap-derived data, CC BY-SA 4.0 for Wikivoyage text) |
| `places[]` | the places (below) |
| `notes[]` | area-wide facts: `id`, `topic`, `text`, `from` |
| `walks[]` | suggested walks: `id`, `title`, `stops` (place ids in order), `notes` |
| `photos[]` | every photo with its author and licence (below) |
| `net` | the walking network (below) |

## Places

| field | meaning |
|---|---|
| `id` | `L..` sights, `F..` food and drink, `S..` services |
| `name`, `nameKo` | English and Korean names |
| `kind` | `sight`, `restaurant`, `cafe`, `station` (subway exits), `info`, `toilet`, `pharmacy`, `atm` |
| `type` | the finer type as collected (`palace gate`, `teahouse`, `subway exit`, …) |
| `lat`, `lon` | position |
| `address`, `addressKo` | street address in English (street name from OpenStreetMap's `name:en`) and in Korean, when known |
| `about`, `aboutFrom` | one or two sentences from Wikivoyage (adapted, CC BY-SA 4.0) or the Wikidata description |
| `tip` | short traveller note written while collecting the data |
| `looks` | for sights: what a walker sees from the street (2–3 sentences, written from the photos or text sources) |
| `serves`, `dish` | for food: words for what it serves, found as whole words in its own texts (Wikivoyage, OpenStreetMap `cuisine`, the dish of its photo): `noodles`, `dumplings`, `soup`, `beef`, `pork`, `chicken`, `barbecue`, `vegetarian`, `tea`, `coffee`, `bread`, `dessert`, `snacks`, `rice cakes`, `breakfast`; and the dish its photo shows |
| `hours` | opening hours (below) |
| `events[]` | fixed-time events from official pages: `name`, `when`, `note` |
| `price` | `{ text, from }` as written by the official site or Wikivoyage |
| `phone`, `transit` | as written in OpenStreetMap or Wikivoyage. A phone number whose digits do not make a Korean number is left out; one without `+` or `0` is written with `+82` (same digits). A transit text cut short in the source is left out; line numbers are removed from one text whose line number disagrees with the station listings |
| `ticket` | the place is inside ticketed palace grounds; the value is the palace id (`L01` Gyeongbokgung, for the palace itself and the halls and gates inside it) |
| `door` | for a walled palace: the id of its main gate (the gate whose own text calls it the main gate) |
| `photos[]` | photo ids |
| `node`, `snapM` | the nearest walking-network node and how far the place is from it, in metres |
| `src[]` | source URLs |

### Opening hours

```json
"hours": {
  "status": "official",                       // official | official-inside | osm | wikivoyage | outdoor | unknown
  "rules": [ { "open": ["09:00-17:00"], "months": [11, 12], "last": "16:00" },
             { "open": ["09:30-21:00"], "days": ["wed"], "nth": "last" } ],
  "closed": { "days": ["tue"], "dates": ["01-01"], "nth": [{ "n": "last", "day": "mon" }], "lunar": true, "text": "as written" },
  "daysStated": false,                        // Wikivoyage gave times but not the days
  "visit": true,                              // hours tourists may visit an area (Bukchon Red Zone), not a building's hours
  "inside": "L01",                            // a place inside Gyeongbokgung follows the palace's hours
  "source": { "name": "…", "url": "…", "read": "2026-11-23" }, "note": "…", "conflict": "…", "text": "as written"
}
```

- On a given day the rule that matches the month, the weekday and the "last weekday of the month" is used; when
  several match, the most specific wins (`nth` over `days` over `months`). A weekday or date in `closed` closes the
  whole day. With OpenStreetMap hours, a weekday not named in any rule is closed.
- `unknown`: the hours were not found in the sources. The app says so; it never guesses.
- `outdoor`: an outdoor public space with no opening hours collected.
- Lunar holidays (Seollal, Chuseok) move every year and stay only in `closed.text`.

### Lists of places open at a time

When a question asks for food places or sights that are open now (or at a day and time the question names), the app
orders its list like this, each group nearest walk first:

1. places open at that moment by their hours (for sights, outdoor public spaces count here too; Bukchon visit hours
   count when visits are allowed at that moment);
2. places whose hours come without days (`daysStated: false`) and whose listed times include that moment; the app
   marks them "Hours not confirmed", because the source does not say which days they open;
3. places with unknown hours, marked "Hours not in pack".

Places closed at that moment are left out. If groups 1 and 2 are both empty, the app says that none of the matching
places is open at that time.

## Photos

`{ id, file, w, h, bytes, kind, for, dish, author, license, licenseUrl, title, page, taken, changes }`.
`kind` is `landmark`, `dish` (a photo of the kind of dish a restaurant serves, not taken there) or `real` (taken at the
restaurant). The app shows the author and licence under every photo and the full list in "Credits and licences".
Photos are copies resized to at most 720 px from the Wikimedia Commons files.

## Walking network

```json
"net": { "nodes": [lat*1e6, lon*1e6, …], "edges": [a, b, wayIndex, lengthInDecimetres, …], "ways": [{ "h": "footway", "n": "Insadong-gil", "k": "인사동길", "fee": 1, "x": 1, "sw": 1, "area": 1, "tun": "yes", "br": 1 }] }
```

Built from OpenStreetMap `highway` ways that people may walk on (not `foot=no`, not `access=no|private|permit` unless
`foot=yes`, not indoor corridors, no cycleways unless open to walkers), keeping the largest connected part.
`n` is the English street name (first letter made a capital), `fee` a ticketed area (palace grounds), `x` a crossing,
`sw` a sidewalk. When OpenStreetMap draws two ways between the same two nodes, only one edge is kept (the named one).

A walk is the shortest path by length over the network from the start place's `node` to the end place's `node`.

- End place: the destination itself, except for a place with `door` (a walled palace): then the walk ends at the
  `door` place (its main gate), unless the start is inside that palace (start `ticket` = the palace id).
- Ways with `fee` (ticketed palace grounds) are used only when the start place or the end place has `ticket`
  (or when there is no other path). Inside the palace most paths carry no `fee` tag; the rule is about the places.
- Same place, start inside the palace asked for, or start at its `door`: no walk (0 m).
- The walking length shown is the path length plus the start's and the end place's `snapM`; the time is that length
  at 80 m per minute, rounded, at least 1 minute. Two places on the same node: the length is the two `snapM`.
- A walk that uses `fee` ways says that part of it is inside the ticketed grounds and gives the palace's opening
  state at the asked time.

## Where it is kept

"Save for offline" stores `pack.json` and every photo in the browser's Cache Storage (`trip-pack-<id>`) and the app
files through the service worker (`sw-trip.js`). The pack is never sent anywhere: on-device answers read it locally,
and when the cloud answers (only with no on-device model, and only online) the request carries the few lines code
chose for that question, not the pack.
