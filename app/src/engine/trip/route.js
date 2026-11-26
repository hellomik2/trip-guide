// Walking routes from the travel pack's own path network (pack.net, built from OpenStreetMap ways).
// No routing server and no map tiles: code finds the shortest walk and writes the steps itself,
// so the same steps are shown on screen and drawn on the map. Pure functions, usable on a phone too.
import { distanceM, bearingDeg, compass, distanceText, WALK_M_PER_MIN } from './geo.js';

const graphs = new WeakMap();

/** Adjacency arrays for one pack (built once and kept). */
export function graphOf(pack) {
  if (graphs.has(pack)) return graphs.get(pack);
  const net = pack?.net;
  if (!net?.nodes?.length) return null;
  const n = net.nodes.length / 2;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  for (let i = 0; i < n; i += 1) { lat[i] = net.nodes[2 * i] / 1e6; lon[i] = net.nodes[2 * i + 1] / 1e6; }
  const m = net.edges.length / 4;
  const deg = new Int32Array(n + 1);
  for (let e = 0; e < m; e += 1) { deg[net.edges[4 * e] + 1] += 1; deg[net.edges[4 * e + 1] + 1] += 1; }
  for (let i = 0; i < n; i += 1) deg[i + 1] += deg[i];
  const fill = deg.slice(0, n);
  const to = new Int32Array(2 * m);
  const edgeOf = new Int32Array(2 * m);
  for (let e = 0; e < m; e += 1) {
    const a = net.edges[4 * e];
    const b = net.edges[4 * e + 1];
    to[fill[a]] = b; edgeOf[fill[a]] = e; fill[a] += 1;
    to[fill[b]] = a; edgeOf[fill[b]] = e; fill[b] += 1;
  }
  const feeNode = new Uint8Array(n);
  for (let e = 0; e < m; e += 1) if (net.ways[net.edges[4 * e + 2]]?.fee) { feeNode[net.edges[4 * e]] = 1; feeNode[net.edges[4 * e + 1]] = 1; }
  // grid of named-way edges (about 50 m cells), to say which street an unnamed pavement runs along
  const grid = new Map();
  const cell = (la, lo) => `${Math.floor(la / 0.00045)}|${Math.floor(lo / 0.00057)}`;
  for (let e = 0; e < m; e += 1) {
    const w = net.ways[net.edges[4 * e + 2]];
    if (!w?.n || w.x || w.h === 'steps') continue;
    const a = net.edges[4 * e];
    const b = net.edges[4 * e + 1];
    const k = cell((lat[a] + lat[b]) / 2, (lon[a] + lon[b]) / 2);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(e);
  }
  const g = { n, m, lat, lon, start: deg, to, edgeOf, edges: net.edges, ways: net.ways, feeNode, grid, cell };
  graphs.set(pack, g);
  return g;
}

/** The named street an unnamed stretch runs beside (within about 20 m and roughly parallel), or null. */
function alongStreet(g, nodes) {
  const votes = new Map();
  const step = Math.max(1, Math.floor(nodes.length / 6));
  for (let i = 0; i + 1 < nodes.length; i += step) {
    const a = { lat: g.lat[nodes[i]], lon: g.lon[nodes[i]] };
    const b = { lat: g.lat[nodes[i + 1]], lon: g.lon[nodes[i + 1]] };
    const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
    const dir = bearingDeg(a, b);
    const ci = Math.floor(mid.lat / 0.00045);
    const cj = Math.floor(mid.lon / 0.00057);
    for (let di = -1; di <= 1; di += 1) for (let dj = -1; dj <= 1; dj += 1) {
      for (const e of g.grid.get(`${ci + di}|${cj + dj}`) ?? []) {
        const p = { lat: g.lat[g.edges[4 * e]], lon: g.lon[g.edges[4 * e]] };
        const q = { lat: g.lat[g.edges[4 * e + 1]], lon: g.lon[g.edges[4 * e + 1]] };
        if (toSegment(p, q, mid).d > 20) continue;
        const d = Math.abs(((bearingDeg(p, q) - dir + 540) % 360) - 180);
        if (d > 30 && d < 150) continue;
        const name = g.ways[g.edges[4 * e + 2]].n;
        votes.set(name, (votes.get(name) ?? 0) + 1);
      }
    }
  }
  let best = null;
  for (const [k, v] of votes) if (!best || v > best[1]) best = [k, v];
  return best && best[1] >= 2 ? best[0] : null;
}

