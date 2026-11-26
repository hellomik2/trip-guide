"""MediaWiki/Wikidata/Commons API를 한 번에 하나씩 부르는 작은 도우미.
모든 호출을 tools/../mw-log.jsonl 에 남긴다."""
import json, time, os, datetime, requests
UA = "offline-travel-data-prep/0.1 (one-time open-data collection for an offline travel guide; python-requests)"
here = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(here, "..", "mw-log.jsonl")
S = requests.Session()
S.headers.update({"User-Agent": UA, "Api-User-Agent": UA})
def get(url, params=None, raw=False, pause=0.3):
    for attempt in range(4):
        t0 = time.time()
        try:
            r = S.get(url, params=params, timeout=60)
            st = r.status_code
        except Exception as e:
            st = None; r = None
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": datetime.datetime.now().isoformat(timespec="seconds"), "url": url,
                                "params": {k: (v if len(str(v)) < 200 else str(v)[:200]+"…") for k, v in (params or {}).items()},
                                "status": st, "secs": round(time.time()-t0, 2)}, ensure_ascii=False) + "\n")
        if st == 200:
            time.sleep(pause)
            return r.content if raw else r.json()
        if st in (429, 503, 502, 504) or st is None:
            time.sleep(30 * (attempt + 1)); continue
        raise RuntimeError(f"HTTP {st} {url}")
    raise RuntimeError(f"failed {url}")
