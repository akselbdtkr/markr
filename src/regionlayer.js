// Områdelagene: firmness, landscape type and moisture, 50–100 km. They inherit
// from the base (its height and its slope) and are stretched along the slope
// like the middle layer, so regions run longer in the direction the land falls.
//
// - Firmness (fasthet), 0..1: inherited from the base, where lowland is looser
//   than highland, plus its own noise. An S-curve keeps it between 0 and 1
//   with a gradual change.
// - Landscape type: slette, åser, platå, fjellsk lie on one chain ordered by
//   firmness. The type noise picks where on the chain a region lies; firmer
//   ground and higher base move it up the chain: in every neighbouring pair,
//   firmer gives the later type (plains → hills → plateau → fjellsk). No set
//   thresholds: the four weights fade into each other.
// - Moisture (fuktighet): from type and firmness. Loose plains are wet, firm
//   mountains dry.
(function (M) {
  'use strict';

  const S = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const TYPES = [
    { id: 'slette', name: 'slette', colour: [205, 202, 142] },
    { id: 'aaser', name: 'åser', colour: [138, 172, 104] },
    { id: 'plataa', name: 'platå', colour: [190, 160, 112] },
    { id: 'fjellsk', name: 'fjellsk', colour: [146, 132, 150] },
  ];

  class RegionLayer {
    // base: a BaseLayer. p: firmSize (km), firmW, firmInherit, typeSize (km),
    // typeW, typeFirm, typeHeight, regStretch.
    constructor(base, seed, p) {
      this.base = base;
      this.p = p;
      this.nf = M.noise.createPerlin(seed * 59 + 1);
      this.nt = M.noise.createPerlin(seed * 59 + 2);
    }

    // Everything at a land point with base value v.
    at(x, y, v) {
      const p = this.p, b = this.base, bp = b.p;
      // Height in the base, 0 at the coast and 1 at the divide.
      const hrel = Math.max(0, Math.min(1.2, (v - bp.tSea) / (bp.tDivide - bp.tSea)));
      const nF = p.firmW > 0 ? b.stretched(this.nf, x, y, p.firmSize * 1000, 2, p.regStretch, 21) : 0;
      const firm = S(-2, 2, p.firmInherit * (2 * hrel - 1) * 1.5 + p.firmW * nF);
      const nT = p.typeW > 0 ? b.stretched(this.nt, x, y, p.typeSize * 1000, 2, p.regStretch, 22) : 0;
      // Place on the chain 0..3: type noise, firmness and height.
      const z = 0.8 * p.typeW * nT + p.typeFirm * (2 * firm - 1) * 1.5 + p.typeHeight * (2 * Math.min(1, hrel) - 1);
      const pos = 3 * S(-2.4, 2.4, z);
      // Soft weights: each type peaks at its place on the chain.
      const w = [0, 0, 0, 0];
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const t = Math.max(0, 1 - Math.abs(pos - k));
        w[k] = t * t * (3 - 2 * t);
        sum += w[k];
      }
      for (let k = 0; k < 4; k++) w[k] /= sum || 1;
      const moist = Math.max(0, Math.min(1, 0.15 + 0.55 * (1 - firm) + 0.25 * (1 - pos / 3)));
      return { firm, pos, w, moist };
    }

    // The blended colour of the types at weights w.
    static colour(w) {
      const c = [0, 0, 0];
      for (let k = 0; k < 4; k++) for (let i = 0; i < 3; i++) c[i] += w[k] * TYPES[k].colour[i];
      return c;
    }
  }

  RegionLayer.TYPES = TYPES;
  M.RegionLayer = RegionLayer;
})(window.Markr = window.Markr || {});
