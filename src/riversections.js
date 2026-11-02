// Elvene per seksjon: a step that runs per section, only once the player has
// zoomed in far enough. The first time a section is drawn, its rivers are
// stored as bottom points; functions then run over them.
//
// 1. Store: on a grid of every second cell, each point finds the bottom of
//    its cross-section (RiverLine.bottom). Bottom points are kept by index on
//    a grid of two cells, at most one per 1.5 cells, with width, water
//    surface and direction along the line.
// 2. Chain: each bottom point is linked to the nearest one ahead and behind
//    along its line. That gives chains that can be walked up and down, and a
//    chain that comes back to itself is a ring.
// 3. Connect: from each loose end, the nearest loose end of another chain
//    within reach, roughly ahead and facing back, is joined to it; failing
//    that, the end joins the middle of another river ahead and feeds into
//    it. Links keep the river's width and swing like meanders.
// 4. Downstream: the lowest end of a chain that does not reach water follows
//    the land downhill, a step at a time, until it reaches the sea or another
//    river (or a pit, which becomes a small lake).
// 5. Rings are removed. Short loose chains become lakes. A chain whose ends
//    both open onto the sea is a sound, at sea level all the way. Rivers
//    under the sea (in fjords) are not stored.
// 6. Meanders: only the links swing (whole half waves between their ends).
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
      const { cell } = this.p, x0 = si * this.size, y0 = sj * this.size, seen = new Map(), g2 = 2 * cell;
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
          // One bottom point per two cells, and none closer than 1.5 cells to
          // another: points found from both banks would otherwise make two
          // parallel chains (a doubled line).
          const ci = Math.floor(on[0] / g2), cj = Math.floor(on[1] / g2), ck = ci * 100003 + cj;
          if (seen.has(ck) || near(seen, ci, cj, on[0], on[1], 1.5 * cell)) continue;
          // A river under the sea (a fjord) is not stored: the sea is there.
          if (this.ground(on[0], on[1]).cls === 0) continue;
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
            if (byCell.has(n.ck) || near(byCell, n.ci, n.cj, n.x, n.y, 1.5 * cell)) continue;
            const c = { ...n, f: -1, b: -1, comp: -1, idx: nodes.length };
            byCell.set(n.ck, c);
            nodes.push(c);
          }
        }
      }
      // Chain: nearest neighbour ahead and behind along the line.
      const R = 2; // in two-cell steps
      for (const n of nodes) {
        let bf = Infinity, bb = Infinity;
        for (let dj = -R; dj <= R; dj++) {
          for (let di = -R; di <= R; di++) {
            if (!di && !dj) continue;
            const o = byCell.get((n.ci + di) * 100003 + (n.cj + dj));
            if (!o) continue;
            const vx = o.x - n.x, vy = o.y - n.y, dist = Math.hypot(vx, vy);
            if (!dist) continue;
            const along = (vx * n.tx + vy * n.ty) / dist;
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
      // An end's width: the river thins where it fades out, so an end takes
      // the widest of the last few points inward. Links and walks keep the
      // river's size.
      const endW = (n, inward) => {
        let w = n.W, cur = n;
        for (let s = 0; s < 8; s++) {
          const nx = inward === 'b' ? cur.b : cur.f;
          if (nx < 0) break;
          cur = nodes[nx];
          w = Math.max(w, cur.W);
        }
        return w;
      };
      const ends = [];
      for (const n of nodes) {
        if (n.f < 0) ends.push({ n, ox: n.tx, oy: n.ty, used: false, W: endW(n, 'b') });
        if (n.b < 0) ends.push({ n, ox: -n.tx, oy: -n.ty, used: false, W: endW(n, 'f') });
      }
      // 3. Connect: a loose end to the nearest loose end of another chain
      // ahead and facing back; failing that, to the middle of another river
      // ahead, which it then feeds into. The link swings like a meander.
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
          this.link(e.n, best.n, Math.max(e.W, best.W), segs, 'bridge');
          join(e.n.idx, best.n.idx);
          continue;
        }
        let mid = null;
        bd = gap;
        for (const c of nodes) {
          if (find(c.idx) === find(e.n.idx)) continue;
          const vx = c.x - e.n.x, vy = c.y - e.n.y, dist = Math.hypot(vx, vy);
          if (dist >= bd || dist === 0 || (vx * e.ox + vy * e.oy) / dist < 0.6) continue;
          mid = c;
          bd = dist;
        }
        if (mid) {
          e.used = true;
          this.link(e.n, mid, e.W, segs, 'tributary');
          join(e.n.idx, mid.idx);
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
      // Which loose ends open onto the sea.
      const seaEnd = (e) => this.ground(e.n.x + e.ox * (e.W / 2 + 2 * cell), e.n.y + e.oy * (e.W / 2 + 2 * cell)).cls === 0;
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
            // A ring is removed: its points draw no water.
            rings.push({ poly: loop });
            for (const n of c.nodes) n.ring = true;
            continue;
          }
        }
        // A depression that starts and ends in the sea: a sound, at sea level
        // all the way.
        if (c.ends.filter(seaEnd).length >= 2) {
          for (const n of c.nodes) {
            n.vSurf = this.p.tSea - 0.01;
            n.sea = true;
            n.W = Math.max(n.W, 3 * cell);
          }
          continue;
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
      let g = this.ground(x + dx * (end.W / 2 + cell), y + dy * (end.W / 2 + cell));
      if (g.cls === 0 || g.cls === 4) return true;
      let h = this.ground(x, y).h, prev = { ...end.n, W: end.W, idx: -1 };
      for (let s = 0; s * step < maxLen; s++) {
        let best = null;
        for (let a = -2; a <= 2; a++) {
          const ang = (a * Math.PI) / 6, c = Math.cos(ang), sn = Math.sin(ang);
          const ex = dx * c - dy * sn, ey = dx * sn + dy * c;
          const px = x + ex * step, py = y + ey * step, gp = this.ground(px, py);
          if (!best || gp.h < best.g.h) best = { px, py, ex, ey, g: gp };
        }
        if (best.g.h > h + 1) return false; // a pit: stop here
        const node = { x: best.px, y: best.py, W: end.W, vSurf: end.n.vSurf, tx: best.ex, ty: best.ey, plain: end.n.plain, idx: -1 };
        segs.push({ a: prev, b: node, kind: 'walk' });
        if (best.g.cls === 0 || best.g.cls === 4) return true;
        const near = byCell.get(Math.floor(best.px / (2 * cell)) * 100003 + Math.floor(best.py / (2 * cell)));
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

    // 6. A link from a to b, of width W, as a meandering line: whole half
    // waves (so it meets both ends straight on), amplitude from the width and
    // the plains' share, and its side from the positions (so neighbouring
    // sections agree).
    link(a, b, W, segs, kind) {
      const { cell, meander } = this.p;
      const vx = b.x - a.x, vy = b.y - a.y, L = Math.hypot(vx, vy);
      const vs = Math.min(a.vSurf, b.vSurf), sea = a.sea && b.sea;
      const m = Math.max(1, Math.round(L / Math.max(6 * W, 10 * cell)));
      const amp = meander * Math.min(0.25 * (L / m), W + 2 * cell) * (0.4 + 0.6 * Math.max(a.plain || 0, b.plain || 0));
      const side = Math.sin(a.x * 0.0007 + b.y * 0.0011) < 0 ? -1 : 1;
      const k = Math.max(1, Math.ceil(L / cell));
      let prev = { ...a, W, vSurf: vs, idx: -1 };
      for (let t = 1; t <= k; t++) {
        const f = t / k, off = amp * side * Math.sin(Math.PI * m * f);
        const node = { x: a.x + vx * f - (vy / L) * off, y: a.y + vy * f + (vx / L) * off, W, vSurf: vs, sea, idx: -1 };
        segs.push({ a: prev, b: node, kind });
        prev = node;
      }
    }

    // 7. The section's water cells.
    build(si, sj) {
      const k = this.key(si, sj);
      let mask = this.masks.get(k);
      if (mask) return mask;
      const gr = this.graph(si, sj), { cell } = this.p;
      const water = new Uint8Array(N * N), surf = new Float32Array(N * N), sea = new Uint8Array(N * N);
      const x0 = si * this.size, y0 = sj * this.size;
      const lakeSet = new Set(gr.lakes);
      const segs = gr.segs.filter((s) => !s.a.ring && !s.b.ring).map((s) => {
        const ax = s.a.x, ay = s.a.y, bx = s.b.x, by = s.b.y;
        const grow = (n) => (lakeSet.has(n) ? 2.5 : 1);
        const wa = s.a.W * grow(s.a), wb = s.b.W * grow(s.b);
        const r = Math.max(wa, wb) / 2;
        return { ax, ay, bx, by, wa, wb, vs: Math.min(s.a.vSurf, s.b.vSurf), sea: !!(s.a.sea && s.b.sea), x0: Math.min(ax, bx) - r, x1: Math.max(ax, bx) + r, y0: Math.min(ay, by) - r, y1: Math.max(ay, by) + r };
      }).filter((s) => s.x1 >= x0 && s.x0 <= x0 + this.size && s.y1 >= y0 && s.y0 <= y0 + this.size);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const cx = x0 + (i + 0.5) * cell, cy = y0 + (j + 0.5) * cell, o = j * N + i;
          let vs = Infinity, isSea = false;
          for (const s of segs) {
            if (cx < s.x0 || cx > s.x1 || cy < s.y0 || cy > s.y1) continue;
            const ex = s.bx - s.ax, ey = s.by - s.ay, l2 = ex * ex + ey * ey;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((cx - s.ax) * ex + (cy - s.ay) * ey) / l2)) : 0;
            const d = Math.hypot(cx - s.ax - ex * t, cy - s.ay - ey * t), w = s.wa + (s.wb - s.wa) * t;
            if (d < w / 2) {
              vs = Math.min(vs, s.vs);
              isSea = isSea || s.sea;
            }
          }
          if (vs < Infinity) {
            water[o] = 1;
            surf[o] = vs;
            sea[o] = isSea ? 1 : 0;
          }
        }
      }
      mask = { water, surf, sea };
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
      return { water: mask.water[o] === 1, vSurf: mask.surf[o], sea: mask.sea[o] === 1 };
    }
  }

  // Is there a stored point within r of (x, y), among the grid cells around
  // (ci, cj)?
  function near(map, ci, cj, x, y, r) {
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const o = map.get((ci + di) * 100003 + (cj + dj));
        if (o && Math.hypot(o.x - x, o.y - y) < r) return true;
      }
    }
    return false;
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
