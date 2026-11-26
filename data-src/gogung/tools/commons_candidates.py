"""장소·음식마다 Wikimedia Commons 사진 후보를 모은다 (허용 라이선스만 남김).
출처: Wikidata P18(대표 사진), Commons 분류(P373 또는 아래 EXTRA_CATS), Commons 파일 검색(EXTRA_SEARCH).
결과: photos/commons-candidates.json. 사진 파일은 여기서 받지 않는다."""
import json, sys, os, re, html
sys.stdout.reconfigure(encoding="utf-8")
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.join(here, "..")
sys.path.insert(0, here)
from mw import get

API = "https://commons.wikimedia.org/w/api.php"
EM = "LicenseShortName|License|LicenseUrl|Artist|Credit|ImageDescription|DateTimeOriginal|UsageTerms|AttributionRequired|Restrictions|ObjectName"
ALLOWED = re.compile(r"^(CC0|Public domain|PD|CC BY(-SA)? \d\.\d( [a-z]{2,3})?|CC BY(-SA)? \d\.\d IGO)$", re.I)

# 분류가 없거나 더 넣을 분류, 검색어 (고른 까닭: Wikidata에 Commons 분류가 없는 곳)
EXTRA_CATS = {
    "L01": ["Gyeongbokgung"], "L14": ["National Museum of Modern and Contemporary Art, Seoul"],
    "L15": ["Samcheong-dong"], "L17": ["Gahoe-dong"], "L25": ["Insadong", "Shops in Insadong"],
    "L26": ["Ssamziegil"], "L30": ["Ikseon-dong"], "L27": ["Museum Kimchikan"], "L28": ["Wongaksaji sipcheung seoktap"],
    "L08": ["National Palace Museum of Korea"],
}
EXTRA_SEARCH = {
    "L18": ["Gahoe-dong 31", "Gahoe-dong alley Bukchon", "Bukchon hanok alley"], "L19": ["Bukchon Observatory", "북촌전망대"],
    "L26": ["Ssamziegil Insadong", "Ssamzie-gil", "Ssamzie"], "L30": ["Ikseon-dong hanok"], "L15": ["Samcheong-dong street Seoul"],
    "L27": ["Museum Kimchikan Insadong", "뮤지엄김치간"], "L21": ["Seoul Museum of Craft Art"],
}
# 음식 종류 (식당 후보가 내는 음식). Commons 분류 이름.
FOOD = {
    "seolleongtang": ["Seolleongtang"], "manduguk": ["Manduguk"], "mandu": ["Mandu"],
    "mandu-jeongol": ["Mandujeongol"], "sujebi": ["Sujebi"], "kalguksu": ["Kalguksu"], "dwaeji-gukbap": ["Dwaejigukbap"],
    "memil-guksu": ["Memil-guksu", "Naengmyeon"], "dak-hanmari": ["Dakhanmari"], "samgyetang": ["Samgyetang"],
    "tteokbokki": ["Tteokbokki"], "bunsik": ["Bunsik"], "samgyeopsal": ["Samgyeopsal", "Samgyeopsalgui"], "korean-vegetarian": ["Korean temple cuisine"],
    "korean-tea": ["Tea of Korea", "Jujube tea", "Yuja tea"], "hotteok": ["Hotteok"], "hamburg-steak": ["Hamburg steaks"],
}


def norm_license(s):
    s = (s or "").strip()
    s = re.sub(r"\s+", " ", s)
    return s


def strip_html(s):
    s = re.sub(r"<[^>]+>", "", s or "")
    return html.unescape(s).strip()


