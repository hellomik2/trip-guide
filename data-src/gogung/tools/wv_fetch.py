import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mw import get
out = sys.argv[1]
d = get("https://en.wikivoyage.org/w/api.php", {"action": "query", "prop": "revisions|info", "titles": "Seoul/Jongno",
        "rvprop": "ids|timestamp|content", "rvslots": "main", "inprop": "url", "format": "json", "formatversion": "2"})
p = d["query"]["pages"][0]
rev = p["revisions"][0]
meta = {"title": p["title"], "pageid": p["pageid"], "url": p["fullurl"], "revid": rev["revid"], "rev_timestamp": rev["timestamp"],
        "permalink": f"https://en.wikivoyage.org/w/index.php?title=Seoul/Jongno&oldid={rev['revid']}",
        "license": "CC BY-SA 4.0", "fetched": __import__("datetime").date.today().isoformat()}
open(os.path.join(out, "seoul-jongno.wikitext"), "w", encoding="utf-8").write(rev["slots"]["main"]["content"])
json.dump(meta, open(os.path.join(out, "seoul-jongno.meta.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps(meta, ensure_ascii=False)); print(len(rev["slots"]["main"]["content"]), "chars")
