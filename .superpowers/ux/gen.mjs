// Throwaway: graph-feasibility experiment for aang. Not production code.
// Usage: node gen.mjs   (needs d3-force installed under D3 path below)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const D3 = '/private/tmp/claude-501/-Users-karych-src/7df13757-1020-45f3-b525-12ff1c856bb7/scratchpad/node_modules/d3-force/src/index.js';
const d3 = await import(D3);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = HERE;
const map = JSON.parse(fs.readFileSync('/Users/karych/src/aang/.aang/map.json', 'utf8'));
const EDGES = JSON.parse(fs.readFileSync(path.join(HERE, 'edges.json'), 'utf8')).edges;

const W = 1400, H = 900;              // viewport the graph must fit
const CHAR = 6.6, LABEL_H = 14;       // px per char at 12px sans, label box height
const LABEL_MAX = 38;                 // chars shown per label
const R = 7;                          // node radius

// ---------------------------------------------------------------- real map
function realNodes() {
  return map.nodes.map(n => ({
    id: n.id, kind: n.kind, status: n.status, turn: n.cites[0].turn,
    label: n.question, sup: n.superseded_by,
  }));
}
function realEdges(tiers) {
  return EDGES.filter(e => tiers.includes(e.tier)).map(e => ({ source: e.s, target: e.t, rel: e.rel, tier: e.tier }));
}

// ---------------------------------------------------------------- synthesis
// Seeded RNG so every run is reproducible.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const QPOOL = map.nodes.map(n => n.question);
// Empirical back-edge distribution (strong+medium, real map, time order): 0:9 1:7 2:4 of 20
const BACK = [0.45, 0.35, 0.20];

function synth(N, seed, density = 1.0) {
  const r = rng(seed);
  const nodes = [], edges = [];
  let turn = 2, counters = { decision: 0, tacit: 0, open: 0 };
  for (let i = 0; i < N; i++) {
    if (i > 0) turn += (r() < 0.35 ? 0 : 1 + Math.floor(r() * 8));
    const k = r() < 0.4 ? 'decision' : (r() < 0.5 ? 'tacit' : 'open');
    counters[k]++;
    const id = (k === 'decision' ? 'd' : k === 'tacit' ? 't' : 'o') + counters[k];
    const label = QPOOL[Math.floor(r() * QPOOL.length)].replace(/\?$/, '') + ' (' + id + ')?';
    const n = { id, kind: k, status: k === 'open' ? 'proposed' : 'accepted', turn, label, sup: null, deg: 0 };
    // back-edges: 0/1/2 per empirical distribution, scaled by density
    let kEdges = r() < BACK[0] ? 0 : (r() < BACK[1] / (BACK[1] + BACK[2]) ? 1 : 2);
    if (density > 1 && r() < density - 1) kEdges++;
    if (density < 1 && r() > density) kEdges = 0;
    const prior = nodes.filter(p => p.kind === 'decision' || r() < 0.07);
    const picked = new Set();
    for (let j = 0; j < kEdges && prior.length > picked.size; j++) {
      // preferential attachment: weight = deg+1; retry on a duplicate target
      let tgt = null;
      for (let tries = 0; tries < 8 && (!tgt || picked.has(tgt.id)); tries++) {
        const tot = prior.reduce((a, p) => a + p.deg + 1, 0);
        let x = r() * tot; tgt = prior[prior.length - 1];
        for (const p of prior) { x -= p.deg + 1; if (x <= 0) { tgt = p; break; } }
      }
      if (picked.has(tgt.id)) continue;
      picked.add(tgt.id);
      let rel = k === 'open' ? 'consequence_of' : k === 'tacit' ? 'parameter_of' : 'refines';
      // ~1 supersession per 20 nodes
      if (k === 'decision' && tgt.kind === 'decision' && tgt.status === 'accepted' && r() < 0.12) {
        tgt.status = 'superseded'; tgt.sup = id; rel = 'supersedes';
      }
      edges.push({ source: id, target: tgt.id, rel, tier: 'synth' });
      tgt.deg++; n.deg++;
    }
    nodes.push(n);
  }
  return { nodes, edges };
}

