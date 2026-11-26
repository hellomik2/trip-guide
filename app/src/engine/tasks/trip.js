// Trip guide: one question about the saved travel pack (trip-pack/2) -> a short answer plus what code worked out.
//
// guide.js plans the question by code: which kind it is, the places, walking routes and steps, opening checks,
// and whether the pack holds the answer at all. When it does not ("gate"), the engine answers at once on this
// computer without any AI call. Otherwise the model words one or two sentences from the lines code chose.
// The steps, list, map and photos on screen always come from code (`view`), never from the model.
import { plan, knownWord } from '../trip/guide.js';
import { words } from '../trip/pick.js';
import { inQuestion } from '../trip/names.js';
import { SYSTEM, userText, ANSWER_SCHEMA, HINTS, identifySchema, UNDERSTAND_SYSTEM, UNDERSTAND_SCHEMA, UNDERSTAND_KINDS, understandText } from '../trip/prompts.js';

const APP_TEXT = 'Answered on this computer by the app from your saved pack (no AI needed)';
const UNDERSTOOD_TEXT = { on_device: 'The on-device AI read the question; the app answered from your saved pack', in_cloud: 'The cloud AI read the question; the app answered from your saved pack' };

function checkInput(input) {
  const pack = input?.pack;
  const question = String(input?.text ?? '').trim();
  if (!pack?.places?.length) throw Object.assign(new Error('No travel pack is saved on this computer.'), { code: 'no-pack' });
  if (pack.format !== 'trip-pack/2') throw Object.assign(new Error('This travel pack is an old format. Save the pack again.'), { code: 'old-pack' });
  if (!question) throw Object.assign(new Error('Type a question first.'), { code: 'empty' });
  return { pack, question };
}

/** The AI's form, kept only where it holds: a known kind, and names that are really written in the question. */
export function readUnderstood(v, question) {
  const str = (x, n) => (typeof x === 'string' ? x.trim().slice(0, n) : '');
  const out = {
    kind: UNDERSTAND_KINDS.includes(v?.kind) ? v.kind : 'other',
    place: str(v?.place, 80), from: str(v?.from, 80), food: str(v?.food, 40),
    time: ['now', 'later', 'any'].includes(v?.time) ? v.time : 'any', also: str(v?.also, 200),
  };
  out.dropped = [];
  for (const f of ['place', 'from']) if (out[f] && !inQuestion(out[f], question)) { out.dropped.push({ field: f, value: out[f] }); out[f] = ''; }
  if (out.kind !== 'route') out.from = '';
  // "how do i walk from A to B": when the AI wrote A as the place and no start, take the order from the words
  if (out.kind === 'route' && out.place && !out.from) {
    const m = String(question).match(/\bfrom\s+(.+?)\s+to\s+(.+?)\s*(?:[?.!,;]|\band\b|\bplease\b|$)/i);
    if (m && inQuestion(out.place, m[1]) && !inQuestion(out.place, m[2])) { out.dropped.push({ field: 'order', value: out.place }); out.from = m[1].trim(); out.place = m[2].trim(); }
  }
  if (out.also && fold2(out.also) === fold2(question)) out.also = '';
  if (/^(any|anything|food|something|whatever|all|korean food|local food|eat|meal|a meal)$/i.test(out.food)) out.food = '';
  // "open now" changes the order of a list, so it needs a word about time in the question itself
  // (the on-device model sometimes marks a plain "any dumplings near X?" as "now")
  if (out.time !== 'any' && !TIME_CUE.test(fold2(question))) { out.dropped.push({ field: 'time', value: out.time }); out.time = 'any'; }
  return out;
}
const fold2 = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const TIME_CUE = /\b(now|open|opens|opened|still|tonight|today|tomorrow|late|later|early|currently|moment|hour|hours|oclock|o clock|\d{1,2} ?(am|pm)|\d{1,2} \d\d|morning|evening|afternoon|night|midnight|noon|closing|close|closes|closed|before|after|until|till|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|dark|sunset|time)\b/;

/** Numbers written in a text, with 12-hour forms of clock times ("20:00" also counts as 8). */
function numbersOf(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/\d+(?:[.,]\d+)?/g)) { out.add(Number(m[0].replace(',', '.'))); out.add(Number(m[0].replace(/,/g, ''))); }
  for (const m of String(text).matchAll(/\b(\d{1,2}):(\d{2})\b/g)) { const h = Number(m[1]); out.add(h % 12 || 12); out.add(h); }
  return out;
}

/** Place ids whose name the answer uses (for "Based on your saved travel pack"). */
function namedIn(answer, view) {
  const a = ` ${words(answer).join(' ')} `;
  return (view?.places ?? []).filter((c) => {
    const ws = words(c.name).filter((w) => w.length > 3 && !['the', 'street', 'gate', 'hall', 'station', 'exit', 'palace', 'museum', 'korea', 'national', 'seoul'].includes(w));
    return ws.length && ws.some((w) => a.includes(` ${w} `));
  }).map((c) => c.id);
}

