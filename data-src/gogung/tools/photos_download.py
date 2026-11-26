"""photos/selection.json 에 고른 Commons 사진을 받아 긴 변 1280px 이하 JPEG로 저장하고 라이선스 표를 만든다.
Commons 썸네일 표준 너비(1280, 가로가 짧으면 960)로 받은 뒤 필요하면 PIL로 한 번 더 줄인다."""
import json, sys, os, io, re, time
sys.stdout.reconfigure(encoding="utf-8")
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.join(here, "..")
sys.path.insert(0, here)
from mw import get, S
from PIL import Image

API = "https://commons.wikimedia.org/w/api.php"
EM = "LicenseShortName|LicenseUrl|Artist|Credit|ImageDescription|DateTimeOriginal|AttributionRequired"
ALLOWED = re.compile(r"^(CC0|Public domain|PD|CC BY(-SA)? \d\.\d( [a-z]{2,3})?)$", re.I)
sel = json.load(open(os.path.join(root, "photos/selection.json"), encoding="utf-8"))
outdir = os.path.join(root, "photos/img"); os.makedirs(outdir, exist_ok=True)


def strip(s):
    import html
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


jobs = []
for pid, lst in sel["landmarks"].items():
    for n, it in enumerate(lst, 1):
        jobs.append((f"{pid}-{n}.jpg", it["title"], "landmark", [pid], it.get("why", "")))
for ftype, lst in sel["foods"].items():
    for n, it in enumerate(lst, 1):
        jobs.append((f"food-{ftype}.jpg", it["title"], "food type", it["used_by"], it.get("why", "")))
for pid, lst in sel["restaurant_real"].items():
    for n, it in enumerate(lst, 1):
        jobs.append((f"{pid}-real-{n}.jpg", it["title"], "restaurant (real)", [pid], it.get("why", "")))

rows = []
for local, title, kind, used_by, why in jobs:
    d = get(API, {"action": "query", "titles": title, "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata",
                  "iiextmetadatafilter": EM, "format": "json", "formatversion": "2"})
    p = d["query"]["pages"][0]; ii = p["imageinfo"][0]; em = ii["extmetadata"]
    g = lambda k: strip((em.get(k) or {}).get("value"))
    lic = re.sub(r"\s+", " ", g("LicenseShortName"))
    if not ALLOWED.match(lic):
        print("SKIP license", title, lic); continue
    w, h = ii["width"], ii["height"]
    tw = 1280 if w >= h else 960
    if w <= tw:
        url = ii["url"]
    else:
        d2 = get(API, {"action": "query", "titles": title, "prop": "imageinfo", "iiprop": "url", "iiurlwidth": tw,
                       "format": "json", "formatversion": "2"})
        url = d2["query"]["pages"][0]["imageinfo"][0]["thumburl"]
    r = S.get(url, timeout=120); time.sleep(0.5)
    if r.status_code != 200:
        print("FAIL", r.status_code, title); continue
    im = Image.open(io.BytesIO(r.content)).convert("RGB")
    im.thumbnail((1280, 1280))
    im.save(os.path.join(outdir, local), "JPEG", quality=85, optimize=True)
    rows.append({"file": "img/" + local, "kind": kind, "used_by": used_by, "commons_title": title,
                 "commons_page": ii["descriptionurl"], "author": g("Artist") or g("Credit"), "credit": g("Credit"),
                 "license": lic, "license_url": g("LicenseUrl") or None, "date_taken": g("DateTimeOriginal")[:19],
                 "original_size": f"{w}x{h}", "saved_size": f"{im.width}x{im.height}",
                 "bytes": os.path.getsize(os.path.join(outdir, local)), "why": why})
    print(local, lic, im.size, rows[-1]["bytes"])

json.dump({"made": "2026-11-23", "source": "Wikimedia Commons", "rows": rows},
          open(os.path.join(root, "photos/licenses.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
with open(os.path.join(root, "photos/licenses.md"), "w", encoding="utf-8") as f:
    f.write("# 사진 라이선스 표 (Wikimedia Commons, 2026-11-23 받음)\n\n")
    f.write("| 파일 | 쓰는 곳 | Commons 파일 이름 | 저자 | 라이선스 | 출처 주소 |\n|---|---|---|---|---|---|\n")
    for r_ in rows:
        a = r_["author"].replace("|", "/").replace("\n", " ")[:80]
        f.write(f"| {r_['file']} | {', '.join(r_['used_by'])} | {r_['commons_title'][5:]} | {a} | {r_['license']} | {r_['commons_page']} |\n")
total = sum(r_["bytes"] for r_ in rows)
print("photos", len(rows), "total bytes", total)