/** Nearest network node to a point (for places the builder already stored `node`). */
export function nearestNode(g, pt) {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < g.n; i += 1) {
    const d = (g.lat[i] - pt.lat) ** 2 + ((g.lon[i] - pt.lon) * 0.79) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

const nodeOf = (g, p) => (Number.isInteger(p?.node) && p.node < g.n ? p.node : nearestNode(g, p));

// The walk is the shortest by length. Paths inside a ticketed area (palace grounds, way.fee) are used only when
// the walk starts or ends on one of them (or when there is no other way), so a walk past a palace does not cut through it.
const usable = (way, allowFee) => allowFee || !way.fee;
const placeOf = (pack, id) => (pack.places ?? []).find((p) => p.id === id) ?? null;

/** Where a walk to "to" ends. A walled palace (door: its main gate) is walked to through that gate, unless you are already inside its ticketed grounds. */
export function endOf(pack, from, to) {
  if (!to?.door || from?.ticket === to.id) return to;
  return placeOf(pack, to.door) ?? to;
}
/** Ticketed paths (fee) are used only when the walk starts or ends inside ticketed grounds (place.ticket). */
const feeAllowed = (from, end) => !!(from?.ticket || end?.ticket);

/** Shortest walk between two places. Returns null if there is no path. */
export function shortestPath(pack, from, to, force = false) {
  const g = graphOf(pack);
  if (!g) return null;
  const s = nodeOf(g, from);
  const t = nodeOf(g, to);
  const allowFee = force || feeAllowed(from, to);
  const { dist, prevEdge, prevNode } = dijkstra(g, s, allowFee, t);
  if (!Number.isFinite(dist[t])) return force ? null : shortestPath(pack, from, to, true);
  const nodes = [t];
  const edges = [];
  for (let v = t; v !== s; v = prevNode[v]) { edges.push(prevEdge[v]); nodes.push(prevNode[v]); }
  nodes.reverse();
  edges.reverse();
  return { from: s, to: t, nodes, edges, meters: dist[t], allowFee, g };
}

function dijkstra(g, s, allowFee, target = -1) {
  const dist = new Float64Array(g.n).fill(Infinity);
  const prevEdge = new Int32Array(g.n).fill(-1);
  const prevNode = new Int32Array(g.n).fill(-1);
  const done = new Uint8Array(g.n);
  const heap = [];
  const push = (c, v) => { heap.push([c, v]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let k = i; if (l < heap.length && heap[l][0] < heap[k][0]) k = l; if (r < heap.length && heap[r][0] < heap[k][0]) k = r; if (k === i) break; [heap[k], heap[i]] = [heap[i], heap[k]]; i = k; } } return top; };
  dist[s] = 0;
  push(0, s);
  while (heap.length) {
    const [c, v] = pop();
    if (done[v]) continue;
    done[v] = 1;
    if (v === target) break;
    for (let k = g.start[v]; k < g.start[v + 1]; k += 1) {
      const e = g.edgeOf[k];
      if (!usable(g.ways[g.edges[4 * e + 2]], allowFee)) continue;
      const w = g.to[k];
      const nc = c + g.edges[4 * e + 3] / 10;
      if (nc < dist[w]) { dist[w] = nc; prevEdge[w] = e; prevNode[w] = v; push(nc, w); }
    }
  }
  return { dist, prevEdge, prevNode };
}

// ---------------------------------------------------------------- steps
const pt = (g, i) => ({ lat: g.lat[i], lon: g.lon[i] });

function wayLabel(w) {
  if (w.x) return { key: 'crossing', text: 'the crosswalk', kind: 'crossing' };
  if (w.h === 'steps') return { key: `steps|${w.n ?? ''}`, text: w.n ? `the steps (${w.n})` : 'the steps', kind: 'steps' };
  if (w.n) return { key: `n|${w.n}`, text: w.n, kind: 'named', fee: !!w.fee };
  if (w.fee) return { key: 'fee', text: 'the paths inside the palace grounds (ticket area)', kind: 'fee', fee: true };
  if (w.sw) return { key: 'sidewalk', text: 'the pavement', kind: 'sidewalk' };
  if (w.h === 'pedestrian') return { key: 'pedestrian', text: w.area ? 'the square' : 'the pedestrian street', kind: 'plain' };
  if (/^(service|residential|living_street|track|unclassified)$/.test(w.h)) return { key: 'lane', text: 'the lane', kind: 'plain' };
  if (/^(primary|secondary|tertiary)/.test(w.h)) return { key: `road|${w.h}`, text: 'the main road', kind: 'plain' };
  return { key: 'path', text: 'the path', kind: 'plain' };
}

