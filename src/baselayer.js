// Grunnlagene: the base displacement, 100–500 km, and the middle layer.
//
// Base: three noise layers mixed into one value v by weight: continents,
// basins and the base layer itself. Large straits (ridged noise) turn coastal
// lowland into open sea, so seas join up. v is read with thresholds:
// sea | lowland | highland | divide.
//
// Middle layer (mellomlaget): inherits from the base. It is stretched along
// the slope of the base value (see `stretched`), and it shifts v on
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
  // A change d added to something with room m above a floor: positive d
  // passes as is; negative d is bent softly so it never takes more than m.
  const keepAbove = (d, m) => (d >= 0 ? d : m <= 0 ? 0 : -m * (1 - Math.exp(d / m)));
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
      // The normalisation can be given, so turning a layer off removes only
      // its share instead of rescaling the others.
      this.norm = p.norm || Math.hypot(p.contW, p.basinW, p.baseW) || 1;
      this.normCB = p.normCB || Math.hypot(p.contW, p.basinW) || 1;
    }

    // The mix of the three fbm layers, without straits, split in two parts
    // (both in units of v): [large, detail]. Large is the continents and the
    // first octave of the basins; it says what is inland. Detail is the finer
    // basin octaves and the base layer.
    mixParts(x, y) {
      const p = this.p, LC = p.contSize * 1000, LB = p.basinSize * 1000, L = p.baseSize * 1000;
      const k = p.basinW / (1.75 * STD[3]);
      const b1 = this.nm(x / LB, y / LB), b3 = fbm(this.nm, x / LB, y / LB, 3) * 1.75;
      const large = ((p.contW * fbm(this.nc, x / LC, y / LC, 2)) / STD[2] + k * b1) / this.norm;
      const detail = (k * (b3 - b1) + (p.baseW * fbm(this.nb, x / L, y / L, 3)) / STD[3]) / this.norm;
      return [large, detail];
    }
    mix(x, y) {
      const [a, b] = this.mixParts(x, y);
      return a + b;
    }

    // The smooth part of the mix (continents and basins, two octaves each):
    // the field that stretching follows. Its slope turns slowly, so a step
    // along it stays valid over hundreds of km.
    smoothMix(x, y) {
      const p = this.p, LC = p.contSize * 1000, LB = p.basinSize * 1000;
      const nrm = this.normCB;
      return ((p.contW * fbm(this.nc, x / LC, y / LC, 2)) / STD[2] + (p.basinW * fbm(this.nm, x / LB, y / LB, 2)) / STD[2]) / nrm;
    }

    // The base value: large + detail, with straits. Inland (large above the
    // inland threshold) the detail is weighted to the positive side: it adds
    // freely, but takes away at most what keeps the land above the sea
    // threshold. A neutral layer there would dig as deep as it lifts and make
    // inland seas; this one cannot make sea inside a continent.
    baseValue(x, y) {
      const p = this.p;
      const [large, detail] = this.mixParts(x, y);
      const inland = Number.isFinite(p.tInland) ? S(p.tInland - 0.2, p.tInland + 0.2, large) : 0;
      let v = large + (inland > 0 ? (1 - inland) * detail + inland * keepAbove(detail, large - p.tSea - 0.05) : detail);
      // Straits: only in lowland close to the sea, never through highland,
      // and never inland.
      const near = (1 - S(p.tSea, p.tSea + 0.5 * (p.tHigh - p.tSea), v)) * (1 - inland);
      if (p.s1W > 0 && near > 0 && v > p.tSea - 0.6) {
        const LS = p.s1Size * 1000, w = p.s1Width;
        const s = p.s1W * S(1 - w, 1 - w * 0.3, ridged(this.ns1, x / LS, y / LS, 1));
        const t = Math.min(1, s) * near;
        v = v * (1 - t) + (p.tSea - 0.6) * t;
      }
      return v;
    }

    // --- stretching ----------------------------------------------------------
    // Stretch a noise along the slope of the base, locally. The base value B
    // is cut into levels ΔB apart. From a point, one Newton step along the
    // slope lands on the level below and one on the level above; the noise is
    // read there, not at the point. Every point on the same slope line
    // between two levels reads the same spot, so the noise is smoothed out
    // along the slope: two peaks one behind the other merge into one line,
    // while across the slope (along the level lines) it varies fully. The two
    // levels are blended by where the point lies between them, and each level
    // has its own offset. Level lines bend with the base, so the streaks do
    // too. The step is capped (maxLen) where the base is nearly flat.
    //
    // n: noise function, L: noise size (m), oct: octaves, dB: level spacing,
    // maxLen: longest step (m), key: offset seed. Returns about normal.
    stretched(n, x, y, L, oct, dB, maxLen, key) {
      const h = 4000, F = (a, b) => this.smoothMix(a, b);
      const B = F(x, y), Bx1 = F(x + h, y), Bx0 = F(x - h, y), By1 = F(x, y + h), By0 = F(x, y - h);
      const gx = (Bx1 - Bx0) / (2 * h), gy = (By1 - By0) / (2 * h), g = Math.hypot(gx, gy);
      // Curvature here. A step longer than about half its radius would fold
      // neighbouring points onto each other (a crease).
      const bxx = (Bx1 - 2 * B + Bx0) / (h * h), byy = (By1 - 2 * B + By0) / (h * h);
      const bxy = (F(x + h, y + h) - F(x + h, y - h) - F(x - h, y + h) + F(x - h, y - h)) / (4 * h * h);
      // Both curvatures count: of the level line (points along it pressed
      // together) and of the slope line (the step turning sideways).
      const kLevel = Math.abs(bxx * gy * gy - 2 * bxy * gx * gy + byy * gx * gx);
      const kSlope = Math.abs((bxx - byy) * gx * gy + bxy * (gy * gy - gx * gx));
      const kappa = g > 0 ? (kLevel + kSlope) / (g * g * g) : 0;
      // Near tops and bottoms of the field the slope turns fast: fade out.
      const fade = S(0.15, 0.5, g / this.typicalSlope());
      const read = (qx, qy, k) => {
        const ox = frac(Math.sin(k * 127.1 + key * 311.7) * 43758.5) * 1000, oy = frac(Math.sin(k * 269.5 + key * 183.3) * 43758.5) * 1000;
        return fbm(n, qx / L + ox, qy / L + oy, oct) / STD[oct];
      };
      if (!(dB > 0) || g < 1e-12) return read(x, y, 0);
      const ax = gx / g, ay = gy / g, u = B / dB, k = Math.floor(u), f = u - k;
      // Distance along the slope down to level k and up to level k + 1,
      // softly capped so flat ground does not throw the point far away.
      // A soft minimum of the step, maxLen and half the curvature radius: it
      // leaves the step untouched well below the limits (so points along the
      // slope still land on the same spot) and bends only near them.
      const lim = kappa > 0 ? Math.min(maxLen, 0.5 / kappa) : maxLen;
      const cap = (d) => (d <= 0 ? 0 : 1 / Math.pow(Math.pow(d, -4) + Math.pow(lim, -4), 0.25));
      const d0 = fade * cap((f * dB) / g), d1 = fade * cap(((1 - f) * dB) / g);
      const n0 = read(x - ax * d0, y - ay * d0, k), n1 = read(x + ax * d1, y + ay * d1, k + 1);
      const w1 = f * f * (3 - 2 * f), w0 = 1 - w1;
      return (w0 * n0 + w1 * n1) / Math.hypot(w0, w1);
    }

    // Typical slope of the smooth field (per metre), measured once per layer, so the
    // stretch can be given as a length: ΔB = stretch × size × typical slope.
    typicalSlope() {
      if (this._gTyp) return this._gTyp;
      let sum = 0, n = 0;
      const h = 2000;
      for (let j = 0; j < 24; j++) {
        for (let i = 0; i < 24; i++) {
          const x = (i - 11.5) * 250000, y = (j - 11.5) * 250000, B = this.smoothMix(x, y);
          sum += Math.hypot(this.smoothMix(x + h, y) - B, this.smoothMix(x, y + h) - B) / h;
          n++;
        }
      }
      return (this._gTyp = sum / n);
    }

    // --- middle layer: noise stretched along the slope of the base ------------
    mid(x, y) {
      // A step is valid only while the slope keeps its direction: at most a
      // quarter of the basin size, and shorter where the field curves (see
      // stretched).
      const p = this.p, Lm = p.midSize * 1000, len = Math.min(p.midStretch * Lm, 0.25 * p.basinSize * 1000);
      return this.stretched(this.nmid, x, y, Lm, 2, p.midStretch > 1 ? len * this.typicalSlope() : 0, len, 8);
    }

    // One layer alone, for viewing: fbm layers about normal, straits 0..1.
    single(id, x, y) {
      const p = this.p, L = (p[id + 'Size'] || 1) * 1000;
      if (id === 'cont') return fbm(this.nc, x / L, y / L, 2) / STD[2];
      if (id === 'basin') return fbm(this.nm, x / L, y / L, 3) / STD[3];
      if (id === 'base') return fbm(this.nb, x / L, y / L, 3) / STD[3];
      if (id === 's1') return S(1 - p.s1Width, 1 - p.s1Width * 0.3, ridged(this.ns1, x / L, y / L, 1));
      if (id === 'mid') return this.mid(x, y);
      if (id === 'inland') return this.mixParts(x, y)[0];
      return 0;
    }

    // The final value: base, then the middle layer on land.
    value(x, y) {
      const p = this.p;
      const v = this.baseValue(x, y);
      if (!(p.midW > 0) || v <= p.tSea) return v;
      // The middle layer never makes sea: it takes away at most what keeps
      // the land above the sea threshold.
      return v + keepAbove(p.midW * this.mid(x, y) * S(p.tSea, p.tHigh, v), v - p.tSea - 0.05);
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