const FACT_WORDS = /\d|\b(open|opens|opening|closed|closes|closing|hours?|minutes?|mins?|metres?|meters?|km|walk|walking|north|south|east|west)\b/i;
// Where a place is, and what the pack "says", come from code; the model repeating the type ("X is a temple") adds nothing.
const LOCATION_WORDS = /\b(located|situated|lies|lying|based in|sits? in|set in|found in|address)\b/i;
const PACK_WORDS = /\b(pack|saved|data|app|application|listed|lists|indicates?|according to|information|mentioned|described)\b/i;
const FILLER = new Set('is are was a an the it its this that there here which who one place spot kind type of called known as also just in at and or with for to on by be'.split(' '));
const splitSentences = (t) => String(t).match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * For food, sights, routes and "what is this", the model only adds words. Sentences of its answer that state numbers,
 * directions or opening are dropped (code shows those), and code adds one sentence with the computed facts.
 */
function compose(kind, modelText, view, pack = null) {
  const c = view.places?.find((x) => x.id === view.focus) ?? view.places?.[0];
  if (!c) return modelText;
  // place names may hold digits ("Bukchon 5th Scenic Spot"), so they are taken out before looking for numbers
  const names = (view.places ?? []).map((x) => x.name);
  const bare = (x) => names.reduce((acc, n) => acc.split(n).join(' '), x);
  const typeWords = new Set((view.places ?? []).flatMap((x) => String(`${x.type ?? ''} ${x.kind ?? ''}`).toLowerCase().split(/[^a-z]+/)).filter(Boolean));
  const restates = (x) => bare(x).toLowerCase().split(/[^a-z]+/).filter((w) => w && !FILLER.has(w) && !typeWords.has(w) && !typeWords.has(w.replace(/s$/, ''))).length < 2;
  // a capitalised word the pack never uses (a misspelt or made-up name: "Bukitchon", "Gwacheon branch") drops the sentence
  const strangeName = (x) => !!pack && bare(x).split(/\s+/).slice(1).some((w) => /^[A-Z][a-z]/.test(w) && !knownWord(pack, w));
  const keep = splitSentences(modelText).filter((x) => !strangeName(x) && !FACT_WORDS.test(bare(x)) && !LOCATION_WORDS.test(bare(x)) && !PACK_WORDS.test(x) && !restates(x) && !/does not include|not in (the|your) (saved )?(travel )?(pack|data)/i.test(x));
  let said = keep.join(' ');
  if (!said) {
    if (kind === 'food') said = c.dish ? `${c.name} serves ${c.dish}.` : `${c.name} is the nearest match.`;
    // the pack's one-line intro, with the name first when the intro does not start with it
    const intro = c.intro ? (fold2(c.intro).startsWith(fold2(c.name.split(' (')[0])) ? c.intro : `${c.name}: ${c.intro}`) : '';
    if (kind === 'sights') said = intro || `${c.name} is the nearest sight.`;
    else if (kind === 'route') said = intro || `Here is the walk to ${c.name}.`;
    else if (kind === 'identify') said = `This looks like ${c.name}.`;
  }
  let facts = '';
  const onFoot = (w) => String(w).replace(' walk,', ' on foot,');
  if (kind === 'food' || kind === 'sights') facts = `${c.name} is ${onFoot(c.walkText)}${c.dir ? ` ${c.dir}` : ''}${view.ref ? ` of ${view.ref.name}` : ''}; ${c.open.short}.`;
  else if (kind === 'route' && view.route) {
    // a subway exit, toilet or ATM has no opening hours to speak of: say nothing rather than "not in your pack"
    const service = ['station', 'toilet', 'atm', 'info', 'pharmacy'].includes(c.kind) && c.open.state === 'unknown';
    facts = `It is ${view.route.summary.replace(/, heading .*$/, '')}${view.route.door ? ` to ${view.route.doorName}, the main gate` : ''}${service ? '' : `; ${c.open.short}`}.`;
    const sameHours = view.ticket && view.ticket.open.short === c.open.short;
    if (view.route.ticketArea && view.ticket) facts += sameHours ? ` Part of this walk goes through the ticketed grounds of ${view.ticket.name}, so you need a palace ticket.` : ` Part of this walk goes through the ticketed grounds of ${view.ticket.name}, so you need a palace ticket; ${view.ticket.open.short.replace(/^its /, 'the palace\'s ').replace(/^it /, 'the palace ')}.`;
  }
  else if (kind === 'identify' && c.walkText) facts = `It is ${onFoot(c.walkText)} from where you said you are.`;
  return `${said} ${facts ? cap(facts) : ''}`.trim();
}