/** Bearing over roughly the first or last `span` metres of a run of nodes. */
function runBearing(g, nodes, fromEnd, span = 20) {
  const seq = fromEnd ? [...nodes].reverse() : nodes;
  const a = pt(g, seq[0]);
  let b = pt(g, seq[1] ?? seq[0]);
  let acc = 0;
  for (let i = 1; i < seq.length; i += 1) {
    acc += distanceM(pt(g, seq[i - 1]), pt(g, seq[i]));
    b = pt(g, seq[i]);
    if (acc >= span) break;
  }
  const deg = fromEnd ? bearingDeg(b, a) : bearingDeg(a, b);
  return deg;
}

function turnWord(delta) {
  const a = Math.abs(delta);
  const side = delta > 0 ? 'right' : 'left';
  if (a < 25) return { word: 'continue', side: null };
  if (a < 60) return { word: `bear ${side}`, side };
  if (a < 145) return { word: `turn ${side}`, side };
  return { word: `turn sharply ${side}`, side };
}

const roundM = (m) => Math.max(10, Math.round(m / 10) * 10);
const lenText = (m) => (m < 1000 ? `${roundM(m)} m` : `${(m / 1000).toFixed(1)} km`);

/** Which side of the walking direction a place is on (a->b is the direction). */
function sideOf(a, b, p) {
  const x1 = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  const y1 = b.lat - a.lat;
  const x2 = (p.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  const y2 = p.lat - a.lat;
  return x1 * y2 - y1 * x2 > 0 ? 'left' : 'right';
}

/** Distance from p to segment a-b in metres, and the fraction along it. */
function toSegment(a, b, p) {
  const k = Math.cos((a.lat * Math.PI) / 180) * 111320;
  const ax = 0; const ay = 0;
  const bx = (b.lon - a.lon) * k; const by = (b.lat - a.lat) * 110540;
  const px = (p.lon - a.lon) * k; const py = (p.lat - a.lat) * 110540;
  const L = bx * bx + by * by;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / L)) : 0;
  const dx = px - t * bx; const dy = py - t * by;
  return { d: Math.sqrt(dx * dx + dy * dy), t };
}

const PASS_KINDS = new Set(['sight', 'restaurant', 'cafe', 'station', 'info', 'toilet', 'pharmacy', 'atm']);

/**
 * Turn a path into steps a walker can follow: one step per stretch of the same street or path, with the turn,
 * the length, and the pack places passed on the way (within about 35 m, sights 45 m).
 */
