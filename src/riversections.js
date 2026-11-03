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
          const c = { ci, cj, ck, sec: sk, x: on[0], y: on[1], W: b.W, vSurf: b.vSurf, tx: on[2], ty: on[3], plain: b.plain, firm: b.firm, vq: b.vq, f: undefined, b: undefined, chain: null, alive: undefined };
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
      let bd = 3 * R;
      for (const o of this.nodesNear(e.n.x, e.n.y, R)) {
        const ch = this.chain(o);
        if (ch === e.chain || ch.ring || ch.nodes.length < 2) continue;
        const oe = ch.ends.find((x) => x.n === o);
        if (!oe) continue;
        const vx = o.x - e.n.x, vy = o.y - e.n.y, dist = Math.hypot(vx, vy);
        if (!dist) continue;
        const ahead = (vx * e.ox + vy * e.oy) / dist, facing = -(vx * oe.ox + vy * oe.oy) / dist;
        // Far ends must lie ahead and face back; near ends (under the gap)
        // may meet at any angle that is not turned away, so lines that
        // overlap side by side join into an S.
        const near = dist < this.p.gap;
        if (near ? ahead < -0.5 || facing < -0.5 : ahead < 0.5 || facing < 0.2) continue;
        // Score: distance, worse the more the two have to turn.
        const score = dist * (1 + 0.5 * (1 - ahead) + 0.5 * (1 - facing));
        if (score >= bd) continue;
        e.match = oe;
        bd = score;
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
        // An outlet: where the river opens to the sea along its course with
        // the least resistance. Such a river ranks lowest (it drains to the
        // sea), so others may flow into it.
        rv.outlet = null;
        if (nodes.length >= 2 && !this.seaEnd(ea) && !this.seaEnd(eb)) {
          rv.outlet = this.outlet(rv, nodes);
          if (rv.outlet) rv.rank = [-Infinity, rv.outlet.n.ck, rv.outlet.n.sec];
        }
        rv.joinSegs = [];
        for (const [x, y] of joins) {
          const f = this.crowd(x.n, y.n, Math.max(x.W, y.W) * rv.wf, new Set(chains));
          this.linkSegs(x.n, y.n, x.W * rv.wf * f, rv.joinSegs, 'bridge', y.W * rv.wf * f, [x.ox, x.oy], [y.ox, y.oy]);
        }
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
    // From a river's mouth: into the middle of another river ahead, of lower
    // rank. Ends are joined only by mutual pairs, so every end has at most
    // one link and which one is fixed. A tributary is the last resort: only
    // close, well ahead, and into a river at least about as wide.
    connect(e) {
      if (e.link !== undefined) return e.link;
      e.link = null;
      const reach = 0.6 * e.chain.reach;
      let mid = null, md = reach;
      for (const o of this.nodesNear(e.n.x, e.n.y, reach)) {
        const ch = this.chain(o);
        if (ch.ring) continue;
        const rv = this.riverOf(ch);
        if (rv === e.chain || rv.ring || rv.endNodes.has(o) || !lower(rv.rank, e.chain.rank)) continue;
        if (o.W * rv.wf < 0.7 * e.W) continue;
        const vx = o.x - e.n.x, vy = o.y - e.n.y, dist = Math.hypot(vx, vy);
        if (!dist || dist >= md || (vx * e.ox + vy * e.oy) / dist < 0.75) continue; // well ahead of e
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
      if (ch.outlet) {
        ch.out = this.outletSegs(ch.outlet);
        return (ch.next = 'sea');
      }
      const link = this.connect(mouth);
      if (link) {
        const nx = this.riverOf(this.chain(link.node));
        if (nx !== ch) {
          // From the width at this end to the width at the other (a
          // tributary keeps its own), so it neither pinches nor swells.
          // Arrives along the main river, from the side the tributary comes
          // from, and narrow in a crowd.
          const t = link.node, sx = mouth.n.x - t.x, sy = mouth.n.y - t.y, sg = sx * t.tx + sy * t.ty >= 0 ? 1 : -1;
          const f = this.crowd(mouth.n, t, mouth.W, new Set([...ch.chains, this.chain(t)]));
          this.linkSegs(mouth.n, t, mouth.W * f, ch.out, link.kind, mouth.W * f, [mouth.ox, mouth.oy], [sg * t.tx, sg * t.ty]);
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
      }
      // (Sources up to the divide: left for a later step.)
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

    // The natural spring above a river, as in the cell formulas: the head
    // of a valley. Around the river's upper end (the end that is not its
    // mouth), points on a grid of two cells are tested: a valley point lies
    // lower than the ground around it (by springDepth), and it is the head
    // when the ground just uphill of it is no longer a valley. The nearest
    // head that lies higher than the end and ahead of it is the spring.
    // Then the way down: the straight line from the spring to the end, its
    // midpoint moved across to the lowest ground within a set distance, and
    // the same again for the two halves, and so on: the path of least
    // resistance, with as little climbing as can be. A brook runs along it
    // and carves the land (see build). Fixed by the river alone.
    spring(rv) {
      if (rv.springSegs) return rv.springSegs;
      const segs = (rv.springSegs = []);
      if (rv.ring || !rv.mouth) return segs;
      const up = rv.ends[0] === rv.mouth ? rv.ends[1] : rv.ends[0];
      if (this.seaEnd(up)) {
        this.why('spring: upper end at sea');
        return segs;
      }
      // Only from an end that finds no other link: none of its own (a
      // partner end, even one that did not pair back), and no other river's
      // end close by that could be its continuation.
      const ce = rv.chains.flatMap((c) => c.ends).find((e) => e.n === up.n);
      if (ce && this.endMatch(ce)) {
        this.why('spring: end has a link');
        return segs;
      }
      for (const o of this.nodesNear(up.n.x, up.n.y, this.p.gap)) {
        const orv = this.riverOf(this.chain(o));
        if (orv !== rv && !orv.ring && orv.endNodes && orv.endNodes.has(o)) {
          this.why('spring: another end close by');
          return segs;
        }
      }
      const { cell } = this.p, side = 5 * cell, g2 = 2 * cell, R = 1.5 * this.p.walk, H = (px, py) => this.ground(px, py).h;
      const h0 = H(up.n.x, up.n.y);
      // Lower than the ground around by at least springDepth: a valley.
      const valley = (px, py) => {
        const hc = H(px, py);
        let sum = 0;
        for (let a = 0; a < 6; a++) sum += H(px + side * Math.cos((a * Math.PI) / 3), py + side * Math.sin((a * Math.PI) / 3));
        return { hc, depth: sum / 6 - hc };
      };
      let best = null, bd = Infinity;
      const n = Math.ceil(R / g2), cx = Math.round(up.n.x / g2), cy = Math.round(up.n.y / g2);
      for (let j = -n; j <= n; j++) {
        for (let i = -n; i <= n; i++) {
          const px = (cx + i) * g2, py = (cy + j) * g2, vx = px - up.n.x, vy = py - up.n.y, d = Math.hypot(vx, vy);
          if (d > R || d < 3 * cell || d >= bd || (vx * up.ox + vy * up.oy) / d < 0.2) continue;
          const g = this.ground(px, py);
          if (g.cls < 1 || g.cls > 3 || g.h <= h0) continue; // on land, above the end
          const v = valley(px, py);
          if (v.depth < this.p.springDepth) continue;
          // The head: just uphill (the highest of the points around) the
          // ground is no longer a valley.
          let ux = px, uy = py, uh = -Infinity;
          for (let a = 0; a < 8; a++) {
            const qx = px + side * Math.cos((a * Math.PI) / 4), qy = py + side * Math.sin((a * Math.PI) / 4), qh = H(qx, qy);
            if (qh > uh) {
              uh = qh;
              ux = qx;
              uy = qy;
            }
          }
          if (valley(ux, uy).depth >= this.p.springDepth) continue;
          best = { x: px, y: py };
          bd = d;
        }
      }
      if (!best) {
        this.why('spring: no valley head nearby');
        return segs;
      }
      // The way down by midpoint displacement.
      const path = [best, { x: up.n.x, y: up.n.y }];
      // Cost of a point: its height, and water is no way for a brook (it
      // would rather run through a lake than round it).
      const cost = (px, py) => {
        const g = this.ground(px, py);
        return g.cls === 0 || g.cls === 4 ? g.h + 1e9 : g.h;
      };
      const refine = (a, b, depth) => {
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        if (L < 6 * cell || depth > 7) return [a];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, px = -(b.y - a.y) / L, py = (b.x - a.x) / L, D = 0.25 * L;
        let m = { x: mx, y: my }, mh = cost(mx, my);
        for (let k = -3; k <= 3; k++) {
          if (!k) continue;
          const qx = mx + (px * D * k) / 3, qy = my + (py * D * k) / 3, qh = cost(qx, qy);
          // Only a clearly lower way is worth the bend.
          if (qh < mh - this.p.springDepth * 0.5) {
            mh = qh;
            m = { x: qx, y: qy };
          }
        }
        return refine(a, m, depth + 1).concat(refine(m, b, depth + 1));
      };
      let pts = refine(path[0], path[1], 0).concat([path[1]]);
      // Smoothed twice (corner cutting), keeping the ends.
      for (let it = 0; it < 2; it++) {
        const q = [pts[0]];
        for (let k = 0; k < pts.length - 1; k++) {
          const a = pts[k], b = pts[k + 1];
          q.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y }, { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
        }
        q.push(pts[pts.length - 1]);
        pts = q;
      }
      // The brook, from the spring down to the river, widening a little.
      const W0 = 0.3 * cell, W1 = Math.max(W0, Math.min(up.W, 0.8 * cell));
      for (let k = 1; k < pts.length; k++) {
        const f0 = (k - 1) / (pts.length - 1), f1 = k / (pts.length - 1);
        segs.push({ a: { x: pts[k - 1].x, y: pts[k - 1].y, W: W0 + (W1 - W0) * f0, vSurf: up.n.vSurf }, b: { x: pts[k].x, y: pts[k].y, W: W0 + (W1 - W0) * f1, vSurf: up.n.vSurf }, kind: 'spring' });
      }
      return segs;
    }

    // Links from a to b, of width W: whole half waves, swinging at most half
    // the width, its side from the positions (so neighbours agree).
    // Width factor for a link from a to b: alone, the river's full width;
    // with other chains close by (a cluster of lakes and rivers), a narrow
    // brook, so it does not merge them all.
    // 7. Outlets. A river that comes close to the sea along its course but
    // does not end there (it turns away, and would run far before reaching
    // the sea or another river) opens to the sea where the resistance is
    // least. From points along the river near the sea, rays are sent out;
    // a ray counts if it reaches the sea within outlet without climbing
    // more than rise over a sill. Its resistance is its length, made larger
    // by the sill (low land is easier), by the slope crossed, and by turning
    // off the river's own direction (a river with direction keeps it). The
    // best point and ray win, if the way out is much shorter than the
    // river's way on (detour). The river then drains there, on both sides
    // of the point: its direction does not matter for drawing.
    outlet(rv, nodes) {
      const p = this.p, R = p.outlet || 0, tSea = p.tSea;
      if (!(R > 0)) return null;
      // The highest sill the water may cut through on its way out.
      const step = this.g2, K = 12, band = 0.35, SILL = p.sill ?? p.rise;
      // Along-river distance from the start, for the detour test.
      const along = [0];
      for (let k = 1; k < nodes.length; k++) along.push(along[k - 1] + Math.hypot(nodes[k].x - nodes[k - 1].x, nodes[k].y - nodes[k - 1].y));
      const total = along[along.length - 1];
      let best = null;
      for (let k = 0; k < nodes.length; k += 3) {
        const n = nodes[k];
        if (!(n.vq < tSea + band)) continue;
        // The way on: along the river to the end it drains through now (its
        // mouth), and from there it has still to find the sea.
        const rest = rv.mouth.n === nodes[0] ? along[k] : total - along[k];
        const h0 = this.ground(n.x, n.y).h;
        for (let r = 0; r < K; r++) {
          const ang = (r / K) * 2 * Math.PI, dx = Math.cos(ang), dy = Math.sin(ang);
          let sill = 0, rough = 0, hp = h0, L = 0, hit = false;
          for (let s = 1; s * step <= R; s++) {
            const g = this.ground(n.x + dx * s * step, n.y + dy * s * step);
            L = s * step;
            if (this.openSea(g, n.x + dx * s * step, n.y + dy * s * step)) {
              hit = true;
              break;
            }
            sill = Math.max(sill, g.h - h0);
            rough += Math.abs(g.h - hp);
            hp = g.h;
            if (sill > SILL) break;
          }
          if (!hit || sill > SILL) continue;
          const slope = ((rough / Math.max(L, 1)) * (p.slopeK || 1));
          const turn = 1 - Math.abs(dx * n.tx + dy * n.ty);
          const res = L * (1 + 2 * (sill / Math.max(1, SILL)) + 2 * Math.min(1, slope / 0.15) + 0.6 * turn);
          // Only a clear short cut: the way out is a small share of the way on.
          if (L > rest / (p.detour || 3)) continue;
          if (!best || res < best.res) best = { n, k, dx, dy, L, res, sill };
        }
      }
      if (!best) return null;
      // The kind of mouth, from the ground at the point: loose and flat
      // makes a delta, firm makes a fjord, the rest a plain mouth.
      const firm = best.n.firm ?? 0.5, flat = 1 - Math.min(1, best.sill / Math.max(1, SILL));
      best.kind = firm < 0.45 && (best.n.plain > 0.3 || flat > 0.4) ? 'delta' : firm > 0.62 ? 'fjord' : 'mouth';
      best.W = Math.max(best.n.W * rv.wf, p.minW || 0);
      best.rv = rv;
      return best;
    }
    // Open sea at a point (g: its ground): sea in the land itself and as
    // drawn, a metre deep, and not a speck: at least 3 of 8 points on a ring round it
    // (8 cells out) are sea too.
    openSea(g, x, y) {
      // At least a metre deep on screen: flats right at the sea threshold
      // flicker between sea and land and are no sea to run out into.
      const deep = (q) => q.cls === 0 && q.sea && q.h < -this.p.rise / 5;
      if (!deep(g)) return false;
      const R = 8 * this.p.cell;
      let n = 0;
      for (let k = 0; k < 8 && n < 3; k++) if (deep(this.ground(x + R * Math.cos((k * Math.PI) / 4), y + R * Math.sin((k * Math.PI) / 4)))) n++;
      return n >= 3;
    }
    // The outlet's water: one channel (a mouth), a fjord (the sea reaching
    // in, widening toward the coast), or a delta (arms fanning out, each
    // narrower, every one reaching the sea).
    outletSegs(o) {
      if (o.segs) return o.segs;
      const p = this.p, n = o.n, segs = [], step = this.g2, tSea = p.tSea, h0 = this.ground(n.x, n.y).h;
      // A ray's end, a little into the sea so the channel meets it.
      const reachSea = (dx, dy, max) => {
        for (let s = 1; s * step <= max; s++) {
          const x = n.x + dx * s * step, y = n.y + dy * s * step, g = this.ground(x, y);
          if (this.openSea(g, x, y)) return { x: x + dx * 2 * p.cell, y: y + dy * 2 * p.cell, L: s * step };
          if (g.h - h0 > (p.sill ?? p.rise)) return null;
        }
        return null;
      };
      const main = reachSea(o.dx, o.dy, o.L + step);
      if (!main) return (o.segs = segs);
      const end = { x: main.x, y: main.y, vSurf: tSea - 0.01 };
      // Leaves along the river (the way of its line that points to the
      // sea), bending out, and meets the sea head on.
      const sg = o.dx * n.tx + o.dy * n.ty >= 0 ? 1 : -1, ux = sg * n.tx + o.dx, uy = sg * n.ty + o.dy, ul = Math.hypot(ux, uy) || 1;
      const da = [ux / ul, uy / ul], db = [-o.dx, -o.dy];
      if (o.kind === 'fjord') {
        // The inner part a river, the outer the sea reaching in, widening.
        const mid = { x: n.x + (end.x - n.x) * 0.4, y: n.y + (end.y - n.y) * 0.4, vSurf: n.vSurf };
        this.linkSegs(n, mid, o.W, segs, 'outlet', o.W * 1.3, da, db);
        const seaSegs = [];
        this.linkSegs({ ...mid, vSurf: tSea - 0.01 }, end, o.W * 1.3, seaSegs, 'fjord', o.W * 3, da, db);
        for (const sg of seaSegs) {
          sg.a.sea = sg.b.sea = true;
          segs.push(sg);
        }
      } else if (o.kind === 'delta') {
        // Arms: the main way and others fanning out to either side that
        // also reach the sea, not much farther off.
        const arms = [main];
        for (const a of [0.35, -0.35, 0.7, -0.7]) {
          if (arms.length >= 4) break;
          const c = Math.cos(a), sn = Math.sin(a), dx = o.dx * c - o.dy * sn, dy = o.dx * sn + o.dy * c;
          const r = reachSea(dx, dy, 1.6 * o.L + step);
          if (r) arms.push({ ...r, dx, dy });
        }
        const w = o.W / Math.sqrt(arms.length);
        for (const r of arms) {
          const dx = r.dx ?? o.dx, dy = r.dy ?? o.dy;
          this.linkSegs(n, { x: r.x, y: r.y, vSurf: tSea - 0.01 }, w, segs, 'delta', w * 1.4, da, [-dx, -dy]);
        }
      } else this.linkSegs(n, end, o.W, segs, 'outlet', o.W * 1.5, da, db);
      return (o.segs = segs);
    }

    crowd(a, b, W, own) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, r = 1.5 * W + 0.5 * Math.hypot(b.x - a.x, b.y - a.y);
      const others = new Set();
      for (const o of this.nodesNear(mx, my, r)) {
        const c = this.chain(o);
        if (!own.has(c)) others.add(c);
      }
      const n = others.size;
      return n ? Math.max(Math.min(1, (this.p.minW || 0) / Math.max(1, W)), 1 / (1 + 1.5 * n)) : 1;
    }

    // A link from a to b, of width W to W2, as a smooth curve: it leaves a
    // along da and arrives at b from the side db points to (a cubic curve),
    // so it meets both straight on instead of cutting across. Widths taper.
    linkSegs(a, b, W, segs, kind, W2 = W, da = null, db = null) {
      const { cell } = this.p;
      const vx = b.x - a.x, vy = b.y - a.y, L = Math.hypot(vx, vy);
      if (!L) return;
      const vs = Math.min(a.vSurf, b.vSurf), h = L / 3;
      const [ax, ay] = da || [vx / L, vy / L], [bx, by] = db || [-vx / L, -vy / L];
      const c1x = a.x + ax * h, c1y = a.y + ay * h, c2x = b.x + bx * h, c2y = b.y + by * h;
      const k = Math.max(2, Math.ceil(L / cell));
      let prev = { x: a.x, y: a.y, W, vSurf: vs };
      for (let t = 1; t <= k; t++) {
        const f = t / k, g = 1 - f;
        const x = g * g * g * a.x + 3 * g * g * f * c1x + 3 * g * f * f * c2x + f * f * f * b.x;
        const y = g * g * g * a.y + 3 * g * g * f * c1y + 3 * g * f * f * c2y + f * f * f * b.y;
        const node = { x, y, W: W + (W2 - W) * f, vSurf: vs };
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
        // A spring: from the river's upper end, up the valley to where it
        // begins, and a brook down from there.
        if (!rv.lake && this.p.springOn !== false) for (const s of this.spring(rv)) segs.add(s);
      }
      this.graphs.set(k, { segs: [...segs], rings });
      const water = new Uint8Array(N * N), surf = new Float32Array(N * N), sea = new Uint8Array(N * N), cover = new Float32Array(N * N), carve = new Float32Array(N * N);
      // Brooks carve the land: a soft channel along them, deepest on the
      // line (springCarve), out to springZone.
      const zone = this.p.springZone || 0, depth = this.p.springCarve || 0;
      if (zone > 0 && depth > 0) {
        for (const sg of segs) {
          if (sg.kind !== 'spring') continue;
          const a = sg.a, b = sg.b, ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
          const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - zone - x0) / cell)), i1 = Math.min(N - 1, Math.floor((Math.max(a.x, b.x) + zone - x0) / cell));
          const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - zone - y0) / cell)), j1 = Math.min(N - 1, Math.floor((Math.max(a.y, b.y) + zone - y0) / cell));
          for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
              const cx = x0 + (i + 0.5) * cell, cy = y0 + (j + 0.5) * cell;
              const t = l2 > 0 ? Math.max(0, Math.min(1, ((cx - a.x) * ex + (cy - a.y) * ey) / l2)) : 0;
              const d = Math.hypot(cx - a.x - ex * t, cy - a.y - ey * t);
              if (d < zone) {
                const q = 1 - d / zone;
                carve[j * N + i] = Math.max(carve[j * N + i], depth * q * q);
              }
            }
          }
        }
      }
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
      mask = { water, surf, sea, cover, remove, carve };
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
      return { water: mask.water[o] === 1, vSurf: mask.surf[o], sea: mask.sea[o] === 1, cover: mask.cover[o], remove: mask.remove[o] === 1, carve: mask.carve[o] };
    }
  }

  RiverSections.N = N;
  M.RiverSections = RiverSections;
})(window.Markr = window.Markr || {});
