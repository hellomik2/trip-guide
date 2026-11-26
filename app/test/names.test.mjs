// Place-name matching (src/engine/trip/names.js) on names written the way travellers write them.
// These cases were written while building the matcher; they are not the judge questions.
//   node test/names.test.mjs
import { readFileSync } from 'node:fs';
import { matchPlace } from '../src/engine/trip/names.js';

const pack = JSON.parse(readFileSync(new URL('../packs/seoul-gogung/pack.json', import.meta.url), 'utf8'));
const byId = (id) => pack.places.find((p) => p.id === id);
const here = byId('L25');

// [phrase, expected id or 'none' or 'here' or 'empty', optional status]
const CASES = [
  ['Gyeongbokgung Palace', 'L01', 'exact'], ['gyeongbokgung', 'L01'], ['Gyeongbok Palace', 'L01'], ['gyeongbukgung', 'L01'], ['Kyungbokgung', 'L01'],
  ["Gyeongbokgung's", 'L01'], ['gyeong bok gung', 'L01'], ['Gyeongbokgung Station', 'S01'], ['gyeongbokgung stn exit 5', 'S01'],
  ['Gwanghwamun', null], ['gwanghwamoon gate', 'L02'], ['Gwanghwa Gate', 'L02'], ['Gwanghwamun Square', 'L10'], ['gwanghwamun sq', 'L10'],
  ['Changdeokgung', 'L23'], ['Changdeok Palace', 'L23'], ['changdukgung', 'L23'], ['Donhwamun', 'L23'],
  ['Jogyesa', 'L24'], ['jogyesa temple', 'L24'], ['Jogye Temple', 'L24'], ['jogeysa', 'L24'],
  ['Insadong', 'L25'], ['insa-dong street', 'L25'], ['Insadong-gil', 'L25'], ['Ssamziegil', 'L26'], ['samzigil', 'L26'],
  ['MMCA', 'L14'], ['mmca seoul', 'L14'], ['modern art museum', 'L14'], ['National Museum of Modern and Contemporary Art', 'L14'],
  ['folk museum', 'L09'], ['National Folk Museum', 'L09'], ['palace museum', 'L08'], ['contemporary history museum', 'L13'],
  ['craft museum', 'L21'], ['Seoul Museum of Craft Art', 'L21', 'exact'], ['kimchi museum', 'L27'], ['Tapgol Park', 'L28'], ['tapgol', 'L28'],
  ['Bukchon Hanok Village', 'L17', 'exact'], ['bukchon village', 'L17'], ['Bukchon', 'L17'], ['bukchon observatory', 'L19'], ['Gahoe-dong alley', 'L18'],
  ['Ikseon-dong', 'L30'], ['ikseondong', 'L30'], ['Unhyeongung', 'L22'], ['Baek In-je House', 'L20'], ['Cheondogyo', 'L29'],
  ['Hyangwonjeong', 'L06'], ['gyeonghoeru', 'L05'], ['Geunjeongjeon', 'L04'], ['Heungnyemun', 'L03'], ['Dongsipjagak', 'L07'],
  ['King Sejong statue', 'L11'], ['statue of admiral yi', 'L12'], ['Jeongdok Library', 'L16'], ['Samcheong-ro', 'L15'], ['samcheongdong', 'L15'],
  ['Anguk Station Exit 6', 'S04', 'exact'], ['anguk stn exit 6', 'S04'], ['Anguk station exit 2', 'S03'], ['Jongno 3-ga Station', 'S06'],
  ['Osegyehyang', 'F15'], ['Can Dumplings', 'F16'], ['kkangtong mandu', 'F16'], ['Tteoksang', 'F12'], ['Artist Bakery', 'F10'], ['Namusae', 'F17'],
  ['Imun Seolleongtang', 'F01'], ['Jeontong Dawon', 'F18'], ['Sinrajemyeon', 'F06'], ['Samcheongdong Hotteok', 'F19'],
  ['changing of the guard ceremony', 'L02'],
  ['N Seoul Tower', 'none'], ['n seoul tower', 'none'], ['namsan tower', 'none'], ['Lotte World Tower', 'none'], ['Myeongdong', 'none'], ['myeong-dong', 'none'],
  ['Gwangjang Market', 'none'], ['Dongdaemun', 'none'], ['Dongdaemun Design Plaza', 'none'], ['DDP', 'none'], ['Starbucks', 'none'], ['Deoksugung', 'none'],
  ['Changgyeonggung', 'none'], ['Jongmyo Shrine', 'none'], ['Samseong', 'none'], ['Gyeonghuigung', 'none'], ['Insadong market', 'none'], ['Bukchon tower', 'none'],
  ['Hongdae', 'none'], ['Itaewon', 'none'], ['Cheonggyecheon', 'none'], ['COEX', 'none'], ['Seoul Station', 'none'],
  ['here', 'here'], ['my hotel', 'here'], ['Seoul', 'empty'], ['the', 'empty'],
  // words for where the traveller is, or of the asking, copied as the place by the model: no name at all
  ['near me', 'empty'], ['from here', 'empty'], ['close to me', 'empty'], ['right here', 'empty'], ['where could we go', 'empty'], ['where do i go from here', 'empty'],
  ['somewhere nearby for us', 'empty'], ['what is close by', 'empty'],
  // the same words around a real name: the name still counts, and a name the pack lacks is still missing
  ['where is jogyesa', 'L24'], ['how do i get to tapgol park', 'L28'], ['tapgol park from here', 'L28'], ['namsan tower from here', 'none'],
  ['the palace', 'L01'], ['the station', null], ['anguk station', null],
];

