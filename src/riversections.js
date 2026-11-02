// Elvene per seksjon: river trees. Runs once the player has zoomed in far
// enough; the first time a section is drawn, its rivers are stored, and
// functions run over them.
//
// 1. Store: on a grid of every second cell, each point finds the bottom of
//    its cross-section (RiverLine.bottom), stepped exactly onto the line.
//    Bottom points are kept on a grid of two cells; of two points closer than
//    1.5 cells, the one with the lower index stays, whichever section found
//    it, so the result does not depend on the order sections are loaded.
//    Rivers under the sea (in fjords) are not stored.
// 2. Chains: each bottom point links to the nearest one ahead and behind
//    along its line. A chain is walked from end to end; one that comes back
//    to itself is a ring, and rings are removed.
// 3. Trees: each chain has its own step on from its lower end: to the
//    nearest facing end of another chain (a link), or into the middle of
//    another river ahead (a tributary), or, failing both, downhill over the
//    land (a walk). Following the steps from chain to chain shows whether a
//    chain reaches the sea; all chains that do form the trees. Everything is
//    a function of the chain alone, so the trees appear as the player
//    explores and are the same whatever the order. A chain that does not reach the sea is no waterway: it is still
//    drawn as a river, and a short one as a small lake. The source of a long chain is followed uphill to the
//    divide, so trees start there. Trees are the waterways of the game, and
//    only chains near what is drawn are ever followed.
// 4. Width: a chain keeps its width by its length: long chains stay wide
//    where they join, short ones narrow, so a long river runs through while
//    small lakes beside it stay apart. Links take the narrower of their two
//    ends and swing a little, in whole half waves.
// 5. A chain whose ends both open onto the sea is a sound, at sea level.
// 6. Draw: the section's cells (16 m) in a channel or lake are water.
(function (M) {
  'use strict';

  const N = 32; // cells per section side
  const S = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const MAX_CHAINS = 80; // chains followed downstream before giving up

  class RiverSections {
    // river: a RiverLine. ground(x, y) -> { h, cls } without this step.
    // p: cell (sim units), gap, walk, short (sim units), meander, tSea,
    // minW (sim units), rise (how much a walk may climb over a sill).
    constructor(river, ground, p) {
      this.river = river;
      this.ground = ground;
      this.p = p;
      this.size = p.cell * N;
      this.g2 = 2 * p.cell;
      this.sampled = new Set();
      this.grid = new Map(); // two-cell grid key -> candidates
      this.masks = new Map();
      this.graphs = new Map(); // section -> { segs, rings } for the overlay
      this.reasons = {}; // why chains found no way to the sea (for inspection)
    }

    key(si, sj) {
      return si * 100003 + sj;
    }

    // 1. Candidate bottom points found from inside section (si, sj).
    sampleSection(si, sj) {
      const sk = this.key(si, sj);
      if (this.sampled.has(sk)) return;
      this.sampled.add(sk);
      const { cell } = this.p, x0 = si * this.size, y0 = sj * this.size, g2 = this.g2, own = new Map();
      for (let j = 0; j < N; j += 2) {
        for (let i = 0; i < N; i += 2) {
          const b = this.river.bottom(x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell);
          if (!b || b.W < cell * 0.5 || b.d > b.W / 2 + 3 * cell) continue;
          const on = this.river.onLine(b.qx, b.qy, cell / 4);
          if (!on) continue;
          const ci = Math.floor(on[0] / g2), cj = Math.floor(on[1] / g2), ck = ci * 100003 + cj;
          if (own.has(ck)) continue;
          if (this.ground(on[0], on[1]).cls === 0) continue; // under the sea
          const c = { ci, cj, ck, sec: sk, x: on[0], y: on[1], W: b.W, vSurf: b.vSurf, tx: on[2], ty: on[3], plain: b.plain, f: undefined, b: undefined, chain: null, alive: undefined };
          own.set(ck, c);
          let list = this.grid.get(ck);
          if (!list) this.grid.set(ck, (list = []));
          list.push(c);
        }
      }
    }
    secOf(x) {
      return Math.floor(x / this.size);
    }
    // Sample every section touching the square of half-size r around (x, y),
    // plus one more ring (so every candidate there can be judged).
    ensure(x, y, r) {
      const i0 = this.secOf(x - r) - 1, i1 = this.secOf(x + r) + 1, j0 = this.secOf(y - r) - 1, j1 = this.secOf(y + r) + 1;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.sampleSection(i, j);
    }
    // A candidate is a node unless a candidate with a lower index lies within
    // 1.5 cells (order independent).
    isAlive(c) {
      if (c.alive !== undefined) return c.alive;
      const r = 1.5 * this.p.cell;
      c.alive = true;
      for (let dj = -1; dj <= 1 && c.alive; dj++) {
        for (let di = -1; di <= 1 && c.alive; di++) {
          const list = this.grid.get((c.ci + di) * 100003 + (c.cj + dj));
          if (!list) continue;
          for (const o of list) {
            if (o === c || Math.hypot(o.x - c.x, o.y - c.y) >= r) continue;
            if (o.ck < c.ck || (o.ck === c.ck && o.sec < c.sec)) {
              c.alive = false;
              break;
            }
          }
        }
      }
      return c.alive;
    }
    // Nodes within r of (x, y).
    nodesNear(x, y, r) {
      this.ensure(x, y, r);
      const g2 = this.g2, out = [];
      for (let cj = Math.floor((y - r) / g2); cj <= Math.floor((y + r) / g2); cj++) {
        for (let ci = Math.floor((x - r) / g2); ci <= Math.floor((x + r) / g2); ci++) {
          const list = this.grid.get(ci * 100003 + cj);
          if (!list) continue;
          for (const c of list) if (Math.hypot(c.x - x, c.y - y) <= r && this.isAlive(c)) out.push(c);
        }
      }
      return out;
    }

    // 2. Links: nearest node ahead and behind along the line.
    links(n) {
      if (n.f !== undefined) return;
      n.f = n.b = null;
      let bf = Infinity, bb = Infinity;
      for (const o of this.nodesNear(n.x, n.y, 2.25 * this.g2)) {
        if (o === n) continue;
        const vx = o.x - n.x, vy = o.y - n.y, dist = Math.hypot(vx, vy);
        if (!dist) continue;
        const along = (vx * n.tx + vy * n.ty) / dist;
        if (along > 0.5 && dist < bf) {
          bf = dist;
          n.f = o;
        } else if (along < -0.5 && dist < bb) {
          bb = dist;
          n.b = o;
        }
      }
    }
    // The chain through n. Two points are in one chain only where their links
    // agree both ways (a.f is b and b.b is a), so the chains do not depend
    // on which point was looked at first: walk back to the head, then ahead.
    chain(n) {
      if (n.chain) return n.chain;
      const back = (m) => {
        this.links(m);
        const o = m.b;
        if (!o) return null;
        this.links(o);
        return o.f === m ? o : null;
      };
      const ahead = (m) => {
        this.links(m);
        const o = m.f;
        if (!o) return null;
        this.links(o);
        return o.b === m ? o : null;
      };
      let head = n, steps = 0, ring = false;
      for (let o = back(head); o && steps++ < 8000; o = back(head)) {
        if (o === n) {
          ring = true;
          break;
        }
        head = o;
      }
      if (ring) {
        // A ring: start from the lowest index, so every point gives the same.
        let low = n, cur = ahead(n);
        while (cur && cur !== n && steps++ < 16000) {
          if (cur.ck < low.ck) low = cur;
          cur = ahead(cur);
        }
        head = low;
      }
      const nodes = [head];
      for (let o = ahead(head); o && o !== head && steps++ < 16000; o = ahead(o)) nodes.push(o);
      let len = 0;
      for (let k = 1; k < nodes.length; k++) len += Math.hypot(nodes[k].x - nodes[k - 1].x, nodes[k].y - nodes[k - 1].y);
      const ch = { nodes, ring, len, tree: undefined, lake: false, sea: false, source: null, segs: null };
      for (const m of nodes) m.chain = ch;
      // Width by length: long chains keep their width, short ones narrow.
      const { short } = this.p;
      ch.wf = 0.3 + 0.7 * S(short, 4 * short, len);
      const endW = (list) => list.slice(0, 8).reduce((w, m) => Math.max(w, m.W), 0) * ch.wf;
      const h = nodes[0], t = nodes[nodes.length - 1];
      ch.ends = [
        { n: h, ox: -h.tx, oy: -h.ty, W: endW(nodes), chain: ch },
        { n: t, ox: t.tx, oy: t.ty, W: endW(nodes.slice().reverse()), chain: ch },
      ];
      return ch;
    }

    why(r) {
      if (this.reasons) this.reasons[r] = (this.reasons[r] || 0) + 1;
    }

    seaEnd(e) {
      const c = this.p.cell;
      return this.ground(e.n.x + e.ox * (e.W / 2 + 2 * c), e.n.y + e.oy * (e.W / 2 + 2 * c)).cls === 0;
    }

    // 3. From a loose end: the nearest facing end of another chain ahead, or
    // else the middle of another river ahead. { node, end?, kind } or null.
    connect(e) {
      if (e.link !== undefined) return e.link;
      e.link = null;
      let best = null, bd = this.p.gap, mid = null, md = this.p.gap;
      for (const o of this.nodesNear(e.n.x, e.n.y, this.p.gap)) {
        const ch = this.chain(o);
        if (ch === e.chain || ch.ring) continue;
        const vx = o.x - e.n.x, vy = o.y - e.n.y, dist = Math.hypot(vx, vy);
        if (!dist || (vx * e.ox + vy * e.oy) / dist < 0.6) continue; // ahead of e
        const oe = ch.ends.find((x) => x.n === o);
        if (oe && -(vx * oe.ox + vy * oe.oy) / dist >= 0.3 && dist < bd) {
          best = oe;
          bd = dist;
        } else if (dist < md) {
          mid = o;
          md = dist;
        }
      }
      if (best) e.link = { node: best.n, end: best, kind: 'bridge' };
      else if (mid) e.link = { node: mid, end: null, kind: 'tributary' };
      return e.link;
    }

    // A chain's own step on from its mouth (always its lower end, so it
    // does not depend on how the chain was reached): to the sea, a link or
    // tributary into another chain, or a walk downhill. ch.next is 'sea', a
    // chain, or null; ch.out holds the step's segments.
    step(ch) {
      if (ch.next !== undefined) return ch.next;
      ch.out = [];
      ch.next = null;
      if (ch.ring || ch.nodes.length < 2) return null;
      const [a, b] = ch.ends;
      if (this.seaEnd(a) && this.seaEnd(b)) {
        ch.sea = true; // a sound
        return (ch.next = 'sea');
      }
      const mouth = a.n.vSurf < b.n.vSurf || (a.n.vSurf === b.n.vSurf && a.n.ck <= b.n.ck) ? a : b;
      if (this.seaEnd(mouth)) return (ch.next = 'sea');
      const link = this.connect(mouth);
      if (link) {
        const nx = this.chain(link.node);
        if (nx !== ch) {
          // From the width at this end to the width at the other (a
          // tributary keeps its own), so it neither pinches nor swells.
          this.linkSegs(mouth.n, link.node, mouth.W, ch.out, link.kind, link.end ? link.end.W : mouth.W);
          return (ch.next = nx);
        }
      }
      const wk = this.walk(mouth, ch.out);
      if (wk === 'sea') return (ch.next = 'sea');
      if (wk) return (ch.next = this.chain(wk));
      this.why('walk stopped');
      ch.out = []; // a walk that ends in a pit draws nothing
      return null;
    }

    // Does the chain reach the sea, following the chains' own steps?
    tree(ch) {
      if (ch.tree !== undefined) return ch.tree;
      const seen = new Set();
      let cur = ch, ok = false;
      for (let k = 0; k < MAX_CHAINS && cur && cur !== 'sea'; k++) {
        if (seen.has(cur)) break;
        seen.add(cur);
        if (cur.tree !== undefined) {
          ok = cur.tree;
          cur = null;
          break;
        }
        cur = this.step(cur);
      }
      if (cur === 'sea') ok = true;
      ch.tree = ok;
      if (!ok) {
        // No way to the sea. A piece of a ring (a tight, closed line, often
        // broken into pieces) is removed; a short loose chain is a small
        // lake; the rest is drawn but no waterway.
        if (ch.ring || this.ringPiece(ch)) ch.ringPiece = true;
        else if (ch.len < this.p.short) ch.lake = true;
      } else if (ch.len >= this.p.short) this.toDivide(ch);
      return ok;
    }

    // Is this chain a piece of a ring? The circle through its two ends and
    // middle gives a radius; a tight one (under the gap length) that the
    // chain bends round by at least a radian, and whose line is also found
    // on the far side of the centre, is a ring.
    ringPiece(ch) {
      const ns = ch.nodes;
      if (ns.length < 3) return false;
      const a = ns[0], b = ns[ns.length >> 1], c = ns[ns.length - 1];
      const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
      if (Math.abs(d) < 1e-9) return false;
      const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
      const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
      const r = Math.hypot(a.x - ux, a.y - uy);
      if (r > this.p.gap) return false;
      // It must bend round the centre, not just curve gently: at least one
      // radian of the circle.
      const ang = Math.abs(Math.atan2((a.x - ux) * (c.y - uy) - (a.y - uy) * (c.x - ux), (a.x - ux) * (c.x - ux) + (a.y - uy) * (c.y - uy)));
      if (ang < 1 && ch.len < r) return false;
      // The far side of the centre from the chain's middle.
      const fx = 2 * ux - b.x, fy = 2 * uy - b.y;
      return this.nodesNear(fx, fy, 0.35 * r + 2 * this.p.cell).length > 0;
    }

    // Links from a to b, of width W: whole half waves, swinging at most half
    // the width, its side from the positions (so neighbours agree).
    linkSegs(a, b, W, segs, kind, W2 = W) {
      const { cell, meander } = this.p;
      const vx = b.x - a.x, vy = b.y - a.y, L = Math.hypot(vx, vy);
      if (!L) return;
      const vs = Math.min(a.vSurf, b.vSurf);
      const Wm = Math.min(W, W2);
      const m = Math.max(1, Math.round(L / Math.max(6 * Wm, 10 * cell)));
      const amp = meander * Math.min(0.2 * (L / m), 0.5 * Wm) * (0.4 + 0.6 * Math.max(a.plain || 0, b.plain || 0));
      const side = Math.sin(a.x * 0.0007 + b.y * 0.0011) < 0 ? -1 : 1;
      const k = Math.max(1, Math.ceil(L / cell));
      let prev = { x: a.x, y: a.y, W, vSurf: vs };
      for (let t = 1; t <= k; t++) {
        const f = t / k, off = amp * side * Math.sin(Math.PI * m * f);
        const node = { x: a.x + vx * f - (vy / L) * off, y: a.y + vy * f + (vx / L) * off, W: W + (W2 - W) * f, vSurf: vs };
        segs.push({ a: prev, b: node, kind });
        prev = node;
      }
    }

    // Follow the land downhill from a loose end. Returns 'sea', a node of
    // another river, or null.
    walk(end, segs) {
      const { cell, walk } = this.p, step = 2 * cell;
      let x = end.n.x, y = end.n.y, dx = end.ox, dy = end.oy, h = this.ground(x, y).h;
      let prev = { x, y, W: end.W, vSurf: end.n.vSurf };
      for (let s = 0; s * step < walk; s++) {
        let best = null;
        for (let a = -2; a <= 2; a++) {
          const ang = (a * Math.PI) / 6, c = Math.cos(ang), sn = Math.sin(ang);
          const ex = dx * c - dy * sn, ey = dx * sn + dy * c, px = x + ex * step, py = y + ey * step;
          const gp = this.ground(px, py);
          if (!best || gp.h < best.g.h) best = { px, py, ex, ey, g: gp };
        }
        if (best.g.h > h + this.p.rise) return null; // a pit deeper than rise
        const node = { x: best.px, y: best.py, W: end.W, vSurf: end.n.vSurf };
        segs.push({ a: prev, b: node, kind: 'walk' });
        if (best.g.cls === 0) return 'sea';
        for (const o of this.nodesNear(best.px, best.py, 1.5 * cell)) if (this.chain(o) !== end.chain) return o;
        prev = node;
        x = best.px;
        y = best.py;
        dx = best.ex;
        dy = best.ey;
        h = Math.min(h, best.g.h);
      }
      return null;
    }

    // The source: from the chain's upper end, uphill until the divide (class
    // 3), narrow. Kept only if it gets there.
    toDivide(ch) {
      if (ch.source) return;
      const { cell, walk, minW } = this.p, step = 2 * cell;
      const up = ch.ends[0].n.vSurf >= ch.ends[1].n.vSurf ? ch.ends[0] : ch.ends[1];
      if (this.ground(up.n.x, up.n.y).cls === 3) return;
      let x = up.n.x, y = up.n.y, dx = up.ox, dy = up.oy, h = this.ground(x, y).h;
      const segs = [];
      let prev = { x, y, W: minW, vSurf: up.n.vSurf };
      for (let s = 0; s * step < 3 * walk; s++) {
        let best = null;
        for (let a = -2; a <= 2; a++) {
          const ang = (a * Math.PI) / 6, c = Math.cos(ang), sn = Math.sin(ang);
          const ex = dx * c - dy * sn, ey = dx * sn + dy * c, px = x + ex * step, py = y + ey * step;
          const gp = this.ground(px, py);
          if (!best || gp.h > best.g.h) best = { px, py, ex, ey, g: gp };
        }
        if (best.g.h < h - 1) return; // a top below the divide: no source
        const node = { x: best.px, y: best.py, W: minW, vSurf: up.n.vSurf };
        segs.push({ a: prev, b: node, kind: 'source' });
        if (best.g.cls === 3) {
          ch.source = segs;
          return;
        }
        prev = node;
        x = best.px;
        y = best.py;
        dx = best.ex;
        dy = best.ey;
        h = Math.max(h, best.g.h);
      }
    }

    // 6. The section's water cells.
    build(si, sj) {
      const k = this.key(si, sj);
      let mask = this.masks.get(k);
      if (mask) return mask;
      const { cell, tSea } = this.p, x0 = si * this.size, y0 = sj * this.size;
      // Every chain whose own segments can reach this section: its line, its
      // step on (a link up to the gap, a walk) and its source (up to three
      // walks). Only these, so a section does not depend on what else was
      // followed before.
      const reach = Math.max(this.p.gap, 3 * this.p.walk);
      const segs = new Set(), rings = [], seen = new Set();
      for (const n of this.nodesNear(x0 + this.size / 2, y0 + this.size / 2, this.size / 2 + reach)) {
        const ch = this.chain(n);
        if (seen.has(ch)) continue;
        seen.add(ch);
        if (ch.ring) {
          rings.push({ poly: ch.nodes });
          continue;
        }
        const t = this.tree(ch);
        if (ch.ringPiece) {
          rings.push({ poly: ch.nodes });
          continue;
        }
        if (!ch.segs) {
          ch.segs = [];
          const grow = ch.lake ? 1.5 * ch.wf : ch.wf;
          for (let q = 1; q < ch.nodes.length; q++) {
            const mk = (m) => ({ x: m.x, y: m.y, W: m.W * grow, vSurf: ch.sea ? tSea - 0.01 : m.vSurf, sea: ch.sea });
            ch.segs.push({ a: mk(ch.nodes[q - 1]), b: mk(ch.nodes[q]), kind: ch.lake ? 'lake' : t ? 'line' : 'loose' });
          }
        }
        for (const s of ch.segs) segs.add(s);
        // Its step on (link, tributary, walk) is drawn whether or not the
        // chain reaches the sea, so rivers inland do not break into pieces.
        if (!ch.lake) {
          this.step(ch);
          for (const s of ch.out) segs.add(s);
        }
        if (t && ch.source) for (const s of ch.source) segs.add(s);
      }
      this.graphs.set(k, { segs: [...segs], rings });
      const water = new Uint8Array(N * N), surf = new Float32Array(N * N), sea = new Uint8Array(N * N), cover = new Float32Array(N * N);
      const minW = this.p.minW || 0;
      const list = [...segs].map((s) => {
        const wa = Math.max(s.a.W, minW), wb = Math.max(s.b.W, minW), r = Math.max(wa, wb) / 2;
        return { ax: s.a.x, ay: s.a.y, bx: s.b.x, by: s.b.y, wa, wb, vs: Math.min(s.a.vSurf, s.b.vSurf), sea: !!(s.a.sea && s.b.sea), x0: Math.min(s.a.x, s.b.x) - r, x1: Math.max(s.a.x, s.b.x) + r, y0: Math.min(s.a.y, s.b.y) - r, y1: Math.max(s.a.y, s.b.y) + r };
      }).filter((s) => s.x1 >= x0 && s.x0 <= x0 + this.size && s.y1 >= y0 && s.y0 <= y0 + this.size);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const cx = x0 + (i + 0.5) * cell, cy = y0 + (j + 0.5) * cell, o = j * N + i;
          let vs = Infinity, isSea = false, cov = 0, cvs = Infinity;
          for (const s of list) {
            if (cx < s.x0 || cx > s.x1 || cy < s.y0 || cy > s.y1) continue;
            const ex = s.bx - s.ax, ey = s.by - s.ay, l2 = ex * ex + ey * ey;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((cx - s.ax) * ex + (cy - s.ay) * ey) / l2)) : 0;
            const d = Math.hypot(cx - s.ax - ex * t, cy - s.ay - ey * t), w = s.wa + (s.wb - s.wa) * t;
            if (d < w / 2) {
              vs = Math.min(vs, s.vs);
              isSea = isSea || s.sea;
            } else if (w < cell && d < cell / 2) {
              // A river narrower than a cell: the cell is tinted by the share
              // of it the river covers, instead of being water or not.
              cov = Math.max(cov, w / cell);
              cvs = Math.min(cvs, s.vs);
            }
          }
          if (vs < Infinity) {
            water[o] = 1;
            surf[o] = vs;
            sea[o] = isSea ? 1 : 0;
          } else if (cov > 0) {
            cover[o] = cov;
            surf[o] = cvs;
          }
        }
      }
      mask = { water, surf, sea, cover };
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
      return { water: mask.water[o] === 1, vSurf: mask.surf[o], sea: mask.sea[o] === 1, cover: mask.cover[o] };
    }
  }

  RiverSections.N = N;
  M.RiverSections = RiverSections;
})(window.Markr = window.Markr || {});
