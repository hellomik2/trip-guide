// Tests for the sign reader's answer reading (src/engine/tasks/sign.js). No AI, no browser.
//   node test/sign.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { signTask, readText, splitPrice, splitLines, textPrompt, textConstraint, tryOrder, SIGN_SYSTEM, PHOTO_PROMPT, PHOTO_NOTE, LINES_DEVICE_NOTE } from '../src/engine/tasks/sign.js';
import { formKeepsRules, wholeSentences } from '../src/engine/tasks/trip.js';
import { UNDERSTAND_SCHEMA, ANSWER_SCHEMA, identifySchema } from '../src/engine/trip/prompts.js';
import { cloudSchema } from '../src/engine/partial-json.js';

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('ok', name); };

t('lines: blank lines and spaces are dropped', () => {
  assert.deepEqual(splitLines(' 떡볶이 4,000원 \r\n\n순대   4,500원\n'), ['떡볶이 4,000원', '순대 4,500원']);
});

t('prompt numbers every line', () => {
  assert.match(textPrompt(['매표소']), /1\. 매표소\n/);
  assert.match(textPrompt(['a', 'b']), /exactly 2 numbered lines/);
});

t('typed text: numbered answers pair with the typed lines; extra numbers are not shown', () => {
  const prep = signTask.prepare({ text: '떡볶이 4,000원\n순대 4,500원' });
  const r = readText('1. Tteokbokki (spicy rice cakes): 4,000 won\n2. Sundae (Korean blood sausage): 4,500 won\n3. Eomuk (fish cake): 1,000 won\nTo do: Order by name.', prep);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[1].ko, '순대 4,500원');
  assert.match(r.rows[1].en, /^Sundae/);
  assert.equal(r.todo, 'Order by name.');
  assert.equal(r.extra.length, 1);
});

t('typed text: one line without a number, markdown and Korean echo removed', () => {
  const prep = signTask.prepare({ text: '매표소' });
  assert.equal(readText('Ticket office.\n**To do:** Buy your tickets here.', prep).rows[0].en, 'Ticket office.');
  assert.equal(readText('1. **매표소 = Ticket office**\nTo do: Buy tickets here.', prep).rows[0].en, 'Ticket office');
  assert.equal(readText('1. Ticket office\nTo do: Buy tickets here.', prep).todo, 'Buy tickets here.');
});

t('typed text: Korean repeated before the meaning, or alone on the numbered line (pipe answers 11-24)', () => {
  const p1 = signTask.prepare({ text: '손을 씻어 주세요' });
  assert.equal(readText('1. 손을 씻어 주세요: Please wash your hands.\nTo do: Wash your hands.', p1).rows[0].en, 'Please wash your hands.');
  const p2 = signTask.prepare({ text: '칼국수 8,000원\n수제비 8,000원' });
  const r2 = readText('1. 칼국수 8,000원 - Noodles in a broth, 8,000 won.\n2. 수제비 8,000원 - Hand-torn dough soup, 8,000 won.\nTo do: Order.', p2);
  assert.deepEqual(r2.rows.map((x) => x.en), ['Noodles in a broth, 8,000 won.', 'Hand-torn dough soup, 8,000 won.']);
  const p3 = signTask.prepare({ text: '엘리베이터는 왼쪽에 있습니다' });
  const r3 = readText('1. 엘리베이터는 왼쪽에 있습니다\nThe elevator is on the left.\n\nTo do: Go left for the elevator.', p3);
  assert.equal(r3.rows[0].en, 'The elevator is on the left.');
  assert.equal(r3.extra.length, 0);
  const p4 = signTask.prepare({ text: '영업시간 11:30~21:00' });
  assert.equal(readText('1. 영업시간 11:30~21:00: Opening hours 11:30 to 21:00', p4).rows[0].en, 'Opening hours 11:30 to 21:00');
  assert.equal(readText('1. 칼국수 (Kalguksu, knife-cut noodles): 8,000 won', p2).rows[0].en, '(Kalguksu, knife-cut noodles): 8,000 won');
  assert.equal(readText('1. 칼국수 8,000 won (Knife soup 8,000 won)', p2).rows[0].en, 'Knife soup 8,000 won');
  // all Korean lines first, then the English lines without numbers (pipe answer 11-24)
  const r5 = readText('1. 칼국수 8,000원\n2. 수제비 8,000원\n\nKalguksu (knife-noodle soup), 8,000 won\nSujebi (hand-pulled flour soup), 8,000 won\n\nTo do: Choose one.', p2);
  assert.deepEqual(r5.rows.map((x) => x.en), ['Kalguksu (knife-noodle soup), 8,000 won', 'Sujebi (hand-pulled flour soup), 8,000 won']);
  assert.equal(signTask.finish('1. 엘리베이터는 왼쪽에 있습니다. (Elevator is on the left)\nTo do: Look left.', p3).rows[0].enText, 'Elevator is on the left');
});

