// Large rivers from their own noise layer, worked out before the cells.
//
// A river line is where a warped noise layer crosses zero: an endless, branching
// set of lines (spaced by `scale`). From any point on such a line, the line is
// followed in coarse steps (256 m) both ways, using only noise and coarse
// terrain, never the cells of other sections:
//   - downstream is where the coast value falls; it ends in the sea, or where
//     it ends in the sea, or where the line fades;
//   - upstream it must reach rugged, high ground (the head); a line that only
//     runs over flat land is no river.
// The water surface at a point falls evenly from the height where the river
// starts to where it ends: hStart + (hEnd - hStart) * up / (up + down). The
// width comes from how loose (not firm) and how flat the ground is, growing
// toward the mouth, up to `maxWidth` (1 km). The river is carved into the
// height: its bed below the surface, the banks rising to the land.
//
// Firmness is an S-curve: high and dry is firm, low and wet is loose.
(function (M) {
  'use strict';

  const { createPerlin, fbm } = M.noise;
  const S = (a, b, v) => {
    if (a === b) return v >= a ? 1 : 0;
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const STEP = 256, GRID = 256, MAX_STEPS = 220;

  class RiverLayer {
    // base: a Terrain (layers, ruggedness, moisture). p: settings.
    constructor(base, seed, p) {
      this.base = base;
      this.p = p;
      this.n = createPerlin(seed * 41 + 7);
      this.wx = createPerlin(seed * 41 + 8);
      this.wy = createPerlin(seed * 41 + 9);
      this.cache = new Map();
      this.down = new Map();
      this.up = new Map();
    }

    // The river noise and its gradient (per metre). A line is where it is 0.
    noise(x, y) {
      const L = this.p.scale, W = L * 0.3;
      const qx = x + W * this.wx(x / L, y / L), qy = y + W * this.wy(x / L, y / L);
      return fbm(this.n, qx / L, qy / L, 2);
    }
    grad(x, y) {
      const h = 20;
      return [(this.noise(x + h, y) - this.noise(x - h, y)) / (2 * h), (this.noise(x, y + h) - this.noise(x, y - h)) / (2 * h)];
    }

    // Firmness at a point: two S-curves, height and dryness, mixed.
    firmness(x, y, h) {
      const p = this.p;
      const dry = 1 - this.base.moisture(x, y, h);
      return 0.5 * S(p.firmHFrom, p.firmHTo, h) + 0.5 * S(p.dryFrom / 100, p.dryTo / 100, dry);
    }

    // Newton steps onto the line (noise 0). Returns [x, y] or null.
    project(x, y) {
      for (let it = 0; it < 5; it++) {
        const v = this.noise(x, y), [gx, gy] = this.grad(x, y), g2 = gx * gx + gy * gy;
        if (g2 < 1e-14) return null;
        const sx = (-v * gx) / g2, sy = (-v * gy) / g2, l = Math.hypot(sx, sy);
        if (l > 2 * STEP) return null;
        x += sx;
        y += sy;
        if (l < 2) return [x, y];
      }
      return Math.abs(this.noise(x, y)) < 0.01 ? [x, y] : null;
    }

    // Follow the line from (x, y) in direction (dx, dy). Returns the distance
    // walked, where it ended and why, and whether it passed a head. Every point
    // reached is remembered with what lies beyond it, so other points on the
    // same river reuse the walk instead of repeating it.
    trace(x, y, dx, dy, downstream) {
      const p = this.p, memo = downstream ? this.down : this.up;
      const path = []; // [key, step length, head here]
      let tail = null;
      for (let k = 0; k < MAX_STEPS; k++) {
        const [gx, gy] = this.grad(x, y), g = Math.hypot(gx, gy);
        if (g < 1e-9) break;
        let tx = -gy / g, ty = gx / g;
        // Orientation relative to the line's own tangent, for the memo key.
        const sgn = tx * dx + ty * dy < 0 ? -1 : 1;
        tx *= sgn;
        ty *= sgn;
        const mk = Math.round(x / 64) + ',' + Math.round(y / 64) + ',' + sgn;
        const known = memo.get(mk);
        if (known) {
          tail = known;
          break;
        }
        const q = this.project(x + tx * STEP, y + ty * STEP);
        if (!q) {
          path.push([mk, 0, false, x, y, false]);
          break; // the line fades
        }
        const len = Math.hypot(q[0] - x, q[1] - y);
        dx = q[0] - x;
        dy = q[1] - y;
        [x, y] = q;
        const L = this.base.layers(x, y);
        let head = false, sea = false;
        if (downstream && L.u < 0) sea = true;
        if (!downstream) {
          const hh = this.base.elevation(x, y, 600);
          head = L.mount > 0.3 || (this.base.ruggedness(x, y) > p.headRugged && hh > p.riverHead);
        }
        path.push([mk, len, head, x, y, sea]);
        if (sea) break;
      }
      // Backfill: from the end toward the start, what lies beyond each point.
      let rest = tail || { len: 0, x, y, head: false, sea: path.length ? path[path.length - 1][5] : false };
      for (let k = path.length - 1; k >= 0; k--) {
        const [mk, len, head] = path[k];
        rest = { len: rest.len + len, x: rest.x, y: rest.y, head: rest.head || head, sea: rest.sea };
        memo.set(mk, rest);
      }
      if (memo.size > 200000) memo.clear();
      return rest;
    }

    // The river through the coarse grid point (gi, gj), or null. Cached.
    course(gi, gj) {
      const key = gi + ',' + gj;
      if (this.cache.has(key)) return this.cache.get(key);
      let res = null;
      const p0 = this.project((gi + 0.5) * GRID, (gj + 0.5) * GRID);
      const g0 = p0 ? Math.hypot(...this.grad(p0[0], p0[1])) : 0;
      if (p0 && g0 >= 0.5 / this.p.scale && this.base.layers(p0[0], p0[1]).u > 0) {
        const [x, y] = p0, [gx, gy] = this.grad(x, y), g = Math.hypot(gx, gy);
        const tx = -gy / g, ty = gx / g;
        // Downstream is the way that reaches the sea, or else ends lowest: the
        // whole course decides, so every point on a river agrees.
        const e0 = (px, py) => this.base.elevation(px, py, 600);
        const A = this.trace(x, y, tx, ty, true), B = this.trace(x, y, -tx, -ty, true);
        const s = A.sea !== B.sea ? (A.sea ? 1 : -1) : e0(A.x, A.y) <= e0(B.x, B.y) ? 1 : -1;
        const down = s > 0 ? A : B;
        const up = this.trace(x, y, -s * tx, -s * ty, false);
        if (up.head && up.len + down.len > 2 * STEP) {
          const e = (px, py) => Math.max(0, this.base.elevation(px, py, 600));
          const hStart = e(up.x, up.y), hEnd = down.sea ? 0 : e(down.x, down.y);
          const f = up.len / (up.len + down.len); // 0 at the start, 1 at the end
          const h0 = e(x, y);
          const firm = this.firmness(x, y, h0);
          const sl = Math.hypot(e(x + 128, y) - e(x - 128, y), e(x, y + 128) - e(x, y - 128)) / 256;
          const flat = 1 - S(0.02, 0.15, sl);
          const pp = this.p;
          const width = Math.max(8, Math.min(pp.maxWidth, pp.width * (0.3 + 0.7 * (1 - firm)) * (0.3 + 0.7 * flat) * (0.35 + 0.65 * f)));
          res = { surface: hStart + (hEnd - hStart) * f, hStart, hEnd, f, upLen: up.len, downLen: down.len, width, firm, depth: 1 + 6 * firm, sea: down.sea };
        }
      }
      this.cache.set(key, res);
      if (this.cache.size > 20000) this.cache.clear();
      return res;
    }

    // The river at a point: blended from the four nearest coarse points, so the
    // surface and width vary smoothly along the river. Returns null away from a
    // river, else {d, surface, width, depth, firm, f, ...}.
    at(x, y) {
      const v = this.noise(x, y), [gx, gy] = this.grad(x, y), g = Math.hypot(gx, gy);
      // Only a clear line: where the noise is flat near 0 (a shallow dip, not a
      // crossing) the distance estimate breaks down and would make a pond.
      if (g < 0.5 / this.p.scale) return null;
      const d = Math.abs(v) / g; // metres from the line
      if (d > this.p.maxWidth) return null;
      const u = x / GRID - 0.5, w = y / GRID - 0.5, i = Math.floor(u), j = Math.floor(w), fu = u - i, fv = w - j;
      let sw = 0, out = null;
      const acc = { surface: 0, width: 0, depth: 0, firm: 0, f: 0, upLen: 0, downLen: 0 };
      for (const [di, dj, wt] of [[0, 0, (1 - fu) * (1 - fv)], [1, 0, fu * (1 - fv)], [0, 1, (1 - fu) * fv], [1, 1, fu * fv]]) {
        const c = this.course(i + di, j + dj);
        if (!c || wt <= 0) continue;
        sw += wt;
        for (const k in acc) acc[k] += wt * c[k];
        out = c;
      }
      if (!out || sw <= 0) return null;
      // Width fades toward points with no river (they count as width 0), so the
      // river tapers smoothly instead of ending on the coarse grid; the rest is
      // averaged over the points that have it.
      const width = acc.width;
      for (const k in acc) acc[k] /= sw;
      acc.width = width;
      if (acc.width < 4) return null;
      if (d > acc.width / 2 + acc.width * 0.5 + 40) return null;
      return Object.assign({ d, hStart: out.hStart, hEnd: out.hEnd, sea: out.sea }, acc);
    }

    // Carve the river into height h at (x, y). Returns {h, level} where level
    // is the water surface (null if not in the river).
    carve(x, y, h) {
      const r = this.at(x, y);
      if (!r) return { h, level: null };
      const half = r.width / 2;
      // The surface never lies above the land around it.
      const surface = Math.min(r.surface, h);
      if (r.d <= half) return { h: Math.min(h, surface - r.depth), level: surface, river: r };
      // Banks: rising from the surface, steeper in firm ground.
      const bank = surface + (r.d - half) * (0.04 + 0.4 * r.firm);
      return { h: Math.min(h, bank), level: null, river: r };
    }
  }

  M.RiverLayer = RiverLayer;
})(window.Markr = window.Markr || {});
