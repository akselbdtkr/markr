// Elvene per seksjon: a step that runs per section, only once the player has
// zoomed in far enough. The first time a section is drawn, its rivers are
// stored as bottom points; functions then run over them.
//
// 1. Store: on a grid of every second cell, each point finds the bottom of
//    its cross-section (RiverLine.bottom). Bottom points are kept by cell
//    index, with width, water surface and direction along the line.
// 2. Chain: each bottom point is linked to the nearest one ahead and behind
//    along its line. That gives chains that can be walked up and down, and a
//    chain that comes back to itself is a ring.
// 3. Connect: from each loose end, the nearest loose end of another chain
//    within reach, roughly ahead and facing back, is joined to it.
// 4. Downstream: the lowest end of a chain that does not reach water follows
//    the land downhill, a step at a time, until it reaches the sea or another
//    river (or a pit, which becomes a small lake).
// 5. Rings and short loose chains become lakes; a ring is filled with no
//    island in the middle.
// 6. Meanders: in plains, the channel swings from side to side along the
//    line (a sine of the position along it, so neighbouring sections agree).
// 7. Draw: the section's cells (16 m) inside a channel or lake are water.
//
// A section reads its own and its eight neighbours' bottom points, so rivers
// connect across section edges.
(function (M) {
  'use strict';

  const N = 32; // cells per section side

  class RiverSections {
    // river: a RiverLine. ground(x, y) -> { h, cls } without this step.
    // p: cell (sim units), gap, walk, short (sim units), meander (0..2).
    constructor(river, ground, p) {
      this.river = river;
      this.ground = ground;
      this.p = p;
      this.size = p.cell * N;
      this.samples = new Map();
      this.graphs = new Map();
      this.masks = new Map();
    }

    key(si, sj) {
      return si * 100003 + sj;
    }

    // 1. Bottom points found from inside section (si, sj).
    sample(si, sj) {
      const k = this.key(si, sj);
      let out = this.samples.get(k);
      if (out) return out;
      const { cell } = this.p, x0 = si * this.size, y0 = sj * this.size, seen = new Map();
      out = [];
      for (let j = 0; j < N; j += 2) {
        for (let i = 0; i < N; i += 2) {
          const b = this.river.bottom(x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell);
          if (!b || b.W < cell * 0.5) continue;
          // Only points close to the river, and bottoms that lie on the line:
          // from far away the step can land on another line or miss.
          if (b.d > b.W / 2 + 3 * cell) continue;
          const on = this.river.onLine(b.qx, b.qy, cell / 4);
          if (!on) continue;
          const ci = Math.floor(on[0] / cell), cj = Math.floor(on[1] / cell), ck = ci * 100003 + cj;
          if (seen.has(ck)) continue;
          const node = { ci, cj, ck, x: on[0], y: on[1], W: b.W, vSurf: b.vSurf, tx: on[2], ty: on[3], plain: b.plain };
          seen.set(ck, node);
          out.push(node);
        }
      }
      this.samples.set(k, out);
      return out;
    }

    // 2–6. The river network around section (si, sj).
    graph(si, sj) {
      const k = this.key(si, sj);
      let gr = this.graphs.get(k);
      if (gr) return gr;
      const { cell, gap, walk, short } = this.p;
      // Gather the 3 × 3 sections' bottom points, one per cell.
      const byCell = new Map(), nodes = [];
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          for (const n of this.sample(si + di, sj + dj)) {
            if (byCell.has(n.ck)) continue;
            const c = { ...n, f: -1, b: -1, comp: -1, idx: nodes.length };
            byCell.set(n.ck, c);
            nodes.push(c);
          }
        }
      }
      // Chain: nearest neighbour ahead and behind along the line.
      const R = 3;
      for (const n of nodes) {
        let bf = Infinity, bb = Infinity;
        for (let dj = -R; dj <= R; dj++) {
          for (let di = -R; di <= R; di++) {
            if (!di && !dj) continue;
            const o = byCell.get((n.ci + di) * 100003 + (n.cj + dj));
            if (!o) continue;
            const dist = Math.hypot(di, dj), along = (di * n.tx + dj * n.ty) / dist;
            if (along > 0.5 && dist < bf) {
              bf = dist;
              n.f = o.idx;
            } else if (along < -0.5 && dist < bb) {
              bb = dist;
              n.b = o.idx;
            }
          }
        }
      }
      const segs = [];
      const pair = new Set();
      const addSeg = (a, b, kind) => {
        const key = a.idx < b.idx ? a.idx + ',' + b.idx : b.idx + ',' + a.idx;
        if (a.idx >= 0 && b.idx >= 0 && pair.has(key)) return;
        pair.add(key);
        segs.push({ a, b, kind });
      };
      for (const n of nodes) {
        if (n.f >= 0) addSeg(n, nodes[n.f], 'line');
        if (n.b >= 0) addSeg(n, nodes[n.b], 'line');
      }
      // Components (union-find over the links).
      const parent = nodes.map((_, i) => i);
      const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      const join = (a, b) => (parent[find(a)] = find(b));
      for (const s of segs) join(s.a.idx, s.b.idx);
      // Loose ends: no link ahead, or none behind. Outward direction.
      const ends = [];
      for (const n of nodes) {
        if (n.f < 0) ends.push({ n, ox: n.tx, oy: n.ty, used: false });
        if (n.b < 0) ends.push({ n, ox: -n.tx, oy: -n.ty, used: false });
      }
      // 3. Connect loose ends of different chains within reach.
      for (const e of ends) {
        if (e.used) continue;
        let best = null, bd = gap;
        for (const c of ends) {
          if (c.used || c === e || find(c.n.idx) === find(e.n.idx)) continue;
          const vx = c.n.x - e.n.x, vy = c.n.y - e.n.y, dist = Math.hypot(vx, vy);
          if (dist >= bd || dist === 0) continue;
          if ((vx * e.ox + vy * e.oy) / dist < 0.6) continue; // ahead of e
          if (-(vx * c.ox + vy * c.oy) / dist < 0.3) continue; // c faces back
          best = c;
          bd = dist;
        }
        if (best) {
          e.used = best.used = true;
          addSeg(e.n, best.n, 'bridge');
          join(e.n.idx, best.n.idx);
        }
      }
      // Group nodes and ends by component.
      const comps = new Map();
      for (const n of nodes) {
        const r = find(n.idx);
        if (!comps.has(r)) comps.set(r, { nodes: [], ends: [] });
        comps.get(r).nodes.push(n);
        n.comp = r;
      }
      for (const e of ends) if (!e.used) comps.get(find(e.n.idx)).ends.push(e);
      const lakes = [], rings = [];
      for (const [, c] of comps) {
        if (c.nodes.length < 2) continue;
        // 5. Ring: no loose ends, and walking ahead comes back to the start.
        if (!c.ends.length && c.nodes.length >= 8) {
          const loop = [];
          let cur = c.nodes[0];
          for (let s = 0; s < c.nodes.length + 2 && cur; s++) {
            loop.push(cur);
            cur = cur.f >= 0 ? nodes[cur.f] : null;
            if (cur === c.nodes[0]) break;
          }
          if (cur === c.nodes[0] && loop.length >= 8) {
            rings.push({ poly: loop, vSurf: Math.min(...loop.map((n) => n.vSurf)) });
            continue;
          }
        }
        // 4. Downstream: the lowest loose end.
        if (!c.ends.length) continue;
        const mouth = c.ends.reduce((a, b) => (b.n.vSurf < a.n.vSurf ? b : a));
        let reached = this.walk(mouth, byCell, segs, cell, walk);
        // Short loose chain that reaches nothing: a lake.
        const length = c.nodes.length * cell;
        if (!reached && length < short && c.ends.length >= 2) lakes.push(...c.nodes);
      }
      gr = { nodes, segs, rings, lakes };
      this.graphs.set(k, gr);
      return gr;
    }

    // Follow the land downhill from a loose end until water. Adds 'walk'
    // segments to segs. Returns true if it reached water.
    walk(end, byCell, segs, cell, maxLen) {
      const step = 2 * cell;
      let x = end.n.x, y = end.n.y, dx = end.ox, dy = end.oy;
      let g = this.ground(x + dx * (end.n.W / 2 + cell), y + dy * (end.n.W / 2 + cell));
      if (g.cls === 0 || g.cls === 4) return true;
      let h = this.ground(x, y).h, prev = end.n;
      for (let s = 0; s * step < maxLen; s++) {
        let best = null;
        for (let a = -2; a <= 2; a++) {
          const ang = (a * Math.PI) / 6, c = Math.cos(ang), sn = Math.sin(ang);
          const ex = dx * c - dy * sn, ey = dx * sn + dy * c;
          const px = x + ex * step, py = y + ey * step, gp = this.ground(px, py);
          if (!best || gp.h < best.g.h) best = { px, py, ex, ey, g: gp };
        }
        if (best.g.h > h + 1) return false; // a pit: stop here
        const node = { x: best.px, y: best.py, W: end.n.W, vSurf: end.n.vSurf, tx: best.ex, ty: best.ey, plain: end.n.plain, idx: -1 };
        segs.push({ a: prev, b: node, kind: 'walk' });
        if (best.g.cls === 0 || best.g.cls === 4) return true;
        const near = byCell.get(Math.floor(best.px / cell) * 100003 + Math.floor(best.py / cell));
        if (near && near.comp !== end.n.comp) {
          segs.push({ a: node, b: near, kind: 'walk' });
          return true;
        }
        prev = node;
        x = best.px;
        y = best.py;
        dx = best.ex;
        dy = best.ey;
        h = Math.min(h, best.g.h);
      }
      return false;
    }

    // 6. A node's position with the meander applied (plains only).
    swing(n) {
      const m = this.p.meander * n.plain;
      if (m <= 0.01) return [n.x, n.y];
      const lambda = Math.max(8 * n.W, 12 * this.p.cell), A = 0.8 * m * n.W;
      const s = Math.sin((2 * Math.PI * (n.x * n.tx + n.y * n.ty)) / lambda);
      return [n.x - n.ty * A * s, n.y + n.tx * A * s];
    }

    // 7. The section's water cells.
    build(si, sj) {
      const k = this.key(si, sj);
      let mask = this.masks.get(k);
      if (mask) return mask;
      const gr = this.graph(si, sj), { cell } = this.p;
      const water = new Uint8Array(N * N), surf = new Float32Array(N * N);
      const x0 = si * this.size, y0 = sj * this.size;
      const lakeSet = new Set(gr.lakes);
      const segs = gr.segs.map((s) => {
        const [ax, ay] = this.swing(s.a), [bx, by] = this.swing(s.b);
        const grow = (n) => (lakeSet.has(n) ? 2.5 : 1);
        const wa = s.a.W * grow(s.a), wb = s.b.W * grow(s.b);
        const r = Math.max(wa, wb) / 2;
        return { ax, ay, bx, by, wa, wb, vs: Math.min(s.a.vSurf, s.b.vSurf), x0: Math.min(ax, bx) - r, x1: Math.max(ax, bx) + r, y0: Math.min(ay, by) - r, y1: Math.max(ay, by) + r };
      }).filter((s) => s.x1 >= x0 && s.x0 <= x0 + this.size && s.y1 >= y0 && s.y0 <= y0 + this.size);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const cx = x0 + (i + 0.5) * cell, cy = y0 + (j + 0.5) * cell, o = j * N + i;
          let vs = Infinity;
          for (const s of segs) {
            if (cx < s.x0 || cx > s.x1 || cy < s.y0 || cy > s.y1) continue;
            const ex = s.bx - s.ax, ey = s.by - s.ay, l2 = ex * ex + ey * ey;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((cx - s.ax) * ex + (cy - s.ay) * ey) / l2)) : 0;
            const d = Math.hypot(cx - s.ax - ex * t, cy - s.ay - ey * t), w = s.wa + (s.wb - s.wa) * t;
            if (d < w / 2) vs = Math.min(vs, s.vs);
          }
          for (const r of gr.rings) if (inside(cx, cy, r.poly)) vs = Math.min(vs, r.vSurf);
          if (vs < Infinity) {
            water[o] = 1;
            surf[o] = vs;
          }
        }
      }
      mask = { water, surf };
      this.masks.set(k, mask);
      return mask;
    }

    // Water at a point, from its section's cells, or undefined when the
    // section has not been built.
    waterAt(x, y) {
      const si = Math.floor(x / this.size), sj = Math.floor(y / this.size);
      const mask = this.masks.get(this.key(si, sj));
      if (!mask) return undefined;
      const i = Math.min(N - 1, Math.floor((x - si * this.size) / this.p.cell)), j = Math.min(N - 1, Math.floor((y - sj * this.size) / this.p.cell));
      const o = j * N + i;
      return { water: mask.water[o] === 1, vSurf: mask.surf[o] };
    }
  }

  // Point in polygon (nodes with x, y), even-odd rule.
  function inside(x, y, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  }

  RiverSections.N = N;
  M.RiverSections = RiverSections;
})(window.Markr = window.Markr || {});
