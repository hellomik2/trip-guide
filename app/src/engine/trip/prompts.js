// Every AI instruction of the trip guide lives in this one file (system prompts, user texts, answer shapes),
// so a phone version can reuse them as they are. The same text goes to the on-device model and to the cloud.
// The model reads the question (step 1) and, for "what is this" and other questions, picks or words the answer
// (step 3). Code (names.js, guide.js) matches the names and finds the places, distances, routes and opening checks.

export const SYSTEM = [
  'You are a friendly local guide for a traveller. You answer only from the numbered lines of the traveller\'s saved travel pack.',
  'Use only facts written in those lines. Never add facts from memory: no history, prices, times, dishes or names that are not in the lines.',
  'The app worked out every distance, walking time, direction, route and opening check in the lines. Copy them as written. Never calculate your own.',
  'The app already shows the route steps, the list of places and the photos on screen, so do not list route steps.',
  'If the lines do not answer the question, set "found" to false and say in one sentence that the saved travel pack does not include it.',
  'Otherwise set "found" to true and answer in one or two short sentences, at most 45 words.',
].join('\n');

// ---------------------------------------------------------------- step 1: understand the question
// The model only reads the question and fills a short form. It does not answer and does not see the pack.
// Code then matches the place name to the pack (names.js) and works out the answer (guide.js).
export const UNDERSTAND_SYSTEM = [
  'You read one question from a traveller walking around central Seoul and fill in a short form. Do not answer the question.',
  'kind: "food" = somewhere to eat or drink. "route" = how to walk or get to a place, how far it is, or where a place or the nearest toilet, pharmacy, ATM or subway exit is. "sights" = things to see or visit around here or around a named place. "identify" = the traveller describes something in front of them and asks what it is. "hours" = when a place opens or closes, or whether it is open. "other" = anything else (price, tickets, phone, tours, events, what one named place is like).',
  'place: the name of the one place, shop, brand or landmark the question is about, copied exactly as written, spelling mistakes included. For route it is the destination; for food or sights it is the place they want it near. Leave it empty when no name is given, for "here", and for a kind of place such as "a toilet" or "the nearest pharmacy". Never write only Seoul or Korea.',
  'from: only for route, the start if the traveller names one ("from X to Y"), copied exactly; otherwise empty.',
  'food: only for food, the dish, drink or cuisine they want in one or two words ("dumplings", "coffee", "vegetarian"); empty if any food is fine.',
  'time: "now" if they want it open now, tonight, still open or before it closes; "later" if they name another day or time; "any" otherwise.',
  'also: if the question asks a second thing, that second question written so it stands alone, with the place name in it; otherwise empty.',
  'Examples:',
  'Q: im starving, any noodle place still open near the folk museum? -> {"kind":"food","place":"the folk museum","from":"","food":"noodles","time":"now","also":""}',
  'Q: How far is it from Tapgol Park to Changdeokgung, and is it open on Mondays? -> {"kind":"route","place":"Changdeokgung","from":"Tapgol Park","food":"","time":"later","also":"Is Changdeokgung open on Mondays?"}',
  'Q: there is a tall stone tower with many roofs behind a fence, what is it -> {"kind":"identify","place":"","from":"","food":"","time":"any","also":""}',
  'Q: what else could we look at around here before it gets dark -> {"kind":"sights","place":"","from":"","food":"","time":"now","also":""}',
  'Q: when does jogyesa close today -> {"kind":"hours","place":"jogyesa","from":"","food":"","time":"now","also":""}',
  'Q: where is the closest bathroom -> {"kind":"route","place":"","from":"","food":"","time":"any","also":""}',
].join('\n');

