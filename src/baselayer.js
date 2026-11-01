// Grunnforskyvning: the base displacement, 100–500 km. It shifts the land
// against sea level over large areas. A warped noise value v is read with
// thresholds: sea | lowland | highland | divide. Straits (ridged noise, two
// scales) pull lowland near the coast below the sea threshold, so seas join
// up through sounds and leave islands and peninsulas.
(function (M) {
  'use strict';

  const { createPerlin, fbm, ridged } = M.noise;
  const FBM2_STD = 0.197, FBM_STD3 = 0.173;
  const S = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const CLASSES = ['hav', 'lavland', 'høyland', 'vanndeling'];

  class BaseLayer {
    // p: scale (km), offset, warp, tSea, tHigh, tDivide, lowTop, highTop,
    // deep, shelf, s1/w1 and s2/w2 (strait strength and width, large/small).
    constructor(seed, p) {
      this.p = p;
      this.n = createPerlin(seed * 53 + 1);
      this.wx = createPerlin(seed * 53 + 2);
      this.wy = createPerlin(seed * 53 + 3);
      this.s1 = createPerlin(seed * 53 + 4);
      this.s2 = createPerlin(seed * 53 + 5);
      this.m = createPerlin(seed * 53 + 6);
    }

    // The raw value v at (x, y) in metres, straits included.
    value(x, y) {
      const p = this.p, L = p.scale * 1000;
      const W = p.warp * L;
      const qx = x + W * fbm(this.wx, x / L, y / L, 2) / FBM2_STD;
      const qy = y + W * fbm(this.wy, x / L, y / L, 2) / FBM2_STD;
      // Basins: a much larger layer decides where the big seas lie, so the
      // sea joins up into oceans instead of scattered pools; the base value
      // adds the coasts and the highlands.
      const LM = p.basin * L;
      const big = fbm(this.m, qx / LM, qy / LM, 3) / FBM_STD3;
      const mid = fbm(this.n, qx / L, qy / L, 3) / FBM_STD3;
      let v = (p.basinW * big + (1 - p.basinW) * mid) / Math.hypot(p.basinW, 1 - p.basinW) + p.offset;
      // Straits: only in lowland close to the sea, never through highland.
      const near = 1 - S(p.tSea + 0.15, p.tHigh, v);
      if (near > 0 && v > p.tSea - 0.4) {
        let s = 0;
        if (p.s1 > 0) s = Math.max(s, p.s1 * S(1 - p.w1, 1 - p.w1 * 0.3, ridged(this.s1, qx / (0.6 * L), qy / (0.6 * L), 1)));
        if (p.s2 > 0) s = Math.max(s, p.s2 * S(1 - p.w2, 1 - p.w2 * 0.3, ridged(this.s2, qx / (0.15 * L), qy / (0.15 * L), 1)));
        // Full strength pulls v to a little below the sea threshold.
        v -= Math.min(1, s) * near * Math.max(0, v - (p.tSea - 0.25));
      }
      return v;
    }

    // Height in metres from v, piecewise with smooth joins.
    height(v) {
      const p = this.p;
      if (v < p.tSea) {
        const d = p.tSea - v;
        return -p.shelf * S(0, 0.35, d) - (p.deep - p.shelf) * S(0.5, 2.6, d);
      }
      if (v < p.tHigh) {
        const t = (v - p.tSea) / (p.tHigh - p.tSea);
        return p.lowTop * t;
      }
      if (v < p.tDivide) {
        const t = (v - p.tHigh) / (p.tDivide - p.tHigh);
        return p.lowTop + (p.highTop - p.lowTop) * t;
      }
      // Divide: rises toward the 5000 m ceiling.
      const k = (p.highTop - p.lowTop) / Math.max(0.05, p.tDivide - p.tHigh); // keep the slope at the join
      const room = 5000 - p.highTop;
      return p.highTop + room * (1 - Math.exp((-(v - p.tDivide) * k) / room));
    }

    cls(v) {
      const p = this.p;
      return v < p.tSea ? 0 : v < p.tHigh ? 1 : v < p.tDivide ? 2 : 3;
    }

    at(x, y) {
      const v = this.value(x, y);
      return { v, h: this.height(v), cls: this.cls(v) };
    }
  }

  BaseLayer.CLASSES = CLASSES;
  M.BaseLayer = BaseLayer;
})(window.Markr = window.Markr || {});
