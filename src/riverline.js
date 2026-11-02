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
//   firmness (more water low down and in loose ground); depth follows
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
    // p: riverAlign (0..1), riverWidth (m), riverHigh (m), riverZone (km),
    // riverBraid (0..1), riverDrop (v units below the surface).
    constructor(base, region, dep, seed, p) {
      this.base = base;
      this.region = region;
      this.dep = dep;
      this.p = p;
      this.nb = M.noise.createPerlin(seed * 67 + 1);
      this.nz = M.noise.createPerlin(seed * 67 + 2);
    }

    // The river at a point with value v. Returns { v, water } — v shaped by
    // the river, water true inside a channel.
    at(x, y, v) {
      const p = this.p, b = this.base, bp = b.p;
      const [n] = this.dep.lines(x, y);
      if (Math.abs(n) > 3) return { v, water: false };
      // Gradient of n (per metre) for the Newton step across.
      const h = 300;
      const nx = (this.dep.lines(x + h, y)[0] - this.dep.lines(x - h, y)[0]) / (2 * h);
      const ny = (this.dep.lines(x, y + h)[0] - this.dep.lines(x, y - h)[0]) / (2 * h);
      const g2 = nx * nx + ny * ny;
      if (g2 < 1e-16) return { v, water: false };
      const g = Math.sqrt(g2), d = Math.abs(n) / g;
      const maxZone = p.riverZone * 1000 * 1.6 + p.riverWidth * 2.5;
      if (d > maxZone) return { v, water: false };
      // The bottom of this cross-section.
      const qx = x - (n * nx) / g2, qy = y - (n * ny) / g2;
      const [, vq, , largeQ] = b.valueParts(qx, qy);
      if (vq < bp.tSea) return { v, water: false };
      // Lowland at the bottom (from the smooth large part): rivers there need
      // less alignment, so the lines hold together.
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
      // next), so the river no longer crosses between depressions there.
      const divideFade = 1 - S(bp.tDivide + 0.1, bp.tDivide + 0.5, vq); // ends inside the divide field
      const fadeAt = (px, py) => S(p.riverAlign - tw, p.riverAlign + tw, this.dep.band(px, py, firm, low));
      let fade = fadeAt(qx, qy);
      // Along the line: the direction is known (across the gradient of n at
      // q), so a few points ahead and behind tell whether the river goes on.
      const L = (s) => this.dep.lines(qx + s[0], qy + s[1])[0];
      const hq0 = 300;
      const n0 = L([0, 0]), nxq = (L([hq0, 0]) - L([-hq0, 0])) / (2 * hq0), nyq = (L([0, hq0]) - L([0, -hq0])) / (2 * hq0);
      const gq = Math.hypot(nxq, nyq) || g, tx = -nyq / gq, ty = nxq / gq;
      // The step must have landed on the line; from too far away it can land
      // on another line or miss, and the water would flicker point to point.
      if (Math.abs(n0) / gq > 0.15 * d + 300) return { v, water: false };
      // A point a distance along the tangent, stepped back onto the line
      // (lines bend, and a straight step would miss them).
      const along = (sDist) => {
        let ax = qx + tx * sDist, ay = qy + ty * sDist;
        const m = this.dep.lines(ax, ay)[0];
        const mx = (this.dep.lines(ax + hq0, ay)[0] - this.dep.lines(ax - hq0, ay)[0]) / (2 * hq0);
        const my = (this.dep.lines(ax, ay + hq0)[0] - this.dep.lines(ax, ay - hq0)[0]) / (2 * hq0);
        const m2 = mx * mx + my * my;
        if (m2 > 1e-16) {
          const step = m / m2;
          if (Math.abs(step) * Math.sqrt(m2) < Math.abs(sDist)) {
            ax -= step * mx;
            ay -= step * my;
          }
        }
        return fadeAt(ax, ay);
      };
      const gap = p.riverGap, len = p.riverShort;
      const ahead = Math.max(along(gap / 2), along(gap)), behind = Math.max(along(-gap / 2), along(-gap));
      // Patch: a gap with river on both sides is filled.
      fade = Math.max(fade, Math.min(ahead, behind)) * divideFade;
      if (fade <= 0.02) return { v, water: false };
      // Short: no river within the minimum length either way: a lake.
      const farA = Math.max(ahead, along(len)), farB = Math.max(behind, along(-len));
      let lake = Math.max(farA, farB) < 0.3;
      // Volume (the cross-section) is a direct function of height and
      // firmness: more water lower down and in loose ground. Depth follows
      // firmness: firm ground cuts a deep channel, loose ground a shallow
      // one. Width is volume over depth, so a shallower river is wider: up
      // to riverWidth at the sea in loose ground.
      const hq = b.height(vq);
      const volume = (0.08 + 0.92 * (1 - S(0, p.riverHigh, hq))) * Math.pow(0.1 + 0.9 * (1 - firm), 3);
      const depth = 1 + (p.riverDeep - 1) * firm; // 1 (loose) .. riverDeep (firm)
      let W = (p.riverWidth * volume * fade) / depth;
      if (lake) W = Math.max(W * 2.5, p.riverWidth * 0.15);
      // The surface: the large part of the base at q, kept a little below the
      // land at q, then lowered toward the sea (riverRise keeps that share of
      // the height above it): rivers lie low, near the coast almost at sea
      // level.
      const surf = (lg, vv) => bp.tSea + 0.005 + Math.max(0, Math.min(lg, vv) - p.riverDrop - bp.tSea) * p.riverRise;
      let vSurf = surf(largeQ, vq);
      // A tight loop (its radius, from the curvature of the line at q, under
      // riverRing or under the width) is filled as one round lake, with no
      // island in the middle, and a flat surface read at its centre.
      const nxx = (L([hq0, 0]) - 2 * n0 + L([-hq0, 0])) / (hq0 * hq0), nyy = (L([0, hq0]) - 2 * n0 + L([0, -hq0])) / (hq0 * hq0);
      const nxy = (L([hq0, hq0]) - L([hq0, -hq0]) - L([-hq0, hq0]) + L([-hq0, -hq0])) / (4 * hq0 * hq0);
      const kappa = (nxx * nyq * nyq - 2 * nxy * nxq * nyq + nyy * nxq * nxq) / (gq * gq * gq);
      const radius = kappa !== 0 ? 1 / Math.abs(kappa) : Infinity;
      const cx = qx - nxq / gq / kappa, cy = qy - nyq / gq / kappa;
      // A ring, not just a sharp bend: the line is there on the far side of
      // the centre too.
      const isRing = radius < Math.max(p.riverRing, 0.75 * W) && Math.abs(this.dep.lines(2 * cx - qx, 2 * cy - qy)[0]) / gq < 0.35 * radius + W / 2;
      // On the inside of a bend the step is only good up to the centre.
      const inside = (x - qx) * (cx - qx) + (y - qy) * (cy - qy) > 0;
      if (!isRing && inside && d > 0.8 * radius) return { v, water: false };
      if (isRing) {
        if (Math.hypot(x - cx, y - cy) < radius + W / 2) {
          const [, vc, , lc] = b.valueParts(cx, cy);
          vSurf = surf(lc, Math.max(vc, bp.tSea));
          return { v: Math.min(v, vSurf), water: true };
        }
        lake = true;
      }
      // Near the water: a wider corridor split into channels.
      const nearSea = p.riverBraid * (1 - S(bp.tSea, bp.tSea + 0.35, vq));
      let water = false;
      const half = W / 2;
      if (nearSea > 0.05) {
        const corridor = half * (1 + 1.2 * nearSea);
        if (d < corridor) {
          const m = b.stretched(this.nb, x, y, Math.max(2000, W * 4), 2, 4, 41);
          water = d < half * (1 - 0.7 * nearSea) || Math.abs(m) < 0.25 + 0.3 * nearSea;
        }
      } else water = d < half;
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

  M.RiverLine = RiverLine;
})(window.Markr = window.Markr || {});
