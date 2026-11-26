# How the travel pack is built

The app reads one JSON file per area (`app/packs/<pack id>/pack.json`, format in `app/docs/trip-pack.md`) and
the resized photos next to it. This folder holds the open data the pack was made from and the scripts that
made it, so the pack can be checked and rebuilt.

```sh
python -I data-src/build_pack.py gogung
```

`build_pack.py` reads `data-src/gogung/` and writes `app/packs/seoul-gogung/pack.json`, the resized photos in
`app/packs/seoul-gogung/img/`, `app/packs/index.json` and `data-src/gogung/build-report.json`. It needs
Python 3.11 and Pillow. It invents nothing: where a raw value is missing the pack says so (for example
opening hours "unknown").

The raw 1280px photos are not in this repository (17.6 MB). `data-src/gogung/tools/photos_download.py` fetches
them again from Wikimedia Commons into `data-src/gogung/photos/img/` from the list in `photos/selection.json`;
`photos/licenses.json` records the author, licence and source page of each one.

## What is here

| Path | What | Source and licence |
|---|---|---|
| `gogung/osm/ways-raw.json` | Footways and streets (node ids and coordinates) used for walking routes | OpenStreetMap contributors, ODbL 1.0 |
| `gogung/wikivoyage/seoul-jongno.meta.json` | The English Wikivoyage article "Seoul/Jongno" the pack adapts: page and revision | Wikivoyage contributors, CC BY-SA 4.0 |
| `gogung/wikidata/entities.json` | Selected fields of the Wikidata items of the places | Wikidata, CC0 |
| `gogung/candidates.json` | The 61 places chosen for the pack | Chosen from the three sources above |
| `gogung/hours/` | Opening hours per place, with the official page and the date it was read | Official websites; OpenStreetMap; Wikivoyage |
| `gogung/landmarks-describe.json` | What each landmark looks like from the street | Written for this project |
| `gogung/walks.json` | Suggested walks (order of stops) | Written for this project |
| `gogung/photos/licenses.json`, `selection.json` | The chosen Wikimedia Commons photos, why, author and licence | Wikimedia Commons (CC0, CC BY, CC BY-SA) |
| `gogung/tools/` | The scripts that fetched and prepared the files above | Apache-2.0 (this project) |

Three raw files that the scripts fetched or parsed are not in this repository, because they hold the contact
e-mail addresses of businesses: the Overpass answer for places (`gogung/osm/places-raw.json`), the article text
(`gogung/wikivoyage/seoul-jongno.wikitext`) and the listings parsed from it (`gogung/wikivoyage/jongno-listings.json`).
`build_pack.py` does not read them; `candidates.json` keeps what was chosen from them. `tools/overpass_fetch.py`,
`tools/wv_fetch.py` and `tools/wv_parse.py` fetch and parse them again. `wv_fetch.py` takes the article's current
revision; the revision the pack adapts is the permalink in `seoul-jongno.meta.json`.

Some script comments are in Korean.

## Licence of the pack

`pack.json` is a derived database of OpenStreetMap data and is available under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Text adapted from Wikivoyage is
available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Each photo keeps its own
licence (see `CREDITS.md`). The code in this folder is under the Apache License 2.0 like the rest of the
repository.
