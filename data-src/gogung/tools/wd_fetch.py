"""Wikidata 항목을 50개씩 받아 필요한 칸만 원문 그대로 남긴다. 쓰는 법: python -I wd_fetch.py <qid목록파일> <저장경로>"""
import json, sys, os, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mw import get
qids = [q.strip() for q in open(sys.argv[1], encoding="utf-8").read().split() if q.strip().startswith("Q")]
qids = list(dict.fromkeys(qids))
KEEP = ["P31", "P18", "P373", "P625", "P571", "P1435", "P856", "P131", "P1448", "P149", "P84", "P3311", "P8517", "P1442", "P2044", "P5775", "P8592", "P1766"]
out = {"source": "https://www.wikidata.org/ (CC0)", "fetched": datetime.date.today().isoformat(), "entities": {}}
if os.path.exists(sys.argv[2]):
    out = json.load(open(sys.argv[2], encoding="utf-8"))
todo = [q for q in qids if q not in out["entities"]]
for i in range(0, len(todo), 50):
    chunk = todo[i:i+50]
    d = get("https://www.wikidata.org/w/api.php", {"action": "wbgetentities", "ids": "|".join(chunk), "format": "json",
            "props": "labels|descriptions|aliases|claims|sitelinks/urls|info", "languages": "en|ko", "sitefilter": "enwiki|kowiki|commonswiki|enwikivoyage"})
    for q, e in d.get("entities", {}).items():
        if "missing" in e:
            out["entities"][q] = {"missing": True}; continue
        claims = {p: e.get("claims", {}).get(p) for p in KEEP if p in e.get("claims", {})}
        out["entities"][q] = {"id": q, "lastrevid": e.get("lastrevid"), "modified": e.get("modified"),
            "labels": e.get("labels", {}), "descriptions": e.get("descriptions", {}), "aliases": e.get("aliases", {}),
            "sitelinks": e.get("sitelinks", {}), "claims": claims}
json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(out["entities"]), "entities")
