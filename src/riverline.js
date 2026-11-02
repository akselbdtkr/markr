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
// - Where: only where the band runs with the slope of the base (its align
//   value at q), on land and below the divide. The river fades with an
//   S-curve as the band turns away: fast in firm rugged ground (fjellsk) and
//   in loose plains and plateaus, softer in hills and loose lowland and
//   highland.
// - Width: from firmness (loose is wider) and height above the sea (higher is
//   narrower, lower is wider), times the fade.
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
      if (Math.abs(n) > 1.2) return { v, water: false };
      // Gradient of n (per metre) for the Newton step across.
      const h = 300;
      const nx = (this.dep.lines(x + h, y)[0] - this.dep.lines(x - h, y)[0]) / (2 * h);
      const ny = (this.dep.lines(x, y + h)[0] - this.dep.lines(x, y - h)[0]) / (2 * h);
      const g2 = nx * nx + ny * ny;
      if (g2 < 1e-16) return { v, water: false };
      const g = Math.sqrt(g2), d = Math.abs(n) / g;
      const maxZone = p.riverZone * 1000 * 1.6 + p.riverWidth * 2;
      if (d > maxZone) return { v, water: false };
      // The bottom of this cross-section.
      const qx = x - (n * nx) / g2, qy = y - (n * ny) / g2;
      const par = this.dep.lines(qx, qy)[1];
      const [, vq] = b.valueParts(qx, qy);
      if (vq < bp.tSea) return { v, water: false };
      const r = this.region.at(qx, qy, vq), w = r.w, firm = r.firm;
      // How fast the river fades: sharp in firm fjellsk and in loose plains
      // and plateaus, soft in hills and in loose lowland and highland.
      const sharp = firm * w[3] + (1 - firm) * (w[0] + w[2]);
      const soft = w[1] + (1 - firm) * (w[1] + w[3]);
      const tw = 0.04 + 0.3 * Math.max(0, Math.min(1, 0.5 + 0.5 * (soft - sharp)));
      let fade = S(p.riverAlign - tw, p.riverAlign + tw, par);
      fade *= 1 - S(bp.tDivide - 0.25, bp.tDivide, vq); // none above the divide
      if (fade <= 0.02) return { v, water: false };
      // Width: loose is wider, higher is narrower.
      const hq = b.height(vq);
      let W = p.riverWidth * (0.25 + 0.75 * (1 - firm)) * (1 - 0.85 * S(0, p.riverHigh, hq)) * fade;
      // The surface: the large part of the base at q, kept a little below the
      // land at q, and never below the sea threshold.
      const large = b.mixParts(qx, qy)[0];
      const vSurf = Math.max(bp.tSea + 0.005, Math.min(large, vq) - p.riverDrop);
      // Near the water: a wider corridor split into channels.
      const nearSea = p.riverBraid * (1 - S(bp.tSea, bp.tSea + 0.35, vq));
      let water = false;
      const half = W / 2;
      if (nearSea > 0.05) {
        const corridor = half * (1 + 3 * nearSea);
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
      const edge = half * (1 + 3 * nearSea);
      if (d >= edge + Z) return { v, water: false };
      const t = (d - edge) / Math.max(1, Z);
      const bank = vSurf + (v - vSurf) * t; // a straight bank up to the land
      const k = 1 - S(0, 1, t);
      return { v: v + k * (Math.min(v, bank) - v), water: false };
    }
  }

  M.RiverLine = RiverLine;
})(window.Markr = window.Markr || {});