// first N nodes of a synthetic session, as the session looked at that point
function prefix(g, N) {
  const ids = new Set(g.nodes.slice(0, N).map(n => n.id));
  const nodes = g.nodes.slice(0, N).map(n => ({ ...n, deg: 0, status: n.sup && !ids.has(n.sup) ? 'accepted' : n.status, sup: n.sup && ids.has(n.sup) ? n.sup : null }));
  const edges = g.edges.filter(e => ids.has(e.source) && ids.has(e.target));
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const e of edges) { byId.get(e.source).deg++; byId.get(e.target).deg++; }
  return { nodes, edges };
}
function nextId(g, letter) { return letter + (Math.max(0, ...g.nodes.filter(n => n.id[0] === letter).map(n => parseInt(n.id.slice(1), 10) || 0)) + 1); }
// three nodes a later session would add; attached to the given hub decision
function later3(base, hub = 'd6') {
  const t = Math.max(...base.nodes.map(n => n.turn));
  const d = nextId(base, 'd'), o = nextId(base, 'o'), tt = nextId(base, 't');
  return {
    nodes: [
      { id: d, kind: 'decision', status: 'accepted', turn: t + 3, label: 'Показывать ли карту графом, а не списком?', sup: null },
      { id: o, kind: 'open', status: 'proposed', turn: t + 3, label: 'Где хранить позиции узлов, если граф?', sup: null },
      { id: tt, kind: 'tacit', status: 'accepted', turn: t + 6, label: 'Раскладка графа — force-directed по умолчанию', sup: null },
    ],
    edges: [
      { source: d, target: hub, rel: 'refines', tier: 'strong' },
      { source: o, target: d, rel: 'consequence_of', tier: 'strong' },
      { source: tt, target: d, rel: 'parameter_of', tier: 'strong' },
    ],
  };
}

// ---------------------------------------------------------------- layouts
function labelW(n) { return Math.min(n.label.length, LABEL_MAX) * CHAR + 4; }
function clone(g) { return { nodes: g.nodes.map(n => ({ ...n })), edges: g.edges.map(e => ({ ...e })) }; }

function forceLayout(g, opts = {}) {
  const gg = clone(g);
  const byId = new Map(gg.nodes.map(n => [n.id, n]));
  if (opts.warm) for (const n of gg.nodes) { const p = opts.warm.get(n.id); if (p) { n.x = p.x; n.y = p.y; if (opts.pin) { n.fx = p.x; n.fy = p.y; } } }
  const links = gg.edges.map(e => ({ source: byId.get(e.source), target: byId.get(e.target), rel: e.rel }));
  const sim = d3.forceSimulation(gg.nodes)
    .force('link', d3.forceLink(links).distance(100).strength(0.6))
    .force('charge', d3.forceManyBody().strength(-380))
    .force('collide', d3.forceCollide(n => Math.max(R + 6, labelW(n) / 2 * 0.75)).iterations(2))
    .force('x', d3.forceX(W / 2).strength(0.03))
    .force('y', d3.forceY(H / 2).strength(0.05))
    .stop();
  for (let i = 0; i < 400; i++) sim.tick();
  for (const n of gg.nodes) { delete n.fx; delete n.fy; }
  gg.fitScale = opts.nofit ? 1 : fit(gg.nodes);
  return gg;
}

// scale+translate positions so the bounding box (labels included) sits in the viewport
function fit(nodes) {
  const xs0 = Math.min(...nodes.map(n => n.x - R)), xs1 = Math.max(...nodes.map(n => n.x + R + labelW(n)));
  const ys0 = Math.min(...nodes.map(n => n.y - R)), ys1 = Math.max(...nodes.map(n => n.y + R));
  const s = Math.min((W - 40) / (xs1 - xs0), (H - 40) / (ys1 - ys0), 1);
  for (const n of nodes) { n.x = 20 + (n.x - xs0) * s; n.y = 20 + (n.y - ys0) * s; }
  return s;
}