export function routeSteps(pack, path, { fromPlace, toPlace } = {}) {
  const { g, nodes, edges } = path;
  // runs of edges with the same label
  const runs = [];
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i];
    const lab = wayLabel(g.ways[g.edges[4 * e + 2]]);
    const len = g.edges[4 * e + 3] / 10;
    const last = runs[runs.length - 1];
    if (last && last.label.key === lab.key) { last.edges.push(e); last.nodes.push(nodes[i + 1]); last.meters += len; } else runs.push({ label: lab, edges: [e], nodes: [nodes[i], nodes[i + 1]], meters: len });
  }
  // fold tiny unnamed bits (under 15 m, not a crossing or steps) into the run before them, so the list stays readable
  const merged = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    const tiny = r.meters < 25 && r.label.kind !== 'crossing' && r.label.kind !== 'steps';
    if (prev && (tiny || (prev.label.key === r.label.key))) { prev.edges.push(...r.edges); prev.nodes.push(...r.nodes.slice(1)); prev.meters += r.meters; continue; }
    merged.push({ ...r, nodes: [...r.nodes], edges: [...r.edges] });
  }
  // a short unnamed run between two runs of the same named street belongs to that street
  for (let i = 1; i < merged.length - 1; i += 1) {
    const [a, b, c] = [merged[i - 1], merged[i], merged[i + 1]];
    if (a.label.key === c.label.key && b.meters < 30 && b.label.kind !== 'crossing' && b.label.kind !== 'steps') {
      a.edges.push(...b.edges, ...c.edges); a.nodes.push(...b.nodes.slice(1), ...c.nodes.slice(1)); a.meters += b.meters + c.meters;
      merged.splice(i, 2);
      i -= 1;
    }
  }

  for (const r of merged) {
    if (!['sidewalk', 'plain'].includes(r.label.kind) || r.meters < 25) continue;
    const st = alongStreet(g, r.nodes);
    if (st) r.label = { key: `along|${st}`, text: `${r.label.kind === 'sidewalk' ? 'the pavement' : r.label.text} along ${st}`, kind: 'along', street: st };
  }
  for (let i = 1; i < merged.length; i += 1) {
    const [a, b] = [merged[i - 1], merged[i]];
    const same = a.label.key === b.label.key || (a.label.street && (b.label.text === a.label.street || b.label.street === a.label.street) && b.label.kind !== 'crossing');
    if (same) { a.edges.push(...b.edges); a.nodes.push(...b.nodes.slice(1)); a.meters += b.meters; if (b.label.kind === 'named') a.label = b.label; merged.splice(i, 1); i -= 1; }
  }

  // places passed: nearest step of each place within reach, not the start or the end
  const skip = new Set([fromPlace?.id, toPlace?.id].filter(Boolean));
  const passes = new Map(); // step index -> [{place, side, at}]
  for (const p of pack.places ?? []) {
    if (skip.has(p.id) || !PASS_KINDS.has(p.kind)) continue;
    const reach = p.kind === 'sight' ? 45 : 35;
    let best = null;
    merged.forEach((r, si) => {
      let along = 0;
      for (let k = 1; k < r.nodes.length; k += 1) {
        const a = pt(g, r.nodes[k - 1]);
        const b = pt(g, r.nodes[k]);
        const seg = distanceM(a, b);
        const { d, t } = toSegment(a, b, p);
        if (d <= reach && (!best || d < best.d)) best = { si, d, side: sideOf(a, b, p), at: along + t * seg };
        along += seg;
      }
    });
    if (best) {
      if (!passes.has(best.si)) passes.set(best.si, []);
      passes.get(best.si).push({ place: p, side: best.side, at: best.at, d: best.d });
    }
  }

  // "Continue on the path" right after another stretch, with no turn, reads as one step with it
  for (let i = 1; i < merged.length; i += 1) {
    const [a, b] = [merged[i - 1], merged[i]];
    if (['crossing', 'steps'].includes(a.label.kind) || ['crossing', 'steps', 'named', 'fee'].includes(b.label.kind)) continue;
    const delta = ((runBearing(g, b.nodes, false) - runBearing(g, a.nodes, true) + 540) % 360) - 180;
    if (Math.abs(delta) >= 25 || (passes.has(i) && !passes.has(i - 1) && false)) continue;
    for (const [si, list] of [...passes]) {
      if (si === i) { passes.set(i - 1, [...(passes.get(i - 1) ?? []), ...list.map((x) => ({ ...x, at: x.at + a.meters }))]); passes.delete(i); } else if (si > i) { passes.set(si - 1, list); passes.delete(si); }
    }
    a.edges.push(...b.edges); a.nodes.push(...b.nodes.slice(1)); a.meters += b.meters;
    merged.splice(i, 1);
    i -= 1;
  }

  const steps = [];
  let walked = 0;
  merged.forEach((r, i) => {
    const head = runBearing(g, r.nodes, false);
    let text;
    let turn = null;
    const on = r.label.text;
    if (i === 0) text = `Head ${compass(head)} on ${on}`;
    else {
      const prevHead = runBearing(g, merged[i - 1].nodes, true);
      const delta = ((head - prevHead + 540) % 360) - 180;
      turn = turnWord(delta);
      if (r.label.kind === 'crossing') text = turn.word === 'continue' ? 'Cross the road at the crosswalk' : `${cap(turn.word)} and cross the road at the crosswalk`;
      else if (r.label.kind === 'steps') text = turn.word === 'continue' ? `Take ${on}` : `${cap(turn.word)} and take ${on}`;
      else if (turn.word === 'continue') text = `Continue on ${on}`;
      else text = `${cap(turn.word)} onto ${on}`;
    }
    if (r.label.fee && !(merged[i - 1]?.label.fee)) text += ' (palace grounds, ticket needed)';
    const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const streetName = norm(r.label.street ?? (r.label.kind === 'named' ? r.label.text : ''));
    const passed = (passes.get(i) ?? [])
      .filter((x) => !streetName || !norm(x.place.name).includes(streetName))
      .sort((a, b) => (a.place.kind === 'sight' ? 0 : 1) - (b.place.kind === 'sight' ? 0 : 1) || a.d - b.d).slice(0, 3)
      .sort((a, b) => a.at - b.at)
      .map((x) => ({ id: x.place.id, name: x.place.name, side: x.side, kind: x.place.kind }));
    steps.push({ n: steps.length + 1, text, meters: r.meters, length: lenText(r.meters), dir: compass(head), turn: turn?.word ?? 'start', street: r.label.kind === 'named' ? r.label.text : r.label.street ?? null, kind: r.label.kind, passes: passed, from: r.nodes[0], to: r.nodes[r.nodes.length - 1], startM: walked });
    walked += r.meters;
  });
  if (toPlace) {
    const lastNode = nodes[nodes.length - 1];
    const prev = nodes[nodes.length - 2] ?? lastNode;
    const side = sideOf(pt(g, prev), pt(g, lastNode), toPlace);
    const off = distanceM(pt(g, lastNode), toPlace);
    steps.push({ n: steps.length + 1, text: `Arrive at ${toPlace.name}${off >= 15 ? `, about ${roundM(off)} m on your ${side}` : ''}`, meters: 0, length: '', kind: 'arrive', passes: [], from: lastNode, to: lastNode, startM: walked, arrive: toPlace.id });
  }
  return steps;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/** One walk from place A to place B: the path, the steps and a summary, or null. */
