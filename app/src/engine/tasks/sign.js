// Sign reader ("Read a sign"): Korean text typed or pasted, or a photo of a sign, menu or notice
// -> what it means in English, line by line, and what the reader should do.
//
// The AI answers in plain text, one line per Korean line and a last "To do:" line. It is never asked to
// write JSON or screen code: measured on the test PC, the on-device model lost meaning when it had to
// write screen code (meaning right fell from 20/20 to 16/30 in that test). The card on screen is drawn by the app.
//
// Where it runs (tryOrder and devicePhotos below; the engine, src/engine/index.js runText, follows them):
//   one line of text   on this device first; the cloud only when the device cannot answer (no model, failed)
//                      and there is a connection and "Never use the cloud" is off
//   two or more lines  the cloud first while online and the cloud is allowed; this device otherwise, or when the cloud fails
//   photo              the cloud only (devicePhotos: false); offline or with the cloud not allowed, a notice asks for typed text
// The prompts below were fixed before measuring. Do not edit them for a judged run; a changed prompt is a
// separate, reference-only variant.

export const SIGN_SYSTEM = 'You help a foreign traveler in Korea understand Korean signs, menus and notices. Answer in plain English. Keep every number exactly as written, in digits: prices in won (for example 12,000 won), times, floors and servings. For food, give the romanized Korean name and what it is in English. Never add lines, items or details that are not in the Korean text.';

const TODO_RULE = 'Then write one last line that starts with "To do:" and says in a few English words what the reader should do because of this text.';

export function textPrompt(lines) {
  const n = lines.length;
  const s = n === 1 ? '' : 's';
  const form = [...lines.map((_, i) => `${i + 1}. (English meaning of line ${i + 1})`), 'To do: (what to do)'].join('\n');
  return `Korean text from a sign, menu or notice. It has ${n} numbered line${s}:\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\nFor each numbered line, write its number and then its meaning in English, without repeating the Korean. Keep every number of the line (prices, times, floors, servings). For food, write the romanized name and what it is, like this: Pajeon (green onion pancake), 15,000 won\nWrite exactly ${n} numbered line${s}.\n${TODO_RULE}\nAnswer in this form:\n${form}`;
}

export const PHOTO_PROMPT = `This photo shows a Korean sign, menu or notice. Read the Korean text in it, top to bottom.
For each line of Korean text you can read, write one line: the Korean text exactly as written, then " = ", then what it means in English.
Write only text that is really in the photo. Do not guess and do not add items. If some text is too small or unclear to read, skip it. If you cannot read any Korean text, write only: No readable Korean text.
${TODO_RULE}`;

// The on-device model reads photos far less well than the cloud. In the first measured run (E4, 11-24) it garbled
// small print and wrote menu lines that are not in the photo, so on the device it reads only the large text.
export const PHOTO_PROMPT_DEVICE = `This photo shows a Korean sign, menu or notice. Read only the large, clear Korean words in it, top to bottom (for example the title of a sign, a shop name, or dish names with their prices). Skip small print.
For each line of that Korean text, write one line: the Korean text exactly as written, then " = ", then what it means in English.
Write at most 8 lines, and only text that is really in the photo. Do not guess and do not add items. If you cannot read any Korean text clearly, write only: No readable Korean text.
${TODO_RULE}`;

/** Shown with every photo read on this device. */
export const PHOTO_NOTE = 'Photos can be misread. For the most accurate meaning, type or paste the Korean text instead.';
/** Shown when the photo way on this device is turned off (devicePhotos: false) and the cloud cannot be used. */
export const PHOTO_OFFLINE_TEXT = 'Reading photos needs an internet connection. Typing or pasting the Korean text works now, even offline.';
export const PHOTO_LOCKED_TEXT = 'Reading photos uses the cloud AI, and “Never use the cloud” is on. Typing or pasting the Korean text works on this computer.';
/** Shown with text of two or more lines (a menu, a notice) read on this device. */
export const LINES_DEVICE_NOTE = 'Read on this computer: dish names on a menu may not be explained correctly. With an internet connection, the cloud AI reads menus more reliably.';

/**
 * Which AI tries first. Photos, and typed text of two or more lines, go to the cloud first while there is a connection
 * and the cloud is allowed: measured on menus (11-26, ten menus and notices), the cloud got the meaning right 10/10,
 * the on-device AI 5/10 (it often gave dish names only in romanized Korean). One line stays on this device first.
 * The other one is the fallback (the engine skips the cloud when it is not allowed or there is no connection).
 */
export function tryOrder({ cloudFirst, online, locked }) {
  return cloudFirst && online && !locked ? ['cloud', 'device'] : ['device', 'cloud'];
}

const MAX_LINES = 30;
const MAX_CHARS = 1500;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