// Deterministic: x = turn (fixed px per turn or fit-to-width), y = kind lane, sub-rows to avoid label overlap
const LANES = { tacit: 0, open: 1, decision: 2 };
function layeredLayout(g, opts = {}) {
  const gg = clone(g);
  const maxTurn = Math.max(...gg.nodes.map(n => n.turn));
  const pxPerTurn = opts.pxPerTurn || (W - 60 - 250) / maxTurn;   // fit-to-width unless fixed
  const laneH = (H - 60) / 3;
  const rows = { tacit: [], open: [], decision: [] };            // per lane: list of sub-rows, each = rightmost x occupied
  const sorted = gg.nodes.slice().sort((a, b) => a.turn - b.turn || a.id.localeCompare(b.id));
  for (const n of sorted) {
    n.x = 30 + n.turn * pxPerTurn;
    const rs = rows[n.kind];
    let i = rs.findIndex(right => right < n.x - R - 6);
    if (i < 0) { i = rs.length; rs.push(0); }
    rs[i] = n.x + R + labelW(n);
    n.row = i;
  }
  for (const n of gg.nodes) {
    const rs = rows[n.kind];
    const step = Math.min(LABEL_H + 10, laneH / (rs.length + 1));
    n.y = 30 + LANES[n.kind] * laneH + 20 + n.row * step;
  }
  gg.width = 30 + maxTurn * pxPerTurn + 260;
  return gg;
}

// ---------------------------------------------------------------- metrics
function labelBox(n) { return { x0: n.x + R + 3, x1: n.x + R + 3 + labelW(n), y0: n.y - LABEL_H / 2, y1: n.y + LABEL_H / 2 }; }
function overlap(a, b) { return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1; }
function labelCollisions(nodes) {
  const bx = nodes.map(labelBox); let c = 0;
  for (let i = 0; i < bx.length; i++) for (let j = i + 1; j < bx.length; j++) if (overlap(bx[i], bx[j])) c++;
  // also label over a foreign node dot
  for (let i = 0; i < nodes.length; i++) for (let j = 0; j < nodes.length; j++) if (i !== j) {
    const n = nodes[j], b = bx[i];
    if (n.x > b.x0 - R && n.x < b.x1 + R && n.y > b.y0 - R && n.y < b.y1 + R) c++;
  }
  return c;
}
function segInter(p, q, r2, s) {
  const d = (q.x - p.x) * (s.y - r2.y) - (q.y - p.y) * (s.x - r2.x);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((r2.x - p.x) * (s.y - r2.y) - (r2.y - p.y) * (s.x - r2.x)) / d;
  const u = ((r2.x - p.x) * (q.y - p.y) - (r2.y - p.y) * (q.x - p.x)) / d;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
}
function crossings(g) {
  const byId = new Map(g.nodes.map(n => [n.id, n])); let c = 0;
  const E = g.edges.map(e => [byId.get(e.source), byId.get(e.target)]);
  for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
    const [a, b] = E[i], [c2, d] = E[j];
    if (a === c2 || a === d || b === c2 || b === d) continue;
    if (segInter(a, b, c2, d)) c++;
  }
  return c;
}
function edgeLen(g) {
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const L = g.edges.map(e => Math.hypot(byId.get(e.source).x - byId.get(e.target).x, byId.get(e.source).y - byId.get(e.target).y));
  return L.length ? +(L.reduce((a, b) => a + b, 0) / L.length).toFixed(0) : 0;
}
// how many edges pass through a label box they don't belong to
function edgeThroughLabel(g) {
  const byId = new Map(g.nodes.map(n => [n.id, n])); let c = 0;
  for (const e of g.edges) {
    const a = byId.get(e.source), b = byId.get(e.target);
    for (const n of g.nodes) { if (n === a || n === b) continue; const bx = labelBox(n);
      const corners = [{x:bx.x0,y:bx.y0},{x:bx.x1,y:bx.y0},{x:bx.x1,y:bx.y1},{x:bx.x0,y:bx.y1}];
      let hit = false; for (let i = 0; i < 4; i++) if (segInter(a, b, corners[i], corners[(i+1)%4])) { hit = true; break; }
      if (hit) c++; }
  }
  return c;
}
function metrics(g) {
  return { n: g.nodes.length, m: g.edges.length, labelCollisions: labelCollisions(g.nodes), crossings: crossings(g), edgeThroughLabel: edgeThroughLabel(g), meanEdgePx: edgeLen(g), ...(g.fitScale !== undefined ? { fitScale: +g.fitScale.toFixed(2) } : {}) };
}
function displacement(before, after) {
  const A = new Map(after.nodes.map(n => [n.id, n]));
  const d = before.nodes.map(n => { const a = A.get(n.id); return Math.hypot(a.x - n.x, a.y - n.y); }).sort((x, y) => x - y);
  const diag = Math.hypot(W, H);
  // relative-order preservation: fraction of pairs whose left/right AND above/below relation survived
  let keep = 0, tot = 0;
  for (let i = 0; i < before.nodes.length; i++) for (let j = i + 1; j < before.nodes.length; j++) {
    const p = before.nodes[i], q = before.nodes[j], p2 = A.get(p.id), q2 = A.get(q.id);
    tot++; if (Math.sign(p.x - q.x) === Math.sign(p2.x - q2.x) && Math.sign(p.y - q.y) === Math.sign(p2.y - q2.y)) keep++;
  }
  const quadrant = n => (n.x < W / 2 ? 'L' : 'R') + (n.y < H / 2 ? 'T' : 'B');
  const sameQuadrant = before.nodes.filter(n => quadrant(n) === quadrant(A.get(n.id))).length;
  return {
    movedNodes: before.nodes.length,
    medianPx: +d[Math.floor(d.length / 2)].toFixed(0), meanPx: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(0), maxPx: +d[d.length - 1].toFixed(0),
    meanPctOfDiagonal: +(100 * d.reduce((a, b) => a + b, 0) / d.length / diag).toFixed(1),
    stayedWithin20px: d.filter(x => x <= 20).length,
    pairOrderKept: +(100 * keep / tot).toFixed(0) + '%',
    sameQuadrant: sameQuadrant + '/' + before.nodes.length,
  };
}

