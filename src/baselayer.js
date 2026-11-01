// Grunnlagene: the base displacement, 100–500 km, and the middle layer.
//
// Base: three noise layers mixed into one value v by weight: continents,
// basins and the base layer itself. Large straits (ridged noise) turn coastal
// lowland into open sea, so seas join up. v is read with thresholds:
// sea | lowland | highland | divide.
//
// Middle layer (mellomlaget): inherits from the base. It is stretched along
// the slope of the base value, so its shapes run downhill, and it shifts v on
// land only, growing from the coast inland: it lifts and sinks the highland
// and the divide, so some mountain areas are high and others low, while the
// coast stays where the base put it.
(function (M) {
  'use strict';

  const { createPerlin, fbm, ridged } = M.noise;
  const STD = { 2: 0.197, 3: 0.173 };
  const S = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const frac = (v) => v - Math.floor(v);
  const CLASSES = ['hav', 'lavland', 'høyland', 'vanndeling'];

  // The base noise layers, largest first: size in km, weight.
  const LAYERS = [
    { id: 'cont', name: 'Kontinenter', type: 'fbm' },
    { id: 'basin', name: 'Havbasseng', type: 'fbm' },
    { id: 'base', name: 'Grunnlag', type: 'fbm' },
    { id: 's1', name: 'Sund', type: 'ridged' },
  ];

  class BaseLayer {
    // p: per layer <id>Size (km) and <id>W (weight); s1Width; thresholds
    // tSea/tHigh/tDivide; heights lowTop/highTop/shelf/deep; middle layer
    // midSize (km), midW, midStretch.
    constructor(seed, p) {
      this.p = p;
      const P = (k) => createPerlin(seed * 53 + k);
      this.nb = P(1);
      this.ns1 = P(4);
      this.nm = P(6);
      this.nc = P(7);
      this.nmid = P(8);
      this.norm = Math.hypot(p.contW, p.basinW, p.baseW) || 1;
      this.frames = new Map(); // middle-layer lattice corner -> frame
    }

    // The smooth mix of the three fbm layers, without straits.
    mix(x, y) {
      const p = this.p, LC = p.contSize * 1000, LB = p.basinSize * 1000, L = p.baseSize * 1000;
      return (
        (p.contW * fbm(this.nc, x / LC, y / LC, 2)) / STD[2] +
        (p.basinW * fbm(this.nm, x / LB, y / LB, 3)) / STD[3] +
        (p.baseW * fbm(this.nb, x / L, y / L, 3)) / STD[3]
      ) / this.norm;
    }

    // The base value: the mix with straits.
    baseValue(x, y) {
      const p = this.p;
      let v = this.mix(x, y);
      // Straits: only in lowland close to the sea, never through highland.
      const near = 1 - S(p.tSea, p.tSea + 0.5 * (p.tHigh - p.tSea), v);
      if (p.s1W > 0 && near > 0 && v > p.tSea - 0.6) {
        const LS = p.s1Size * 1000, w = p.s1Width;
        const s = p.s1W * S(1 - w, 1 - w * 0.3, ridged(this.ns1, x / LS, y / LS, 1));
        const t = Math.min(1, s) * near;
        v = v * (1 - t) + (p.tSea - 0.6) * t;
      }
      return v;
    }

    // --- middle layer --------------------------------------------------------
    // Stretched noise needs a direction, and a direction that turns from place
    // to place would twist a single noise. So each corner of a lattice (2 ×
    // the layer size) gets its own frame from the slope of the base there, the
    // noise is read in each of the four nearest frames, and they are blended.
    frame(i, j, G) {
      const k = i + ',' + j;
      let f = this.frames.get(k);
      if (f) return f;
      const x = i * G, y = j * G;
      // The slope of the base over its own size: a smooth direction, so
      // neighbouring frames agree and the blend shows no weave.
      const h = this.p.baseSize * 1000;
      const gx = (this.mix(x + h, y) - this.mix(x - h, y)) / (2 * h);
      const gy = (this.mix(x, y + h) - this.mix(x, y - h)) / (2 * h);
      const g = Math.hypot(gx, gy);
      // Stretch only where the base clearly slopes.
      const e = 1 + (this.p.midStretch - 1) * S(0.15, 0.6, g * this.p.baseSize * 1000);
      const ax = g > 0 ? gx / g : 1, ay = g > 0 ? gy / g : 0;
      f = { x, y, ax, ay, e, ox: frac(Math.sin(i * 127.1 + j * 311.7) * 43758.5) * 1000, oy: frac(Math.sin(i * 269.5 + j * 183.3) * 43758.5) * 1000 };
      this.frames.set(k, f);
      if (this.frames.size > 200000) this.frames.clear();
      return f;
    }

    // The middle-layer value at (x, y), about normal (mean 0, sd 1).
    mid(x, y) {
      const p = this.p, Lm = p.midSize * 1000, G = 2 * Lm;
      const u = x / G, w = y / G, i = Math.floor(u), j = Math.floor(w);
      const fu = u - i, fv = w - j, su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
      let sum = 0, sw2 = 0;
      for (const [di, dj, wt] of [[0, 0, (1 - su) * (1 - sv)], [1, 0, su * (1 - sv)], [0, 1, (1 - su) * sv], [1, 1, su * sv]]) {
        if (wt <= 0) continue;
        const f = this.frame(i + di, j + dj, G), dx = x - f.x, dy = y - f.y;
        const along = (dx * f.ax + dy * f.ay) / (Lm * f.e), across = (-dx * f.ay + dy * f.ax) / Lm;
        sum += (wt * fbm(this.nmid, along + f.ox, across + f.oy, 2)) / STD[2];
        sw2 += wt * wt;
      }
      return sum / Math.sqrt(sw2);
    }

    // The final value: base, then the middle layer on land.
    value(x, y) {
      const p = this.p;
      const v = this.baseValue(x, y);
      if (!(p.midW > 0) || v <= p.tSea) return v;
      return v + p.midW * this.mid(x, y) * S(p.tSea, p.tHigh, v);
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