export const UNDERSTAND_KINDS = ['food', 'route', 'sights', 'identify', 'hours', 'other'];
// The length of every free-text field is bounded in the schema itself. Chrome's on-device models follow maxLength
// while they write (checked 11-26 on the test PC: a 200-word request into a field with maxLength 12 stopped at
// 12 characters). Without a bound, the "Gemma 4 for Built-in AI" model sometimes kept writing inside one field for
// 47 to 59 s, so the question was not read. The cloud gets the same schema without
// maxLength (partial-json.js cloudSchema). A "pattern" for the letters was tried too and made reading the question
// slower (25 questions: middle time 9.1 s with it, 8.2 s without), so the letters are checked after the answer:
// TEXT_OK, used by tasks/trip.js formKeepsRules (a form that fails is asked once more on the device).
// Characters allowed: letters (accented Latin and Hangul too), digits, space and the punctuation of names and short
// sentences. Code marks, brackets and slashes (seen in broken forms) are not.
const TEXT_CHARS = "A-Za-z0-9 .,:;'?!&()À-ɏ가-힣‘’“”–—-"; // the hyphen last: a plain character
export const TEXT_OK = new RegExp(`^[${TEXT_CHARS}]*$`);
export const boundedText = (max, description) => ({ type: 'string', maxLength: max, description });
export const UNDERSTAND_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: UNDERSTAND_KINDS },
    place: boundedText(80, 'place name copied from the question, or ""'),
    from: boundedText(80, 'start place copied from the question, or ""'),
    food: boundedText(40, 'dish, drink or cuisine, or ""'),
    time: { type: 'string', enum: ['now', 'later', 'any'] },
    also: boundedText(160, 'a second question, or ""'),
  },
  required: ['kind', 'place', 'from', 'food', 'time', 'also'],
  additionalProperties: false,
};
export const understandText = (question) => `Q: ${String(question).trim()}`;

// ---------------------------------------------------------------- step 2: word the answer
/** What to say for each kind of question (chosen by code in tasks/trip.js). */
export const HINTS = {
  food: 'In one short sentence (at most 20 words), say what this place serves or is known for, using its line. Do not give distances, times or opening hours: the app adds them.',
  sights: 'In one short sentence (at most 20 words), say what this place is, using its About line. Do not give distances, times or opening hours: the app adds them.',
  route: 'In one short sentence (at most 20 words), say one useful thing about the destination from its lines (what it is, or its tip). Do not give distances, times, directions or steps: the app adds them.',
  identify: 'Choose the one line whose "Looks like" best matches what the traveller describes. Set "id" to that line\'s id and say in one short sentence which place it is and the detail that matches. No distances. If no line clearly matches, set "found" to false and "id" to "none".',
  other: 'Answer the exact question from the lines. For a question about time or opening, copy the opening line. For a price, give the price as written.',
};

/** The user turn: where the traveller is, when, the question, the chosen data lines, and the hint. */
export function userText({ question, here, when, cityLine, lines, hint }) {
  return [
    here ? `The traveller is at ${here.name}.` : 'The traveller has not chosen where they are.',
    when ? `Time used for opening checks: ${when}.` : '',
    `Question: ${String(question).trim()}`,
    '',
    `Saved travel pack${cityLine ? ` (${cityLine})` : ''}:`,
    ...lines,
    ...(hint ? ['', hint] : []),
  ].filter((x, i) => x !== '' || i > 2).join('\n');
}

/** Answer shape for most questions. */
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'true if the lines answer the question' },
    answer: boundedText(360, 'One or two short sentences'), // at most 45 words asked; the longest measured answer was 272 characters
  },
  required: ['found', 'answer'],
  additionalProperties: false,
};

/** Answer shape for "what am I looking at": the model must pick one of the candidate ids, or "none". */
export function identifySchema(ids) {
  return {
    type: 'object',
    properties: {
      found: { type: 'boolean', description: 'true if one candidate matches what the traveller sees' },
      id: { type: 'string', enum: [...ids, 'none'], description: 'id of the matching line' },
      answer: boundedText(180, 'One short sentence'), // cut answers end at a whole sentence (tasks/trip.js wholeSentences)
    },
    required: ['found', 'id', 'answer'],
    additionalProperties: false,
  };
}
