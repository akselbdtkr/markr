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
//   firmer gives the later type (plains → hills → plateau → fjellsk). The
//   type value z is read with three thresholds of your own (slette | åser |
//   platå | fjellsk), each an S-curve; where the curves overlap a point is a
//   share of several types.
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
      // Both noises on a lattice (see Lattice.pick).
      if (!this.lats) {
        this.lats = new Map();
        this.latFn = (a, c) => [
          p.firmW > 0 ? b.stretched(this.nf, a, c, p.firmSize * 1000, 2, p.regStretch, 21) : 0,
          p.typeW > 0 ? b.stretched(this.nt, a, c, p.typeSize * 1000, 2, p.regStretch, 22) : 0,
        ];
      }
      const [nF, nT] = M.Lattice.pick(this.lats, (Math.min(p.firmSize, p.typeSize) * 1000) / 16, this.latFn).at(x, y);
      const firm = S(-2, 2, p.firmInherit * (2 * hrel - 1) * 1.5 + p.firmW * nF);
      // Place on the chain 0..3: type noise, firmness and height.
      const z = 0.8 * p.typeW * nT + p.typeFirm * (2 * firm - 1) * 1.5 + p.typeHeight * (2 * Math.min(1, hrel) - 1);
      const pos = this.posOf(z), w = this.weights(z);
      const moist = Math.max(0, Math.min(1, 0.15 + 0.55 * (1 - firm) + 0.25 * (1 - pos / 3)));
      return { firm, z, pos, w, moist };
    }

    // Place on the chain (0..3) from the type value z: one step at each of
    // the three thresholds (tT1, tT2, tT3), each soft over ± typeSoft.
    // The share of each type at z: one S-curve per threshold. Below the first
    // all is slette; each threshold passes a share on to the next type. With
    // wide curves they overlap, and a point is a mix of several types.
    weights(z) {
      const p = this.p, s = Math.max(0.01, p.typeSoft);
      const s1 = S(p.tT1 - s, p.tT1 + s, z), s2 = S(p.tT2 - s, p.tT2 + s, z), s3 = S(p.tT3 - s, p.tT3 + s, z);
      return [1 - s1, s1 * (1 - s2), s1 * s2 * (1 - s3), s1 * s2 * s3];
    }

    posOf(z) {
      const p = this.p, s = Math.max(0.01, p.typeSoft);
      return S(p.tT1 - s, p.tT1 + s, z) + S(p.tT2 - s, p.tT2 + s, z) + S(p.tT3 - s, p.tT3 + s, z);
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
