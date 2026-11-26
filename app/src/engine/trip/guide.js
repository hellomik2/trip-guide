// The trip guide's plan for one question, made by code before any AI call (trip-pack/2).
//
// Four kinds of question, as the traveller would use a map app:
//   food      "Where can I get dumplings near here?"   nearest food places by walking distance, open check, dish photos
//   route     "How do I get to Jogyesa?"                 the walk, step by step, drawn on the map
//   sights    "What is worth seeing around here?"        nearest sights with a one-line intro and photos
//   identify  "I see a tall tower with a dome…"          the landmark whose street look matches, so "I am here" can be set
//   other     anything else about the saved places (hours, price, phone, events, city notes)
//
// Code finds the places, distances, routes, steps and "open or closed". It also decides first when the
// question asks for something the pack does not hold ("gate"), so the answer says so instead of talking
// around it. The model only writes one or two sentences from the lines code gives it (prompts.js).
import { fold, stem, words, STOP, readWhen, placeFromPhrase, mentions } from './pick.js';
import { hoursLine, momentOf, shiftMoment, momentText, weekText } from './hours.js';
import { walk, walkMetersFrom } from './route.js';
import { distanceText, WALK_M_PER_MIN, compass, bearingDeg } from './geo.js';
import { placeById } from './pack.js';
import { matchPlace, kindWordsOnly, inQuestion } from './names.js';