// ---------------------------------------------------------------- render
const COL = { decision: '#2c5a86', tacit: '#955500', open: '#6a4c9e' };
const MARK = { decision: '●', tacit: '◆', open: '○' };
function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function svg(g, { title, ghosts, width, lanes } = {}) {
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const Wd = width || W;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${H}" viewBox="0 0 ${Wd} ${H}" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="12">
<defs><marker id="a" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8a8272"/></marker></defs>
<rect width="${Wd}" height="${H}" fill="#f4f1e9"/>`;
  if (lanes) for (const k of Object.keys(LANES)) { const y = 30 + LANES[k] * (H - 60) / 3; s += `<line x1="0" y1="${y - 6}" x2="${Wd}" y2="${y - 6}" stroke="#dad3c4"/><text x="8" y="${y + 6}" fill="${COL[k]}" font-weight="700">${MARK[k]} ${k}</text>`; }
  if (ghosts) for (const n of ghosts.nodes) { const a = byId.get(n.id); if (!a) continue;
    s += `<circle cx="${n.x}" cy="${n.y}" r="${R}" fill="none" stroke="${COL[n.kind]}" stroke-dasharray="2 2" opacity=".6"/><line x1="${n.x}" y1="${n.y}" x2="${a.x}" y2="${a.y}" stroke="#b0261f" stroke-width="1" opacity=".55"/>`; }
  for (const e of g.edges) { const a = byId.get(e.source), b = byId.get(e.target);
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, ex = b.x - dx / L * (R + 1), ey = b.y - dy / L * (R + 1);
    s += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${e.rel === 'supersedes' || e.rel === 'superseded_by' ? '#b0261f' : '#8a8272'}" stroke-width="1.2" marker-end="url(#a)"/>`; }
  for (const n of g.nodes) { const lab = n.label.length > LABEL_MAX ? n.label.slice(0, LABEL_MAX - 1) + '…' : n.label;
    const sup = n.status === 'superseded';
    s += `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${R}" fill="${n.kind === 'open' ? '#f4f1e9' : COL[n.kind]}" stroke="${COL[n.kind]}" stroke-width="2"${n.isNew ? ' stroke="#b0261f" stroke-width="3"' : ''}/>`;
    s += `<text x="${(n.x + R + 3).toFixed(1)}" y="${(n.y + 4).toFixed(1)}" fill="#1e1a14"${sup ? ' text-decoration="line-through" opacity=".6"' : ''}${n.isNew ? ' font-weight="700"' : ''}><tspan fill="#8a8272" font-family="ui-monospace,Menlo,monospace" font-size="10.5">${n.id}</tspan> ${esc(lab)}</text>`; }
  if (title) s += `<text x="${Wd - 12}" y="${H - 12}" text-anchor="end" fill="#8a8272" font-size="12">${esc(title)}</text>`;
  return s + '</svg>';
}
function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>body{margin:0;background:#f4f1e9;font:13px system-ui,sans-serif;color:#1e1a14}h1{font:600 14px system-ui;margin:8px 12px}p{margin:4px 12px;color:#5c554a}</style><h1>${esc(title)}</h1>${body}`;
}
function write(name, html) { fs.writeFileSync(path.join(OUT, name), html); }