t('typed text: a missing line is marked, not filled', () => {
  const prep = signTask.prepare({ text: '평일 10:00~22:00\n주말 11:00~20:00' });
  const r = readText('1. Weekdays: 10:00 to 22:00', prep);
  assert.equal(r.rows[1].missing, true);
  assert.deepEqual(r.missing, ['주말 11:00~20:00']);
});

t('photo: "Korean = English" lines, Korean:/English: pairs, unreadable', () => {
  const prep = signTask.prepare({ image: { data: 'AAAA', mimeType: 'image/jpeg' } });
  const r = readText('미끄럼 주의 = Caution, slippery floor\nTo do: Walk carefully.', prep);
  assert.deepEqual(r.rows, [{ ko: '미끄럼 주의', en: 'Caution, slippery floor' }]);
  const r2 = readText('Korean: 금연 건물\nEnglish: Non-smoking building.', prep);
  assert.deepEqual(r2.rows, [{ ko: '금연 건물', en: 'Non-smoking building.' }]);
  assert.equal(readText('No readable Korean text.', prep).unreadable, true);
});

t('finish: device photos carry the note; cloud photos do not', () => {
  const prep = signTask.prepare({ image: { data: 'AAAA', mimeType: 'image/png' } });
  assert.equal(signTask.finish('출입금지 = No entry\nTo do: Do not go in.', prep, 'device').note, PHOTO_NOTE);
  assert.equal(signTask.finish('출입금지 = No entry\nTo do: Do not go in.', prep, 'cloud').note, null);
  assert.equal(signTask.finish('No readable Korean text.', prep, 'cloud').found, false);
});

t('price is split off the end of a menu line', () => {
  assert.deepEqual(splitPrice('Tteokbokki (spicy rice cakes): 4,000 won'), { text: 'Tteokbokki (spicy rice cakes)', price: '4,000 won' });
  assert.deepEqual(splitPrice('Gukbap (rice in soup) ₩7,000'), { text: 'Gukbap (rice in soup)', price: '7,000 won' });
  assert.equal(splitPrice('Open 11:00 to 21:00').price, null);
  assert.equal(splitPrice('The restroom is on the 2nd floor.').price, null);
  assert.equal(splitPrice('Fine of up to 100,000 won if you smoke').price, null);
  assert.equal(splitPrice('A fine of 100,000 won').price, null);
  assert.equal(splitPrice('gukbap (takeout - 7,000 won)').price, null);
  assert.deepEqual(splitPrice('Sundubu-jjigae (soft tofu stew) 9,000 won'), { text: 'Sundubu-jjigae (soft tofu stew)', price: '9,000 won' });
  assert.deepEqual(splitPrice('Bibimbap, one serving – 10,000 won.'), { text: 'Bibimbap, one serving', price: '10,000 won' });
});

t('input checks: empty, no Korean, bad file', () => {
  assert.throws(() => signTask.prepare({ text: '  ' }), /Type or paste/);
  assert.throws(() => signTask.prepare({ text: 'hello' }), /no Korean/);
  assert.throws(() => signTask.prepare({ image: { data: 'x', mimeType: 'text/plain' } }), /not a photo/);
});

t('routing: two or more typed lines go to the cloud first while online and allowed; one line stays on this device first', () => {
  assert.equal(signTask.prepare({ text: '매표소' }).cloudFirst, false);
  assert.equal(signTask.prepare({ text: '칼국수 8,000원\n\n수제비 8,000원' }).cloudFirst, true); // blank lines do not count
  assert.equal(signTask.order, tryOrder);
  assert.deepEqual(tryOrder({ cloudFirst: true, online: true, locked: false }), ['cloud', 'device']);
  assert.deepEqual(tryOrder({ cloudFirst: true, online: false, locked: false }), ['device', 'cloud']);
  assert.deepEqual(tryOrder({ cloudFirst: true, online: true, locked: true }), ['device', 'cloud']);
  assert.deepEqual(tryOrder({ cloudFirst: false, online: true, locked: false }), ['device', 'cloud']);
});