const FOOD_KINDS = new Set(['restaurant', 'cafe']);
const PLACE_KIND_WORDS = {
  pharmacy: /\b(pharmac(y|ies)|chemists?|drug ?stores?|medicine|painkillers?|plasters?|band-?aids?)\b/,
  atm: /\b(atms?|cash machines?|cash points?|withdraw\w*|banks?)\b/,
  toilet: /\b(toilets?|restrooms?|bathrooms?|wc|loo|washrooms?)\b/,
  info: /\b(tourist info\w*|information (cent(er|re)|desk|office)|info (cent(er|re)|desk)|visitor cent(er|re))\b/,
  station: /\b(subway|metro|underground|station|stations|exit \d+|train)\b/,
};
// Kinds of place a traveller may ask for that this pack does not hold at all (checked against the pack, not assumed).
const OTHER_KIND_WORDS = {
  hospital: [/\b(hospitals?|clinics?|doctors?|emergency room|a&e|dentists?)\b/, 'hospitals or clinics'],
  hotel: [/\b(hotels?|hostels?|guest ?houses?|accommodation|place to stay|somewhere to stay|where (?:can|could|should) (?:i|we) (?:sleep|stay))\b/, 'places to stay'],
  police: [/\b(police|police station)\b/, 'police stations'],
  post: [/\b(post office|post box|mail a (letter|parcel))\b/, 'post offices'],
  store: [/\b(convenience stores?|supermarkets?|grocer(y|ies)|mini-?marts?|7-?eleven|gs25)\b/, 'shops such as convenience stores or supermarkets'],
  bar: [/\b(bars?|pubs?|beers?|cocktails?|wine|nightlife|night ?clubs?|clubs?)\b/, 'bars or pubs'],
  laundry: [/\b(laundr(y|ies)|laundromats?)\b/, 'laundries'],
  luggage: [/\b(luggage|lockers?|left baggage|baggage storage)\b/, 'luggage storage'],
  rental: [/\b(bikes?|bicycles?|scooters?|hanbok) (rental|hire|shop)s?\b|\brent (a )?(bike|bicycle|scooter|hanbok)\b|\b(rent|rental|rentals|renting|hire|hiring)\b/, 'rental shops'],
  church: [/\b(churches|church|cathedrals?|mosques?|synagogues?)\b/, 'churches or mosques'],
};
// Topics the pack has no data on. A word here only counts when the place asked about has no text with it.
const ABSENT_TOPICS = [
  [/\b(weather|forecast|rain(ing|y)?|snow(ing|y)?|temperature|umbrella)\b/, 'the weather'],
  [/\b(exchange rate|currency exchange|money exchange|exchange (my )?money|change money)\b/, 'money exchange'],
  [/\b(crowded|busy|queues?|wait(ing)? times?|how long (is|will) the (line|wait))\b/, 'how busy it is'],
  [/\b(reserv(e|ation|ations)|book(ing)? (a )?(table|ticket)|book online|online tickets?)\b/, 'reservations or booking'],
  [/\b(wheelchairs?|accessible|accessibility|step-free|strollers?|prams?|elevators?|lifts?)\b/, 'step-free access'],
  [/\b(wi-?fi)\b/, 'wifi'], [/\b(sim cards?|esims?|mobile data)\b/, 'SIM cards or mobile data'], [/\b(charg(e|ing) (my|a) phone|phone chargers?|power banks?)\b/, 'phone charging'],
  [/\b(credit cards?|card payments?|pay by card|pay with (a )?card|apple pay|contactless)\b/, 'how to pay'],
  [/\b(vegan|halal|kosher|gluten|allerg(y|ies|ic)|nut-free|dairy-free|lactose)\b/, 'that diet'],
  [/\b(dogs?|pets?|cats?)\b/, 'pets'],
  [/\b(smok(e|ing)|cigarettes?)\b/, 'smoking'],
  [/\b(parking|park (my|the) car|car park)\b/, 'parking'],
  [/\b(taxis?|uber|cabs?)\b/, 'taxis'],
  [/\b(dress code|what to wear)\b/, 'a dress code'],
  [/\b(drones?|tripods?)\b/, 'drone or tripod rules'],
  [/\b(english menus?|menu in english|picture menu)\b/, 'menus'],
  [/\b(lockers?|cloakroom|coat check)\b/, 'lockers'],
  [/\b(audio ?guides?)\b/, 'audio guides'],
];
// Food words: the tag the pack uses (place.serves), or null when no place in the pack is known to serve it.
const FOOD_WORDS = [
  [/\bnoodles?\b|\bguksu\b|\bkalguksu\b|\bnaengmyeon\b|\bmyeon\b|\bramen\b/, 'noodles'],
  [/\bdumplings?\b|\bmandu\b/, 'dumplings'],
  [/\bsoups?\b|\bstews?\b|\bhot ?pots?\b|\bbroth\b|\bgukbap\b|\btang\b/, 'soup'],
  [/\bbeef\b/, 'beef'], [/\bpork\b/, 'pork'], [/\bchicken\b/, 'chicken'],
  [/\bbarbecue\b|\bbbq\b|\bgrill(ed)?\b|\bsamgyeopsal\b/, 'barbecue'],
  [/\bvegetarian\b|\bveggie\b|\bmeat-?free\b|\btemple food\b/, 'vegetarian'],
  [/\btea\b|\bteahouses?\b|\btea ?houses?\b/, 'tea'], [/\bcoffee\b|\blatte\b|\bespresso\b|\bamericano\b/, 'coffee'],
  [/\bbread\b|\bbaker(y|ies)\b|\bpastr(y|ies)\b|\bsalt bread\b/, 'bread'],
  [/\bdesserts?\b|\bsweets?\b|\bbingsu\b|\bshaved ice\b|\bhotteok\b/, 'dessert'],
  [/\bsnacks?\b|\bstreet food\b|\bbunsik\b|\btteokbokki\b/, 'snacks'], [/\brice cakes?\b|\btteok\b/, 'rice cakes'],
  [/\bbreakfast\b/, 'breakfast'],
  [/\bpizza\b|\bpasta\b|\bitalian\b/, null], [/\bburgers?\b|\bfast food\b|\bfries\b/, null], [/\bsushi\b|\bjapanese\b/, null],
  [/\bchinese\b|\bdim sum\b/, null], [/\bthai\b|\bindian\b|\bcurry\b|\bmexican\b|\btacos?\b|\bfrench\b|\bwestern\b/, null],
  [/\bseafood\b|\bfish\b|\bsashimi\b|\bcrab\b|\bshrimp\b|\boctopus\b/, null], [/\bkimchi stew\b|\bkimchi jjigae\b|\bbibimbap\b|\bbulgogi\b|\bfried chicken\b|\bice cream\b/, null],
  [/\bsteaks?\b/, 'steak'], [/\bbeer\b|\bwine\b|\bsoju\b|\bmakgeolli\b|\bcocktails?\b/, null],
];
const FOOD_RE = /\b(eat|eating|food|restaurants?|lunch|dinner|breakfast|brunch|supper|hungry|meals?|dine|dining|snacks?|cafes?|caf[eé]s?|coffee|tea|teahouses?|bakery|bakeries|bread|dessert|drinks?|noodles?|dumplings?|soup|bbq|barbecue|vegetarian|where to eat|bite)\b/;
const SIGHT_RE = /\b(see|seeing|visit|visiting|wander|wandering|stroll|strolling|walk around|hanok|alleys?|lanes?|old streets?|neighbou?rhoods?|scenic|sights?|sightseeing|attractions?|things to do|what to do|worth|museums?|palaces?|temples?|galler(y|ies)|interesting|landmarks?|photo spots?|views?|viewpoints?|historic|history|parks?|monuments?|statues?|hanok villages?|explore|tour)\b/;
const IDENTIFY_RE = /\b((i am|i'm|im|standing|we are|we're) (right )?in front of|in front of (a|an|this|that|some)|what (is|'s|are) (this|that|these|those)|what am i (looking at|seeing)|(?<!\b(can|could|should|do|where|will) )i (can )?see|i'm looking at|i am looking at|looking at|in front of me|ahead of me|right in front|which (building|place|gate|tower|statue|temple|pavilion|hall|street|museum) is (this|that|it)|what (building|gate|tower|statue|place|temple|pavilion|hall|street) is (this|that)|what (could|might) (this|that|it) be|what(s| is) (its|the) name|what (is|s) (it|this|that) called|name of (this|that|it)|what (is|'s) it|who (is|'s) (this|that|it)|what place is (this|that)|do you know what|looks? (a bit |a little |kind of |sort of )?like an? |where am i|i'm standing|i am standing|there is an? .{0,60} (here|ahead|in front)|identify)\b/;
const LOOK_WORDS = /\b(statues?|towers?|gates?|pillars?|columns?|roofs?|pavill?ions?|mountains?|rocky|peaks?|hills?|bridges?|six-sided|eight-sided|hexagon(al)?|octagon(al)?|brick|stone|wooden|wood|ponds?|pavilions?|arch|arches|arched|domes?|spires?|pagodas?|halls?|courtyards?|terraces?|railings?|tiled|tiles|painted|colou?rful|golden|gold|bronze|alleys?|lanes?|windows?|stairs|fountains?|watchtowers?|swords?|throne|walls?|trees?|plaza|squares?|storey|story|lawn|islands?|eaves|ramps?|glass|red|green|white|grey|gray|pale|tall|huge|narrow|seated|sitting|armou?r|building|floors?|yellow|blue|cream|pool|dark|modern|traditional|old)\b/g;
const ROUTE_RE = /\b(how (do|can|should|would) (i|we) (get|go|reach|walk)|get to|go to|getting to|way to|directions?|how far|walk to|walking to|walk me|route|take me|show me the way|navigate|reach|head to|from .+ to |which way)\b/;
const NOW_RE = /\b(now|right now|at the moment|currently|still open|open today|tonight|this evening)\b/;
const HOURS_ASK = /\b(is (it|this|that|the [a-z]+|[a-z]+) (still )?open|are (they|these|those|the [a-z]+) (still )?open|open (now|today|tonight|tomorrow|until|till|at|on|late)|still open|opening (hours|times)|open(ing)? hours|hours|what time|when (does|do|is|are|will)|close[sd]?\b|closing|price|cost|fee|ticket)\b/;
const OPEN_RE = /\b(open|opens|opening|close|closes|closing|closed|hours?|what time|when)\b/;
const PRICE_RE = /\b(price|prices|cost|costs|how much|fee|fees|admission|entry|entrance fee|ticket|tickets|free)\b/;
const PHONE_RE = /\b(phone|call|telephone|number)\b/;
const ADDRESS_RE = /\b(address|where exactly)\b/;
const EVENT_RE = /\b(ceremony|guard|changing of the guard|tour|tours|guided|event|events|show|performance)\b/;
// A word for a kind of food or sight ("dumpling", "buddhist"), beside the English place words names.js knows ("museum", "house").
const isKindWord = (w) => FOOD_RE.test(w) || FOOD_WORDS.some(([re]) => re.test(w)) || SIGHT_RE.test(w) || SIGHT_TYPES.some(([re]) => re.test(w));
// Words after which a place in the question is the reference ("near X", "at X"), not what is looked for.
const KIND_HEAD_END = /\b(?:near|around|close to|next to|by|from|in|at|inside)\b/;
// Words of a search around a place; without them a sights reading of "Tell me about X" is about X itself.
const SEARCH_CUE = /\b(near|nearby|around|close|closest|nearest|next to|by|from|any|anything|anywhere|somewhere|else|other|more|places|things|spots|where|walk|walking)\b/;

const CAPS_SKIP = new Set(['i', 'is', 'are', 'can', 'could', 'where', 'what', 'which', 'when', 'how', 'who', 'do', 'does', 'any', 'the', 'a', 'an', 'my', 'we', 'it', 'there', 'please', 'tell', 'show', 'find', 'give', 'hi', 'hello', 'ok', 'okay', 'thanks', 'so', 'and', 'or', 'but', 'if', 'should', 'would', 'will', 'shall',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'korea', 'korean', 'south', 'seoul', 'english', 'asia', 'am', 'pm', 'im', "i'm", 'id', "i'd", 'ive', "i've", 'is', 'exit', 'line', 'station', 'gate', 'street', 'road', 'palace', 'museum', 'temple', 'park', 'hall', 'village']);

// ---------------------------------------------------------------- vocabulary of the pack
const vocabs = new WeakMap();
function vocab(pack) {
  if (vocabs.has(pack)) return vocabs.get(pack);
  const all = new Set();
  const add = (t) => { const ws = words(t); for (const w of ws) { all.add(w); all.add(stem(w)); } for (let i = 1; i < ws.length; i += 1) all.add(ws[i - 1] + ws[i]); };
  for (const p of pack.places ?? []) for (const t of [p.name, p.type, p.about, p.looks, p.tip, p.dish, p.address, p.transit, p.price?.text, p.hours?.note, ...(p.events ?? []).map((e) => `${e.name} ${e.when} ${e.note ?? ''}`), ...(p.serves ?? [])]) add(t);
  for (const w of pack.net?.ways ?? []) add(w.n);
  for (const n of pack.notes ?? []) add(`${n.topic} ${n.text}`);
  for (const w of pack.walks ?? []) add(w.title);
  add(`${pack.city} ${pack.area} ${pack.country}`);
  vocabs.set(pack, all);
  return all;
}

// Words that may start a capitalised run but are not part of a name; place nouns ("Station", "Gate") may be.
const NOT_NAME = new Set(['i', 'is', 'are', 'can', 'could', 'where', 'what', 'which', 'when', 'how', 'who', 'do', 'does', 'any', 'the', 'a', 'an', 'my', 'we', 'it', 'there', 'please', 'tell', 'show', 'find', 'give', 'hi', 'hello', 'ok', 'okay', 'thanks', 'so', 'and', 'or', 'but', 'if', 'should', 'would', 'will', 'shall',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'am', 'pm', 'im', 'id', 'ive', 'english', 'take', 'get', 'go', 'walk', 'directions', 'best', 'how', 'to', 'from', 'me', 'us', 'need', 'want', 'looking', 'hey', 'excuse', 'sorry']);
const nameSources = new WeakMap();
/** Word lists of every name the pack holds: places, streets, notes, events, walks. */
function namesOf(pack) {
  if (nameSources.has(pack)) return nameSources.get(pack);
  const list = [];
  const add = (t) => { const ws = words(t ?? ''); if (ws.length) list.push(new Set([...ws, ...ws.map(stem), ...ws.slice(1).map((w, i) => ws[i] + w)])); };
  for (const p of pack.places ?? []) { add(p.name); add(p.tip); add(p.price?.text); add(p.hours?.note); for (const e of p.events ?? []) add(e.name); }
  for (const w of pack.net?.ways ?? []) add(w.n);
  for (const n of pack.notes ?? []) add(n.topic);
  for (const w of pack.walks ?? []) add(w.title);
  add(`${pack.city ?? ''} ${pack.area ?? ''} ${pack.country ?? ''}`);
  nameSources.set(pack, list);
  return list;
}
const wordIn = (set, w) => set.has(w) || set.has(stem(w)) || (w.length >= 5 && [...set].some((x) => x.length > w.length && x.startsWith(w)));
/** A run of two or more name words that no single saved name holds as a whole ("N Seoul Tower", "Lotte Tower"). */
function unknownRuns(pack, question, handled) {
  const out = [];
  let run = [];
  const flush = () => {
    const ws = run.flatMap((t) => words(t)).filter((w) => !NOT_NAME.has(w) && !STOP.has(w) && !handled(w));
    if (ws.length >= 2) {
      const covered = namesOf(pack).some((set) => ws.every((w, i) => wordIn(set, w) || (i + 1 < ws.length && set.has(w + ws[i + 1])) || (i > 0 && set.has(ws[i - 1] + w))));
      if (!covered) out.push(run.join(' '));
    }
    run = [];
  };
  for (const m of String(question).matchAll(/[A-Za-z][A-Za-z'’-]*/g)) {
    const t = m[0];
    if (/^[A-Z]/.test(t) && !NOT_NAME.has(fold(t).replace(/['’]s$/, ''))) run.push(t); else flush();
  }
  flush();
  return out;
}

/** A word the pack uses somewhere (any place text, street, note): names the model writes must be among them. */
export function knownWord(pack, w) { const v = vocab(pack); const x = fold(w).replace(/[^a-z0-9]/g, ""); return !x || v.has(x) || v.has(stem(x)); }

/** Capitalised names in the question that no saved place, street or note uses ("Namsan Tower", "Myeongdong"). */
function unknownNames(pack, question) {
  const v = vocab(pack);
  const out = [];
  let run = [];
  const flush = () => { if (run.length) out.push(run.join(' ')); run = []; };
  const starts = new Set();
  let atStart = true;
  for (const m of String(question).matchAll(/[A-Za-z][A-Za-z'’-]*|[.!?]/g)) {
    if (/^[.!?]$/.test(m[0])) { atStart = true; continue; }
    if (atStart) starts.add(m.index);
    atStart = false;
  }
  const found = [...String(question).matchAll(/[A-Za-z][A-Za-z'’-]*/g)];
  let runStart = false;
  found.forEach((m, i) => {
    const t = m[0];
    const lower = fold(t).replace(/['’]s$/, '');
    const isCap = /^[A-Z]/.test(t) && !CAPS_SKIP.has(lower);
    if (isCap) { if (!run.length) runStart = starts.has(m.index); run.push(t); } else { if (run.length === 1 && runStart) run = []; flush(); }
    if (i === found.length - 1) { if (run.length === 1 && runStart) run = []; flush(); }
  });
  flush();
  // Words the guide already understands (food, kinds of place, topics) are not names.
  const handled = (w) => [...FOOD_WORDS.map(([re]) => re), ...Object.values(PLACE_KIND_WORDS), ...Object.values(OTHER_KIND_WORDS).map(([re]) => re), ...ABSENT_TOPICS.map(([re]) => re), FOOD_RE, SIGHT_RE].some((re) => re.test(w));
  const single = out.filter((name) => {
    const ws = words(name).filter((w) => !STOP.has(w) && !CAPS_SKIP.has(w) && !handled(w));
    if (!ws.length) return false;
    // one word that no saved place, street or note uses is enough ("Namsan Tower": "namsan")
    return ws.some((w) => !v.has(w) && !v.has(stem(w)));
  });
  return [...new Set([...single, ...unknownRuns(pack, question, handled)])];
}

// ---------------------------------------------------------------- place texts
const placeText = (p) => fold([p.name, p.nameKo, p.type, p.about, p.looks, p.tip, p.dish, p.price?.text, p.transit, p.hours?.note, p.hours?.text, ...(p.events ?? []).map((e) => `${e.name} ${e.when} ${e.note ?? ''}`), ...(p.serves ?? [])].filter(Boolean).join(' '));

function scoreEntries(pack, terms, fields) {
  const entries = (pack.places ?? []).map((p) => {
    const tf = new Map();
    let len = 0;
    for (const [text, w] of fields(p)) for (const t of words(text).map(stem)) { if (STOP.has(t)) continue; tf.set(t, (tf.get(t) ?? 0) + w); len += w; }
    return { p, tf, len };
  });
  const N = entries.length;
  const avg = entries.reduce((a, e) => a + e.len, 0) / Math.max(1, N);
  const df = new Map(terms.map((t) => [t, entries.filter((e) => e.tf.has(t)).length]));
  return entries.map((e) => {
    let s = 0;
    for (const t of terms) {
      const f = e.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += idf * ((f * 2.2) / (f + 1.2 * (0.5 + (0.5 * e.len) / avg)));
    }
    return { p: e.p, s };
  });
}

// Words that describe how a thing looks, mapped to the words the pack's descriptions use.
const LOOK_SYNONYMS = {
  gold: 'golden gilded', golden: 'gold gilded', gilded: 'golden gold', bronze: 'metal', sitting: 'seated', seated: 'sitting throne', throne: 'seated', king: 'throne seated', sword: 'admiral armoured',
  armor: 'armoured', armour: 'armoured', admiral: 'sword armoured', soldier: 'armoured', warrior: 'armoured sword', pond: 'water lake', lake: 'pond water', water: 'pond', island: 'pond',
  pagoda: 'tiered tower', tiered: 'tier pagoda', tower: 'watchtower pagoda', dome: 'spire', spire: 'dome tower', brick: 'red-brick', red: 'red-brick', church: 'spire dome tower', cross: 'spire',
  roof: 'roofs tiled', roofs: 'roof tiled', tile: 'tiled', tiles: 'tiled', wooden: 'wood', pillars: 'pillar columns', columns: 'pillars', gate: 'gate', door: 'gate doorway', arches: 'arched',
  arch: 'arched', alley: 'lane lanes alleys', alleys: 'lane lanes alley', lane: 'alley lanes', narrow: 'steep lanes', houses: 'hanok', traditional: 'hanok', hanok: 'traditional houses',
  spiral: 'ramps ramp walkway', ramp: 'ramps walkway', courtyard: 'yard', shops: 'shop', library: 'school', fountain: 'fountain basin', school: 'library', glass: 'glass-walled',
  temple: 'hall emblem', buddha: 'temple', lanterns: 'temple', colorful: 'painted', colourful: 'painted', painted: 'colourful', green: 'painted', mountain: 'mountains bugaksan', mountains: 'mountain bugaksan',
  octagonal: 'eight-sided', six: 'sides', sided: 'sides', hexagon: 'six sides', pavillion: 'pavilion', rocky: 'rocky peak', peak: 'peak rocky', hill: 'mountain', bridge: 'bridge', column: 'pillars pillar', columns: 'pillars pillar', story: 'storey', storey: 'storey', lawn: 'lawn', grass: 'lawn grassy', shopping: 'shops shop', mall: 'shops', fountain: 'fountain basin', 'eight-sided': 'pavilion', hexagonal: 'six sides', statue: 'statue', square: 'plaza', plaza: 'square', canopy: 'entrance', steps: 'stairs', stairs: 'steps stairways',
};

function expand(terms, dict) {
  const out = new Set(terms);
  for (const t of terms) for (const x of (dict[t] ?? '').split(' ').filter(Boolean)) out.add(stem(x));
  return [...out];
}

// ---------------------------------------------------------------- helpers
const kmText = (m) => `${distanceText(m)} walk, about ${Math.max(1, Math.round(m / WALK_M_PER_MIN))} min`;
const firstSentence = (t) => (String(t ?? '').match(/^.*?[.!?](?=\s|$)/)?.[0] ?? String(t ?? '')).trim();

function momentFor(question, at) {
  let m = momentOf(at);
  const t = fold(question);
  if (/\btomorrow\b/.test(t)) m = momentOf(new Date(m.d.getFullYear(), m.d.getMonth(), m.d.getDate() + 1, m.d.getHours(), m.d.getMinutes()));
  const w = readWhen(question);
  if (w.days.length || w.minute != null) m = shiftMoment(m, { day: w.days[0] ?? null, minute: w.minute });
  return { m, asked: w.days.length > 0 || w.minute != null || /\btomorrow\b/.test(t), now: NOW_RE.test(t) };
}

/** What the question asks for, by code. Words after "near …" name the reference place, not what is asked for. */
export function detectKind(question) {
  const t = fold(question);
  if (IDENTIFY_RE.test(t)) return 'identify';
  const looksCount = (t.match(LOOK_WORDS) ?? []).length;
  const askingWhat = /\b(what|which|who|whats)\b/.test(t) || /\?\s*$/.test(question) || !/\b(where|how|when|is there|are there|any)\b/.test(t);
  if (looksCount >= 3 && askingWhat && !ROUTE_RE.test(t) && !FOOD_RE.test(t) && !HOURS_ASK.test(t)) return 'identify';
  const strong = t.match(/\b(?:(?:best|quickest|fastest|shortest|easiest) way (?:to (?:walk |get |go )?|back )|walk(?:ing)? back to|get back to|go back to|head back to|directions to|take me (?:back )?to|walk me to)\s*/);
  if (strong) {
    const tail = t.slice(strong.index + strong[0].length);
    if (!FOOD_RE.test(tail) && !FOOD_WORDS.some(([re]) => re.test(tail)) && !/^(the )?(nearest|closest|a|an|any|some)\b/.test(tail)) return 'route';
  }
  // "before dinner", "after lunch" say when, not what to eat
  const head = t.replace(/\b(before|after|until|till) (breakfast|brunch|lunch|dinner|supper)\b/g, ' ').split(/\b(?:near|around|close to|next to|by|from)\b/)[0];
  const food = FOOD_RE.test(head) || FOOD_WORDS.some(([re]) => re.test(head));
  const kindWord = Object.values(PLACE_KIND_WORDS).some((re) => re.test(head));
  if (ROUTE_RE.test(t) && !/\b(nearest|closest|good|best|recommend|any)\b/.test(t)) return 'route';
  if (food) return 'food';
  if (kindWord && /\b(nearest|closest|where|any|find|need|is there|are there|near)\b/.test(t)) return 'route';
  if (ROUTE_RE.test(t)) return 'route';
  const searching = /\b(near|nearby|around|close by|closest|nearest|worth|recommend|suggest|any|things to|what to|best|good|interesting|places to|where (can|could|should|do) (i|we)|where to|what (can|could|should) (i|we)|(can|could) (i|we) (still )?(go|see|visit)|go and see|still (go|see|visit))\b/.test(t);
  if (SIGHT_RE.test(head) && searching && (/\b(any|near|nearby|around|worth|recommend|suggest|things to|what to|places to|where (can|could|should|do) (i|we)|where to|what (can|could|should) (i|we)|(can|could) (i|we) (still )?(go|see|visit)|go and see|still (go|see|visit))\b/.test(t) || !/\b(open|close|closes|hours|price|cost|fee|ticket|phone|address)\b/.test(t))) return 'sights';
  return 'other';
}

const cap1 = (x) => String(x).charAt(0).toUpperCase() + String(x).slice(1);
function gate(text, why, extra = {}) { return { text, why, ...extra }; }

/** A place card for the screen: everything is computed here, nothing by the model. */
function card(pack, p, { walkM, m, here, rank, from = null }) {
  const h = hoursLine(p, m);
  return {
    id: p.id, rank, name: p.name, nameKo: p.nameKo ?? null, kind: p.kind, type: p.type, lat: p.lat, lon: p.lon,
    walkM: walkM ?? null, walkText: walkM != null ? kmText(walkM) : null, from,
    dir: here && here.id !== p.id ? compass(bearingDeg(here, p)) : null,
    intro: (p.aboutFrom === 'wikivoyage' ? firstSentence(p.about) : '') || p.tip || firstSentence(p.about) || '', dish: p.dish ?? null, serves: p.serves ?? [],
    open: { state: h.state, text: h.text, short: h.short, today: h.today ?? null, closesAt: h.closesAt ?? null, opensAt: h.opensAt ?? null },
    week: weekText(p, m), price: p.price?.text ?? null, photos: p.photos ?? [], address: p.address ?? null, addressKo: p.addressKo ?? null,
  };
}

/** One data line for the model (short; only what the question needs). */
function line(c, { withOpen = true, withPrice = false, withIntro = true, withDish = false, withWalk = true } = {}) {
  const parts = [`[${c.id}] ${c.rank ? `${c.rank}. ` : ''}${c.name} (${c.type}).`];
  if (withWalk && c.walkText) parts.push(`From ${c.from ?? 'you'}: ${c.walkText}${c.dir ? `, ${c.dir}` : ''}.`);
  if (withDish && c.dish) parts.push(`Serves: ${c.dish}.`);
  if (withIntro && c.intro) parts.push(`About: ${c.intro}`);
  if (withOpen) parts.push(c.open.text);
  if (withPrice && c.price) parts.push(`Price: ${c.price}.`);
  return parts.join(' ');
}

// ---------------------------------------------------------------- the plan from what the AI understood
const KIND_LABEL = { food: 'Food', route: 'Directions', sights: 'Sights nearby', identify: 'What is this?', hours: 'Opening hours', other: 'Question' };
const placeRef = (p) => (p ? { id: p.id, name: p.name } : null);
/** Words of the question with the place names taken out, for reading conditions ("dumplings", "museum") only. */
function withoutNames(t, ...names) {
  let x = ` ${t} `;
  for (const n of names) { const f = fold(n ?? '').trim(); if (f.length > 1) x = x.split(f).join(' '); }
  return x.replace(/\s+/g, ' ').trim();
}

/**
 * The plan for one question once its kind and names are known.
 * @param understood  { kind: food|route|sights|identify|hours|other, place, from, food, time: now|later|any, also,
 *                      placeId?, fromId? (chosen on screen), by: 'device'|'cloud'|'user' }
 *   Without it (no AI could read the question) the older word rules guess the kind and the place (planByRules).
 */
export function plan(pack, question, { hereId, at, kind, understood } = {}) {
  if (!understood) {
    const p = planByRules(pack, question, { hereId, at, kind });
    const focus = p.view?.places?.find((c) => c.id === p.view.focus) ?? null;
    p.view = { ...p.view, understood: { by: 'rules', kind: p.kind, place: placeRef(focus), status: focus ? 'guess' : 'empty', candidates: [], label: `${KIND_LABEL[p.kind] ?? 'Question'}${focus ? ` · ${focus.name}` : ''}` } };
    return p;
  }
  const here = placeById(pack, hereId) ?? null;
  const q = String(question ?? '').trim();
  const t = fold(q);
  const u = understood;
  let k = ['food', 'route', 'sights', 'identify', 'hours', 'other'].includes(kind) ? kind : ['food', 'route', 'sights', 'identify', 'hours', 'other'].includes(u.kind) ? u.kind : 'other';
  const { m, asked, now: nowWords } = momentFor(q, at);
  const now = nowWords || u.time === 'now';
  const timed = asked || u.time === 'later';
  const base = { kind: k, kindFrom: kind ? 'chosen' : u.by === 'user' ? 'chosen' : 'understood', here: here ? { id: here.id, name: here.name } : null, moment: { text: momentText(m), day: m.day, minute: m.minute, asked } };
  const dist = here ? walkMetersFrom(pack, here) : new Map();
  const cardOf = (p, rank) => card(pack, p, { walkM: here ? dist.get(p.id) : null, m, here, rank });

  // names: the screen's choice, or the AI's words matched to the pack by code
  const resolve = (id, text) => {
    if (id !== undefined && id !== null) { const p = id ? placeById(pack, id) : null; return { status: p ? 'chosen' : 'empty', place: p, candidates: [], phrase: p?.name ?? '' }; }
    return matchPlace(pack, text, { here });
  };
  let pm = resolve(u.placeId, u.place);
  // a phrase of kind words only ("art museums", "tea house", "dumpling place") written before "near / around / at …" says what
  // they look for, even when a saved name holds the same words ("Seoul Museum of Craft Art", "Traditional Tea House")
  const kindPhrase = ['close', 'guess'].includes(pm.status) && kindWordsOnly(u.place, isKindWord) && inQuestion(u.place, t.split(KIND_HEAD_END)[0]);
  // the kind the AI read, checked against the question's own words (code only; a kind chosen on screen is kept)
  if (!kind && u.by !== 'user') {
    // "what is this" needs a description of something in front of the traveller; "which museums are open now?" is a search
    if (k === 'identify' && !IDENTIFY_RE.test(t) && (t.match(LOOK_WORDS) ?? []).length < 2) k = detectKind(q);
    // "is there a cafe open near me?" looks for places of a kind; it is not about the opening hours of one place
    else if ((k === 'hours' || k === 'other') && (pm.status === 'empty' || pm.how === 'kind' || kindPhrase) && /\b(is there|are there|any|anywhere|somewhere)\b/.test(t)) {
      const d = detectKind(q);
      if (d === 'food' || d === 'sights') k = d;
    }
    // "Tell me about MMCA Seoul" is about the one place it names, not the sights around it
    if (k === 'sights' && ['exact', 'close', 'guess'].includes(pm.status) && !kindPhrase && !SEARCH_CUE.test(t) && detectKind(q) === 'other') k = 'other';
    base.kind = k;
  }
  // for food and sights a phrase of place words only ("nearby museums", "a teahouse") is what they look for, not where
  if ((k === 'food' || k === 'sights') && (pm.how === 'kind' || kindPhrase)) pm = { status: 'empty', place: null, candidates: [], phrase: '' };
  // the same for a phrase made only of food or sight words ("nearest pork place", "a good noodle spot"): what, not where
  if ((k === 'food' || k === 'sights') && pm.status === 'none') {
    const filler = new Set(['nearest', 'closest', 'near', 'nearby', 'place', 'places', 'spot', 'spots', 'somewhere', 'the', 'a', 'an', 'some', 'any', 'good', 'best', 'cheap', 'local', 'nice', 'restaurant', 'restaurants', 'cafe', 'cafes', 'shop', 'shops', 'joint', 'stall']);
    const ws = words(u.place).filter((w) => !filler.has(w));
    const foodWs = new Set(words(u.food ?? ''));
    // (sight words include every word the sights list reads as a type: "buddhist", "royal", "exhibition", "lookout")
    if (ws.every((w) => foodWs.has(w) || FOOD_RE.test(w) || FOOD_WORDS.some(([re]) => re.test(w)) || SIGHT_RE.test(w) || SIGHT_TYPES.some(([re]) => re.test(w)))) pm = { status: 'empty', place: null, candidates: [], phrase: '' };
  }
  const fm = k === 'route' ? resolve(u.fromId, u.from) : { status: 'empty', place: null, candidates: [] };
  const target = pm.status === 'here' ? here : pm.place;
  const origin0 = fm.status === 'here' ? here : fm.place;
  const und = {
    by: u.by, kind: k, place: placeRef(target), placeText: u.place ?? '', status: pm.status, how: pm.how ?? null,
    candidates: (pm.candidates ?? []).map(placeRef), from: placeRef(origin0), fromText: u.from ?? '', fromStatus: fm.status,
    food: u.food ?? '', time: u.time ?? 'any', also: String(u.also ?? '').trim(),
  };
  const done = (p) => {
    const view = { ...(p.view ?? {}), understood: und };
    und.label = understoodLabel(k, und, view);
    return { ...base, ...p, view };
  };
  const condText = withoutNames(t, pm.place ? u.place : '', u.from, target?.name, origin0?.name);

  if (k === 'identify') return done(identifyPlan(pack, q, t, { here, m, cardOf, dist }));
  // 1. topics and kinds of place the pack does not hold (checked on the question's own words)
  for (const [re, what] of ABSENT_TOPICS) {
    const hit = condText.match(re);
    if (!hit) continue;
    if (target && what !== 'the weather' && placeText(target).includes(fold(hit[0]))) continue; // the place's own text mentions it
    return done({ gate: gate(`Your saved travel pack does not include ${what}${target ? ` for ${target.name}` : ''}.`, `topic:${hit[0]}`), view: { kind: k, places: target ? [cardOf(target)] : [] } });
  }
  for (const [kindName, [re, label]] of Object.entries(OTHER_KIND_WORDS)) {
    const hit = condText.match(re);
    if (!hit) continue;
    if ((pack.places ?? []).some((p) => p.kind === kindName)) continue;
    if (kindName === 'bar' && (k === 'food' || FOOD_RE.test(t)) && !/\b(bars?|pubs?|beers?|cocktails?|wine)\b/.test(t)) continue;
    return done({ gate: gate(`Your saved travel pack does not include ${label}.`, `kind:${kindName}`), view: { kind: k, places: [] } });
  }
  // 2. a name the pack does not hold: say so, offer the closest names, never answer about another place
  const missing = pm.status === 'none' ? pm : fm.status === 'none' ? fm : null;
  if (missing) {
    und.candidates = (missing.candidates ?? []).map(placeRef);
    if (missing === fm) und.fromMissing = true;
    return done({ gate: gate(`Your saved travel pack does not include “${missing.phrase}”.${missing.candidates?.length ? ' Places with a similar name are below.' : ''}`, `name:${missing.phrase}`), view: { kind: k, places: [] } });
  }
  if (pm.status === 'empty' && !u.placeId) {
    const unknown = unknownNames(pack, q);
    if (unknown.length) return done({ gate: gate(`Your saved travel pack does not include “${unknown[0]}”.`, `name:${unknown[0]}`), view: { kind: k, places: [] } });
  }

  if (k === 'food' || k === 'sights') {
    const foodNamed = target && FOOD_KINDS.has(target.kind) ? target : null;
    const ref = target && !foodNamed && target.id !== here?.id ? target : null;
    const from = ref ?? here;
    const d2 = ref ? walkMetersFrom(pack, ref) : dist;
    const cardFrom = ref ? (p, rank) => card(pack, p, { walkM: d2.get(p.id), m, here: ref, rank, from: ref.name }) : cardOf;
    const foodText = fold(`${u.food ?? ''} ${condText}`);
    const sub = k === 'food'
      ? foodPlan(pack, q, foodText, { here: from, m, now, asked: timed, cardOf: cardFrom, named: foodNamed ? [foodNamed] : [], checkOpen: now || timed || OPEN_RE.test(condText) })
      : sightsPlan(pack, q, condText, { here: from, m, now, asked: timed, cardOf: cardFrom });
    if (ref && sub.view) sub.view.ref = { id: ref.id, name: ref.name };
    return done(sub);
  }
  if (k === 'route') {
    const origin = origin0 ?? here;
    if (!origin) return done({ gate: gate('Choose where you are first ("I am here"), so the app can work out the walk.', 'no-here'), view: { kind: 'route', places: [] } });
    let dest = target;
    if (!dest) {
      // no name: a kind of place ("the nearest toilet", "a pharmacy"), the nearest one to the start
      const kindAsked = Object.entries(PLACE_KIND_WORDS).find(([, re]) => re.test(condText))?.[0] ?? null;
      if (kindAsked) {
        const pool = (pack.places ?? []).filter((p) => p.kind === kindAsked && p.id !== origin.id);
        if (!pool.length) return done({ gate: gate(`Your saved travel pack does not include any ${kindAsked === 'atm' ? 'ATM' : kindAsked}.`, `kind:${kindAsked}`), view: { kind: 'route', places: [] } });
        const d = origin === here ? dist : walkMetersFrom(pack, origin);
        dest = pool.sort((x, y) => d.get(x.id) - d.get(y.id))[0];
        und.place = placeRef(dest);
        und.status = 'kind';
        und.candidates = pool.slice(1, 4).map(placeRef);
      }
    }
    if (!dest) return done({ gate: gate('Which place do you want to walk to? Pick it below, or ask again with its name.', 'route:no-target'), view: { kind: 'route', places: [] } });
    return done(routeAnswer(pack, origin, dest, { here, m, cardOf }));
  }
  // hours and other questions: about the named place, or about "here" when no place is named
  const named = target ? [target] : [];
  const sub = otherPlan(pack, q, t, { here, m, cardOf, named: named.length ? named : k === 'hours' && here ? [here] : [], asked, now, force: k === 'hours' ? 'hours' : null, explicit: named.length > 0 || k === 'hours' });
  return done(sub);
}

/** The one line above the answer: what the app understood, in a few words. */
function understoodLabel(k, u, view) {
  const parts = [KIND_LABEL[k] ?? 'Question'];
  const nameOf = (p, text, status) => (status === 'none' ? `“${text}” (not in your pack)` : p?.name ?? '');
  if (k === 'route') {
    if (u.from || u.fromMissing) parts.push(`from ${nameOf(u.from, u.fromText, u.fromStatus)}`);
    if (u.place || u.status === 'none') parts.push(`to ${nameOf(u.place, u.placeText, u.status)}`);
  } else if (k === 'food' || k === 'sights') {
    const filter = k === 'food' ? (view.filter ?? []).join(', ') : (view.typeFilter ?? []).join(', ');
    if (filter) parts.push(filter);
    else if (k === 'food' && u.food) parts.push(u.food);
    if (u.time === 'now' || view.openFirst) parts.push(`open at ${view.openAt ?? 'that time'}`);
    if (u.place || u.status === 'none') parts.push(u.status === 'none' ? nameOf(null, u.placeText, 'none') : `near ${u.place.name}`);
  } else if (k !== 'identify') {
    if (u.place || u.status === 'none') parts.push(nameOf(u.place, u.placeText, u.status));
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------- the plan by word rules (no AI could read the question)
/**
 * @param pack  trip-pack/2
 * @param question  the traveller's words
 * @param opts  { hereId, at: 'YYYY-MM-DDTHH:MM' | Date, kind?: 'food'|'route'|'sights'|'identify' }
 * @returns { kind, here, moment, gate|null, view, lines, hint, schema }
 */
export function planByRules(pack, question, { hereId, at, kind } = {}) {
  const here = placeById(pack, hereId) ?? null;
  const q = String(question ?? '').trim();
  const t = fold(q);
  const k = ['food', 'route', 'sights', 'identify'].includes(kind) ? kind : detectKind(q);
  const { m, asked, now } = momentFor(q, at);
  const base = { kind: k, kindFrom: kind ? 'chosen' : 'detected', here: here ? { id: here.id, name: here.name } : null, moment: { text: momentText(m), day: m.day, minute: m.minute, asked } };
  const dist = here ? walkMetersFrom(pack, here) : new Map();
  const cardOf = (p, rank) => card(pack, p, { walkM: here ? dist.get(p.id) : null, m, here, rank });
  const found = mentions(pack, words(q), t);
  // a full-name match ("Gyeongbokgung Palace") wins over places that only share one word with it ("Gyeongbokgung Station Exit 5")
  const fullName = (p) => fold(p.name).replace(/\s*\([^)]*\)\s*$/, '').replace(/^the\s+/, '');
  const full = found.filter((x) => t.includes(fullName(x.place)));
  const named = (full.length ? full : found).map((x) => x.place);

  if (k === 'identify') return { ...base, ...identifyPlan(pack, q, t, { here, m, cardOf, dist }) };
  // 1. topics and kinds of place the pack does not hold
  for (const [re, what] of ABSENT_TOPICS) {
    const hit = t.match(re);
    if (!hit) continue;
    const target = named[0];
    if (target && placeText(target).includes(fold(hit[0]))) continue; // the place's own text mentions it
    return { ...base, gate: gate(`Your saved travel pack does not include ${what}${target ? ` for ${target.name}` : ''}.`, `topic:${hit[0]}`), view: { kind: k, places: target ? [cardOf(target)] : [] } };
  }
  for (const [kindName, [re, label]] of Object.entries(OTHER_KIND_WORDS)) {
    const hit = t.match(re);
    if (!hit) continue;
    if ((pack.places ?? []).some((p) => p.kind === kindName)) continue;
    if (kindName === 'bar' && FOOD_RE.test(t) && !/\b(bars?|pubs?|beers?|cocktails?|wine)\b/.test(t)) continue;
    return { ...base, gate: gate(`Your saved travel pack does not include ${label}.`, `kind:${kindName}`), view: { kind: k, places: [] } };
  }
  const unknown = unknownNames(pack, q);
  if (unknown.length) return { ...base, gate: gate(`Your saved travel pack does not include ${unknown[0]}.`, `name:${unknown[0]}`), view: { kind: k, places: [] } };

  // "near Jogyesa", "around Insa-dong": food and sights are measured from that place instead of from here
  if (k === 'food' || k === 'sights') {
    const tail = t.match(/\b(?:near|around|close to|next to|by|from)\s+(?:the\s+)?(.+?)[?.!]*$/)?.[1] ?? null;
    const ref = tail ? placeFromPhrase({ ...pack, places: pack.places.filter((p) => !FOOD_KINDS.has(p.kind)) }, tail, here) : null;
    if (ref && ref !== 'here' && ref.id !== here?.id && !FOOD_KINDS.has(ref.kind)) {
      const d2 = walkMetersFrom(pack, ref);
      const cardFrom = (p, rank) => card(pack, p, { walkM: d2.get(p.id), m, here: ref, rank, from: ref.name });
      const sub = k === 'food' ? foodPlan(pack, q, t, { here: ref, m, now, asked, cardOf: cardFrom, named: named.filter((p) => p.id !== ref.id) }) : sightsPlan(pack, q, t, { here: ref, m, now, asked, cardOf: cardFrom });
      if (sub.view) sub.view.ref = { id: ref.id, name: ref.name };
      return { ...base, ...sub };
    }
  }
  if (k === 'food') return { ...base, ...foodPlan(pack, q, t, { here, m, now, asked, cardOf, named }) };
  if (k === 'sights') return { ...base, ...sightsPlan(pack, q, t, { here, m, now, asked, cardOf }) };
  if (k === 'route') return { ...base, ...routePlan(pack, q, t, { here, m, cardOf, named, dist }) };
  if (k === 'identify') return { ...base, ...identifyPlan(pack, q, t, { here, m, cardOf, dist }) };
  return { ...base, ...otherPlan(pack, q, t, { here, m, cardOf, named, asked, now }) };
}

// ---------------------------------------------------------------- food
function foodPlan(pack, q, t, { here, m, now, asked, cardOf, named, checkOpen: openAsked = null }) {
  if (!here) return { gate: gate('Choose where you are first ("I am here"), so the app can find what is near you.', 'no-here'), view: { kind: 'food', places: [] } };
  const wants = [];
  for (const [re, tag] of FOOD_WORDS) {
    const hit = t.match(re);
    if (!hit) continue;
    if (tag === null) return { gate: gate(`Your saved travel pack does not list any place for ${hit[0]}.`, `food:${hit[0]}`), view: { kind: 'food', places: [] } };
    wants.push({ tag, word: hit[0] });
  }
  let pool = (pack.places ?? []).filter((p) => FOOD_KINDS.has(p.kind) && p.id !== here.id);
  const drinkOnly = /\b(tea|coffee|cafes?|caf[eé]s?|teahouses?|bakery|bakeries|dessert|drinks?)\b/.test(t) && !/\b(lunch|dinner|meal|restaurant|eat)\b/.test(t);
  const cafeAsked = /\bcaf(e|es|é|és)\b/.test(t) && wants.every((w) => ['coffee', 'tea'].includes(w.tag));
  for (const w of cafeAsked ? [] : wants) {
    if (w.tag === 'steak') { pool = pool.filter((p) => /steak/i.test(`${p.about} ${p.dish}`)); continue; }
    pool = pool.filter((p) => (p.serves ?? []).includes(w.tag));
  }
  if ((!wants.length || cafeAsked) && drinkOnly) pool = pool.filter((p) => p.kind === 'cafe' || (p.serves ?? []).some((s) => ['tea', 'coffee', 'bread', 'dessert'].includes(s)));
  if (!pool.length) return { gate: gate(`Your saved travel pack does not list a place for ${wants.map((w) => w.word).join(' and ') || 'that'}.`, 'food:none'), view: { kind: 'food', places: [] } };
  const named0 = named.find((p) => FOOD_KINDS.has(p.kind));
  let cards = pool.map((p) => cardOf(p)).sort((a, b) => a.walkM - b.walkM);
  const checkOpen = openAsked ?? (now || asked || OPEN_RE.test(t));
  let filterNote = '';
  if (checkOpen) {
    const daysOpen = (c) => c.open.state === 'open' && /does not say which days/.test(c.open.text ?? '');
    const open = [...cards.filter((c) => c.open.state === 'open' && !daysOpen(c)), ...cards.filter(daysOpen)];
    const unknown = cards.filter((c) => c.open.state === 'unknown');
    if (!open.length) {
      const list = cards.slice(0, 3).map((c, i) => ({ ...c, rank: i + 1 }));
      return {
        gate: gate(`None of the ${wants.length ? `${wants.map((w) => w.word).join(' ')} ` : ''}places in your saved pack is open at ${momentText(m)}${unknown.length ? ` (${unknown.length} have no hours in the pack)` : ''}.`, 'food:none-open', { found: true }),
        view: { kind: 'food', places: list, focus: list[0]?.id ?? null, route: walk(pack, here, placeById(pack, list[0]?.id)), filter: wants.map((w) => w.tag), openFirst: true, openAt: momentText(m) },
      };
    }
    // confirmed open first; then times without days ("Hours not confirmed"); then no hours in the pack
    cards = [...open.map((c) => (daysOpen(c) ? { ...c, unconfirmed: true } : c)), ...unknown];
    filterNote = `Places open at ${momentText(m)} come first. “Hours not confirmed”: the source gives times but not the days. Places with no hours in the pack come last.`;
  }
  if (named0) cards = [cardOf(named0), ...cards.filter((c) => c.id !== named0.id)];
  const list = cards.slice(0, 3).map((c, i) => ({ ...c, rank: i + 1 }));
  const route = walk(pack, here, placeById(pack, list[0].id));
  // the model only says what place 1 serves; distances and opening are added by code (tasks/trip.js)
  const lines = list[0].intro || list[0].dish ? [line(list[0], { withDish: true, withPrice: PRICE_RE.test(t), withOpen: false, withWalk: false })] : [];
  return {
    gate: null,
    view: { kind: 'food', places: list, focus: list[0].id, route, filter: wants.map((w) => w.tag), note: filterNote, openFirst: checkOpen, openAt: momentText(m) },
    lines, hintKey: 'food',
  };
}

// ---------------------------------------------------------------- sights
const SIGHT_TYPES = [
  [/\bmuseums?\b|\bgaller(y|ies)\b|\bart\b|\bexhibitions?\b/, (p) => /museum|gallery|art/i.test(`${p.type} ${p.name}`), 'museums'],
  [/\bpalaces?\b|\broyal\b/, (p) => /palace|throne|pavilion|gate/i.test(p.type) && !/museum/i.test(p.type), 'palaces'],
  [/\btemples?\b|\bbuddhis\w*\b/, (p) => /temple/i.test(`${p.type} ${p.name}`), 'temples'],
  [/\bstatues?\b|\bmonuments?\b/, (p) => /statue|monument/i.test(`${p.type} ${p.about}`), 'statues'],
  [/\bhanok\b|\btraditional houses?\b|\bold houses?\b/, (p) => /hanok|historic house/i.test(`${p.type} ${p.name}`), 'hanok houses'],
  [/\bparks?\b|\bgardens?\b|\bgreen\b/, (p) => /park|garden/i.test(`${p.type} ${p.name}`), 'parks'],
  [/\bviews?\b|\bviewpoints?\b|\bpanoram\w*\b|\blookout\b/, (p) => /viewpoint|view/i.test(`${p.type} ${p.about}`), 'viewpoints'],
  [/\bstreets?\b|\bshopping\b|\bshops?\b|\bsouvenirs?\b/, (p) => /street|shopping/i.test(`${p.type}`), 'streets and shops'],
  [/\bfree\b/, (p) => /^free\b|^free$/i.test(p.price?.text ?? '') || /\bfree\b/i.test(p.price?.text ?? '') && !/\d/.test(String(p.price?.text ?? '').split(/free/i)[0]), 'free places'],
];
const ABSENT_SIGHTS = /\b(zoo|aquarium|beach|river|cinema|theme park|amusement|casino|stadium|castle|church|cathedral|tower observatory|skyscraper)\b/;

function sightsPlan(pack, q, t, { here, m, now, asked, cardOf, typeText = null }) {
  if (!here) return { gate: gate('Choose where you are first ("I am here"), so the app can find what is near you.', 'no-here'), view: { kind: 'sights', places: [] } };
  const absent = t.match(ABSENT_SIGHTS);
  if (absent && !(pack.places ?? []).some((p) => placeText(p).includes(fold(absent[0])))) return { gate: gate(`Your saved travel pack does not include a ${absent[0]}.`, `sight:${absent[0]}`), view: { kind: 'sights', places: [] } };
  let pool = (pack.places ?? []).filter((p) => p.kind === 'sight' && p.id !== here.id);
  const sightHead = typeText ?? t.split(/\b(?:near|around|close to|next to|by|from)\b/)[0];
  const filters = SIGHT_TYPES.filter(([re]) => re.test(sightHead));
  const typeFilter = filters.map(([, , label]) => label).filter(Boolean);
  for (const [, ok] of filters) pool = pool.filter(ok);
  if (!pool.length) return { gate: gate('Your saved travel pack does not list a sight of that kind.', 'sight:none'), view: { kind: 'sights', places: [] } };
  // things inside the same palace as "here" are not "nearby sights" to walk to; keep them but they rank as they are
  let cards = pool.map((p) => cardOf(p)).sort((a, b) => a.walkM - b.walkM);
  let note = '';
  if (now || asked) {
    const days = (c) => c.open.state === 'open' && /does not say which days/.test(c.open.text ?? '');
    const okNow = [...cards.filter((c) => (c.open.state === 'open' && !days(c)) || c.open.state === 'outdoor'), ...cards.filter(days).map((c) => ({ ...c, unconfirmed: true }))];
    if (!okNow.length) {
      const list = cards.slice(0, 3).map((c, i) => ({ ...c, rank: i + 1 }));
      return { gate: gate(`None of the ${typeFilter.length ? typeFilter.join(' or ') : 'sights'} in your saved pack is open at ${momentText(m)}.`, 'sight:none-open', { found: true }), view: { kind: 'sights', places: list, focus: list[0]?.id ?? null, route: walk(pack, here, placeById(pack, list[0]?.id)), typeFilter, openFirst: true, openAt: momentText(m) } };
    }
    cards = [...okNow, ...cards.filter((c) => c.open.state === 'unknown')];
    note = `Places open at ${momentText(m)} and outdoor places come first. “Hours not confirmed”: the source gives times but not the days. Places with no hours in the pack come last.`;
  }
  const list = cards.slice(0, 4).map((c, i) => ({ ...c, rank: i + 1 }));
  const route = walk(pack, here, placeById(pack, list[0].id));
  const lines = list[0].intro ? [line(list[0], { withOpen: false, withWalk: false, withPrice: PRICE_RE.test(t) })] : [];
  return { gate: null, view: { kind: 'sights', places: list, focus: list[0].id, route, note, typeFilter, openFirst: !!(now || asked), openAt: momentText(m) }, lines, hintKey: 'sights' };
}

// ---------------------------------------------------------------- route
function routePlan(pack, q, t, { here, m, cardOf, named, dist }) {
  // "from A to B" starts at A; "to B" ends at B; a kind ("nearest toilet") ends at the nearest of that kind.
  const fromPart = t.match(/\bfrom (.+?) to /)?.[1] ?? null;
  const fromPlace = fromPart ? placeFromPhrase(pack, fromPart, here) : null;
  const origin = fromPlace && fromPlace !== 'here' ? fromPlace : here;
  if (!origin) return { gate: gate('Choose where you are first ("I am here"), so the app can work out the walk.', 'no-here'), view: { kind: 'route', places: [] } };
  const toTail = t.match(/\b(?:get to|go to|getting to|way to|walk to|walking to|take me to|head to|reach|directions to|route to|how far is|how far to|to)\s+(?:the\s+)?(.+?)(?:\s+from\b.*)?[?.!]*$/)?.[1] ?? null;
  let target = null;
  const namedNotOrigin = named.filter((p) => p.id !== origin.id);
  // "Is there a pharmacy near Insa-dong?": a kind of place, the nearest one to the place after "near" (or to the start)
  const nearTail = t.match(/\b(?:near|around|close to|next to)\s+(?:the\s+)?(.+?)[?.!]*$/)?.[1] ?? null;
  const nearRef = nearTail ? placeFromPhrase({ ...pack, places: pack.places.filter((p) => !FOOD_KINDS.has(p.kind)) }, nearTail, here) : null;
  const head = t.split(/\b(?:near|around|close to|next to)\b/)[0];
  const kindAsked = /\b(nearest|closest|a|an|any|some|is there|are there|need|find)\b/.test(head) ? Object.entries(PLACE_KIND_WORDS).find(([, re]) => re.test(head))?.[0] ?? null : null;
  if (kindAsked) {
    const from = nearRef && nearRef !== 'here' ? nearRef : origin;
    const pool = (pack.places ?? []).filter((p) => p.kind === kindAsked && p.id !== from.id);
    if (!pool.length) return { gate: gate(`Your saved travel pack does not include any ${kindAsked === 'atm' ? 'ATM' : kindAsked}.`, `kind:${kindAsked}`), view: { kind: 'route', places: [] } };
    const d = from === here ? dist : walkMetersFrom(pack, from);
    target = pool.sort((x, y) => d.get(x.id) - d.get(y.id))[0];
  }
  const destPhrase = toTail ? toTail.replace(/^(?:(?:walk|walking|go|get|head|run|come)\s+)?(?:back\s+)?(?:to\s+)?(?:the\s+)?/, '').split(/[?.!,;]|\s(?:is|are|please|from|on|by|walking|walkable|quickly|now|today|asap|and|so|then|for|if|with|it)\b/)[0].trim() : null;
  if (!target && destPhrase) { const p = placeFromPhrase(pack, destPhrase, origin); if (p && p !== 'here') target = p; }
  // K24: a destination phrase with a landmark word the chosen place's name lacks, or with a word the pack never uses,
  // names something else ("n seoul tower" is not "Seoul Museum of Craft Art")
  if (target && destPhrase && !kindAsked) {
    const ws = words(destPhrase).filter((w) => w.length > 1 && !STOP.has(w) && !['the', 'a', 'an', 'of'].includes(w));
    const nw = words(target.name);
    const own = new Set([...nw, ...nw.map(stem), ...nw.slice(1).map((w, i) => nw[i] + w)]);
    const LANDMARK = /^(tower|towers|market|markets|mall|bridge|mountain|river|stream|stadium|hotel|university|hospital|airport|terminal|cathedral|church|plaza|park|palace|temple|museum|gate|station|square|street|village|hall|centre|center|building|shrine|garden|gardens)$/;
    const missing = ws.filter((w) => !wordIn(own, w));
    if (ws.length >= 2 && missing.some((w) => (LANDMARK.test(w) && !own.has(w)) || !vocab(pack).has(w))) return { gate: gate(`Your saved travel pack does not include ${destPhrase}.`, `name:${destPhrase}`), view: { kind: 'route', places: [] } };
  }
  if (!target && namedNotOrigin.length) target = namedNotOrigin[namedNotOrigin.length > 1 && fromPlace ? 1 : 0] ?? namedNotOrigin[0];
  if (target && origin && target.id === origin.id && namedNotOrigin.length) target = namedNotOrigin[0];
  // a destination phrase that matches no saved place: say the pack does not include it
  if (!target && destPhrase && words(destPhrase).some((w) => w.length > 1 && !STOP.has(w))) return { gate: gate(`Your saved travel pack does not include ${destPhrase}. Try a name from the list of places.`, `name:${destPhrase}`), view: { kind: 'route', places: [] } };
  if (!target) return { gate: gate('I could not find that place in your saved travel pack. Try its name as it appears in the list of places.', 'route:no-target'), view: { kind: 'route', places: [] } };
  return routeAnswer(pack, origin, target, { here, m, cardOf });
}

/** The walk from one saved place to another: steps, map line, ticket note and the lines for the model. */
function routeAnswer(pack, origin, target, { here, m, cardOf }) {
  const w = walk(pack, origin, target);
  if (w?.same) { const c0 = cardOf(target); return { gate: gate(`${w.summary} ${cap1(c0.open.short)}.`, 'route:here', { found: true }), view: { kind: 'route', places: [c0], focus: target.id } }; }
  if (!w) return { gate: gate(`Your saved pack has no walking path to ${target.name}.`, 'route:no-path'), view: { kind: 'route', places: [cardOf(target)] } };
  const c = { ...cardOf(target), walkM: w.meters, walkText: kmText(w.meters), dir: w.dir };
  const ticket = w.ticketPlace ? placeById(pack, w.ticketPlace) : null;
  const ticketView = ticket ? { id: ticket.id, name: ticket.name, open: cardOf(ticket).open } : null;
  const startNote = origin !== here ? `Start: ${origin.name}.` : `Start: ${origin.name} (where you are).`;
  const lines = [
    `[${target.id}] Destination: ${target.name} (${target.type}).${c.intro ? ` About: ${c.intro}` : ''}`,
    `${startNote}${w.ticketArea ? ` Part of the walk is inside the ticketed grounds of ${ticket?.name ?? 'the palace'}.` : ''}${w.door ? ` The walk ends at ${w.doorName}, the main gate.` : ''}`,
    ...(target.tip && target.tip !== c.intro ? [`Tip: ${target.tip}`] : []),
  ];
  return { gate: null, view: { kind: 'route', places: [c], focus: target.id, route: w, origin: { id: origin.id, name: origin.name }, ticket: ticketView }, lines, hintKey: 'route' };
}

// ---------------------------------------------------------------- identify
function identifyPlan(pack, q, t, { here, m, cardOf, dist }) {
  const pool = (pack.places ?? []).filter((p) => p.looks || p.kind === 'sight');
  const terms = expand([...new Set(words(q).map(stem).filter((w) => !STOP.has(w) && !['see', 'look', 'front', 'thi', 'that', 'what', 'big', 'larg', 'there', 'building'].includes(w)))], LOOK_SYNONYMS).map(stem);
  const known = new Set(pool.flatMap((p) => words(`${p.looks ?? ''} ${p.name} ${p.type} ${p.about ?? ''}`).map(stem)));
  const near1 = (a, b) => { if (Math.abs(a.length - b.length) > 1 || a[0] !== b[0]) return false; let i = 0, j = 0, d = 0; while (i < a.length && j < b.length) { if (a[i] === b[j]) { i += 1; j += 1; continue; } d += 1; if (d > 1) return false; if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; } } return d + (a.length - i) + (b.length - j) <= 1; };
  for (const w of [...terms]) if (w.length >= 6 && !known.has(w)) { const k = [...known].find((x) => x.length >= 5 && near1(w, x)); if (k) terms.push(k); }
  const scored = scoreEntries({ places: pool }, terms, (p) => [[p.looks, 2], [p.name, 2], [p.type, 2], [p.about, 1]]);
  for (const s of scored) {
    const d = here ? dist.get(s.p.id) : null;
    // nearer things are more likely what the traveller sees; within 300 m counts most
    if (d != null) s.s *= d < 150 ? 1.5 : d < 300 ? 1.35 : d < 600 ? 1.15 : d < 1200 ? 1 : 0.85;
  }
  const top = scored.filter((s) => s.s > 0).sort((a, b) => b.s - a.s).slice(0, 5);
  if (!top.length) return { gate: gate('Your saved travel pack has no landmark that matches this description.', 'identify:none'), view: { kind: 'identify', places: [] } };
  const cards = top.map((s, i) => ({ ...cardOf(s.p), rank: i + 1, looks: s.p.looks, score: Number(s.s.toFixed(2)) }));
  const lines = cards.map((c) => `[${c.id}] ${c.name} (${c.type})${c.walkText ? `, ${c.walkText} from where you said you are` : ''}. Looks like: ${c.looks ?? 'no description in the pack'}`);
  return { gate: null, view: { kind: 'identify', places: cards, focus: null }, lines, hintKey: 'identify', ids: cards.map((c) => c.id) };
}

// ---------------------------------------------------------------- other
function otherPlan(pack, q, t, { here, m, cardOf, named, asked, now, force = null, explicit = false }) {
  const terms = [...new Set(words(q).map(stem).filter((w) => !STOP.has(w)))];
  let targets = named.slice(0, 2);
  if (!targets.length) {
    const runs = [...String(q).matchAll(/\b[A-Z][a-z]+(?:[ -][A-Z][a-z]+)+\b/g)].map((x) => fold(x[0])).filter((r) => words(r).some((w) => !STOP.has(w)));
    const factText = (p) => fold([p.name, p.tip, p.price?.text, p.hours?.note, p.hours?.text, ...(p.events ?? []).map((e) => `${e.name} ${e.note ?? ""}`)].filter(Boolean).join(" "));
    const inFacts = runs.length ? (pack.places ?? []).filter((p) => runs.some((r) => factText(p).includes(r))) : [];
    const holder = inFacts.length ? inFacts : runs.length ? (pack.places ?? []).filter((p) => runs.some((r) => placeText(p).includes(r))) : [];
    if (holder.length === 1) targets = holder;
  }
  if (!targets.length) {
    const scored = scoreEntries(pack, terms, (p) => [[p.name, 3], [p.type, 2], [p.about, 1], [p.tip, 1], [p.dish, 1], [p.hours?.note, 1], [(p.events ?? []).map((e) => `${e.name} ${e.note ?? ''}`).join(' '), 2]]).filter((s) => s.s > 0).sort((a, b) => b.s - a.s);
    targets = scored.slice(0, 2).map((s) => s.p);
  }
  const notes = (pack.notes ?? []).filter((n) => terms.some((w) => words(`${n.topic} ${n.text}`).map(stem).includes(w)));
  const wantPrice = PRICE_RE.test(t);
  const wantPhone = PHONE_RE.test(t);
  const wantAddress = ADDRESS_RE.test(t);
  const wantEvents = EVENT_RE.test(t);
  const wantHours = force === 'hours' || (wantEvents ? /\b(open|opens|opening|close|closes|closing|closed|hours?)\b/.test(t) : OPEN_RE.test(t) || asked || now);
  const p0 = targets[0];
  // a place the question names, even by a word many names share ("Gwanghwamun")
  const isNamed = explicit || named.length > 0 || (!!p0 && words(q).some((w) => w.length > 4 && words(p0.name).includes(w)));
  // asked for a field this place does not have: say so (code), do not let the model talk around it
  if (p0 && isNamed) {
    if (wantPrice && !p0.price && !(p0.hours?.inside && placeById(pack, p0.hours.inside)?.price)) return { gate: gate(`Your saved travel pack has no price for ${p0.name}.`, 'field:price'), view: { kind: 'other', places: [cardOf(p0)], focus: p0.id } };
    if (wantPhone && !p0.phone) return { gate: gate(`Your saved travel pack has no phone number for ${p0.name}.`, 'field:phone'), view: { kind: 'other', places: [cardOf(p0)], focus: p0.id } };
    if (wantHours && !wantPrice && !wantEvents && p0.hours?.status === 'unknown') return { gate: gate(`Your saved travel pack has no opening hours for ${p0.name}${p0.hours?.note ? '' : ' (they were not found in the sources)'}.`, 'field:hours', { found: true }), view: { kind: 'other', places: [cardOf(p0)], focus: p0.id } };
    if (wantEvents && !(p0.events?.length) && !(p0.hours?.inside && placeById(pack, p0.hours.inside)?.events?.length)) return { gate: gate(`Your saved travel pack has no tours or events for ${p0.name}.`, 'field:events'), view: { kind: 'other', places: [cardOf(p0)], focus: p0.id } };
  }
  if (!targets.length && !notes.length) return { gate: gate('Your saved travel pack does not include this.', 'other:none'), view: { kind: 'other', places: [] } };
  if (p0 && isNamed && (wantHours || wantPrice || wantPhone || wantAddress || wantEvents)) {
    const c = cardOf(p0);
    const inside = p0.hours?.inside ? placeById(pack, p0.hours.inside) : null;
    const priceOf = p0.price ?? inside?.price ?? null;
    const ev = p0.events?.length ? p0.events : inside?.events ?? [];
    const out = [];
    if (wantHours) out.push(/^At /.test(c.open.text) ? c.open.text.replace(/^At /, `${p0.name}, at `) : `${p0.name}: ${c.open.text}`, ...(c.open.state === 'unknown' || c.open.state === 'outdoor' ? [] : [`This week: ${c.week}.`]));
    if (wantHours && p0.hours?.closed?.text && !/^(Tourist|Every|Closed)/.test(p0.hours.closed.text)) out.push(`Closing days as written: ${p0.hours.closed.text}`);
    if (wantPrice && priceOf) out.push(`Price for ${inside && !p0.price ? `${inside.name} (it is inside)` : p0.name}: ${priceOf.text} (${priceOf.from}).`);
    if (wantPhone && p0.phone) out.push(`Phone for ${p0.name}: ${p0.phone}.`);
    if (wantAddress) out.push(`Address of ${p0.name}: ${[p0.address, p0.addressKo].filter(Boolean).join(' / ') || 'not in the pack'}.`);
    if (wantEvents && ev.length) out.push(`At ${p0.name}: ${ev.map((e) => `${e.name}${e.when ? ` ${e.when}` : ''}${e.note ? ` (${e.note})` : ''}`).join('; ')}.`);
    if (out.length) return { gate: gate(out.join(' '), 'other:lookup', { found: true }), view: { kind: 'other', places: [c], focus: p0.id } };
  }
  const lines = [];
  const cards = [];
  for (const p of targets) {
    const c = cardOf(p);
    cards.push(c);
    const parts = [`[${p.id}] ${p.name} (${p.type}).`];
    if (c.walkText && here && p.id !== here.id) parts.push(`From you: ${c.walkText}, ${c.dir}.`);
    if (p.about) parts.push(`About: ${firstSentence(p.about)}`);
    if (wantHours || !(wantPrice || wantPhone || wantAddress || wantEvents)) parts.push(c.open.text, `Week: ${c.week}.`);
    if (wantHours && p.hours?.note) parts.push(`Hours note: ${p.hours.note}`);
    if (wantHours && p.hours?.closed?.text) parts.push(`Closing days as written: ${p.hours.closed.text}`);
    const priceOf = p.price ?? (p.hours?.inside ? placeById(pack, p.hours.inside)?.price : null);
    if (wantPrice && priceOf) parts.push(`Price: ${priceOf.text} (${priceOf.from}).`);
    if (wantPhone && p.phone) parts.push(`Phone: ${p.phone}.`);
    if (wantAddress) parts.push(`Address: ${[p.address, p.addressKo].filter(Boolean).join(' / ') || 'not in the pack'}.`);
    const ev = p.events?.length ? p.events : p.hours?.inside ? placeById(pack, p.hours.inside)?.events ?? [] : [];
    if (wantEvents && ev.length) parts.push(`Events: ${ev.map((e) => `${e.name}${e.when ? ` ${e.when}` : ''}${e.note ? ` (${e.note})` : ''}`).join('; ')}.`);
    if (p.tip) parts.push(`Tip: ${p.tip}`);
    lines.push(parts.join(' '));
  }
  for (const n of notes.slice(0, 2)) lines.push(`[${n.id}] ${n.topic}: ${n.text}`);
  return { gate: null, view: { kind: 'other', places: cards, focus: cards[0]?.id ?? null }, lines, hintKey: 'other' };
}