def info_from_pages(pages):
    out = []
    for p in pages.values() if isinstance(pages, dict) else pages:
        ii = (p.get("imageinfo") or [None])[0]
        if not ii:
            continue
        em = ii.get("extmetadata", {})
        g = lambda k: (em.get(k) or {}).get("value")
        lic = norm_license(strip_html(g("LicenseShortName")))
        out.append({"title": p["title"], "pageid": p.get("pageid"), "mime": ii.get("mime"), "width": ii.get("width"), "height": ii.get("height"),
                    "size": ii.get("size"), "url": ii.get("url"), "descriptionurl": ii.get("descriptionurl"), "thumburl": ii.get("thumburl"),
                    "license": lic, "license_url": g("LicenseUrl"), "artist": strip_html(g("Artist")), "credit": strip_html(g("Credit")),
                    "description": strip_html(g("ImageDescription"))[:400], "date": strip_html(g("DateTimeOriginal")),
                    "restrictions": g("Restrictions"), "allowed": bool(ALLOWED.match(lic)) and ii.get("mime") in ("image/jpeg", "image/png")})
    return out


def by_titles(titles):
    res = []
    for i in range(0, len(titles), 40):
        d = get(API, {"action": "query", "titles": "|".join(titles[i:i+40]), "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata",
                      "iiurlwidth": 330, "iiextmetadatafilter": EM, "format": "json", "formatversion": "2"})
        res += info_from_pages(d["query"]["pages"])
    return res


def by_cat(cat, limit=40):
    d = get(API, {"action": "query", "generator": "categorymembers", "gcmtitle": "Category:" + cat, "gcmtype": "file", "gcmlimit": limit,
                  "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": 330, "iiextmetadatafilter": EM,
                  "format": "json", "formatversion": "2"})
    return info_from_pages(d.get("query", {}).get("pages", []))


def by_search(q, limit=15):
    d = get(API, {"action": "query", "generator": "search", "gsrsearch": q, "gsrnamespace": 6, "gsrlimit": limit,
                  "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": 330, "iiextmetadatafilter": EM,
                  "format": "json", "formatversion": "2"})
    return info_from_pages(d.get("query", {}).get("pages", []))


def main():
    only = set(sys.argv[1].split(",")) if len(sys.argv) > 1 else None
    c = json.load(open(os.path.join(root, "candidates.json"), encoding="utf-8"))
    wd = json.load(open(os.path.join(root, "wikidata/entities.json"), encoding="utf-8"))["entities"]
    val = lambda e, p: [x["mainsnak"].get("datavalue", {}).get("value") for x in (e.get("claims", {}).get(p) or [])]
    outp = os.path.join(root, "photos/commons-candidates.json")
    out = json.load(open(outp, encoding="utf-8")) if (only and os.path.exists(outp)) else {"made": "2026-11-23", "api": API, "allowed_rule": ALLOWED.pattern, "places": {}, "foods": {}}
    for p in c["places"]:
        if p["group"] != "landmark" or (only and p["id"] not in only):
            continue
        e = wd.get(p["wikidata"] or "", {})
        files, seen = [], set()
        def add(lst, how):
            for f in lst:
                if f["title"] in seen:
                    continue
                seen.add(f["title"]); f["found_by"] = how; files.append(f)
        p18 = ["File:" + t for t in val(e, "P18")]
        if p18:
            add(by_titles(p18), "wikidata P18")
        for cat in val(e, "P373") + EXTRA_CATS.get(p["id"], []):
            add(by_cat(cat), "category:" + cat)
        for q in EXTRA_SEARCH.get(p["id"], []):
            add(by_search(q), "search:" + q)
        out["places"][p["id"]] = {"name_en": p["name_en"], "files": files}
        print(p["id"], p["name_en"], "all", len(files), "allowed", sum(f["allowed"] for f in files))
    for k, cats in FOOD.items():
        if only and ("food" not in only) and (k not in only):
            continue
        files, seen = [], set()
        for cat in cats:
            for f in by_cat(cat, 30):
                if f["title"] in seen:
                    continue
                seen.add(f["title"]); f["found_by"] = "category:" + cat; files.append(f)
        out["foods"][k] = {"files": files}
        print("food", k, "all", len(files), "allowed", sum(f["allowed"] for f in files))
    os.makedirs(os.path.join(root, "photos"), exist_ok=True)
    json.dump(out, open(outp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


main()