// ---------------------------------------------------------------- run
const results = {};
const real = { nodes: realNodes(), edges: realEdges(['strong', 'medium']) };
const realAll = { nodes: realNodes(), edges: realEdges(['strong', 'medium', 'weak']) };

// edge accounting on the real map
{
  const deg = {}; for (const n of real.nodes) deg[n.id] = 0;
  for (const e of real.edges) { deg[e.source]++; deg[e.target]++; }
  const degAll = {}; for (const n of realAll.nodes) degAll[n.id] = 0;
  for (const e of realAll.edges) { degAll[e.source]++; degAll[e.target]++; }
  results.realEdges = {
    strong: EDGES.filter(e => e.tier === 'strong').length, medium: EDGES.filter(e => e.tier === 'medium').length, weak: EDGES.filter(e => e.tier === 'weak').length,
    edgesPerNode_strong: (5 / 20).toFixed(2), edgesPerNode_strongMedium: (real.edges.length / 20).toFixed(2), edgesPerNode_all: (realAll.edges.length / 20).toFixed(2),
    isolated_strongMedium: Object.entries(deg).filter(([, d]) => d === 0).map(([k]) => k),
    isolated_all: Object.entries(degAll).filter(([, d]) => d === 0).map(([k]) => k),
    degree_strongMedium: Object.fromEntries(Object.entries(deg).sort((a, b) => b[1] - a[1])),
    maxBackEdgesPerNode: 2,
  };
}

const S100 = synth(100, 11);
const sizes = { 20: real, 50: prefix(S100, 50), 100: prefix(S100, 100) };
const sizes_dense = { 100: synth(100, 11, 1.4) };
const maxDeg = g => { const d = {}; for (const e of g.edges) { d[e.source] = (d[e.source] || 0) + 1; d[e.target] = (d[e.target] || 0) + 1; } return Math.max(0, ...Object.values(d)); };
results.synthDensity = Object.fromEntries(Object.entries(sizes).map(([k, g]) => [k, { n: g.nodes.length, m: g.edges.length, mPerN: (g.edges.length / g.nodes.length).toFixed(2), maxDeg: maxDeg(g), isolated: g.nodes.filter(n => !g.edges.some(e => e.source === n.id || e.target === n.id)).length }]));
results.synthDensity['synth20prefix'] = { n: 20, m: prefix(S100, 20).edges.length, note: 'first 20 of the synthetic session, to compare with the real 20-node map (13 edges)' };
results.synthDensity['100_dense'] = { n: 100, m: sizes_dense[100].edges.length, mPerN: (sizes_dense[100].edges.length / 100).toFixed(2) };

