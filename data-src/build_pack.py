# Build the app's travel pack (trip-pack/2) from one area's raw data folder.
#
#   python -I data-src/build_pack.py gogung
#
# Reads  data-src/<area>/  (candidates.json, hours/, landmarks-describe.json, walks.json, photos/, osm/ways-raw.json, wikidata/, wikivoyage/)
# Writes app/packs/<pack id>/pack.json, app/packs/<pack id>/img/*.jpg (smaller copies), app/packs/index.json,
#        and data-src/<area>/build-report.json (what was dropped or could not be read, and counts).
#
# Nothing is invented here: every value comes from a raw file. Where a raw value is missing the pack says so
# (hours status "unknown"), and a source that disagrees with another is kept as a "conflict" text.
# Run it again after editing the raw files; the pack and photos are rebuilt from scratch each time.
import hashlib
import json
import math
import re
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageOps

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
AREAS = {
    'gogung': {
        'id': 'seoul-gogung',
        'title': 'Seoul: Gyeongbokgung, Bukchon and Insa-dong',
        'city': 'Seoul',
        'area': 'Gyeongbokgung, Bukchon and Insa-dong (Jongno-gu)',
        'country': 'South Korea',
    },
}
PHOTO_EDGE = 720      # longest edge of the copies kept in the pack (the raw copies are 1280)
PHOTO_QUALITY = 74


def load(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))


def dump(p, data, compact=False):
    Path(p).parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, separators=(',', ':')) if compact else json.dumps(data, ensure_ascii=False, indent=1)
    Path(p).write_text(text + '\n', encoding='utf-8')


