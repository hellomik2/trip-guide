"""핵심 장소 후보를 고른 목록(아래 PICKS)과 받은 원본에서 채워 candidates.json 을 만든다.
고른 까닭과 고친 이름은 note 칸에 적는다. 원본 값은 바꾸지 않고 osm.tags 에 그대로 둔다."""
import json, sys, os
sys.stdout.reconfigure(encoding="utf-8")
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.join(here, "..")
osm = json.load(open(os.path.join(root, "osm/places-raw.json"), encoding="utf-8"))
wv = json.load(open(os.path.join(root, "wikivoyage/jongno-listings.json"), encoding="utf-8"))
byid = {f"{e['type'][0]}{e['id']}": e for e in osm["elements"]}
wvby = {i["name"]: i for i in wv["items"] if i["in_bbox"]}
TYPES = {"n": "node", "w": "way", "r": "relation"}

# (id, group, kind, osm, wikivoyage name, wikidata, name_en override, note)
PICKS = [
 ("L01", "landmark", "palace", "r5501517", "Gyeongbokgung", "Q482485", None, "Main royal palace of the Joseon dynasty."),
 ("L02", "landmark", "palace gate", "w170199440", None, "Q485034", None, "Main (south) gate of Gyeongbokgung; the Royal Guard Changing Ceremony is held here."),
 ("L03", "landmark", "palace gate", "w1203368739", None, "Q12626205", None, "Second gate inside Gwanghwamun. Official site: free tours start at the Information Center inside Heungnyemun. Wikidata id found by search."),
 ("L04", "landmark", "throne hall", "w170199428", None, "Q10855678", None, ""),
 ("L05", "landmark", "pavilion", "w170199469", None, "Q12583939", None, "Wikidata id found by search (OSM has none)."),
 ("L06", "landmark", "pavilion", "w842192001", None, "Q16745780", "Hyangwonjeong Pavilion", "OSM name:en 'Hyangwonjeong' (added after July 2026); 'Pavilion' added as written on the official Royal Palaces site history table."),
 ("L07", "landmark", "watchtower", "w236942291", None, "Q16630864", None, "Wikidata id found by Korean search."),
 ("L08", "landmark", "museum", "r2270998", "National Palace Museum", "Q335998", None, ""),
 ("L09", "landmark", "museum", "r5501518", "National Folk Museum", "Q486449", None, "OSM has three relations named 국립민속박물관 (r5501516, r5501518, r5501521); r5501518 carries the wikidata tag."),
 ("L10", "landmark", "public square", "r5672803", "Gwanghwamun Plaza", "Q5623300", None, ""),
 ("L11", "landmark", "statue", "w380883710", None, "Q30601154", "Statue of King Sejong the Great", "OSM name:en 'King Sejong the Great (Statue at Gwanghwamun)'; shortened."),
 ("L12", "landmark", "statue", "n2653074012", None, "Q30594133", "Statue of Admiral Yi Sun-sin", "OSM name:en has a typo ('Admniral Yi Sun Shin'); English name taken from the Wikidata label."),
 ("L13", "landmark", "museum", "w141957171", "National Museum of Korean Contemporary History", "Q12592360", None, ""),
 ("L14", "landmark", "museum", "r14956894", "MMCA Seoul (National Museum of Modern and Contemporary Art, Korea)", "Q484054", "MMCA Seoul (National Museum of Modern and Contemporary Art)", "OSM name:en 'National Museum of Modern and Contemporary Art'; 'MMCA Seoul' from Wikivoyage and the official site."),
 ("L15", "landmark", "street", "w551184628", None, "Q16100499", "Samcheong-ro (Samcheong-dong street)", "Street of cafes, galleries and shops north-east of Gyeongbokgung. The OSM way is one segment of Samcheong-ro."),
 ("L16", "landmark", "library and garden", "r10754475", None, "Q624545", None, "Public library (Seoul Metropolitan Office of Education). Seoul Museum of Education (w301282717) is in its grounds."),
 ("L17", "landmark", "hanok village", "n2669684119", "Bukchon Hanok Village", "Q490981", "Bukchon Hanok Village", "OSM name tag reads '북촌한옥마을 ДЕРЕВНЯ' (a Russian word mixed in, looks like an editing error). Red Zone visiting hours apply."),
 ("L18", "landmark", "viewpoint", "n5786802583", None, None, "Bukchon 5th Scenic Spot: Gahoe-dong Alley", "OSM name:en spells 'Buchon'; corrected to 'Bukchon'. Spots 4 and 6 (n4722178090, n5786802580) are within 100 m."),
 ("L19", "landmark", "viewpoint", "WV", "Bukchon Observatory", None, None, "Not found in OSM. Location and facts only from Wikivoyage (private rooftop; admission includes a drink)."),
 ("L20", "landmark", "historic house", "w611541494", None, "Q19657151", "Baek In-je House", "OSM name:en 'Baek In-Je's House In Gahoe-dong'."),
 ("L21", "landmark", "museum", "w237615585", "Seoul Craft Museum", "Q115260513", "Seoul Museum of Craft Art", "Two Wikidata items describe this museum (Q115260513 used by Wikivoyage, Q97205213 found by search). Official English name 'Seoul Museum of Craft Art (SeMoCA)'."),
 ("L22", "landmark", "palace (residence)", "w771236312", "Unhyeongung", "Q490392", "Unhyeongung", ""),
 ("L23", "landmark", "palace gate", "w170199455", None, "Q16092829", "Donhwamun Gate (Changdeokgung Palace)", "Main gate of Changdeokgung, at the east edge of the area. The palace itself: OSM w789965985, Wikidata Q477157."),
 ("L24", "landmark", "temple", "w223157537", "Jogyesa Temple", "Q488824", None, ""),
 ("L25", "landmark", "street", "n4992383221", "Insadong", "Q61097753", "Insa-dong Street (Insadong-gil)", "OSM node name:en 'Isandong tourist traditional street' (typo). Wikidata Q61097753 is the road Insadong-gil; the neighbourhood is Q488678."),
 ("L26", "landmark", "shopping complex", "r14280713", "Ssamziegil", None, None, "No Wikidata item found."),
 ("L27", "landmark", "museum", "w355665717", "Museum Kimchikan", "Q625781", None, ""),
 ("L28", "landmark", "park", "r11504980", "Tapgol (\"Pagoda\") Park", "Q483357", None, "Wongaksa Pagoda (w320791143, Q625836) and Palgakjeong (w320791145) are inside."),
 ("L29", "landmark", "religious building", "w320793333", None, "Q12618846", "Cheondogyo Central Temple", "OSM and Wikidata have only the Korean name; English name written by us (needs checking)."),
 ("L30", "landmark", "hanok street", "w980200451", None, "Q124669648", "Ikseon-dong Hanok Village", "OSM name '익선동 한옥마을 Ikseondong'."),
 ("F01", "food", "restaurant", "n4459966889", "Imun Seolnongtang", "Q12611409", None, ""),
 ("F02", "food", "restaurant", "n12062468549", "Sadongmyenok", None, "Sadong Myeonok", "OSM has no name:en; Wikivoyage spells 'Sadongmyenok'."),
 ("F03", "food", "restaurant", "n5614557724", "Gung", None, None, "Wikivoyage lists it as 'Gung' (궁). In the 2026-07-28 OSM copy it was node 5618578721 named '개성만두 궁 (미쉐린가이드, 만두전골)'; in today's data it is node 5614557724."),
 ("F04", "food", "restaurant", "w316516024", "Samcheong Sujaebi", None, None, "Duplicate node n12060692158 at the same spot."),
 ("F05", "food", "restaurant", "n12074718646", "Uyeonhwa", None, "Uyeonhwa", "OSM has no name:en."),
 ("F06", "food", "restaurant", "n13674868878", "Sinrajemyeon Anguk Branch", None, "Sinrajemyeon (Anguk)", "OSM cuisine tag says 'ramen'; Wikivoyage says kalguksu."),
 ("F07", "food", "restaurant", "n13955726451", "Chwiyabeolguksi", None, "Chwiyabeol Guksi", ""),
 ("F08", "food", "restaurant", "n13955741503", "Eomyongbaek pork soup", None, "Eomyongbaek Dwaeji Gukbap", ""),
 ("F09", "food", "restaurant", "n6897152187", "GwanghwamunMijin", None, "Gwanghwamun Mijin", "OSM opening_hours (Mo-Su 10:00-22:00) and Wikivoyage hours (10:30-21:00) differ."),
 ("F10", "food", "bakery cafe", "n11794898969", "Artist Bakery", None, None, ""),
 ("F11", "food", "restaurant", "w355845777", None, None, "Man-Seok Dak Han Ma-Ri (Insadong)", "OSM only. Not in Wikivoyage."),
 ("F12", "food", "restaurant", "WV", "Tteoksang", None, None, "Not found in OSM. Location from Wikivoyage."),
 ("F13", "food", "snack bar", "WV", "Pungnyeon Ssal Nongsan", None, None, "Not found in OSM. Location from Wikivoyage."),
 ("F14", "food", "restaurant", "WV", "Ikseon-dong Meat Restaurant", "Q141901871", None, "Not found in OSM. Location from Wikivoyage."),
 ("F15", "food", "restaurant", "n2471444664", None, None, "Osegyehyang", "OSM only. Vegetarian Korean (OSM cuisine tag)."),
 ("F16", "food", "restaurant", "n5476055828", None, None, "Can Dumplings (Kkangtong Mandu)", "OSM only."),
 ("F17", "food", "teahouse", "w555212525", None, None, "Namusae Teahouse", "OSM only. OSM name has only English."),
 ("F18", "food", "teahouse", "n4455281404", None, None, "Traditional Tea House (Jeontong Dawon)", "OSM only."),
 ("F19", "food", "street snack", "w426709960", None, None, "Samcheongdong Hotteok", "OSM only."),
 ("S01", "service", "subway exit", "n3403538917", None, None, "Gyeongbokgung Station Exit 5", "Line 3. Exit on the palace side."),
 ("S02", "service", "subway exit", "n3403538918", None, None, "Anguk Station Exit 1", "Line 3. Seoul Museum of Craft Art is 50 m from Exit 1 (official museum page)."),
 ("S03", "service", "subway exit", "n3403538920", None, None, "Anguk Station Exit 2", "Line 3. Toward Bukchon."),
 ("S04", "service", "subway exit", "n3403538919", None, None, "Anguk Station Exit 6", "Line 3. Toward Insa-dong and Jogyesa (Jogyesa official page: Exit 6)."),
 ("S05", "service", "subway exit", "n3841809500", None, None, "Gwanghwamun Station Exit 9", "Line 5. Opens onto Gwanghwamun Square (OSM: level -1, wheelchair=yes)."),
 ("S06", "service", "subway exit", "n3403195792", None, None, "Jongno 3-ga Station Exit 5", "Lines 1/3/5. Toward Ikseon-dong and Tapgol Park. OSM has no English description."),
 ("S07", "service", "tourist information", "n3371283293", None, None, None, ""),
 ("S08", "service", "tourist information", "w611165760", None, None, None, ""),
 ("S09", "service", "toilets", "n5798480901", None, None, None, ""),
 ("S10", "service", "toilets", "n3052967563", None, None, "Public toilets under Gwanghwamun Square", "OSM node has no name; level -1, fee=no, wheelchair=yes."),
 ("S11", "service", "pharmacy", "w355665710", None, None, "Sudo Onnuri Pharmacy (Insa-dong)", "OSM has only the Korean name 수도온누리약국; English written by us."),
 ("S12", "service", "atm", "n3793809178", None, None, "Woori Bank Jaedong Branch (ATM)", "Near Anguk Station Exits 2 and 3."),
]