results.layouts = {};
const layouts = {};
for (const [k, g] of Object.entries(sizes)) {
  const F = forceLayout(g), Lfit = layeredLayout(g), Lfix = layeredLayout(g, { pxPerTurn: 14 });
  layouts[k] = { F, Lfit, Lfix };
  results.layouts[k] = { force: metrics(F), layeredFit: metrics(Lfit), layeredFixed14px: { ...metrics(Lfix), widthPx: Math.round(Lfix.width), screensWide: +(Lfix.width / W).toFixed(1) } };
  write(`graph-${k}-force.html`, page(`${k} nodes, ${g.edges.length} edges — force-directed (d3-force, 400 ticks, fitted to 1400×900)`, svg(F, { title: `force · n=${k} m=${g.edges.length}` })));
  write(`graph-${k}-layered.html`, page(`${k} nodes — layered by time (x = turn, fit to width) × kind lanes`, svg(Lfit, { title: `layered fit · n=${k}`, lanes: true })));
  write(`graph-${k}-layered-fixed.html`, page(`${k} nodes — layered by time, fixed 14 px/turn (scrolls horizontally, ${Math.round(Lfix.width)} px wide)`, `<div style="overflow-x:auto">${svg(Lfix, { title: `layered fixed · n=${k}`, lanes: true, width: Math.ceil(Lfix.width) })}</div>`));
}
{ const g = sizes_dense[100], F = forceLayout(g); results.layouts['100_dense'] = { force: metrics(F) }; write('graph-100-dense-force.html', page(`100 nodes, ${g.edges.length} edges (upper-bound density incl. weak-tier) — force-directed`, svg(F))); }
// real map with weak edges too
{ const F = forceLayout(realAll); results.layouts['20_allTiers'] = { force: metrics(F) }; write('graph-20-force-alltiers.html', page(`20 nodes, ${realAll.edges.length} edges (strong+medium+weak) — force-directed`, svg(F))); }