export function walk(pack, fromPlace, toPlace) {
  if (!fromPlace || !toPlace) return null;
  if (fromPlace.id === toPlace.id) return { same: true, meters: 0, minutes: 0, steps: [], summary: `You are at ${toPlace.name}.` };
  if (fromPlace.ticket === toPlace.id) return { same: true, inside: true, meters: 0, minutes: 0, steps: [], summary: `You are inside the grounds of ${toPlace.name}.` };
  const end = endOf(pack, fromPlace, toPlace);
  if (end.id === fromPlace.id) return { same: true, meters: 0, minutes: 0, steps: [], summary: `You are at ${end.name}, the main gate of ${toPlace.name}.` };
  const path = shortestPath(pack, fromPlace, end);
  if (!path) return null;
  const steps = routeSteps(pack, path, { fromPlace, toPlace: end });
  if (end !== toPlace && steps.length) {
    const last = steps[steps.length - 1];
    if (last.arrive) last.text = `Arrive at ${end.name}, the main gate of ${toPlace.name}`;
  }
  const meters = path.meters + (fromPlace.snapM ?? 0) + (end.snapM ?? 0);
  const minutes = Math.max(1, Math.round(meters / WALK_M_PER_MIN));
  const line = path.nodes.map((i) => [path.g.lat[i], path.g.lon[i]]);
  const straight = distanceM(fromPlace, toPlace);
  const dir = compass(bearingDeg(fromPlace, toPlace));
  return {
    from: fromPlace.id, to: toPlace.id, meters, minutes, steps, line, nodes: path.nodes, pathMeters: path.meters, dir, straight,
    door: end !== toPlace ? end.id : null,
    doorName: end !== toPlace ? end.name : null,
    ticketArea: path.edges.some((e) => path.g.ways[path.g.edges[4 * e + 2]]?.fee),
    ticketPlace: path.edges.some((e) => path.g.ways[path.g.edges[4 * e + 2]]?.fee) ? (fromPlace.ticket || end.ticket || (pack.places ?? []).find((p) => p.ticket === p.id)?.id || null) : null,
    summary: `${distanceText(meters)} on foot, about ${minutes} min, heading ${dir} overall`,
  };
}

/** Walking distance only (for ranking), in metres; falls back to the straight line if there is no path. */
export function walkMeters(pack, a, b) {
  if (a.id === b.id || a.ticket === b.id) return 0;
  const end = endOf(pack, a, b);
  if (end.id === a.id) return 0;
  const p = shortestPath(pack, a, end);
  return p ? p.meters + (a.snapM ?? 0) + (end.snapM ?? 0) : distanceM(a, b) * 1.3;
}

/** Walking distances from one place to every place, by the same rule as shortestPath (two searches: with and without ticketed paths). */
export function walkMetersFrom(pack, from) {
  const g = graphOf(pack);
  const out = new Map();
  if (!g) return out;
  const s = nodeOf(g, from);
  const outside = dijkstra(g, s, feeAllowed(from, null)).dist;
  const inside = from.ticket ? outside : dijkstra(g, s, true).dist;
  for (const p of pack.places ?? []) {
    const end = endOf(pack, from, p);
    const t = nodeOf(g, end);
    let d = (feeAllowed(from, end) ? inside : outside)[t];
    if (!Number.isFinite(d)) d = inside[t];
    const same = p.id === from.id || end.id === from.id || from.ticket === p.id;
    out.set(p.id, same ? 0 : Number.isFinite(d) ? d + (from.snapM ?? 0) + (end.snapM ?? 0) : distanceM(from, p) * 1.3);
  }
  return out;
}
