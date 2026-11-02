// Elvene: rivers along the bottom lines of the depression layer, worked out
// point by point but read at the bottom of the cross-section.
//
// With the median threshold, a depression's bottom is the line where its
// noise n is 0. From any point one Newton step across, q = p − n ∇n / |∇n|²,
// lands on that line: the bottom of the cross-section the point lies in, and
// |n| / |∇n| is the distance to it. Everything else is read at q, so every
// point of one cross-section agrees: both banks get the same width and the
// same water surface.
//
// - Where: only where the depression is deep at q (its band there, which is
//   shallow where the line turns across the slope), on land, up into the
//   divide field. The river fades with an S-curve as the band weakens: fast
//   in firm rugged ground (fjellsk) and in loose plains and plateaus, softer
//   in hills and loose lowland and highland.
// - Width: volume over depth. Volume is a direct function of height and
//   firmness, through two curves you set (size by height, size by
//   firmness); depth follows
//   firmness (firm cuts deep, loose stays shallow), so a shallower river is
//   wider: up to riverWidth (2 km on screen) at the water in loose ground.
// - Surface: the large part of the base at q (continents and the first basin
//   octave), which rises steadily up the slope the river follows, so the
//   surface falls steadily downstream.
// - Several channels near the water: close to the sea the corridor widens
//   and a small noise, stretched along the slope, splits it into channels
//   with islands between (a braid). The main channel narrows as it does.
// - Around the river the land is shaped down toward the water in a zone whose
//   size follows firmness and a slow noise.
(function (M) {
  'use strict';

  const S = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  class RiverLine {
    // p: riverAlign (0..1), riverWidth (m), rvH and rvF (size curves), riverZone (km),
    // riverBraid (0..1), riverDrop (v units below the surface).
    constructor(base, region, dep, seed, p) {
      this.base = base;
      this.region = region;
      this.dep = dep;
      this.p = p;
      this.nb = M.noise.createPerlin(seed * 67 + 1);
      this.nz = M.noise.createPerlin(seed * 67 + 2);
    }

    // The bottom of the cross-section at (x, y), with what is read there, or
    // null away from rivers: { d, qx, qy, tx, ty (along the line), W, vSurf,
    // fade, firm, plain, nearSea }.
    bottom(x, y) {
      const p = this.p, b = this.base, bp = b.p;
      const [n] = this.dep.lines(x, y);
      if (Math.abs(n) > 3) return null;
      // Gradient of n (per metre) for the Newton step across.
      const h = 300;
      const nx = (this.dep.lines(x + h, y)[0] - this.dep.lines(x - h, y)[0]) / (2 * h);
      const ny = (this.dep.lines(x, y + h)[0] - this.dep.lines(x, y - h)[0]) / (2 * h);
      const g2 = nx * nx + ny * ny;
      if (g2 < 1e-16) return null;
      const g = Math.sqrt(g2), d = Math.abs(n) / g;
      // The farthest a point can be from the line and still be touched: half
      // the widest river (with the corridor near the sea) and the zone.
      const maxZone = 0.5 * p.riverWidth * (1 + 1.2 * p.riverBraid) + p.riverZone * 1000 * 1.5 + (p.riverMin || 0);
      if (d > maxZone) return null;
      // The bottom of this cross-section.
      const qx = x - (n * nx) / g2, qy = y - (n * ny) / g2;
      const [, vq, , largeQ] = b.valueParts(qx, qy);
      if (vq < bp.tSea) return null;
      // Lowland at the bottom (from the smooth large part).
      const low = 1 - S(bp.tSea, bp.tHigh, largeQ);
      const r = this.region.at(qx, qy, vq), w = r.w, firm = r.firm;
      // How fast the river fades: sharp in firm fjellsk and in loose plains
      // and plateaus, soft in hills and in loose lowland and highland.
      const sharp = firm * w[3] + (1 - firm) * (w[0] + w[2]);
      const soft = w[1] + (1 - firm) * (w[1] + w[3]);
      const tw = 0.04 + 0.3 * Math.max(0, Math.min(1, 0.5 + 0.5 * (soft - sharp)));
      // The river follows the depression itself: it exists only where the
      // band is deep at the bottom point. The band is shallow where its line
      // turns across the slope (where the stretched noise blends between two
      // levels, its zero line can run obliquely from one depression to the
      // next), so the river does not cross between depressions there.
      const bandQ = this.dep.band(qx, qy, firm, low, r.pos);
      let fade = S(p.riverAlign - tw, p.riverAlign + tw, bandQ);
      fade *= 1 - S(bp.tDivide + 0.1, bp.tDivide + 0.5, vq); // ends inside the divide field
      if (fade <= 0.02) return null;
      // Volume (the cross-section) is a direct function of height and
      // firmness: more water lower down and in loose ground. Depth follows
      // firmness: firm ground cuts a deep channel, loose ground a shallow
      // one. Width is volume over depth, so a shallower river is wider: up
      // to riverWidth at the sea in loose ground.
      // Two curves you set (no threshold): size by height on screen, and size
      // by firmness. Volume is their product.
      const hq = b.height(vq);
      // Height runs from the sea to the divide (as a share of the divide's
      // height), so rivers can be shaped all the way up.
      const hDiv = Math.max(1, b.height(bp.tDivide));
      const volume = curve(RiverLine.CURVE_H, p.rvH, hq / hDiv) * curve(RiverLine.CURVE_F, p.rvF, firm);
      const depth = 1 + (p.riverDeep - 1) * firm; // 1 (loose) .. riverDeep (firm)
      // Never narrower than riverMin where the river is clear, so it stays
      // visible right up to the divide.
      const W = Math.max((p.riverWidth * volume * fade) / depth, (p.riverMin || 0) * S(0.1, 0.35, fade));
      // The surface: the large part of the base at q, kept a little below the
      // land at q, then lowered toward the sea (riverRise keeps that share of
      // the height above it): rivers lie low, near the coast almost at sea
      // level.
      const vSurf = bp.tSea + 0.005 + Math.max(0, Math.min(largeQ, vq) - p.riverDrop - bp.tSea) * p.riverRise;
      const nearSea = p.riverBraid * (1 - S(bp.tSea, bp.tSea + 0.35, vq));
      return { d, qx, qy, tx: -ny / g, ty: nx / g, W, vSurf, fade, firm, plain: w[0], nearSea };
    }

    // A bottom point stepped exactly onto the line: one more Newton step from
    // (qx, qy), and accepted only if it then lies on the line (within tol).
    // Returns [x, y, tx, ty] or null.
    onLine(qx, qy, tol) {
      const h = 150, L = (x, y) => this.dep.lines(x, y)[0];
      for (let it = 0; it < 2; it++) {
        const n = L(qx, qy), nx = (L(qx + h, qy) - L(qx - h, qy)) / (2 * h), ny = (L(qx, qy + h) - L(qx, qy - h)) / (2 * h);
        const g2 = nx * nx + ny * ny;
        if (g2 < 1e-16) return null;
        const g = Math.sqrt(g2);
        if (Math.abs(n) / g < tol) return [qx, qy, -ny / g, nx / g];
        qx -= (n * nx) / g2;
        qy -= (n * ny) / g2;
      }
      return null;
    }

    // The widest the river can be at a point of height h (sim) and firmness
    // firm: a cheap bound, so small rivers can be skipped in large views.
    maxWidth(h, firm) {
      const p = this.p, hDiv = Math.max(1, this.base.height(this.base.p.tDivide));
      const volume = curve(RiverLine.CURVE_H, p.rvH, h / hDiv) * curve(RiverLine.CURVE_F, p.rvF, firm);
      return Math.max((p.riverWidth * volume) / (1 + (p.riverDeep - 1) * firm), p.riverMin || 0) * (1 + 1.2 * p.riverBraid);
    }

    // The river at a point with value v. Returns { v, water } — v shaped by
    // the river, water true inside a channel. mask, when given ({ water,
    // vSurf } from the per-section step), decides the water instead.
    at(x, y, v, mask) {
      const p = this.p, b = this.base;
      const bt = this.bottom(x, y);
      if (mask && mask.water) return { v: Math.min(v, mask.vSurf), water: true, sea: mask.sea };
      if (!bt) return { v, water: false };
      const { d, qx, qy, W, vSurf, fade, firm, nearSea } = bt;
      // Near the water: a wider corridor split into channels.
      let water = false;
      const half = W / 2;
      if (nearSea > 0.05) {
        const corridor = half * (1 + 1.2 * nearSea);
        if (d < corridor) {
          const m = b.stretched(this.nb, x, y, Math.max(2000, W * 4), 2, 4, 41);
          water = d < half * (1 - 0.7 * nearSea) || Math.abs(m) < 0.25 + 0.3 * nearSea;
        }
      } else water = d < half;
      if (mask) water = false; // the section step has said no
      if (water) return { v: Math.min(v, vSurf), water: true };
      // The zone around: the land slopes down toward the water. Its size
      // follows firmness (loose is wider) and a slow noise.
      const zn = this.nz(qx / 40000, qy / 40000);
      const Z = p.riverZone * 1000 * (0.6 + 0.6 * (1 - firm)) * (0.75 + 0.5 * zn) * fade;
      const edge = half * (1 + 1.2 * nearSea);
      if (d >= edge + Z) return { v, water: false };
      const t = (d - edge) / Math.max(1, Z);
      const bank = vSurf + (v - vSurf) * t; // a straight bank up to the land
      const k = 1 - S(0, 1, t);
      return { v: v + k * (Math.min(v, bank) - v), water: false };
    }
  }

  // Piecewise linear through the points (xs, ys), flat beyond the ends.
  function curve(xs, ys, x) {
    if (x <= xs[0]) return ys[0];
    for (let k = 1; k < xs.length; k++) if (x <= xs[k]) return ys[k - 1] + ((ys[k] - ys[k - 1]) * (x - xs[k - 1])) / (xs[k] - xs[k - 1]);
    return ys[ys.length - 1];
  }
  // Where the size curves have their points: height on screen (m), firmness.
  // The points lie closer where river bottoms are common: low and loose.
  RiverLine.CURVE_H = [0, 0.05, 0.12, 0.25, 0.5, 1]; // share of the divide's height
  RiverLine.CURVE_F = [0, 0.05, 0.1, 0.2, 0.4, 1];
  RiverLine.curve = curve;
  M.RiverLine = RiverLine;
})(window.Markr = window.Markr || {});
