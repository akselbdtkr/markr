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
//    drawn as a river, and a bendy one as a small lake. The source of a straight chain is followed uphill to the
//    divide, so trees start there. Trees are the waterways of the game, and
//    only chains near what is drawn are ever followed.
// 4. Rivers: chains are first joined end to end where two ends are each
//    other's best partner (mutual, so the order does not matter), and the
//    joined river is judged as one. A short piece has one water level all
//    along. Direction: the river's straightness (ends' distance over its
//    length) decides. Straight chains keep their width and look farther for links
//    (up to twice the gap); bendy ones narrow, look less far, and become
//    lakes when they find no way to the sea. Links taper between the two
//    ends' widths and swing a little, in whole half waves.
// 5. A chain whose ends both open onto the sea is a sound, at sea level.
// 6. Draw: the section's cells (16 m) in a channel or lake are water. This
//    adds to the river drawn point by point, it does not replace it, so a
//    river that is already whole is never broken up; only rings are taken
//    away.
(function (M) {
  'use strict';

  const N = 32; // cells per section side
  const S = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const MAX_CHAINS = 80; // chains followed downstream before giving up
  const lower = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));

  class RiverSections {
    // river: a RiverLine. ground(x, y) -> { h, cls } without this step.
    // p: cell (sim units), gap, walk (sim units), bend (straightness under
    // which a chain with no way out is a lake), meander, tSea,
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
      // A short piece has one water level all along: its lowest.
      if (len < 2 * this.p.gap) {
        const lv = Math.min(...nodes.map((m) => m.vSurf));
        for (const m of nodes) m.vSurf = lv;
      }
      // Ends' widths: the widest of the last points inward (rivers thin
      // where they fade).
      const endW = (list) => list.slice(0, 8).reduce((w, m) => Math.max(w, m.W), 0);
      const h = nodes[0], t = nodes[nodes.length - 1];
      ch.ends = [
        { n: h, ox: -h.tx, oy: -h.ty, W: endW(nodes), chain: ch },
        { n: t, ox: t.tx, oy: t.ty, W: endW(nodes.slice().reverse()), chain: ch },
      ];
      return ch;
    }

    // A loose end's best partner: the nearest end of another chain within
    // twice the gap, ahead of it and facing back.
    endMatch(e) {
      if (e.match !== undefined) return e.match;
      e.match = null;
      // A one-point chain has one node for both ends: it takes no part.
      if (e.chain.nodes.length < 2) return null;
      const R = 2 * this.p.gap;
      let bd = R;
      for (const o of this.nodesNear(e.n.x, e.n.y, R)) {
        const ch = this.chain(o);
        if (ch === e.chain || ch.ring || ch.nodes.length < 2) continue;
        const oe = ch.ends.find((x) => x.n === o);
        if (!oe) continue;
        const vx = o.x - e.n.x, vy = o.y - e.n.y, dist = Math.hypot(vx, vy);
        if (!dist || dist >= bd || (vx * e.ox + vy * e.oy) / dist < 0.6 || -(vx * oe.ox + vy * oe.oy) / dist < 0.3) continue;
        e.match = oe;
        bd = dist;
      }
      return e.match;
    }
    // Two ends are joined only when each is the other's best partner, so it
    // does not matter which side looks first.
    pair(e) {
      const m = this.endMatch(e);
      return m && this.endMatch(m) === e ? m : null;
    }

    // The river a chain belongs to: chains joined end to end by mutual
    // pairs, judged as one. Straightness, width, reach and whether it is a
    // lake are worked out for the whole river, so a short piece between two
    // long ones is part of a long, straight river.
    riverOf(ch) {
      if (ch.river) return ch.river;
      const make = (chains, nodes, joins, ends, len) => {
        const rv = { chains, nodes, joins, len, ring: false, tree: undefined, next: undefined, out: null, lake: false, sea: false, source: null, ringPiece: false };
        const a = ends[0].n, b = ends[1].n;
        rv.straight = len > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / len : 1;
        // A river with direction keeps its width and looks far for links; a
        // bendy one narrows, looks less far, and becomes a lake more easily.
        rv.wf = 0.3 + 0.7 * S(0.35, 0.8, rv.straight);
        rv.reach = this.p.gap * (0.5 + 1.5 * S(0.4, 0.9, rv.straight));
        rv.ends = ends.map((e) => ({ n: e.n, ox: e.ox, oy: e.oy, W: e.W * rv.wf, chain: rv }));
        // The mouth: the lower end (ties by index). Its level ranks the
        // river: water only flows on to a river of lower rank, so steps can
        // never go round in a circle.
        const [ea, eb] = rv.ends;
        rv.mouth = ea.n.vSurf < eb.n.vSurf || (ea.n.vSurf === eb.n.vSurf && ea.n.ck <= eb.n.ck) ? ea : eb;
        rv.rank = [rv.mouth.n.vSurf, rv.mouth.n.ck, rv.mouth.n.sec];
        rv.endNodes = new Set([ea.n, eb.n]);
        rv.joinSegs = [];
        for (const [x, y] of joins) this.linkSegs(x.n, y.n, x.W * rv.wf, rv.joinSegs, 'bridge', y.W * rv.wf);
        for (const c of chains) c.river = rv;
        return rv;
      };
      if (ch.ring || ch.nodes.length < 2) {
        const rv = make([ch], ch.nodes, [], ch.ends, ch.len);
        rv.ring = ch.ring;
        return rv;
      }
      // Follow mutual pairs out of both ends.
      const seen = new Set([ch]), joins = [];
      const grow = (start) => {
        const list = [];
        let e = start, len = 0;
        for (let k = 0; k < 200; k++) {
          const m = this.pair(e);
          if (!m || seen.has(m.chain)) break;
          seen.add(m.chain);
          joins.push([e, m]);
          len += Math.hypot(m.n.x - e.n.x, m.n.y - e.n.y) + m.chain.len;
          const flip = m === m.chain.ends[1];
          list.push(flip ? m.chain.nodes.slice().reverse() : m.chain.nodes);
          e = flip ? m.chain.ends[0] : m.chain.ends[1];
        }
        return { list, end: e, len };
      };
      const fwd = grow(ch.ends[1]), bwd = grow(ch.ends[0]);
      // Chains paired all the way round: a ring, removed. Which pair would
      // close it depends on where one starts, so none is drawn.
      if (fwd.end !== bwd.end && this.pair(fwd.end) === bwd.end) {
        const all = [...seen];
        const rv = make(all, all.flatMap((c) => c.nodes), [], [bwd.end, fwd.end], ch.len + fwd.len + bwd.len);
        rv.ring = true;
        rv.joinSegs = [];
        return rv;
      }
      let nodes = [];
      for (let k = bwd.list.length - 1; k >= 0; k--) nodes = nodes.concat(bwd.list[k].slice().reverse());
      nodes = nodes.concat(ch.nodes);
      for (const l of fwd.list) nodes = nodes.concat(l);
      let ends = [bwd.end, fwd.end];
      // The same river from any of its chains: ends in a fixed order.
      if (ends[0].n.ck > ends[1].n.ck || (ends[0].n.ck === ends[1].n.ck && ends[0].n.sec > ends[1].n.sec)) {
        ends = [ends[1], ends[0]];
        nodes = nodes.reverse();
      }
      return make([...seen], nodes, joins, ends, ch.len + fwd.len + bwd.len);
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
    // From a river's mouth: into the middle of another river ahead, of lower
    // rank. Ends are joined only by mutual pairs, so every end has at most
    // one link and which one is fixed. { node, kind } or null.
    connect(e) {
      if (e.link !== undefined) return e.link;
      e.link = null;
      const reach = e.chain.reach;
      let mid = null, md = reach;
      for (const o of this.nodesNear(e.n.x, e.n.y, reach)) {
        const ch = this.chain(o);
        if (ch.ring) continue;
        const rv = this.riverOf(ch);
        if (rv === e.chain || rv.ring || rv.endNodes.has(o) || !lower(rv.rank, e.chain.rank)) continue;
        const vx = o.x - e.n.x, vy = o.y - e.n.y, dist = Math.hypot(vx, vy);
        if (!dist || dist >= md || (vx * e.ox + vy * e.oy) / dist < 0.6) continue; // ahead of e
        mid = o;
        md = dist;
      }
      if (mid) e.link = { node: mid, end: null, kind: 'tributary' };
      return e.link;
    }

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
      const mouth = ch.mouth;
      if (this.seaEnd(mouth)) return (ch.next = 'sea');
      const link = this.connect(mouth);
      if (link) {
        const nx = this.riverOf(this.chain(link.node));
        if (nx !== ch) {
          // From the width at this end to the width at the other (a
          // tributary keeps its own), so it neither pinches nor swells.
          this.linkSegs(mouth.n, link.node, mouth.W, ch.out, link.kind, mouth.W);
          return (ch.next = nx);
        }
      }
      const wk = this.walk(mouth, ch.out);
      if (wk === 'sea') return (ch.next = 'sea');
      if (wk) return (ch.next = this.riverOf(this.chain(wk)));
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
        // broken into pieces) is removed; a bendy loose chain is a small
        // lake; the rest is drawn but no waterway.
        if (ch.ring || this.ringPiece(ch)) ch.ringPiece = true;
        else if (ch.straight < this.p.bend) ch.lake = true;
      } else if (ch.straight >= this.p.bend) this.toDivide(ch);
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
        for (const o of this.nodesNear(best.px, best.py, 1.5 * cell)) {
          const rv = this.riverOf(this.chain(o));
          if (rv !== end.chain && !rv.ring && !rv.endNodes.has(o) && lower(rv.rank, end.chain.rank)) return o;
        }
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
      const reach = Math.max(2 * this.p.gap, 3 * this.p.walk);
      const segs = new Set(), rings = [], seen = new Set();
      for (const n of this.nodesNear(x0 + this.size / 2, y0 + this.size / 2, this.size / 2 + reach)) {
        const ch = this.chain(n);
        if (seen.has(ch)) continue;
        seen.add(ch);
        if (ch.ring) {
          rings.push({ poly: ch.nodes });
          continue;
        }
        const rv = this.riverOf(ch);
        if (seen.has(rv)) continue;
        seen.add(rv);
        const t = this.tree(rv);
        if (rv.ringPiece) {
          rings.push({ poly: rv.nodes });
          continue;
        }
        if (!rv.segs) {
          rv.segs = [];
          const grow = rv.lake ? 1.5 * rv.wf : rv.wf;
          const mk = (m) => ({ x: m.x, y: m.y, W: m.W * grow, vSurf: rv.sea ? tSea - 0.01 : m.vSurf, sea: rv.sea });
          for (const c of rv.chains) {
            for (let q = 1; q < c.nodes.length; q++) rv.segs.push({ a: mk(c.nodes[q - 1]), b: mk(c.nodes[q]), kind: rv.lake ? 'lake' : t ? 'line' : 'loose' });
          }
          for (const j of rv.joinSegs) rv.segs.push(rv.sea ? { a: { ...j.a, vSurf: tSea - 0.01, sea: true }, b: { ...j.b, vSurf: tSea - 0.01, sea: true }, kind: j.kind } : j);
        }
        for (const s of rv.segs) segs.add(s);
        // Its step on (link, tributary, walk) is drawn whether or not the
        // river reaches the sea, so rivers inland do not break into pieces.
        if (!rv.lake) {
          this.step(rv);
          for (const s of rv.out) segs.add(s);
        }
        if (t && rv.source) for (const s of rv.source) segs.add(s);
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
      // Removed water: cells along rings and ring pieces, which the river
      // drawn point by point would otherwise still show.
      const remove = new Uint8Array(N * N);
      for (const r of rings) {
        const ns = r.poly;
        for (let q = 0; q < ns.length; q++) {
          const a = ns[q], b = ns[(q + 1) % ns.length], R = Math.max(a.W, b.W) / 2 + cell;
          const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - R - x0) / cell)), i1 = Math.min(N - 1, Math.floor((Math.max(a.x, b.x) + R - x0) / cell));
          const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - R - y0) / cell)), j1 = Math.min(N - 1, Math.floor((Math.max(a.y, b.y) + R - y0) / cell));
          const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
          for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
              const cx = x0 + (i + 0.5) * cell, cy = y0 + (j + 0.5) * cell;
              const t = l2 > 0 ? Math.max(0, Math.min(1, ((cx - a.x) * ex + (cy - a.y) * ey) / l2)) : 0;
              if (Math.hypot(cx - a.x - ex * t, cy - a.y - ey * t) < R && !water[j * N + i]) remove[j * N + i] = 1;
            }
          }
        }
      }
      mask = { water, surf, sea, cover, remove };
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
      return { water: mask.water[o] === 1, vSurf: mask.surf[o], sea: mask.sea[o] === 1, cover: mask.cover[o], remove: mask.remove[o] === 1 };
    }
  }

  RiverSections.N = N;
  M.RiverSections = RiverSections;
})(window.Markr = window.Markr || {});
