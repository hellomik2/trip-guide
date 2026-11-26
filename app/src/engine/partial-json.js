// Read a JSON object that is still streaming in ("{"name":"Dana Wh") so the UI can show fields early.
// Returns the fields that can be read so far, or null. Never throws.

function closeUp(s) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += esc ? '\\"' : '"';
  return out + stack.reverse().join('');
}

export function stripFence(text) {
  return String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

export function parsePartial(text) {
  let s = stripFence(text);
  const start = s.indexOf('{');
  if (start < 0) return null;
  s = s.slice(start);
  for (let tries = 0; tries < 6 && s.length > 1; tries += 1) {
    try {
      const v = JSON.parse(closeUp(s));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      // drop the last unfinished piece ("key": or a cut number) and try again
      const cut = Math.max(s.lastIndexOf(','), s.lastIndexOf('{') === 0 ? 0 : -1);
      if (cut <= 0) { s = '{'; break; }
      s = s.slice(0, cut);
    }
  }
  try { return JSON.parse(closeUp(s)); } catch { return null; }
}

/** Final answer: strict parse first, then the lenient one. */
export function parseFinal(text) {
  try {
    const v = JSON.parse(stripFence(text));
    if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v, strict: true };
  } catch { /* fall through */ }
  const v = parsePartial(text);
  return { value: v, strict: false };
}

/** The schema for the cloud: the same, without maxLength and pattern. */
export function cloudSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cloudSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if ((k === 'maxLength' || k === 'pattern') && typeof v !== 'object') continue; // a keyword, not a property named so
    out[k] = cloudSchema(v);
  }
  return out;
}
