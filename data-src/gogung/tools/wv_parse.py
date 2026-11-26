"""Wikivoyage 원문(wikitext)에서 항목 틀({{see}}, {{eat}} …)을 항목 단위로 꺼낸다.
글자는 고치지 않고 틀 칸 값 그대로 둔다. 좌표로 범위 안/밖을 표시한다."""
import json, re, sys, os
src, meta_p, out = sys.argv[1], sys.argv[2], sys.argv[3]
S, W, N, E = 37.5705, 126.9730, 37.5860, 126.9910   # data-src/gogung/bbox.json 과 같음
txt = open(src, encoding="utf-8").read()
meta = json.load(open(meta_p, encoding="utf-8"))
KINDS = ("see", "do", "buy", "eat", "drink", "sleep", "listing", "go")

def end_of_template(s, i):
    depth = 0; j = i
    while j < len(s):
        if s.startswith("{{", j): depth += 1; j += 2; continue
        if s.startswith("}}", j):
            depth -= 1; j += 2
            if depth == 0: return j
            continue
        j += 1
    return -1

def split_top(body):
    parts, cur, d1, d2, j = [], [], 0, 0, 0
    while j < len(body):
        if body.startswith("{{", j): d1 += 1; cur.append("{{"); j += 2; continue
        if body.startswith("}}", j): d1 -= 1; cur.append("}}"); j += 2; continue
        if body.startswith("[[", j): d2 += 1; cur.append("[["); j += 2; continue
        if body.startswith("]]", j): d2 -= 1; cur.append("]]"); j += 2; continue
        c = body[j]
        if c == "|" and d1 == 0 and d2 == 0:
            parts.append("".join(cur)); cur = []
        else:
            cur.append(c)
        j += 1
    parts.append("".join(cur)); return parts

# 절 위치
heads = [(m.start(), len(m.group(1)), m.group(2).strip()) for m in re.finditer(r"^(={2,4})\s*(.*?)\s*\1\s*$", txt, re.M)]
def section_at(pos):
    path = {}
    for st, lvl, name in heads:
        if st > pos: break
        path[lvl] = name
        for k in list(path):
            if k > lvl: del path[k]
    return " / ".join(path[k] for k in sorted(path))

items = []
for m in re.finditer(r"\{\{\s*(" + "|".join(KINDS) + r")\s*\|", txt, re.I):
    st = m.start(); en = end_of_template(txt, st)
    if en < 0: continue
    raw = txt[st:en]
    parts = split_top(raw[2:-2])
    kind = parts[0].strip().lower()
    fields = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1); fields[k.strip()] = v.strip()
    def num(x):
        try: return float(fields.get(x, "").strip())
        except: return None
    lat, lon = num("lat"), num("long")
    inb = None if lat is None or lon is None else (S <= lat <= N and W <= lon <= E)
    line = txt.count("\n", 0, st) + 1
    items.append({"kind": kind, "type": fields.get("type", ""), "name": fields.get("name", ""), "alt": fields.get("alt", ""),
                  "section": section_at(st), "line": line, "lat": lat, "lon": lon, "in_bbox": inb,
                  "fields": fields, "raw": raw})
res = {"source": {k: meta[k] for k in ("title", "url", "revid", "rev_timestamp", "permalink", "license", "fetched")},
       "bbox": {"south": S, "west": W, "north": N, "east": E},
       "count_all": len(items), "count_in_bbox": sum(1 for i in items if i["in_bbox"]),
       "count_no_coords": sum(1 for i in items if i["in_bbox"] is None), "items": items}
json.dump(res, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
from collections import Counter
print("all", len(items), "in", res["count_in_bbox"], "nocoord", res["count_no_coords"])
print(Counter((i["kind"], i["in_bbox"]) for i in items))
for i in items:
    if i["in_bbox"]: print(i["kind"], "|", i["name"], "|", i["lat"], i["lon"], "|", i["section"])
print("--- no coords")
for i in items:
    if i["in_bbox"] is None: print(i["kind"], "|", i["name"], "|", i["section"])
