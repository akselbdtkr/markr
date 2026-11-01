// Grunnforskyvning: the base displacement, 100–500 km. It shifts the land
// against sea level over large areas.
//
// Three noise layers are mixed into one value v: continents (largest),
// basins and the base layer. v is read with thresholds:
// sea | lowland | highland | divide. Straits (ridged noise, two scales) pull
// lowland near the coast below the sea threshold, so seas join up through
// sounds.
(function (M) {
  'use strict';

  const { createPerlin, fbm, ridged } = M.noise;
  const STD = { 2: 0.197, 3: 0.173 };
  const S = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const CLASSES = ['hav', 'lavland', 'høyland', 'vanndeling'];

  // The noise layers, largest first. size is a factor on the base scale.
  const LAYERS = [
    { id: 'cont', name: 'Kontinenter', type: 'fbm', size: 10, oct: 2 },
    { id: 'basin', name: 'Havbasseng', type: 'fbm', size: 4.2, oct: 3 },
    { id: 'base', name: 'Grunnlag', type: 'fbm', size: 1, oct: 3 },
    { id: 's1', name: 'Store sund', type: 'ridged', size: 0.6 },
    { id: 's2', name: 'Små sund', type: 'ridged', size: 0.15 },
    { id: 'warp', name: 'Vridning', type: 'warp', size: 1 },
  ];

  class BaseLayer {
    // p: scale (km), weights per layer (p.cont, p.basin, p.base, p.s1, p.s2,
    // p.warp), widths w1/w2, thresholds tSea/tHigh/tDivide, heights.
    constructor(seed, p) {
      this.p = p;
      const P = (k) => createPerlin(seed * 53 + k);
      this.nb = P(1);
      this.wx = P(2);
      this.wy = P(3);
      this.ns1 = P(4);
      this.ns2 = P(5);
      this.nm = P(6);
      this.nc = P(7);
      this.norm = Math.hypot(p.cont, p.basin, p.base) || 1;
    }

    value(x, y) {
      const p = this.p, L = p.scale * 1000, W = p.warp * L;
      const qx = x + (W * fbm(this.wx, x / L, y / L, 2)) / STD[2];
      const qy = y + (W * fbm(this.wy, x / L, y / L, 2)) / STD[2];
      const LC = 10 * L, LB = 4.2 * L;
      let v =
        (p.cont * fbm(this.nc, qx / LC, qy / LC, 2) / STD[2] +
          p.basin * fbm(this.nm, qx / LB, qy / LB, 3) / STD[3] +
          p.base * fbm(this.nb, qx / L, qy / L, 3) / STD[3]) / this.norm;
      // Straits: only in lowland close to the sea, never through highland.
      // Gate: full near the coast, gone halfway into the lowland.
      const near = 1 - S(p.tSea, p.tSea + 0.5 * (p.tHigh - p.tSea), v);
      if (near > 0 && v > p.tSea - 0.6) {
        let s = 0;
        if (p.s1 > 0) s = Math.max(s, p.s1 * S(1 - p.w1, 1 - p.w1 * 0.3, ridged(this.ns1, qx / (0.6 * L), qy / (0.6 * L), 1)));
        if (p.s2 > 0) s = Math.max(s, p.s2 * S(1 - p.w2, 1 - p.w2 * 0.3, ridged(this.ns2, qx / (0.15 * L), qy / (0.15 * L), 1)));
        // A strait is clear sea: full strength pulls v well below the threshold.
        const t = Math.min(1, s) * near;
        v = v * (1 - t) + (p.tSea - 0.6) * t;
      }
      return v;
    }

    // Height in metres from v: the profile.
    height(v) {
      const p = this.p;
      if (v < p.tSea) {
        const d = p.tSea - v;
        return -p.shelf * S(0, 0.35, d) - (p.deep - p.shelf) * S(0.5, 2.6, d);
      }
      if (v < p.tHigh) return (p.lowTop * (v - p.tSea)) / (p.tHigh - p.tSea);
      if (v < p.tDivide) return p.lowTop + ((p.highTop - p.lowTop) * (v - p.tHigh)) / (p.tDivide - p.tHigh);
      // Divide: keeps the highland slope at the join, levels off toward 5000 m.
      const k = (p.highTop - p.lowTop) / Math.max(0.05, p.tDivide - p.tHigh), room = 5000 - p.highTop;
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
  BaseLayer.LAYERS = LAYERS;
  M.BaseLayer = BaseLayer;
})(window.Markr = window.Markr || {});
