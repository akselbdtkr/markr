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
  const STD = { 1: 0.22, 2: 0.197, 3: 0.173 };
  const S = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const frac = (v) => v - Math.floor(v);
  // A change d added to something with room m above a floor: positive d
  // passes as is; negative d is bent softly so it never takes more than m.
  const keepAbove = (d, m) => (d >= 0 ? d : m <= 0 ? 0 : -m * (1 - Math.exp(d / m)));
  const CLASSES = ['hav', 'lavland', 'høyland', 'vanndeling'];

  // A coarse lattice for slow, smooth layers: fn(x, y) -> array of numbers is
  // computed once per node (spacing G metres, kept across redraws) and blended
  // smoothly between nodes. Layers that vary over tens of km lose nothing,
  // and a redraw reads few nodes instead of every pixel.
  // Catmull-Rom weights for t in [0, 1), into w.
  const cr = (t, w) => {
    w[0] = (((-t + 2) * t - 1) * t) / 2;
    w[1] = ((3 * t - 5) * t * t + 2) / 2;
    w[2] = (((-3 * t + 4) * t + 1) * t) / 2;
    w[3] = ((t - 1) * t * t) / 2;
  };
  class Lattice {
    constructor(G, fn) {
      this.G = G;
      this.fn = fn;
      this.tiles = new Map(); // 64 × 64 nodes each, in typed arrays
      this.nv = 0; // values per node
      this.lastKey = NaN;
      this.lastTile = null;
      this.wa = [0, 0, 0, 0];
      this.wb = [0, 0, 0, 0];
      this.out = [];
    }
    tile(ti, tj) {
      const key = ti * 100003 + tj;
      if (key === this.lastKey) return this.lastTile;
      let t = this.tiles.get(key);
      if (!t) {
        if (this.tiles.size > 400) this.tiles.clear();
        t = { v: new Float64Array(4096 * this.nv), f: new Uint8Array(4096) };
        this.tiles.set(key, t);
      }
      this.lastKey = key;
      this.lastTile = t;
      return t;
    }
    at(x, y) {
      // Scattered samples far apart (the profiles' bars) gain nothing from
      // the lattice: each would build many nodes. They read directly.
      if (Lattice.direct) return this.fn(x, y);
      if (!this.nv) {
        this.nv = this.fn(0, 0).length;
        this.out = new Array(this.nv).fill(0);
      }
      // Catmull-Rom over 4 × 4 nodes: smooth in value and slope, so shading
      // and narrow bands show no lattice.
      const G = this.G, nv = this.nv, u = x / G, w = y / G, i = Math.floor(u), j = Math.floor(w);
      const wa = this.wa, wb = this.wb, out = this.out;
      cr(u - i, wa);
      cr(w - j, wb);
      for (let k = 0; k < nv; k++) out[k] = 0;
      for (let dj = 0; dj < 4; dj++) {
        const nj = j + dj - 1, tj = nj >> 6, lj = nj & 63;
        for (let di = 0; di < 4; di++) {
          const ni = i + di - 1, t = this.tile(ni >> 6, tj), idx = lj * 64 + (ni & 63), o = idx * nv;
          if (!t.f[idx]) {
            const v = this.fn(ni * G, nj * G);
            for (let k = 0; k < nv; k++) t.v[o + k] = v[k];
            t.f[idx] = 1;
          }
          const wt = wa[di] * wb[dj];
          for (let k = 0; k < nv; k++) out[k] += wt * t.v[o + k];
        }
      }
      // The result array is reused: read it at once (callers destructure).
      return out;
    }
  }
  // The map never needs finer detail than the points it draws (at most the
  // 16 m cells). So a lattice's spacing follows the drawing: a cell
  // (Lattice.section) times a power of two: about as coarse as the drawn points
  // (Lattice.pixel, set by the page), but never coarser than a sixteenth of
  // the layer (maxG).
  // One lattice is kept per spacing, so zooming back reuses earlier work.
  Lattice.section = 128; // the finest spacing: a cell, set by the page in simulation units
  Lattice.pixel = 4000;
  // fine: follow the drawn points (for layers with narrow features); else
  // always the coarsest allowed spacing (smooth layers).
  Lattice.pick = (store, maxG, fn, fine) => {
    let G = Lattice.section;
    while ((!fine || G < Lattice.pixel) && G * 2 <= maxG) G *= 2;
    // Far out, no finer than the drawn points either: smooth layers would
    // otherwise build far more nodes than there are pixels.
    while (G < 2 * Lattice.pixel) G *= 2;
    let l = store.get(G);
    if (!l) {
      l = new Lattice(G, fn);
      store.set(G, l);
    }
    return l;
  };
  M.Lattice = Lattice;

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
      this._inland = inland; // read by valueParts
      this._large = large;
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
    // The slope frame at a point: the smooth field, its slope and curvature.
    // Computed once per point and shared by every stretched layer there (the
    // last one is kept, since the layers ask for the same point in turn).
    slopeFrame(x, y) {
      if (this._fr && this._fx === x && this._fy === y) return this._fr;
      const h = 4000, F = (a, b) => this.smoothMix(a, b);
      const B = F(x, y), Bx1 = F(x + h, y), Bx0 = F(x - h, y), By1 = F(x, y + h), By0 = F(x, y - h);
      const gx = (Bx1 - Bx0) / (2 * h), gy = (By1 - By0) / (2 * h), g = Math.hypot(gx, gy);
      // Curvature here. A step longer than about half its radius would fold
      // neighbouring points onto each other (a crease). Both curvatures count:
      // of the level line (points along it pressed together) and of the slope
      // line (the step turning sideways).
      const bxx = (Bx1 - 2 * B + Bx0) / (h * h), byy = (By1 - 2 * B + By0) / (h * h);
      const bxy = (F(x + h, y + h) - F(x + h, y - h) - F(x - h, y + h) + F(x - h, y - h)) / (4 * h * h);
      const kLevel = Math.abs(bxx * gy * gy - 2 * bxy * gx * gy + byy * gx * gx);
      const kSlope = Math.abs((bxx - byy) * gx * gy + bxy * (gy * gy - gx * gx));
      const fr = {
        x, y, B, g, ax: g > 0 ? gx / g : 1, ay: g > 0 ? gy / g : 0,
        kappa: g > 0 ? (kLevel + kSlope) / (g * g * g) : 0,
        // Near tops and bottoms of the field the slope turns fast: fade out.
        fade: S(0.15, 0.5, g / this.typicalSlope()),
      };
      this._fr = fr;
      this._fx = x;
      this._fy = y;
      return fr;
    }

    // Read noise n stretched along the slope (see above), in frame fr.
    readStretched(fr, n, L, oct, dB, maxLen, key) {
      const { x, y, B, g, ax, ay, kappa, fade } = fr;
      const read = (qx, qy, k) => {
        const ox = frac(Math.sin(k * 127.1 + key * 311.7) * 43758.5) * 1000, oy = frac(Math.sin(k * 269.5 + key * 183.3) * 43758.5) * 1000;
        return fbm(n, qx / L + ox, qy / L + oy, oct) / STD[oct];
      };
      if (!(dB > 0) || g < 1e-12) return read(x, y, 0);
      const u = B / dB, k = Math.floor(u), f = u - k;
      // Distance along the slope down to level k and up to level k + 1, as a
      // soft minimum of the step, maxLen and half the curvature radius: it
      // leaves the step untouched well below the limits (so points along the
      // slope still land on the same spot) and bends only near them.
      const lim = kappa > 0 ? Math.min(maxLen, 0.5 / kappa) : maxLen;
      const cap = (d) => (d <= 0 ? 0 : 1 / Math.pow(Math.pow(d, -4) + Math.pow(lim, -4), 0.25));
      const d0 = fade * cap((f * dB) / g), d1 = fade * cap(((1 - f) * dB) / g);
      const n0 = read(x - ax * d0, y - ay * d0, k), n1 = read(x + ax * d1, y + ay * d1, k + 1);
      const w1 = f * f * (3 - 2 * f), w0 = 1 - w1;
      return (w0 * n0 + w1 * n1) / Math.hypot(w0, w1);
    }

    // n: noise, L: size (m), oct: octaves, stretch: length / size. The step
    // is valid only while the slope keeps its direction: at most a quarter of
    // the basin size, and shorter where the field curves.
    stretched(n, x, y, L, oct, stretch, key) {
      const len = Math.min(stretch * L, 0.25 * this.p.basinSize * 1000);
      return this.readStretched(this.slopeFrame(x, y), n, L, oct, stretch > 1 ? len * this.typicalSlope() : 0, len, key);
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
    // The middle layer, on a lattice (see Lattice.pick).
    mid(x, y) {
      if (!this.midLats) {
        this.midLats = new Map();
        this.midFn = (a, b) => [this.stretched(this.nmid, a, b, this.p.midSize * 1000, 2, this.p.midStretch, 8)];
      }
      return Lattice.pick(this.midLats, (this.p.midSize * 1000) / 16, this.midFn).at(x, y)[0];
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
    // [base value, final value (with the middle layer), inland weight,
    // large part (continents and the first basin octave)].
    valueParts(x, y) {
      const p = this.p;
      const vb = this.baseValue(x, y), inland = this._inland, large = this._large;
      if (!(p.midW > 0) || vb <= p.tSea) return [vb, vb, inland, large];
      return [vb, vb + keepAbove(p.midW * this.mid(x, y) * S(p.tSea, p.tHigh, vb), vb - p.tSea - 0.05), inland, large];
    }

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
      // Divide: rises divSteep times as steeply as the highland at the join,
      // so the divide fields stand higher, levelling off toward 5000 m.
      const k = ((p.divSteep || 1) * (p.highTop - p.lowTop)) / Math.max(0.05, p.tDivide - p.tHigh), room = 5000 - p.highTop;
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
  BaseLayer.keepAbove = keepAbove;
  BaseLayer.LAYERS = LAYERS;
  M.BaseLayer = BaseLayer;
})(window.Markr = window.Markr || {});
