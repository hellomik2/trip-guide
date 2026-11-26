// Tiny static server for local development. Binds to 127.0.0.1 only, no build step.
//
//   node tools/serve.mjs              -> http://localhost:8790/   simple: /x also serves x.html, no redirects, no caching
//   node tools/serve.mjs --hosting    -> http://localhost:8791/   like Firebase Hosting, from firebase.json
//   node tools/serve.mjs --hosting --port 8792
//   node tools/serve.mjs --hosting --root <folder> --port 8796   serve another folder (with its own firebase.json),
//                                                                 e.g. the one tools/make-deploy.mjs makes
//
// The --hosting mode follows the documented Hosting rules (https://firebase.google.com/docs/hosting/full-config):
//   ignore        files matching "ignore" are not served (they are not deployed)
//   redirects     matched first, against the request path ("source" globs, "type" 301 or 302)
//   trailingSlash false: /dir/ is redirected to /dir
//   cleanUrls     /page.html is redirected (301) to /page, and /page serves page.html
//   headers       every rule whose "source" matches the request path adds its headers
//   Cache-Control "max-age=3600" when no rule sets it (the documented default one-hour browser cache)
// Not covered: rewrites, i18n, the reserved /__/ paths, regex sources. The query string is kept on redirects.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, PAGE_PORT } from './env.mjs';

const argv = process.argv.slice(2);
const HOSTING = argv.includes('--hosting');
const portArg = argv.indexOf('--port') >= 0 ? Number(argv[argv.indexOf('--port') + 1]) : null;
const PORT = portArg || (HOSTING ? PAGE_PORT + 1 : PAGE_PORT);
const rootArg = argv.indexOf('--root') >= 0 ? argv[argv.indexOf('--root') + 1] : null;
const SERVE_ROOT = rootArg ? path.resolve(rootArg) : ROOT; // default: app/

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};
const typeOf = (file) => types[path.extname(file).toLowerCase()] || 'application/octet-stream';
const hidden = /^\/(tools|node_modules|\.git)(\/|$)/;

/** Glob (with the extglob @(a|b) form) to a RegExp. Patterns without a leading "/" match a path without one. */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i += 1;
      if (glob[i + 1] === '/') { re += '(?:.*/)?'; i += 1; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '@' && glob[i + 1] === '(') {
      const end = glob.indexOf(')', i);
      re += `(?:${glob.slice(i + 2, end).split('|').map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const globMatch = (glob, urlPath) => globRe(glob).test(glob.startsWith('/') ? urlPath : urlPath.replace(/^\//, ''));

const hostingConfig = () => JSON.parse(readFileSync(path.join(SERVE_ROOT, 'firebase.json'), 'utf8')).hosting;

async function isFile(rel, cfg) {
  if (cfg && (cfg.ignore ?? []).some((g) => globMatch(g, rel))) return false;
  const file = path.normalize(path.join(SERVE_ROOT, rel));
  if (!file.startsWith(SERVE_ROOT + path.sep)) return false;
  try { return (await stat(file)).isFile() ? file : false; } catch { return false; }
}

function headersFor(urlPath, cfg) {
  const out = {};
  for (const rule of cfg.headers ?? []) {
    if (rule.source && globMatch(rule.source, urlPath)) for (const h of rule.headers) out[h.key.toLowerCase()] = h.value;
  }
  if (!out['cache-control']) out['cache-control'] = 'max-age=3600';
  return out;
}

async function hosting(req, res) {
  const cfg = hostingConfig(); // read on every request, so edits to firebase.json apply at once
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  const send = (status, head, body) => { res.writeHead(status, { ...headersFor(p, cfg), ...head }); res.end(body); };
  const redirect = (status, to) => send(status, { location: to + url.search }, '');

  for (const r of cfg.redirects ?? []) if (r.source && globMatch(r.source, p)) return redirect(r.type ?? 301, r.destination);
  if (cfg.trailingSlash === false && p.length > 1 && p.endsWith('/')) return redirect(301, p.replace(/\/+$/, ''));
  if (cfg.cleanUrls && p.endsWith('.html') && (await isFile(p, cfg))) return redirect(301, p.replace(/(\/index)?\.html$/, '') || '/');

  const rel = p.replace(/^\//, '');
  const file = (rel && (await isFile(rel, cfg)))
    || (cfg.cleanUrls && rel && (await isFile(`${rel}.html`, cfg)))
    || (await isFile(path.posix.join(rel, 'index.html'), cfg));
  if (file) return send(200, { 'content-type': typeOf(file) }, await readFile(file));
  const custom = await isFile('404.html', cfg);
  return send(404, { 'content-type': 'text/html; charset=utf-8' }, custom ? await readFile(custom) : 'Page Not Found');
}

async function simple(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (rel === '/') rel = '/index.html';
  if (!path.extname(rel)) rel += '.html';
  const file = path.normalize(path.join(SERVE_ROOT, rel));
  if (!file.startsWith(SERVE_ROOT + path.sep) || hidden.test(rel)) { res.writeHead(403).end('forbidden'); return; }
  const body = await readFile(file);
  res.writeHead(200, { 'content-type': typeOf(file), 'cache-control': 'no-store' });
  res.end(body);
}

http.createServer(async (req, res) => {
  try {
    await (HOSTING ? hosting : simple)(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${SERVE_ROOT} at http://localhost:${PORT}/${HOSTING ? ' (like Firebase Hosting, from firebase.json)' : ''}`));
