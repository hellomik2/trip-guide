// Look for secrets and direct Chrome AI calls before committing.
//   node tools/scan-secrets.mjs [file-or-folder ...]    default: every file git would commit under this folder
//   node tools/scan-secrets.mjs --selftest              prove the patterns catch made-up secrets
// Also compares against the real values in local/firebase-config.js (prints only "found"/"not found").
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './env.mjs';

const PATTERNS = [
  ['firebase-web-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['uuid (App Check debug token shape)', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['debug-token-literal', /FIREBASE_APPCHECK_DEBUG_TOKEN\s*=\s*['"`][^'"`]{8,}/],
  ['service-account-json', /"type"\s*:\s*"service_account"/],
];
const CALLS = /\.(prompt|promptStreaming)\s*\(/;
const CODE = /\.(m?js|html)$/i;

function listFiles(args) {
  if (args.length) return args.flatMap((a) => (statSync(a).isDirectory() ? walk(a) : [a]));
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '.'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean).map((f) => path.join(ROOT, f));
}
function walk(dir) {
  return readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

async function realValues() {
  const file = path.join(ROOT, 'local', 'firebase-config.js');
  if (!existsSync(file)) return [];
  const m = await import(pathToFileURL(file).href);
  const vals = [m.firebaseConfig?.apiKey, m.firebaseConfig?.appId, m.firebaseConfig?.messagingSenderId, m.appCheckDebugToken, m.recaptchaSiteKey];
  return vals.filter((v) => typeof v === 'string' && v.length >= 8).map((v, i) => [`local config value #${i + 1}`, v]);
}

export async function scan(files, { real = true } = {}) {
  const reals = real ? await realValues() : [];
  const hits = [];
  for (const f of files) {
    const name = path.basename(f);
    if (/^\.env/i.test(name)) hits.push({ file: f, kind: '.env file' });
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const [kind, re] of PATTERNS) if (re.test(text)) hits.push({ file: f, kind });
    for (const [kind, v] of reals) if (text.includes(v)) hits.push({ file: f, kind });
    if (CODE.test(f) && !/tools[\\/]scan-secrets\.mjs$/.test(f)) {
      text.split('\n').forEach((line, i) => { if (CALLS.test(line)) hits.push({ file: f, kind: `direct prompt call, line ${i + 1}` }); });
    }
  }
  return hits;
}

const args = process.argv.slice(2);
if (args[0] === '--selftest') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scan-selftest-'));
  const fake = {
    // built at run time, so this file itself does not contain the shapes it looks for
    'a.js': `const k = "${'AI'}za${'x'.repeat(35)}";`,
    'b.js': `self.FIREBASE_APPCHECK_${'DEBUG'}_TOKEN = '${['12345678', 'aaaa', '4bbb', '8ccc', '1234567890ab'].join('-')}';`,
    'c.txt': `${'-'.repeat(5)}BEGIN PRIVATE KEY${'-'.repeat(5)}\nabc`,
    '.env': 'X=1',
    'd.js': 'const s = await session.promptStreaming(text);',
    'e.json': `{"type": "${'service'}_account"}`,
    'clean.js': 'export const ok = 1; // promptOptions and "prompt" as a word are fine',
  };
  for (const [n, t] of Object.entries(fake)) writeFileSync(path.join(dir, n), t);
  const hits = await scan(walk(dir), { real: false });
  const by = (n) => hits.filter((h) => path.basename(h.file) === n).map((h) => h.kind);
  const expect = { 'a.js': 'firebase-web-api-key', 'b.js': 'debug-token-literal', 'c.txt': 'private-key-block', '.env': '.env file', 'd.js': 'direct prompt call', 'e.json': 'service-account-json' };
  let ok = true;
  for (const [n, k] of Object.entries(expect)) { const got = by(n); const pass = got.some((x) => x.startsWith(k)); ok &&= pass; console.log(pass ? 'caught' : 'MISSED', n, '->', got.join(', ')); }
  const clean = by('clean.js');
  console.log(clean.length ? `FALSE ALARM clean.js -> ${clean}` : 'clean.js: no hit');
  console.log(ok && !clean.length ? 'SELFTEST PASS' : 'SELFTEST FAIL');
  process.exit(ok && !clean.length ? 0 : 1);
} else {
  const files = listFiles(args);
  const hits = await scan(files);
  console.log(`scanned ${files.length} files`);
  for (const h of hits) console.log('HIT', path.relative(process.cwd(), h.file), '->', h.kind);
  console.log(hits.length ? `FOUND ${hits.length}` : 'CLEAN');
  process.exit(hits.length ? 1 : 0);
}