export const tripTask = {
  id: 'trip',
  dateLabel: '',
  system: SYSTEM,
  schema: ANSWER_SCHEMA,
  columns: [
    { key: 'question', label: 'Question' },
    { key: 'answer', label: 'Answer' },
  ],

  inspect() { return { date: null }; },

  // Step 1 (AI): read the question into a short form (kind, place name as written, start, food, time, a second
  // question). Skipped when the person already chose the kind and place on screen.
  understandSystem: UNDERSTAND_SYSTEM,
  understand(input) {
    const { question } = checkInput(input);
    if (input?.understood) return null;
    return { system: UNDERSTAND_SYSTEM, schema: UNDERSTAND_SCHEMA, userText: understandText(question) };
  },
  readUnderstood(value, input) { return readUnderstood(value, String(input?.text ?? '')); },
  // The free cloud tier allows a few requests a minute: two cloud requests for one question are spaced this far apart.
  cloudGapMs: 6500,

  // Step 2 (code): the plan. Step 3 (AI, only when it adds words): one or two sentences from the lines code chose.
  prepare(input) {
    const { pack, question } = checkInput(input);
    const t0 = performance.now();
    const u = input?.understood ?? null;
    const p = plan(pack, question, { hereId: input?.here, at: input?.at, kind: input?.kind, understood: u });
    const planMs = Math.round(performance.now() - t0);
    const cityLine = [pack.city, pack.area].filter(Boolean).join(', ');
    const prep = { text: question, date: null, question, pack, plan: p, planMs, view: { ...p.view, kind: p.kind, kindFrom: p.kindFrom, here: p.here, moment: p.moment } };
    const by = input?.understoodSource ?? null; // 'on_device' | 'in_cloud' from step 1, or null when chosen on screen
    const directText = by ? UNDERSTOOD_TEXT[by] ?? APP_TEXT : APP_TEXT;
    const base = { question, kind: p.kind, here: p.here?.id ?? null, hereName: p.here?.name ?? null, lines: [], understood: p.view?.understood ?? null };
    if (p.gate) {
      prep.direct = { record: { ...base, found: !!p.gate.found, gated: !p.gate.found, gateWhy: p.gate.why, answer: p.gate.text, used: [] }, reasonText: directText, source: by };
      prep.userText = '';
      prep.sourceText = '';
      return prep;
    }
    // Food, sights and routes: code has the whole answer (name, dish or one-line intro from the pack, walk, opening),
    // so the AI is not asked to word it. Measured on the test PC, a second on-device request added 5 to 8 seconds and
    // its extra sentence was sometimes filler. The AI still reads every question (step 1), picks "what is this"
    // among the candidates, and words answers about one place's other facts (step 3).
    if (p.view?.places?.length && ['food', 'sights', 'route'].includes(p.kind)) {
      prep.direct = { record: { ...base, found: true, gated: false, answer: compose(p.kind, '', prep.view), used: [prep.view.places[0].id] }, reasonText: directText, source: by };
      prep.userText = '';
      prep.sourceText = '';
      return prep;
    }
    const hint = HINTS[p.hintKey] ?? HINTS.other;
    prep.schema = p.kind === 'identify' ? identifySchema(p.ids) : ANSWER_SCHEMA;
    prep.lines = p.lines;
    prep.userText = userText({ question, here: p.here, when: p.moment.text, cityLine, lines: p.lines, hint });
    prep.sourceText = p.lines.join('\n');
    return prep;
  },

  partial(rec) { return { answer: typeof rec?.answer === 'string' ? rec.answer : '', found: rec?.found }; },

  finish(value, prep) {
    const v = value ?? {};
    const p = prep.plan;
    const modelText = typeof v.answer === 'string' ? v.answer.trim() : '';
    let found = v.found !== false && modelText !== '';
    let pickedId = null;
    let answer = modelText;
    if (p.kind === 'identify') {
      pickedId = found && p.ids.includes(v.id) ? v.id : null;
      if (!pickedId) found = false;
      else { prep.view.focus = pickedId; answer = compose('identify', modelText, prep.view, prep.pack); }
    } else if (['food', 'sights', 'route'].includes(p.kind) && prep.view.places?.length) {
      // code already found the answer; the model's "found" does not override it
      found = true;
      answer = compose(p.kind, modelText, prep.view, prep.pack);
    }
    const record = {
      question: prep.question, kind: p.kind, found, gated: false, answer, modelText, pickedId,
      used: found ? (pickedId ? [pickedId] : namedIn(answer, prep.view)) : [],
      here: p.here?.id ?? null, hereName: p.here?.name ? p.here.name : null, lines: (prep.lines ?? []).map((text) => ({ text })),
      understood: prep.view?.understood ?? null,
    };
    // Flag numbers in the answer that are in neither the question nor the given lines.
    const known = numbersOf(`${prep.question}\n${prep.sourceText}`);
    const strays = [...numbersOf(modelText)].filter((n) => !known.has(n));
    const check = found && strays.length ? ['answer'] : [];
    if (pickedId) prep.view.focus = pickedId;
    return { record, check, candidates: [] };
  },

  display(r) { return { question: r?.question ?? '', answer: r?.answer ?? '' }; },

  /** No AI could read the question (no model and no internet): what the older word rules guess, shown under the notice. */
  guess(input) {
    try { return this.prepare({ ...input, understood: null, understoodSource: null }).view; } catch { return null; }
  },
};