/** Plain Korean text -> its non-empty lines (pasted text keeps its line breaks). */
export function splitLines(text) {
  return String(text ?? '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function checkInput(input) {
  if (input?.image) {
    const img = input.image;
    if (!img.data || !/^image\//.test(img.mimeType ?? '')) throw Object.assign(new Error('This file is not a photo the app can read. Choose a JPEG or PNG photo.'), { code: 'bad-image' });
    return { kind: 'photo', img };
  }
  const raw = String(input?.text ?? '');
  const lines = splitLines(raw);
  if (!lines.length) throw Object.assign(new Error('Type or paste some Korean text first, or choose a photo.'), { code: 'empty' });
  if (raw.length > MAX_CHARS || lines.length > MAX_LINES) throw Object.assign(new Error(`That is too long. Paste at most ${MAX_LINES} lines (${MAX_CHARS} characters) at a time.`), { code: 'too-long-input' });
  if (!HANGUL.test(raw)) throw Object.assign(new Error('There is no Korean text in this. Paste the Korean words from the sign or menu.'), { code: 'no-korean' });
  return { kind: 'text', lines };
}

const clean = (s) => String(s ?? '').replace(/\*\*|__|`/g, '').replace(/^\s*[-*•]\s+/, '').trim();
const TODO = /^\s*(?:\*\*)?\s*to\s*do\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/i;
const NUMBERED = /^\s*(?:\*\*)?(\d{1,2})\s*[.)：:]\s*(?:\*\*)?\s*(.*)$/;
const NONE = /no readable korean text/i;

/** "<Korean line> - Kalguksu ..." -> "Kalguksu ...": the Korean the model repeated before the English is dropped. */
export function dropKorean(v) {
  // "<Korean> 8,000 won (Knife soup 8,000 won)": the English is the part in brackets at the end
  const br = v.match(/^(.*?)\s*\(([^()]*)\)\s*\.?$/);
  if (br && HANGUL.test(br[1]) && /[a-z]{3}/i.test(br[2]) && !HANGUL.test(br[2])) return br[2].trim();
  let k = v.search(/[A-Za-z]/);
  if (k <= 0 || !HANGUL.test(v.slice(0, k))) return v;
  while (k > 0 && '("“\'['.includes(v[k - 1])) k -= 1;
  const rest = v.slice(k).replace(/^[\s=:→>–—-]+/, '').trim();
  return HANGUL.test(rest) ? v : rest;
}

/** "Tteokbokki (spicy rice cakes): 4,000 won" -> { text: "Tteokbokki (spicy rice cakes)", price: "4,000 won" } */
// Only a price at the very end, after a name that ends in ")" or after ":", "–", "—", " - " or "₩", is split off;
// "A fine of 100,000 won" stays one sentence.
const PRICE_END = /^(.*?\S)\s*([:–—]|\s-)?\s*\(?((?:₩\s?)?\d{1,3}(?:,\d{3})+(?:\s*(?:won|KRW))?|(?:₩\s?)?\d{3,6}\s*(?:won|KRW))\)?\.?$/i;
export function splitPrice(en) {
  const m = String(en).match(PRICE_END);
  if (!m || /\d$/.test(m[1]) || !/[a-z)]/i.test(m[1])) return { text: en, price: null };
  if (!m[2] && !m[1].endsWith(')') && !m[3].startsWith('₩')) return { text: en, price: null };
  const open = (s) => (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length;
  if (open(m[1]) > 0) return { text: en, price: null }; // "gukbap (takeout - 7,000 won)": the price is inside the brackets
  return { text: m[1].replace(/[\s:,–—-]+$/, ''), price: m[3].replace(/^₩\s?(.*)$/, '$1 won').replace(/(\d)$/, '$1 won') };
}

/** Model text -> rows. For typed text, numbered lines are paired with the typed lines; nothing else is kept. */
export function readText(text, prep) {
  const out = { rows: [], todo: '', unreadable: false, extra: [], missing: [] };
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const loose = [];
  if (prep.kind === 'text') {
    const en = new Array(prep.lines.length).fill('');
    // numbered lines that only repeated the Korean: their meanings follow as plain English lines, in the same order
    const waiting = [];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      if (TODO.test(raw)) { out.todo ||= clean(raw.replace(TODO, '')); waiting.length = 0; continue; }
      const m = raw.match(NUMBERED);
      if (m) {
        const i = Number(m[1]) - 1;
        const v = dropKorean(clean(m[2]));
        if (i >= 0 && i < en.length && !en[i] && !waiting.includes(i)) {
          if (v && !/[a-z]/i.test(v)) waiting.push(i); // only Korean (and numbers): wait for its English line
          else en[i] = v;
        } else if (v) out.extra.push(raw.trim());
      } else if (waiting.length && /[a-z]/i.test(raw) && !HANGUL.test(raw)) en[waiting.shift()] = clean(raw);
      else loose.push(clean(raw));
    }
    // one line and the model did not number it: its first plain line is the meaning
    if (en.length === 1 && !en[0] && loose.length) en[0] = loose.shift();
    for (const l of loose) if (l) out.extra.push(l);
    out.rows = prep.lines.map((ko, i) => ({ ko, en: en[i], ...(en[i] ? {} : { missing: true }) }));
    out.missing = out.rows.filter((r) => r.missing).map((r) => r.ko);
    return out;
  }
  // photo: "Korean as read = English meaning", or "Korean: ..." / "English: ..." pairs
  let pendingKo = null;
  for (const raw of lines) {
    const t = clean(raw);
    if (!t) continue;
    if (TODO.test(raw)) { out.todo ||= clean(raw.replace(TODO, '')); continue; }
    if (NONE.test(t) && !out.rows.length) { out.unreadable = true; continue; }
    const ko = t.match(/^korean\s*[:：]\s*(.*)$/i);
    if (ko) { pendingKo = ko[1].trim(); continue; }
    const enLine = t.match(/^english\s*[:：]\s*(.*)$/i);
    if (enLine) { if (pendingKo != null) { out.rows.push({ ko: pendingKo, en: enLine[1].trim() }); pendingKo = null; } else out.extra.push(t); continue; }
    const eq = t.match(/^(.*?)\s+(?:=|→|->)\s+(.*)$/) ?? t.match(/^(.*?)\s*=\s*(.*)$/);
    if (eq && HANGUL.test(eq[1])) { out.rows.push({ ko: eq[1].replace(/^\d{1,2}[.)]\s*/, '').trim(), en: eq[2].trim() }); continue; }
    out.extra.push(t);
  }
  if (out.rows.length) out.unreadable = false;
  return out;
}

// The photo goes to the on-device model as it is. Chrome stretches it to a square and warns that this may hurt
// reading; putting it on a square instead made all three pipe-check photos worse (11-24, the text got smaller),
// so it is not done.

export const signTask = {
  id: 'sign',
  output: 'text', // plain text answers, read by readText (no JSON, no response schema)
  system: SIGN_SYSTEM,
  // The free cloud tier allows a few requests a minute: cloud requests are spaced this far apart.
  cloudGapMs: 6700,
  // Photos read on this device: off. Measured on the test PC (11-24, ten real photos of signs and menus):
  // 4/10 right with 2 answers holding made-up lines, then 5/10 with 1 after one prompt fix (PHOTO_PROMPT_DEVICE),
  // below the line of 6/10. So an offline photo gets PHOTO_OFFLINE_TEXT and the person is asked to type the text;
  // typed text works offline. Set to true to bring the on-device photo way back (its note and prompt are kept).
  devicePhotos: false,

  prepare(input) {
    const c = checkInput(input);
    if (c.kind === 'photo') {
      const photo = { inlineData: { data: c.img.data, mimeType: c.img.mimeType } };
      return { kind: 'photo', image: true, cloudFirst: true, lines: [], parts: [{ text: PHOTO_PROMPT }, photo], deviceParts: [{ text: PHOTO_PROMPT_DEVICE }, photo], measureText: PHOTO_PROMPT,
        input: { kind: 'photo', name: c.img.name ?? null, bytes: c.img.bytes ?? null, width: c.img.width ?? null, height: c.img.height ?? null, mimeType: c.img.mimeType } };
    }
    const prompt = textPrompt(c.lines);
    return { kind: 'text', image: false, cloudFirst: c.lines.length >= 2, lines: c.lines, parts: prompt, measureText: prompt, input: { kind: 'text', text: c.lines.join('\n'), lines: c.lines.length } };
  },

  order: tryOrder,

  /** The card so far, while the answer streams in. */
  partial(text, prep) { return readText(text, prep); },

  finish(text, prep, where) {
    const r = readText(text, prep);
    const rows = r.rows.map((x) => { const p = splitPrice(x.en ?? ''); return { ...x, enText: p.text.replace(/^\(([^()]*)\)$/, '$1'), price: p.price }; });
    const empty = prep.kind === 'text' ? rows.every((x) => !x.en) : !rows.length;
    return {
      kind: prep.kind, rows, todo: r.todo, unreadable: r.unreadable || (prep.kind === 'photo' && !rows.length),
      found: !empty, extra: r.extra, missing: r.missing,
      note: where !== 'device' ? null : prep.kind === 'photo' ? PHOTO_NOTE : prep.lines.length >= 2 ? LINES_DEVICE_NOTE : null,
    };
  },
};
