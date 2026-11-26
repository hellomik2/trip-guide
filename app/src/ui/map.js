// The walking map, drawn as SVG from the saved pack's own path network. No map tiles and no map server:
// it works offline and shows exactly the path the steps describe.
const NS = 'http://www.w3.org/2000/svg';
const KIND_COLOR = { sight: '#7c3aed', restaurant: '#c2410c', cafe: '#b45309', station: '#0369a1', info: '#0f766e', toilet: '#475569', pharmacy: '#be123c', atm: '#475569', other: '#475569' };

function svg(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  if (text != null) n.textContent = text;
  return n;
}

export function createMap(el, pack) {
  const lat0 = pack.center.lat;
  const lon0 = pack.center.lon;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110540;
  const X = (lon) => (lon - lon0) * kx;
  const Y = (lat) => -(lat - lat0) * ky;
  const P = (p) => [X(p.lon), Y(p.lat)];
  const net = pack.net;
  const nx = (i) => X(net.nodes[2 * i + 1] / 1e6);
  const ny = (i) => Y(net.nodes[2 * i] / 1e6);

  el.replaceChildren();
  el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const defs = svg('defs');
  defs.append(svg('filter', { id: 'halo' }));
  el.append(defs);
  const base = svg('g', { class: 'm-base' });
  const over = svg('g', { class: 'm-over' });
  el.append(base, over);

  // base: paths by kind, one <path> each (fast to draw, about 5,800 segments)
  const groups = { major: [], minor: [], foot: [], fee: [], steps: [] };
  for (let e = 0; e < net.edges.length / 4; e += 1) {
    const a = net.edges[4 * e];
    const b = net.edges[4 * e + 1];
    const w = net.ways[net.edges[4 * e + 2]];
    const g = w.fee ? 'fee' : w.h === 'steps' ? 'steps' : /^(primary|secondary|tertiary)/.test(w.h) ? 'major' : /^(footway|path|pedestrian|corridor)$/.test(w.h) ? 'foot' : 'minor';
    groups[g].push(`M${nx(a).toFixed(1)} ${ny(a).toFixed(1)}L${nx(b).toFixed(1)} ${ny(b).toFixed(1)}`);
  }
  for (const [g, d] of Object.entries(groups)) base.append(svg('path', { d: d.join(''), class: `m-${g}` }));
  // street names along the main roads (once per name, at the middle segment of its longest stretch)
  const labelled = new Map();
  for (let e = 0; e < net.edges.length / 4; e += 1) {
    const w = net.ways[net.edges[4 * e + 2]];
    if (!w.n || !/^(primary|secondary|tertiary)/.test(w.h)) continue;
    const len = net.edges[4 * e + 3];
    if (!labelled.has(w.n) || labelled.get(w.n).len < len) labelled.set(w.n, { e, len });
  }
  const streetLabels = svg('g', { class: 'm-streets' });
  for (const [name, { e }] of labelled) {
    const a = net.edges[4 * e];
    const b = net.edges[4 * e + 1];
    let ang = (Math.atan2(ny(b) - ny(a), nx(b) - nx(a)) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    const cx = (nx(a) + nx(b)) / 2;
    const cy = (ny(a) + ny(b)) / 2;
    streetLabels.append(svg('text', { x: cx, y: cy, transform: `rotate(${ang.toFixed(0)} ${cx.toFixed(1)} ${cy.toFixed(1)})`, class: 'm-street' }, name));
  }
  base.append(streetLabels);
  // all places as small dots, so the map reads as a neighbourhood
  const dots = svg('g', { class: 'm-dots' });
  for (const p of pack.places) {
    const [x, y] = P(p);
    dots.append(svg('circle', { cx: x, cy: y, r: 5, fill: KIND_COLOR[p.kind] ?? KIND_COLOR.other, class: 'm-dot' }));
  }
  base.append(dots);

  let view = null; // [x, y, w, h]
  let fit = null;
  const setView = (v) => {
    view = v;
    el.setAttribute('viewBox', v.map((n) => n.toFixed(1)).join(' '));
    const k = v[2] / Math.max(1, el.clientWidth || 600); // metres per pixel
    el.style.setProperty('--k', k.toFixed(3));
    for (const t of el.querySelectorAll('.scale-txt, .m-street, .m-label, .m-num')) t.style.fontSize = `${(t.classList.contains('m-street') ? 11 : t.classList.contains('m-num') ? 11 : 12.5) * k}px`;
    for (const t of el.querySelectorAll('[data-r]')) t.setAttribute('r', String(Number(t.dataset.r) * k));
    el.querySelector('.m-dots')?.querySelectorAll('circle').forEach((c) => c.setAttribute('r', String(3.2 * k)));
    drawScale();
  };
  const fitTo = (pts, minSpan = 320) => {
    const box = el.getBoundingClientRect();
    const aspect = box.width > 0 && box.height > 0 ? box.width / box.height : 1.4;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (!Number.isFinite(x0)) { [x0, y0, x1, y1] = [-700, -700, 700, 700]; }
    let w = Math.max(minSpan, (x1 - x0) * 1.25);
    let h = Math.max(minSpan / aspect, (y1 - y0) * 1.25);
    if (w / h > aspect) h = w / aspect; else w = h * aspect;
    fit = [(x0 + x1) / 2 - w / 2, (y0 + y1) / 2 - h / 2, w, h];
    setView(fit);
  };

  const scale = svg('g', { class: 'm-scale' });
  el.append(scale);
  function drawScale() {
    scale.replaceChildren();
    if (!view) return;
    const k = view[2] / Math.max(1, el.clientWidth || 600);
    const target = 90 * k;
    const nice = [20, 50, 100, 200, 250, 500, 1000].find((n) => n >= target * 0.7) ?? 1000;
    const x = view[0] + 12 * k;
    const y = view[1] + view[3] - 14 * k;
    scale.append(svg('line', { x1: x, y1: y, x2: x + nice, y2: y, class: 'scale-line' }));
    scale.append(svg('text', { x, y: y - 6 * k, class: 'scale-txt', style: `font-size:${11 * k}px` }, nice >= 1000 ? `${nice / 1000} km` : `${nice} m`));
    scale.append(svg('text', { x: view[0] + view[2] - 22 * k, y: view[1] + 22 * k, class: 'scale-txt north', style: `font-size:${13 * k}px` }, 'N ↑'));
  }

  function marker(p, { cls, label, num, r = 7 }) {
    const [x, y] = P(p);
    const g = svg('g', { class: `m-mark ${cls}`, 'data-id': p.id ?? '' });
    g.append(svg('circle', { cx: x, cy: y, 'data-r': r, r, class: 'm-pin' }));
    if (num != null) g.append(svg('text', { x, y, class: 'm-num', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, String(num)));
    if (label) g.append(svg('text', { x, y, dx: 0, class: 'm-label', 'data-dx': 10 }, label));
    return g;
  }

  function placeLabels() {
    const k = view ? view[2] / Math.max(1, el.clientWidth || 600) : 1;
    for (const t of over.querySelectorAll('.m-label')) { t.setAttribute('dx', String(10 * k)); t.setAttribute('dy', String(4 * k)); }
  }

  let stepMarks = [];
  return {
    /** Draw one answer: route (line and step numbers), places (numbered), here and the focus place. */
    show({ route = null, places = [], here = null, focus = null, stepNumbers = true } = {}) {
      over.replaceChildren();
      stepMarks = [];
      const pts = [];
      if (route?.line?.length) {
        const d = route.line.map(([la, lo], i) => `${i ? 'L' : 'M'}${X(lo).toFixed(1)} ${Y(la).toFixed(1)}`).join('');
        over.append(svg('path', { d, class: 'm-route-casing', 'data-sw': 9 }), svg('path', { d, class: 'm-route', 'data-sw': 5 }));
        for (const [la, lo] of route.line) pts.push([X(lo), Y(la)]);
        for (const s of stepNumbers ? route.steps ?? [] : []) {
          if (s.kind === 'arrive') continue;
          const g = svg('g', { class: 'm-step', 'data-step': s.n });
          const x = nx(s.from);
          const y = ny(s.from);
          g.append(svg('circle', { cx: x, cy: y, 'data-r': 8, r: 8, class: 'm-step-dot' }), svg('text', { x, y, class: 'm-num', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, String(s.n)));
          over.append(g);
          stepMarks.push(g);
        }
      }
      for (const c of places) {
        if (here && c.id === here.id) continue;
        const isFocus = c.id === focus;
        over.append(marker(c, { cls: `${isFocus ? 'focus' : 'item'} k-${c.kind}`, label: c.name.replace(/\s*\(.*\)$/, ''), num: c.rank ?? null, r: isFocus ? 9 : 8 }));
        pts.push(P(c));
      }
      if (here) { over.append(marker(here, { cls: 'here', label: 'You', r: 7 })); pts.push(P(here)); }
      fitTo(pts, route ? 260 : 420);
      placeLabels();
    },
    highlightStep(n) {
      for (const g of stepMarks) g.classList.toggle('on', Number(g.dataset.step) === n);
    },
    zoom(dir) {
      if (!view) return;
      if (dir === 'fit' && fit) { setView(fit); placeLabels(); return; }
      const f = dir === 'in' ? 0.7 : 1 / 0.7;
      const [x, y, w, h] = view;
      setView([x + (w - w * f) / 2, y + (h - h * f) / 2, w * f, h * f]);
      placeLabels();
    },
    pan(dx, dy) {
      if (!view) return;
      const k = view[2] / Math.max(1, el.clientWidth || 600);
      setView([view[0] - dx * k, view[1] - dy * k, view[2], view[3]]);
    },
    refit() { if (fit) { setView(view ?? fit); placeLabels(); } },
  };
}
