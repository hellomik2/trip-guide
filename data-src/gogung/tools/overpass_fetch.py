"""Overpass 질의를 예절 지켜 보내고 원본을 저장한다.
쓰는 법: python -I overpass_fetch.py <이름> <질의파일> <저장경로> [서버주소,서버주소…] [최대 시도] [실패 뒤 쉬는 초]
- 질의 사이 10초 이상 (마지막 질의 시각을 log에서 읽음)
- 502/429/504 오면 정한 초(기본 60, 최소 60) 쉬고 다시, 서버를 번갈아
- 모든 시도를 osm/query-log.jsonl 에 남긴다 (합계 40번 안을 세기 위함)
"""
import sys, json, time, os, datetime
import requests

UA = "offline-travel-data-prep/0.1 (one-time open-data collection; python-requests)"
SERVERS = (sys.argv[4] if len(sys.argv) > 4 else "https://overpass-api.de/api/interpreter").split(",")
MAX_TRY = int(sys.argv[5]) if len(sys.argv) > 5 else 3
REST = int(sys.argv[6]) if len(sys.argv) > 6 else 60
here = os.path.dirname(os.path.abspath(__file__))
log_path = os.path.join(here, "..", "osm", "query-log.jsonl")

def last_time():
    if not os.path.exists(log_path):
        return 0
    t = 0
    with open(log_path, encoding="utf-8") as f:
        for line in f:
            try:
                t = max(t, json.loads(line)["end_epoch"])
            except Exception:
                pass
    return t

def count_attempts():
    if not os.path.exists(log_path):
        return 0
    with open(log_path, encoding="utf-8") as f:
        return sum(1 for l in f if l.strip())

name, qfile, out = sys.argv[1], sys.argv[2], sys.argv[3]
q = open(qfile, encoding="utf-8").read()
for attempt in range(MAX_TRY):
    URL = SERVERS[attempt % len(SERVERS)]
    n = count_attempts()
    if n >= 40:
        print("STOP: 40번에 닿음"); sys.exit(2)
    wait = 10.5 - (time.time() - last_time())
    if wait > 0:
        time.sleep(wait)
    t0 = time.time()
    status, size, err = None, 0, None
    try:
        r = requests.post(URL, data={"data": q}, headers={"User-Agent": UA}, timeout=200)
        status, size = r.status_code, len(r.content)
        if status == 200:
            with open(out, "wb") as f:
                f.write(r.content)
    except Exception as e:
        err = repr(e)
    t1 = time.time()
    rec = {"n": n + 1, "name": name, "server": URL, "attempt": attempt + 1, "status": status, "bytes": size,
           "error": err, "start": datetime.datetime.fromtimestamp(t0).isoformat(timespec="seconds"),
           "secs": round(t1 - t0, 1), "end_epoch": t1}
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(json.dumps(rec, ensure_ascii=False))
    if status == 200:
        sys.exit(0)
    if status in (429, 502, 503, 504) or err:
        if attempt + 1 < MAX_TRY:
            time.sleep(REST)
        continue
    sys.exit(1)
sys.exit(1)