# ---------------------------------------------------------------- text helpers
def clean_wiki(s):
    if not s:
        return ''
    s = re.sub(r'<ref[^>]*>.*?</ref>', '', s, flags=re.S)
    s = re.sub(r'<[^>]+>', '', s)
    s = re.sub(r'\{\{[^{}]*\}\}', '', s)
    s = re.sub(r"'{2,}", '', s)
    s = re.sub(r'\[\[(?:[^\]|]*\|)?([^\]]+)\]\]', r'\1', s)
    s = re.sub(r'\[https?://\S+ ([^\]]+)\]', r'\1', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def sentences(s):
    s = s.replace('e.g.', 'e_g_').replace('i.e.', 'i_e_').replace('St.', 'St_')
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z0-9"(])', s)
    return [p.replace('e_g_', 'e.g.').replace('i_e_', 'i.e.').replace('St_', 'St.').strip() for p in parts if p.strip()]


def first_sentences(s, max_chars=260):
    out = ''
    for sent in sentences(s):
        if out and len(out) + 1 + len(sent) > max_chars:
            break
        out = f'{out} {sent}'.strip()
        if len(out) >= max_chars:
            break
    return out


# Sentences in the raw notes that are about the data itself, not for a traveller.
DATA_TALK = re.compile(r'\b(OSM|OpenStreetMap|Wikidata|Wikivoyage|Commons|name:en|node|relation|way\b|tag|typo|spell|spelled|written by us|'
                       r'shortened|corrected|added after|found by|Duplicate|copy|Location|search|needs? check|items? describe|'
                       r'cuisine tag|Picked|n\d{6,}|w\d{6,}|r\d{6,}|Q\d{3,})', re.I)


# Sentences of a place's source text that are about another site than the place. They are left out of "about" and
# written to the build report. Wikivoyage lists MMCA Seoul with a first sentence about the main museum in Gwacheon,
# another city, so answers about MMCA Seoul mixed the two.
OTHER_SITE = {
    'L14': [(re.compile(r'^MMCA is mainly located at the Gwacheon\b'), 'about the main MMCA museum in Gwacheon (another city), not MMCA Seoul')],
}


# Words of a source sentence that are plainly wrong: cut out (the sentence is kept, shorter) and written to the build report.
# Wikivoyage puts Tapgol Park "just to the east of Jongmyo Shrine"; its own listings place Jongmyo Shrine about 500 m east of the park.
WRONG_CLAUSE = {
    'L28': [(', just to the east of Jongmyo Shrine', 'wrong direction: the Wikivoyage listings place Jongmyo Shrine east of Tapgol Park (lon 126.993889 against 126.98824)')],
}


def without_other_site(pid, text, report):
    for pat, why in OTHER_SITE.get(pid, []):
        drop = [s for s in sentences(text) if pat.search(s)]
        if drop:
            text = ' '.join(s for s in sentences(text) if not pat.search(s))
            report['dropped_text'].append({'place': pid, 'text': drop, 'why': why})
    for clause, why in WRONG_CLAUSE.get(pid, []):
        if clause in text:
            report['changed_text'].append({'place': pid, 'about': text, 'now': text.replace(clause, ''), 'why': why})
            text = text.replace(clause, '')
    return text


def traveller_note(note):
    keep = [s for s in sentences(note or '') if not DATA_TALK.search(s)]
    return ' '.join(keep).strip()


# ---------------------------------------------------------------- hours
MONTH = {m: i + 1 for i, m in enumerate(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'])}
MONTH.update({k[:3]: v for k, v in list(MONTH.items())})
DAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
DAY_WORD = {'mon': 'mon', 'monday': 'mon', 'mondays': 'mon', 'mo': 'mon', 'tue': 'tue', 'tuesday': 'tue', 'tuesdays': 'tue', 'tu': 'tue',
            'wed': 'wed', 'wednesday': 'wed', 'wednesdays': 'wed', 'we': 'wed', 'thu': 'thu', 'thursday': 'thu', 'thursdays': 'thu', 'th': 'thu',
            'fri': 'fri', 'friday': 'fri', 'fridays': 'fri', 'fr': 'fri', 'sat': 'sat', 'saturday': 'sat', 'saturdays': 'sat', 'sa': 'sat',
            'sun': 'sun', 'sunday': 'sun', 'sundays': 'sun', 'su': 'sun'}
SPAN = re.compile(r'(\d{1,2}):(\d{2})\s*(?:-|–|to)\s*(\d{1,2}):(\d{2})')


def month_range(a, b):
    out = [a]
    while out[-1] != b:
        out.append(out[-1] % 12 + 1)
    return out


def months_of(text):
    """'January through February', 'February - May / September - October', 'Fridays, April - November' -> [months]."""
    text = re.sub(r'\([^)]*\)', '', text).lower()
    found = []
    for part in text.split('/'):
        ms = [MONTH[w] for w in re.findall(r'[a-z]+', part) if w in MONTH]
        if len(ms) >= 2:
            found += month_range(ms[0], ms[1])
        elif len(ms) == 1:
            found.append(ms[0])
    return sorted(set(found)) or None


def day_range(a, b):
    i, j = DAY.index(a), DAY.index(b)
    out = [DAY[i]]
    while DAY[i] != DAY[j]:
        i = (i + 1) % 7
        out.append(DAY[i])
    return out


def days_of(text):
    """'Mon-Fri, Sun', 'Tue-Sun (weekdays and weekends)', 'every day', 'Fr-We', 'Sa Su', 'Fridays' -> [days] or None."""
    t = re.sub(r'\([^)]*\)', '', text).lower()
    if re.search(r'every ?day|daily|mo-su', t):
        return list(DAY)
    out = []
    for a, b in re.findall(r'\b([a-z]{2,9})\s*-\s*([a-z]{2,9})\b', t):
        if a in DAY_WORD and b in DAY_WORD:
            out += day_range(DAY_WORD[a], DAY_WORD[b])
    t2 = re.sub(r'\b([a-z]{2,9})\s*-\s*([a-z]{2,9})\b', ' ', t)
    for w in re.findall(r'[a-z]+', t2):
        if w in DAY_WORD:
            out.append(DAY_WORD[w])
    return [d for d in DAY if d in out] or None


def spans_of(text):
    return [f'{int(a):02d}:{b}-{int(c):02d}:{d}' for a, b, c, d in SPAN.findall(text)]


def closed_of(text):
    """Weekly closing days and fixed dates in an official 'closed' text. The text itself is kept as written too."""
    if not text:
        return None
    t = text.lower()
    days = []
    for m in re.finditer(r'(?:closed (?:on |every )?|every )(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)', t):
        before = t[max(0, m.start() - 12):m.start()]
        if 'last' in before:
            continue
        days.append(DAY_WORD[m.group(1)])
    nth = [{'n': 'last', 'day': DAY_WORD[m.group(1)]} for m in re.finditer(r'last (monday|tuesday|wednesday|thursday|friday|saturday|sunday) of every month', t)]
    dates = []
    for m in re.finditer(r'\b(january|february|march|april|may|june|july|august|september|october|november|december|jan\.?|dec\.?)\s*(\d{1,2})(?:st|nd|rd|th)?\b', t):
        mon = MONTH[m.group(1).rstrip('.')[:3]]
        day = int(m.group(2))
        # Only fixed public holidays are read as dates. Lunar holidays (Seollal, Chuseok) move every year and stay as text,
        # so a date followed by "(Seollal)" or "(Chuseok)" is not read.
        near = t[m.end():m.end() + 14]
        if re.match(r'\s*\((?:[^)]*)(seollal|chuseok|lunar|temporary)', near):
            continue
        if (mon, day) in [(1, 1), (12, 25)]:
            dates.append(f'{mon:02d}-{day:02d}')
    out = {'text': text}
    if days:
        out['days'] = sorted(set(days), key=DAY.index)
    if nth:
        out['nth'] = nth
    if dates:
        out['dates'] = sorted(set(dates))
    if re.search(r'seollal|chuseok|lunar new year', t):
        out['lunar'] = True
    return out


def rule(open_spans, months=None, days=None, last=None, nth=None, note=None):
    r = {'open': open_spans}
    if months and len(months) < 12:
        r['months'] = months
    if days and len(days) < 7:
        r['days'] = days
    if nth:
        r['nth'] = nth
    if last:
        r['last'] = last
    if note:
        r['note'] = note
    return r


def official_rules(official, report, pid):
    rules = []
    for h in official.get('hours') or []:
        spans = spans_of(h.get('open', ''))
        if not spans:
            report['hours_unread'].append({'place': pid, 'text': h})
            continue
        last = h.get('last_admission')
        if h.get('area') and h['area'] != 'Palace Building Area':
            continue  # Changdeokgung: the Secret Garden has its own hours; they stay in the note
        period, days_txt = h.get('period'), h.get('days')
        months = months_of(period) if period else None
        days = days_of(period) if period and days_of(period) else None
        nth = None
        if days_txt:
            if re.search(r'culture day|last wednesday', days_txt, re.I):
                nth, days = 'last', ['wed']
            else:
                days = days_of(days_txt)
                if days is None:
                    report['hours_unread'].append({'place': pid, 'text': h})
                    continue
        rules.append(rule(spans, months, days, last, nth))
    return rules


# Opening facts that the official pages give only inside a free-text note. Each entry repeats the note it reads,
# so a changed note shows up in the build report instead of silently keeping an old rule.
NOTE_RULES = {
    'L09': ('Wednesday 09:00-20:00 (entrance until 19:00)', [rule(['09:00-20:00'], months_of('March to October'), ['wed'], '19:00')]),
    'L20': ('In August, weekend (Fri, Sat) night opening until 20:00 (as written on the page).', [rule(['09:00-20:00'], [8], ['fri', 'sat'])]),
    'L21': ('Open until 21:00 on Fridays. Craft Archives special exhibitions open only Tue-Fri.', [rule(['10:00-21:00'], None, ['fri'])]),
}


def osm_rules(text):
    """OpenStreetMap opening_hours in the simple forms found here ('Mo-Su 10:00-22:00', 'Fr-We 11:30-16:00, 17:00-21:00',
    'Jan-Feb,Nov-Dec 09:00-17:00; ...', '11:00-21:00'). Days not named are closed (OSM rule)."""
    rules = []
    for part in [p.strip() for p in text.split(';') if p.strip()]:
        spans = spans_of(part)
        head = SPAN.sub('', part).strip(' ,')
        if not spans:
            return None
        months = None
        days = list(DAY)
        if head:
            words = re.findall(r'[A-Za-z]+', head)
            if all(w.lower()[:3] in MONTH for w in words):
                months = sorted(set(sum([month_range(MONTH[a.lower()[:3]], MONTH[b.lower()[:3]]) for a, b in re.findall(r'([A-Za-z]{3})-([A-Za-z]{3})', head)], [])))
            else:
                days = days_of(head)
                if days is None:
                    return None
        rules.append(rule(spans, months, days))
    return rules


def wikivoyage_rules(text):
    """Wikivoyage 'hours' as written. Without day names the source does not say on which days, so daysStated is false."""
    t = text.strip()
    parts = re.split(r',\s*(?=[A-Z][a-z])', t)
    rules = []
    stated = False
    for part in parts:
        spans = spans_of(part)
        if not spans:
            return None, False
        head = SPAN.sub('', part).strip(' ,')
        if head:
            d = days_of(head)
            if d is None:
                return None, False
            stated = True
            rules.append(rule(spans, None, d))
        else:
            rules.append(rule(spans))
    return rules, stated


SRC_NAME = {'official': 'official website', 'official-inside': 'official website of Gyeongbokgung Palace', 'osm': 'OpenStreetMap', 'wikivoyage': 'Wikivoyage'}


def build_hours(pid, h, report):
    status = h['status']
    out = {'status': status}
    off = h.get('official')
    if status in ('official', 'official-inside') and off:
        out['rules'] = official_rules(off, report, pid)
        if pid in NOTE_RULES:
            expect, extra = NOTE_RULES[pid]
            notes = [x.get('note', '') for x in off.get('hours') or []]
            if expect in notes:
                out['rules'] += extra
            else:
                report['hours_note_changed'].append(pid)
        if off.get('closed'):
            out['closed'] = closed_of(off['closed'])
        out['source'] = {'name': off.get('publisher'), 'url': off.get('source_url'), 'read': off.get('read_date')}
        notes = [x['note'] for x in off.get('hours') or [] if x.get('note') and not (pid in NOTE_RULES and x['note'] == NOTE_RULES[pid][0])]
        if pid == 'L23':
            garden = [x for x in off.get('hours') or [] if x.get('area') == 'Secret Garden']
            notes.append('Secret Garden (separate ticket area): ' + '; '.join(f"{x['period']} {x['open']}" for x in garden) + '.')
        if notes:
            out['note'] = ' '.join(notes)
        if status == 'official-inside':
            out['inside'] = h.get('official_of')
        if 'Red Zone' in (out.get('note') or ''):
            out['visit'] = True  # tourist visiting hours of the lanes, not the opening hours of a building
        if not out['rules']:
            out['status'] = 'unknown'
            report['hours_unread'].append({'place': pid, 'why': 'official page read but no rule could be read'})
    elif status == 'osm':
        rules = osm_rules(h['osm_opening_hours'])
        if rules is None:
            report['hours_unread'].append({'place': pid, 'text': h['osm_opening_hours']})
            out = {'status': 'unknown', 'text': h['osm_opening_hours']}
        else:
            out.update({'rules': rules, 'text': h['osm_opening_hours'], 'daysStated': True})
        out['source'] = {'name': 'OpenStreetMap', 'url': None, 'read': '2026-11-23'}
    elif status == 'wikivoyage':
        rules, stated = wikivoyage_rules(h['wikivoyage_hours'])
        if rules is None:
            report['hours_unread'].append({'place': pid, 'text': h['wikivoyage_hours']})
            out = {'status': 'unknown', 'text': h['wikivoyage_hours']}
        else:
            out.update({'rules': rules, 'text': h['wikivoyage_hours'], 'daysStated': stated})
        out['source'] = {'name': 'Wikivoyage (Seoul/Jongno)', 'url': None, 'read': '2026-11-23'}
    elif status == 'outdoor':
        pass
    else:
        out = {'status': 'unknown'}
        # "traveller_note" is the sentence a traveller sees; "hours_note" is the research record of how the
        # hours were looked for. The Korean marker for "unknown" is dropped from a research note used as it is.
        if off and off.get('traveller_note'):
            out['note'] = off['traveller_note']
        elif off and off.get('hours_note'):
            out['note'] = off['hours_note'].replace(' 모름.', '').replace('모름. ', '').replace('모름', '').strip()
    if h.get('conflict'):
        out['conflict'] = h['conflict']
    return out


def build_events(h):
    ev = []
    for src in [h.get('official') or {}, h.get('events') or {}]:
        for e in src.get('events') or []:
            ev.append({k: v for k, v in e.items() if k in ('name', 'when', 'note')})
    if h.get('events') and h['events'].get('note'):
        ev.append({'name': 'About these times', 'when': '', 'note': h['events']['note']})
    return ev


def price_of(cand, h):
    off = h.get('official') or {}
    if off.get('fee'):
        return {'text': off['fee'], 'from': 'official website'}
    wv = (cand.get('wikivoyage') or {}).get('price')
    if wv:
        return {'text': wv, 'from': 'Wikivoyage'}
    return None


# ---------------------------------------------------------------- kinds and food
KIND = {
    'landmark': 'sight', 'restaurant': 'restaurant', 'bakery cafe': 'cafe', 'teahouse': 'cafe', 'snack bar': 'restaurant', 'street snack': 'restaurant',
    'subway exit': 'station', 'tourist information': 'info', 'toilets': 'toilet', 'pharmacy': 'pharmacy', 'atm': 'atm',
}
DISH = {
    'seolleongtang': 'seolleongtang', 'manduguk': 'manduguk (dumpling soup)', 'mandu': 'mandu (dumplings)', 'mandu-jeongol': 'mandu jeongol (dumpling hot pot)',
    'sujebi': 'sujebi (hand-torn noodle soup)', 'hamburg-steak': 'hamburg steak', 'kalguksu': 'kalguksu (noodle soup)', 'dwaeji-gukbap': 'dwaeji gukbap (pork and rice soup)',
    'memil-guksu': 'buckwheat noodles', 'salt-bread': 'salt bread', 'dak-hanmari': 'dak hanmari (chicken soup)', 'tteokbokki': 'tteokbokki (rice cakes)',
    'bunsik': 'Korean snacks (bunsik)', 'samgyeopsal': 'Korean barbecue (pork belly)', 'korean-vegetarian': 'Korean vegetarian table', 'korean-tea': 'Korean traditional tea',
    'hotteok': 'hotteok (filled pancake)',
}
# Words a traveller may use for food; a place gets the word when its own texts (Wikivoyage, OSM cuisine, the dish of its photo) contain one of the patterns.
SERVES = {
    'noodles': r'noodle|guksu|kalguksu|myeon|ramen|sujebi|naengmyeon',
    'dumplings': r'dumpling|mandu',
    'soup': r'soup|tang\b|seolleongtang|gukbap|sujebi|hot ?pot|jeongol|stew|hanmari',
    'beef': r'\bbeef|\box\b|seolleongtang',
    'pork': r'\bpork|dwaeji|samgyeopsal|cutlet',
    'chicken': r'chicken|\bdak\b',
    'barbecue': r'barbecue|bbq|grill|samgyeopsal',
    'vegetarian': r'vegetarian|vegetable_cuisine|vegetable cuisine|temple food',
    'tea': r'\btea\b|teahouse|\bcha\b|omija|jujube|yuja',
    'coffee': r'\b(?:coffee|americano|latte|espresso)\b',
    'bread': r'bread|bakery|salt bread',
    'dessert': r'dessert|bingsu|shaved ice|hotteok|yakgwa',
    'snacks': r'snack|bunsik|tteokbokki|street food|hotteok|rice cake',
    'rice cakes': r'\btteok|rice cake',
    'breakfast': r'breakfast',
}


def kr_phone(raw, report, pid):
    # keep a phone number only if its digits make a Korean number (area 2 + 7-8 digits, other areas 2 digits + 7-8,
    # mobile 1x + 7-8); a number without "+" or "0" gets the "+82" form. Digits are never changed.
    digits = re.sub(r'\D', '', raw or '')
    if digits.startswith('82'):
        rest = digits[2:]
        rest = rest[1:] if rest.startswith('0') else rest
    elif digits.startswith('0'):
        rest = digits[1:]
    else:
        rest = ''
    ok = bool(re.fullmatch(r'2\d{7,8}|[3-6]\d\d{7,8}|1\d\d{7,8}', rest))
    if not ok:
        report['dropped_text'].append({'place': pid, 'phone': raw, 'why': 'digits do not make a Korean phone number'})
        return None
    if raw.strip().startswith(('+', '0')):
        return raw.strip()
    area = rest[:1] if rest.startswith('2') else rest[:2]
    num = rest[len(area):]
    formatted = f'+82 {area}-{num[:-4]}-{num[-4:]}'
    report['changed_text'].append({'place': pid, 'phone': raw, 'now': formatted, 'why': 'same digits, written with the country code'})
    return formatted


def transit_of(raw, report, pid):
    t = clean_wiki(raw)
    if not t:
        return None
    # "84m from" lost its station; such a cut text says nothing
    if len(t) < 12 or re.search(r'\b(from|to|of|at|near)\s*$', t, re.I):
        report['dropped_text'].append({'place': pid, 'transit': t, 'why': 'cut short in the source'})
        return None
    # line numbers in one listing disagree with the station listings (Gwanghwamun is line 5, the text says 2): drop the line numbers only
    t2 = re.sub(r',\s*Line No\.\s*\d+', '', t)
    if t2 != t:
        report['changed_text'].append({'place': pid, 'transit': t, 'now': t2, 'why': 'line numbers removed (one disagrees with the station listings)'})
    return t2


def serves_of(texts):
    t = ' '.join(texts).lower()
    return [k for k, pat in SERVES.items() if re.search(pat, t)]


# ---------------------------------------------------------------- walking network
WALK_HW = {'footway', 'pedestrian', 'steps', 'path', 'living_street', 'residential', 'service', 'tertiary', 'tertiary_link',
           'secondary', 'secondary_link', 'primary', 'primary_link', 'unclassified', 'track'}
FOOT_OK = {'yes', 'designated', 'permissive'}


def walkable(t):
    hw = t.get('highway')
    foot = t.get('foot')
    if foot == 'no':
        return False, 'foot=no'
    if hw == 'cycleway':
        return (foot in FOOT_OK), 'cycleway'
    if hw not in WALK_HW:
        return False, f'highway={hw}'
    if t.get('access') in ('no', 'private', 'permit') and foot not in FOOT_OK:
        return False, f"access={t.get('access')}"
    if t.get('indoor') == 'yes':
        return False, 'indoor'
    if '폐쇄' in (t.get('name') or ''):  # the Korean word for "closed" in a way name
        return False, 'closed'
    return True, None


def hav(a, b):
    R = 6371000.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(min(1, math.sqrt(h)))


def build_net(ways_raw, report):
    ways, node_xy, edges = [], {}, []
    dropped = {}
    for w in ways_raw:
        t = w.get('tags', {})
        ok, why = walkable(t)
        if not ok:
            dropped[why] = dropped.get(why, 0) + 1
            continue
        meta = {'h': t['highway']}
        if t.get('name:en'):
            meta['n'] = t['name:en'][0].upper() + t['name:en'][1:]
        if t.get('name:ko') or t.get('name'):
            meta['k'] = t.get('name:ko') or t.get('name')
        if t.get('fee') == 'yes':
            meta['fee'] = 1
        if t.get('footway') == 'crossing' or t.get('crossing'):
            meta['x'] = 1
        if t.get('footway') == 'sidewalk':
            meta['sw'] = 1
        if t.get('area') == 'yes':
            meta['area'] = 1
        if t.get('tunnel') in ('yes', 'building_passage') or (t.get('layer') or '').startswith('-'):
            meta['tun'] = t.get('tunnel') or 'yes'
        if t.get('bridge') == 'yes':
            meta['br'] = 1
        wi = len(ways)
        ways.append(meta)
        for nid, g in zip(w['nodes'], w['geometry']):
            node_xy[nid] = (g['lat'], g['lon'])
        for a, b in zip(w['nodes'], w['nodes'][1:]):
            if a != b:
                edges.append((a, b, wi))
    report['net_dropped_ways'] = dropped
    # keep the largest connected part only
    adj = {}
    for a, b, _ in edges:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    seen, parts = set(), []
    for n in adj:
        if n in seen:
            continue
        stack, comp = [n], []
        seen.add(n)
        while stack:
            x = stack.pop()
            comp.append(x)
            for y in adj[x]:
                if y not in seen:
                    seen.add(y)
                    stack.append(y)
        parts.append(comp)
    parts.sort(key=len, reverse=True)
    main = set(parts[0])
    report['net_parts'] = {'kept_nodes': len(parts[0]), 'other_parts': len(parts) - 1, 'other_nodes': sum(len(p) for p in parts[1:])}
    order = sorted(main)
    index = {n: i for i, n in enumerate(order)}
    nodes = []
    for n in order:
        la, lo = node_xy[n]
        nodes += [round(la * 1e6), round(lo * 1e6)]
    flat = []
    total = 0.0
    used_ways = set()
    pair = {}
    for a, b, wi in edges:
        if a in main and b in main:
            k = (min(a, b), max(a, b))
            if k in pair:
                if not ways[pair[k]].get('n') and ways[wi].get('n'):
                    pair[k] = wi
                continue
            pair[k] = wi
    report['net_parallel_dropped'] = len([1 for a, b, wi in edges if a in main and b in main]) - len(pair)
    for a, b, wi in edges:
        if a in main and b in main:
            k = (min(a, b), max(a, b))
            if pair.get(k) != wi:
                continue
            pair[k] = None
            d = hav(node_xy[a], node_xy[b])
            total += d
            flat += [index[a], index[b], wi, max(1, round(d * 10))]
            used_ways.add(wi)
    report['net'] = {'ways_kept': len(used_ways), 'nodes': len(order), 'edges': len(flat) // 4, 'length_km': round(total / 1000, 1)}
    return {'nodes': nodes, 'edges': flat, 'ways': ways, 'unit': {'nodes': 'lat,lon x 1e6 (flat)', 'edges': 'a,b,wayIndex,length in decimetres (flat)'}}, [node_xy[n] for n in order]


def snap(places, coords, net):
    # nearest network node; nodes on a fee (ticketed) way are only used for places that are themselves inside a ticketed area
    fee_nodes = set()
    e = net['edges']
    for i in range(0, len(e), 4):
        if net['ways'][e[i + 2]].get('fee'):
            fee_nodes.add(e[i])
            fee_nodes.add(e[i + 1])
    for p in places:
        best, bd, best_any, bd_any = None, 1e9, None, 1e9
        for i, c in enumerate(coords):
            d = hav((p['lat'], p['lon']), c)
            if d < bd_any:
                best_any, bd_any = i, d
            if i not in fee_nodes and d < bd:
                best, bd = i, d
        inside = p.get('_inside_fee')
        if inside or best is None or bd > bd_any + 60:
            best, bd = best_any, bd_any
        p['node'] = best
        p['snapM'] = round(bd)


# ---------------------------------------------------------------- photos
def build_photos(area_dir, out_dir, report):
    rows = load(area_dir / 'photos' / 'licenses.json')['rows']
    img_out = out_dir / 'img'
    if img_out.exists():
        shutil.rmtree(img_out)
    img_out.mkdir(parents=True)
    photos = []
    total = 0
    for r in rows:
        src = area_dir / 'photos' / r['file']
        if not src.exists():
            report['photos_missing'].append(r['file'])
            continue
        stem = Path(r['file']).stem
        kind = 'landmark' if r['kind'] == 'landmark' else 'real' if 'real' in r['kind'] else 'dish'
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im).convert('RGB')
            im.thumbnail((PHOTO_EDGE, PHOTO_EDGE), Image.LANCZOS)
            dst = img_out / f'{stem}.jpg'
            im.save(dst, 'JPEG', quality=PHOTO_QUALITY, optimize=True, progressive=True)
            w, h = im.size
        size = dst.stat().st_size
        total += size
        dish = DISH.get(stem.replace('food-', '')) if kind == 'dish' else None
        photos.append({
            'id': stem, 'file': f'img/{stem}.jpg', 'w': w, 'h': h, 'bytes': size, 'kind': kind, 'for': r['used_by'],
            'dish': dish, 'author': r['author'], 'license': r['license'], 'licenseUrl': r.get('license_url'),
            'title': r['commons_title'].replace('File:', ''), 'page': r['commons_page'], 'taken': r.get('date_taken'),
            'changes': f'Resized to {w}x{h} for this app.',
        })
    report['photos'] = {'count': len(photos), 'bytes': total}
    return photos


# ---------------------------------------------------------------- addresses
def street_names(ways_raw):
    m = {}
    for w in ways_raw:
        t = w.get('tags', {})
        ko = t.get('name:ko') or t.get('name')
        if ko and t.get('name:en'):
            m.setdefault(ko, t['name:en'])
    return m


def addresses(cand, streets):
    t = (cand.get('osm') or {}).get('tags') or {}
    st, no = t.get('addr:street'), t.get('addr:housenumber')
    ko = None
    en = None
    if st and no:
        st = st.split(';')[-1]
        ko = f'{st} {no}'
        if st in streets:
            en = f'{no} {streets[st]}'
    if not en:
        wv = (cand.get('wikivoyage') or {}).get('address')
        if wv:
            en = wv
    return en, ko


# ---------------------------------------------------------------- main
def main(area):
    cfg = AREAS[area]
    area_dir = HERE / area
    out_dir = ROOT / 'app' / 'packs' / cfg['id']
    report = {'area': area, 'hours_unread': [], 'hours_note_changed': [], 'photos_missing': [], 'dropped_text': [], 'changed_text': []}

    cands = load(area_dir / 'candidates.json')['places']
    hours = load(area_dir / 'hours' / 'hours-by-place.json')['places']
    looks = {x['id']: x for x in load(area_dir / 'landmarks-describe.json')['items']}
    walks = load(area_dir / 'walks.json')['walks']
    wd = load(area_dir / 'wikidata' / 'entities.json')['entities']
    wv_meta = load(area_dir / 'wikivoyage' / 'seoul-jongno.meta.json')
    ways_raw = load(area_dir / 'osm' / 'ways-raw.json')['elements']
    streets = street_names(ways_raw)

    photos = build_photos(area_dir, out_dir, report)
    photos_for = {}
    for ph in photos:
        for pid in ph['for']:
            photos_for.setdefault(pid, []).append(ph)

    places = []
    for c in cands:
        pid = c['id']
        h = hours.get(pid, {'status': 'unknown'})
        kind = 'sight' if c['group'] == 'landmark' else KIND.get(c['kind'], 'other')
        wv = c.get('wikivoyage') or {}
        wv_text = without_other_site(pid, clean_wiki(wv.get('content')), report)
        q = c.get('wikidata')
        wd_desc = ((wd.get(q) or {}).get('descriptions', {}).get('en') or {}).get('value') if q else None
        about, about_from = '', None
        if wv_text:
            about, about_from = first_sentences(wv_text), 'wikivoyage'
        elif wd_desc:
            about, about_from = wd_desc[0].upper() + wd_desc[1:] + '.', 'wikidata'
        tip = traveller_note(c.get('note'))
        if c.get('note') and tip != (c.get('note') or '').strip():
            report['dropped_text'].append({'place': pid, 'note': c['note'], 'kept': tip})
        en_addr, ko_addr = addresses(c, streets)
        if pid == 'L17' and en_addr and 'Jung-gu' in en_addr:
            report['dropped_text'].append({'place': pid, 'address': en_addr, 'why': 'Wikivoyage address is in Jung-gu, outside this area (another hanok village); not used'})
            en_addr = None
        t = (c.get('osm') or {}).get('tags') or {}
        ph = photos_for.get(pid, [])
        dish = next((x['dish'] for x in ph if x['kind'] == 'dish'), None)
        p = {
            'id': pid, 'name': c['name_en'], 'nameKo': c.get('name_ko') if re.search(r'[\uac00-\ud7a3]', c.get('name_ko') or '') else None, 'kind': kind, 'type': c['kind'],
            'lat': round(c['lat'], 6), 'lon': round(c['lon'], 6),
        }
        if en_addr:
            p['address'] = en_addr
        if ko_addr:
            p['addressKo'] = ko_addr
        if about:
            p['about'] = about
            p['aboutFrom'] = about_from
        if tip:
            p['tip'] = tip
        if kind in ('restaurant', 'cafe'):
            texts = [wv_text, t.get('cuisine', '').replace('_', ' '), dish or '', c['kind']]
            p['serves'] = serves_of(texts)
            if dish:
                p['dish'] = dish
        if looks.get(pid):
            p['looks'] = looks[pid]['text']
        p['hours'] = build_hours(pid, h, report)
        ev = build_events(h)
        if ev:
            p['events'] = ev
        pr = price_of(c, h)
        if pr:
            p['price'] = pr
        phone = t.get('phone') or t.get('contact:phone')
        phone = kr_phone(phone, report, pid) if phone else None
        if phone:
            p['phone'] = phone
        transit = transit_of(wv.get('directions'), report, pid) if wv.get('directions') else None
        if transit:
            p['transit'] = transit
        if ph:
            p['photos'] = [x['id'] for x in ph]
        p['src'] = c.get('sources', [])
        if p['hours'].get('inside') or (pid == 'L01'):
            p['_inside_fee'] = True
            p['ticket'] = p['hours'].get('inside') or pid
        places.append(p)

    # A palace is a large walled area; its point is the middle of the grounds. Walks to it end at its main gate when the
    # pack has that gate and the gate's own text calls it the main gate (Wikivoyage: "Main gate of Geongbokgung Palace").
    for p in places:
        if p.get('ticket') == p['id']:
            gate = next((g for g in places if g['type'] == 'palace gate' and re.match(r'main gate of', g.get('about') or '', re.I)), None)
            if gate:
                p['door'] = gate['id']

    net, coords = build_net(ways_raw, report)
    snap(places, coords, net)
    for p in places:
        p.pop('_inside_fee', None)
    far = [{'place': p['id'], 'snapM': p['snapM']} for p in places if p['snapM'] > 60]
    report['far_from_path'] = far

    notes = []
    seen_notes = set()
    for w in walks:
        for n in w.get('notes', []):
            if n in seen_notes or re.search(r'location is from', n, re.I):
                continue
            seen_notes.add(n)
    if any('Red Zone' in n for n in seen_notes):
        notes.append({'id': 'N01', 'topic': 'Bukchon Red Zone', 'text': 'In the Bukchon Red Zone (the hanok lanes around Bukchon-ro 11-gil) tourists may visit only from 10:00 to 17:00; from 17:00 to 10:00 the next day tourist visits are not allowed.', 'from': 'Jongno-gu (official), read 23 Nov 2026'})
    if any('vehicle-free' in n for n in seen_notes):
        notes.append({'id': 'N02', 'topic': 'Insa-dong car-free times', 'text': 'Insa-dong is a vehicle-free zone on Saturday afternoons and Sundays (as stated on the Jogyesa official page).', 'from': 'Jogyesa (official), read 23 Nov 2026'})

    walk_list = [{'id': w['id'], 'title': w['title_en'], 'stops': w['stops'], 'notes': [n for n in w.get('notes', []) if not re.search(r'location is from', n, re.I)]} for w in walks]

    credits = [
        'Map and place data © OpenStreetMap contributors, available under the Open Database License (ODbL). openstreetmap.org/copyright',
        f'Travel text adapted from Wikivoyage, "Seoul/Jongno" (revision {wv_meta["revid"]}), CC BY-SA 4.0. Changes were made.',
        'Facts from Wikidata (CC0).',
        'Photos from Wikimedia Commons; each photo shows its author and licence (CC BY, CC BY-SA or CC0). Photos were resized.',
        'Opening hours checked on official sites on 23 Nov 2026; they can change.',
        'Walking routes are worked out by this app from OpenStreetMap paths.',
        'Not affiliated with or endorsed by the OpenStreetMap Foundation or the Wikimedia Foundation.',
    ]
    lats = [p['lat'] for p in places]
    lons = [p['lon'] for p in places]
    pack = {
        'format': 'trip-pack/2', 'id': cfg['id'], 'title': cfg['title'], 'city': cfg['city'], 'area': cfg['area'], 'country': cfg['country'],
        'language': 'en', 'updated': '2026-11-23',
        'source': 'OpenStreetMap, Wikivoyage, Wikidata, Wikimedia Commons and official websites (see credits).',
        'center': {'lat': round(sum(lats) / len(lats), 6), 'lon': round(sum(lons) / len(lons), 6)},
        'bbox': [37.5705, 126.9730, 37.5860, 126.9910],
        'credits': credits,
        'licence': {'data': 'ODbL 1.0 (this pack is a derived database of OpenStreetMap data)', 'dataUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
                    'text': 'CC BY-SA 4.0 for text adapted from Wikivoyage', 'textUrl': 'https://creativecommons.org/licenses/by-sa/4.0/', 'photos': 'per photo'},
        'places': places, 'notes': notes, 'walks': walk_list, 'photos': photos, 'net': net,
    }
    dump(out_dir / 'pack.json', pack, compact=True)
    size = (out_dir / 'pack.json').stat().st_size
    digest = hashlib.sha256((out_dir / 'pack.json').read_bytes()).hexdigest()[:12]
    index_file = ROOT / 'app' / 'packs' / 'index.json'
    idx = load(index_file) if index_file.exists() else {'packs': []}
    idx['packs'] = [x for x in idx['packs'] if x['id'] != cfg['id']] + [{
        'id': cfg['id'], 'title': cfg['title'], 'url': f'packs/{cfg["id"]}/pack.json', 'bytes': size + report['photos']['bytes'],
        'packBytes': size, 'photos': len(photos), 'places': len(places), 'version': digest, 'updated': pack['updated'],
    }]
    dump(index_file, idx)
    report['pack'] = {'file': str((out_dir / 'pack.json').relative_to(ROOT)), 'bytes': size, 'sha256_12': digest, 'places': len(places),
                      'by_kind': {k: sum(1 for p in places if p['kind'] == k) for k in sorted({p['kind'] for p in places})},
                      'hours_status': {s: sum(1 for p in places if p['hours']['status'] == s) for s in sorted({p['hours']['status'] for p in places})},
                      'with_photo': sum(1 for p in places if p.get('photos')), 'with_looks': sum(1 for p in places if p.get('looks'))}
    dump(area_dir / 'build-report.json', report)
    print(json.dumps({k: report[k] for k in ('pack', 'photos', 'net', 'net_parts', 'far_from_path', 'hours_unread', 'hours_note_changed', 'photos_missing')}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'gogung')