# 한국어 이름을 OSM name 칸과 다르게 적은 곳 (까닭은 note 또는 아래 주석). OSM 원본은 osm.tags 에 그대로 있다.
KO_OVERRIDE = {
    "L17": "북촌한옥마을",      # OSM name 에 'ДЕРЕВНЯ' 가 섞여 있음
    "L30": "익선동 한옥마을",   # OSM name 끝에 영어 'Ikseondong'
    "S12": "우리은행 재동지점", # OSM name '우리은행' + branch '재동지점'
}
DESC_AS_KO = {"S01", "S02", "S03", "S04", "S05", "S06"}  # 지하철 출구는 OSM description(한국어)을 이름으로


def ll(e):
    if "lat" in e:
        return e["lat"], e["lon"]
    c = e.get("center")
    return c["lat"], c["lon"]


out = []
for pid, group, kind, oid, wvname, qid, en_over, note in PICKS:
    w = wvby.get(wvname) if wvname else None
    if wvname and not w:
        print("WV missing", wvname); sys.exit(1)
    rec = {"id": pid, "group": group, "kind": kind}
    if oid == "WV":
        rec.update({"name_en": en_over or w["name"], "name_ko": w["fields"].get("alt") or None, "lat": w["lat"], "lon": w["lon"],
                    "coord_source": "wikivoyage", "osm": None})
    else:
        e = byid[oid]; t = e.get("tags", {}); la, lo = ll(e)
        rec.update({"name_en": en_over or t.get("name:en") or None, "name_ko": t.get("name"), "lat": round(la, 6), "lon": round(lo, 6),
                    "coord_source": "osm" + ("" if "lat" in e else " (center of way/relation)"),
                    "osm": {"type": TYPES[oid[0]], "id": e["id"], "url": f"https://www.openstreetmap.org/{TYPES[oid[0]]}/{e['id']}",
                            "version": e.get("version"), "timestamp": e.get("timestamp"), "tags": t}})
    if pid in KO_OVERRIDE:
        rec["name_ko"] = KO_OVERRIDE[pid]
    if pid in DESC_AS_KO:
        rec["name_ko"] = rec["osm"]["tags"].get("description")
    rec["opening_hours_osm"] = rec["osm"]["tags"].get("opening_hours") if rec["osm"] else None
    rec["wikidata"] = qid or (rec["osm"]["tags"].get("wikidata") if rec["osm"] else None)
    if w:
        f = w["fields"]
        rec["wikivoyage"] = {"name": w["name"], "kind": w["kind"], "section": w["section"], "line": w["line"],
                             "hours": f.get("hours") or None, "price": f.get("price") or None,
                             "address": f.get("address") or None, "directions": f.get("directions") or None,
                             "content": f.get("content") or None, "lastedit": f.get("lastedit") or None,
                             "url": wv["source"]["permalink"], "revid": wv["source"]["revid"]}
    else:
        rec["wikivoyage"] = None
    srcs = []
    if rec["osm"]:
        srcs.append(rec["osm"]["url"])
    if w:
        srcs.append(wv["source"]["permalink"] + f" (listing '{w['name']}', line {w['line']})")
    if rec["wikidata"]:
        srcs.append(f"https://www.wikidata.org/wiki/{rec['wikidata']}")
    rec["sources"] = srcs
    rec["note"] = note
    out.append(rec)

json.dump({"made": "2026-11-23",
           "how": "Picked by hand from osm/places-raw.json and wikivoyage/jongno-listings.json (see tools/build_candidates.py PICKS).",
           "counts": {g: sum(1 for r in out if r["group"] == g) for g in ("landmark", "food", "service")}, "places": out},
          open(os.path.join(root, "candidates.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for r in out:
    print(r["id"], "|", r["name_en"], "|", r["name_ko"], "|", r["lat"], r["lon"], "|", r["wikidata"], "|", r["opening_hours_osm"])