t('note: several lines read on this device get the menu note; the cloud and one line get none', () => {
  const two = signTask.prepare({ text: '칼국수 8,000원\n수제비 8,000원' });
  const ans = '1. Kalguksu (knife-cut noodle soup), 8,000 won\n2. Sujebi (hand-torn dough soup), 8,000 won\nTo do: Order by name.';
  assert.equal(signTask.finish(ans, two, 'device').note, LINES_DEVICE_NOTE);
  assert.equal(signTask.finish(ans, two, 'cloud').note, null);
  assert.equal(signTask.finish('Ticket office.', signTask.prepare({ text: '매표소' }), 'device').note, null);
  assert.doesNotMatch(LINES_DEVICE_NOTE, /[가-힣]/);
});

t('prompts are the ones measured (sha256 fingerprints recorded before the runs)', () => {
  const h = (x) => createHash('sha256').update(x).digest('hex').slice(0, 16);
  assert.equal(h(SIGN_SYSTEM), 'ab6bd5fc12c8766c'); // 26 Nov: two sentences added for both on-device models; before: 4f9bd0411a41561c
  assert.equal(h(textPrompt(['{line 1}'])), '4ead2335410207dd');
  assert.equal(h(textPrompt(['{line 1}', '{line 2}'])), '58a20be3e848d6d0');
  assert.equal(h(PHOTO_PROMPT), '795e5916bba74a87');
});

// ---- 26 Nov: answers bounded for both on-device models
t('on-device text answers: one numbered English line per Korean line, then To do, no Korean letters', () => {
  const one = textConstraint(1);
  assert.ok(one.test('1. Pull\nTo do: Pull the door.'));
  assert.ok(!one.test('1. 당기세요\nTo do: Pull.'));
  assert.ok(!one.test('To do: Please take off your shoes.'));
  assert.ok(!one.test('1. Open from 11시 to 9시\nTo do: Visit.'));
  const two = textConstraint(2);
  assert.ok(two.test('1. Tteokbokki (spicy rice cakes), 4,000 won\n2. Eomuk (fish cake), 1,000 won\nTo do: Order by name.'));
  assert.ok(!two.test('1. Tteokbokki, 4,000 won\nTo do: Order.'));
  assert.ok(signTask.prepare({ text: '매표소' }).deviceConstraint instanceof RegExp);
});

t('a line number written twice is dropped from the meaning', () => {
  const p = signTask.prepare({ text: '금일 휴무' });
  assert.equal(readText('1. 1. Closed today\nTo do: Come back tomorrow.', p).rows[0].en, 'Closed today');
  assert.equal(readText('1. 1 person bibimbap 10,000 won\nTo do: Order.', p).rows[0].en, '1 person bibimbap 10,000 won');
});

t('question form: free-text fields bounded on the device, not for the cloud', () => {
  for (const k of ['place', 'from', 'food', 'also']) {
    const f = UNDERSTAND_SCHEMA.properties[k];
    assert.ok(f.maxLength > 0 && f.maxLength <= 160 && f.type === 'string');
  }
  assert.ok(ANSWER_SCHEMA.properties.answer.maxLength >= 300);
  assert.ok(identifySchema(['L01']).properties.answer.maxLength >= 150);
  assert.equal(wholeSentences('Jogyesa Temple. It has a red gable with a gold sym'), 'Jogyesa Temple. It has a red gable with a gold…');
  assert.equal(wholeSentences('The hall of Jogyesa Temple. It has a red gable with a gold sym'), 'The hall of Jogyesa Temple.');
  assert.equal(wholeSentences('A finished sentence.'), 'A finished sentence.');
  const c = cloudSchema(UNDERSTAND_SCHEMA);
  assert.equal(JSON.stringify(c).includes('maxLength') || JSON.stringify(c).includes('pattern'), false);
  assert.deepEqual(c.properties.kind, UNDERSTAND_SCHEMA.properties.kind);
  assert.deepEqual(c.required, UNDERSTAND_SCHEMA.required);
});

t('question form keeps its own rules (else the device is asked once more)', () => {
  const base = { kind: 'route', place: 'Anguk Station Exit 2', from: '', food: '', time: 'any', also: '' };
  assert.equal(formKeepsRules(base), true);
  assert.equal(formKeepsRules({ ...base, kind: 'food', food: 'dumplings' }), true);
  assert.equal(formKeepsRules({ ...base, kind: 'sights', food: 'place erode' }), false); // food only for food questions
  assert.equal(formKeepsRules({ ...base, kind: 'sights', from: 'Tapgol Park' }), false); // from only for routes
  assert.equal(formKeepsRules({ ...base, also: '//x_),' }), false);
  assert.equal(formKeepsRules({ ...base, place: '정독도서관' }), true);
  assert.equal(formKeepsRules(null), false);
});

console.log(`${n} tests passed`);