let bad = 0;
for (const [phrase, want, status] of CASES) {
  const r = matchPlace(pack, phrase, { here });
  const got = r.status === 'none' ? 'none' : r.status === 'here' ? 'here' : r.status === 'empty' ? 'empty' : r.place?.id;
  const ok = want === null ? r.status === 'guess' : got === want && (!status || r.status === status);
  if (!ok) bad += 1;
  if (!ok || process.argv.includes('-v')) console.log(`${ok ? 'ok ' : 'BAD'} ${JSON.stringify(phrase)} -> ${got} (${r.status}${r.how ? `, ${r.how}` : ''})${want === null ? ' want guess' : ` want ${want}${status ? ` ${status}` : ''}`}${r.candidates?.length ? ` · also: ${r.candidates.map((p) => p.id).join(',')}` : ''}`);
}
console.log(`${CASES.length - bad}/${CASES.length} ok`);

// Kind words against names (guide.js plan): a phrase of kind words written before "near / around / at …" is what the traveller
// looks for, even when a saved name holds the same words; a sights reading of a question about one named place is about it.
// The forms are what the on-device model might write; the questions are not the judge questions.
const { kindWordsOnly } = await import('../src/engine/trip/names.js');
const { plan } = await import('../src/engine/trip/guide.js');
const { readUnderstood } = await import('../src/engine/tasks/trip.js');
const KIND_CASES = [['art museums', true], ['the tea house', true], ['old palaces', true], ['palace museum', true], ['Traditional Tea House', false], ['MMCA Seoul', false],
  ['craft museum', false], ['modern art museum', false], ['Insa-dong street', false], ['near me', false], ['dumpling place', false]];
let bad2 = 0;
for (const [phrase, want] of KIND_CASES) {
  const got = kindWordsOnly(phrase);
  if (got !== want) { bad2 += 1; console.log(`BAD kindWordsOnly(${JSON.stringify(phrase)}) = ${got}, want ${want}`); }
}
// [question, here, the model's form, kind wanted, place status wanted ('empty' = no place taken), place id wanted (or null)]
const PLAN_CASES = [
  ['is there a nice art museum around this area?', 'L25', { kind: 'sights', place: 'art museum' }, 'sights', 'empty', null],
  ['we want a tea house, anything close?', 'L22', { kind: 'food', place: 'tea house', food: 'tea' }, 'food', 'empty', null],
  ['any dumpling place nearby?', 'L28', { kind: 'food', place: 'dumpling place', food: 'dumplings' }, 'food', 'empty', null],
  ['are there art museums worth a look', 'S04', { kind: 'other', place: 'art museums' }, 'sights', 'empty', null],
  ['Are there cafes at the palace museum?', 'L10', { kind: 'food', place: 'palace museum' }, 'food', 'close', 'L08'],
  ['any good dumpling place near Tapgol Park?', 'L24', { kind: 'food', place: 'Tapgol Park', food: 'dumplings' }, 'food', 'exact', 'L28'],
  ['What is Bukchon Observatory like?', 'L25', { kind: 'sights', place: 'Bukchon Observatory' }, 'other', 'exact', 'L19'],
  ['What else is there to see near Jogyesa?', 'L25', { kind: 'sights', place: 'Jogyesa' }, 'sights', 'close', 'L24'],
];
for (const [q, here, form, kind, status, id] of PLAN_CASES) {
  const u = { ...readUnderstood({ from: '', food: '', time: 'any', also: '', ...form }, q), by: 'device' };
  const p = plan(pack, q, { hereId: here, at: '2026-11-28T11:00', understood: u });
  const und = p.view?.understood ?? {};
  const ok = p.kind === kind && und.status === status && (und.place?.id ?? null) === id;
  if (!ok) bad2 += 1;
  if (!ok || process.argv.includes('-v')) console.log(`${ok ? 'ok ' : 'BAD'} ${JSON.stringify(q)} ${JSON.stringify(form)} -> ${p.kind} ${und.status} ${und.place?.id ?? '-'} want ${kind} ${status} ${id ?? '-'}`);
}
console.log(`${KIND_CASES.length + PLAN_CASES.length - bad2}/${KIND_CASES.length + PLAN_CASES.length} kind-word cases ok`);
process.exit(bad || bad2 ? 1 : 0);