// ---------------------------------------------------------------- stability: +3 nodes
results.stability = {};
function grow(g, extra) { const gg = clone(g); for (const n of extra.nodes) gg.nodes.push({ ...n, isNew: true }); gg.edges.push(...extra.edges); return gg; }
function synthExtra(g) { // 3 nodes attached like later3 but to this graph's busiest decision
  const hub = g.nodes.filter(n => n.kind === 'decision').sort((a, b) => (b.deg ?? 0) - (a.deg ?? 0))[0];
  return later3(g, hub.id);
}
for (const [k, g] of Object.entries(sizes)) {
  const extra = k === '20' ? later3(g) : synthExtra(g);
  const g2 = grow(g, extra);
  const { F, Lfit, Lfix } = layouts[k];
  const F2 = forceLayout(g2);
  const warm = new Map(F.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
  const F2warm = forceLayout(g2, { warm });
  const F2pin = forceLayout(g2, { warm, pin: true });
  const L2fit = layeredLayout(g2), L2fix = layeredLayout(g2, { pxPerTurn: 14 });
  results.stability[k] = {
    force_fresh: displacement(F, F2),
    force_warmStart: displacement(F, F2warm),
    force_pinnedOld: { ...displacement(F, F2pin), note: 'old nodes fixed; only the 3 new ones move', after: metrics(F2pin) },
    layered_fitToWidth: displacement(Lfit, L2fit),
    layered_fixedScale: displacement(Lfix, L2fix),
  };
  if (k === '20') {
    write('stability-20+3-force-fresh.html', page('20 → 23 nodes, force-directed re-run from scratch. Dashed = old position, red line = where it went, bold = new nodes', svg(F2, { ghosts: F })));
    write('stability-20+3-force-warm.html', page('20 → 23 nodes, force-directed warm-started from old positions (not pinned). Dashed = old position', svg(F2warm, { ghosts: F })));
    write('stability-20+3-force-pinned.html', page('20 → 23 nodes, old nodes pinned, only new nodes placed by the simulation', svg(F2pin, { ghosts: F })));
    write('stability-20+3-layered-fit.html', page('20 → 23 nodes, layered by time, fit to width. Dashed = old position', svg(L2fit, { ghosts: Lfit, lanes: true })));
    write('stability-20+3-layered-fixed.html', page('20 → 23 nodes, layered by time, fixed 14 px/turn. Dashed = old position', `<div style="overflow-x:auto">${svg(L2fix, { ghosts: Lfix, lanes: true, width: Math.ceil(L2fix.width) })}</div>`));
  }
}

// ---------------------------------------------------------------- incremental pinned sessions 20→100
{
  const full = S100;
  let laid = forceLayout(prefix(full, 20), { nofit: true });
  const steps = [];
  for (let n = 23; n <= 100; n = Math.min(n + 3, 100)) {
    const g = prefix(full, n);
    const warm = new Map(laid.nodes.map(x => [x.id, { x: x.x, y: x.y }]));
    laid = forceLayout(g, { warm, pin: true, nofit: true });
    if (n === 23 || n === 50 || n === 100) { const fitted = clone(laid); const s = fit(fitted.nodes); steps.push({ n, fitScale: +s.toFixed(2), ...metrics(fitted) }); if (n !== 23) write(`incremental-pinned-${n}.html`, page(`${n} nodes reached by pinning every previous session's nodes and placing 3 new ones at a time (from 20)`, svg(fitted))); }
    if (n === 100) break;
  }
  results.incrementalPinned = { steps, freshAt50: metrics(layouts[50].F), freshAt100: metrics(layouts[100].F) };
}

// ---------------------------------------------------------------- the alternative: spine + arc gutter + neighbourhood
function arcList(g, { order, title, select }) {
  const nodes = g.nodes.slice();
  if (order === 'spine') { const K = { tacit: 0, open: 1, decision: 2 }; nodes.sort((a, b) => K[a.kind] - K[b.kind] || b.turn - a.turn); }
  else nodes.sort((a, b) => a.turn - b.turn || a.id.localeCompare(b.id));
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const ROWH = 46, GUT = 130, top = 8;
  const rowY = i => top + i * ROWH + ROWH / 2;
  const adj = new Map(nodes.map(n => [n.id, []]));
  for (const e of g.edges) { adj.get(e.source).push({ id: e.target, rel: e.rel, dir: '→' }); adj.get(e.target).push({ id: e.source, rel: e.rel, dir: '←' }); }
  // arc crossings: two arcs (i1,j1),(i2,j2) on the same side cross iff intervals interleave
  const iv = g.edges.map(e => [Math.min(idx.get(e.source), idx.get(e.target)), Math.max(idx.get(e.source), idx.get(e.target))]);
  let cross = 0; for (let a = 0; a < iv.length; a++) for (let b = a + 1; b < iv.length; b++) { const [p, q] = iv[a], [r2, s] = iv[b]; if ((p < r2 && r2 < q && q < s) || (r2 < p && p < s && s < q)) cross++; }
  const spans = iv.map(([p, q]) => q - p); const meanSpan = spans.length ? (spans.reduce((a, b) => a + b, 0) / spans.length).toFixed(1) : 0;
  const offscreen = spans.filter(sp => sp * ROWH > 900).length;
  const Hh = top + nodes.length * ROWH + 8;
  let arcs = '';
  for (const e of g.edges) { const i = idx.get(e.source), j = idx.get(e.target); const y1 = rowY(i), y2 = rowY(j); const d = Math.abs(y2 - y1); const bul = Math.min(GUT - 14, 24 + d / 6);
    const hot = select && (e.source === select || e.target === select);
    arcs += `<path d="M${GUT - 6},${y1} C${GUT - 6 - bul},${y1} ${GUT - 6 - bul},${y2} ${GUT - 6},${y2}" fill="none" stroke="${e.rel.startsWith('supersede') ? '#b0261f' : (hot ? '#1a63c9' : '#b5ac9a')}" stroke-width="${hot ? 2.2 : 1.2}" opacity="${select && !hot ? 0.35 : 1}"/>`; }
  let rows = '';
  nodes.forEach((n, i) => { const nb = adj.get(n.id); const sup = n.status === 'superseded'; const hot = select === n.id; const near = select && nb.some(x => x.id === select);
    rows += `<div class="row${hot ? ' sel' : ''}${near ? ' near' : ''}" style="top:${top + i * ROWH}px"><span class="mark" style="color:${COL[n.kind]}">${MARK[n.kind]}</span><span class="body"><span class="q${sup ? ' sup' : ''}">${esc(n.label)}</span><span class="w">turn ${n.turn}${nb.length ? ' · ' + nb.map(x => `<b class="chip" style="border-color:${COL[nodes[idx.get(x.id)].kind]}">${x.dir} ${x.id}</b> <i>${x.rel.replace(/_/g, ' ')}</i>`).join(', ') : ' · <i>ни с чем не связано</i>'}</span></span><span class="idc">${n.id}</span></div>`; });
  const css = `<style>.wrap{position:relative;width:${W}px;margin:0 12px}.gut{position:absolute;left:0;top:0}.row{position:absolute;left:${GUT}px;right:0;height:${ROWH - 4}px;display:flex;gap:10px;align-items:flex-start;padding:5px 10px;border-bottom:1px solid #dad3c4;background:#fdfbf6;box-sizing:border-box}.row.sel{background:#e9e3d3;outline:2px solid #1a63c9}.row.near{background:#eef3fb}.mark{font-weight:700;width:14px}.body{flex:1;min-width:0}.q{display:block;font:14px Charter,Georgia,serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.q.sup{text-decoration:line-through;opacity:.6}.w{display:block;font-size:11.5px;color:#5c554a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.chip{font:600 11px ui-monospace,Menlo,monospace;border:1px solid;border-radius:3px;padding:0 4px;color:#1e1a14}.idc{font:10.5px ui-monospace,Menlo,monospace;color:#8a8272}</style>`;
  const body = `${css}<div class="wrap" style="height:${Hh}px"><svg class="gut" width="${GUT}" height="${Hh}">${arcs}</svg>${rows}</div>`;
  return { html: page(title, body), metrics: { n: nodes.length, m: g.edges.length, order, arcCrossings: cross, meanArcSpanRows: +meanSpan, arcsLongerThanOneScreen: offscreen, labelCollisions: 0, heightPx: Hh, screensTall: +(Hh / H).toFixed(1) } };
}
results.arcList = {};
for (const [k, g] of Object.entries(sizes)) {
  for (const order of ['spine', 'time']) {
    const sel = k === '20' ? (order === 'spine' ? 'd6' : null) : null;
    const { html, metrics: m } = arcList(g, { order, title: `${k} nodes — list in ${order === 'spine' ? 'spine order (tacit, open, decision; newest first)' : 'time order'} with relationship gutter and per-row neighbour chips${sel ? ' · d6 selected' : ''}`, select: sel });
    write(`alt-list-${k}-${order}${sel ? '-sel' : ''}.html`, html);
    results.arcList[`${k}_${order}`] = m;
  }
}
// arc-list stability: +3 nodes
{
  const g2 = grow(real, later3(real));
  const a = arcList(real, { order: 'spine', title: '' }), b = arcList(g2, { order: 'spine', title: '' });
  // row index shift of old nodes
  const K = { tacit: 0, open: 1, decision: 2 };
  const ord = g => g.nodes.slice().sort((x, y) => K[x.kind] - K[y.kind] || y.turn - x.turn).map(n => n.id);
  const o1 = ord(real), o2 = ord(g2); const shifts = o1.map(id => o2.indexOf(id) - o1.indexOf(id));
  const ordT = g => g.nodes.slice().sort((x, y) => x.turn - y.turn || x.id.localeCompare(y.id)).map(n => n.id);
  const t1 = ordT(real), t2 = ordT(g2); const shiftsT = t1.map(id => t2.indexOf(id) - t1.indexOf(id));
  results.arcListStability = {
    spineOrder: { rowsShifted: shifts.filter(s => s !== 0).length, maxRowShift: Math.max(...shifts), relativeOrderKept: '100%', shiftsPerRow: shifts.join('') },
    timeOrder: { rowsShifted: shiftsT.filter(s => s !== 0).length, maxRowShift: Math.max(...shiftsT), relativeOrderKept: '100%' },
    note: 'a shift of k rows = k×46px straight down; every other node keeps its row',
  };
}

fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
