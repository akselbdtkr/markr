// Nedsenkslaget: valleys, ravines, canyons, rivers and fjords. A band where a
// noise layer passes a middle value sinks the land toward the base
// displacement (the base value without the middle layer, minus a depth), so
// inside the band the middle layer is nearly flattened away. In lowland
// (read from the smooth large part of the base) the floor is pulled hard
// toward sea level, more in plains: the sea follows the depressions far in,
// making fjords, islands and small sounds, even where the inland threshold
// would keep it out.
//
// Two ways to find the band, to compare:
// - median: the band is where a stretched fbm passes its median (0). Its
//   zero lines are long, winding and never cross or branch.
// - ridged: lines of two octaves (the second half the size, shallower), each
//   where its noise passes 0. Lines of the two octaves meet and cross, which
//   gives branches, but also loops.
//
// The band follows firmness: loose ground gives a wider band with a flat floor
// and steep sides; firm ground a narrow band with soft, V-shaped sides. Parts
// of the band that run across the slope of the base are made shallow (align),
// so the deep, continuous depressions run with the slope.
(function (M) {
  'use strict';

  const S = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  class DepressionLayer {
    // p: depMode ('median' | 'ridged'), depSize (km), depDepth (v units),
    // depWidth, depSoft (edge S-curve), depStretch, depAlign (0..1), depLow
    // and depPlain (pull toward sea level in lowland and plains).
    constructor(base, seed, p) {
      this.base = base;
      this.p = p;
      this.n1 = M.noise.createPerlin(seed * 61 + 1);
      this.n2 = M.noise.createPerlin(seed * 61 + 2);
    }

    // Stretched noise at (x + dx, y + dy), read in the frame of (x, y): close
    // enough over a few km, and it keeps the gradient cheap.
    read(fr, dx, dy, n, L, oct, key) {
      const b = this.base, p = this.p;
      const len = Math.min(p.depStretch * L, 0.25 * b.p.basinSize * 1000);
      const dB = p.depStretch > 1 ? len * b.typicalSlope() : 0;
      const f = dx || dy ? { ...fr, x: fr.x + dx, y: fr.y + dy, B: fr.B + fr.g * (dx * fr.ax + dy * fr.ay) } : fr;
      return b.readStretched(f, n, L, oct, dB, len, key);
    }

    // The band at a point (0 outside, 1 at the centre), given firmness.
    // The slow part, on a lattice (see Lattice.pick): the noise, how
    // much its lines run with the slope, and the second octave (ridged).
    // Only the band's shape is worked out per point, so narrow bands stay
    // sharp while the costly reads are shared.
    lines(x, y) {
      const p = this.p, L = p.depSize * 1000, median = p.depMode !== 'ridged', oct = median ? 3 : 1;
      if (!this.lats) {
        this.lats = new Map();
        this.latFn = (a, c) => {
          const fr = this.base.slopeFrame(a, c), h = 2000;
          const n = this.read(fr, 0, 0, this.n1, L, oct, 31);
          // Align: the band runs along the level lines of n, so it runs with
          // the slope where n hardly changes along the slope.
          const nA = this.read(fr, fr.ax * h, fr.ay * h, this.n1, L, oct, 31), nB = this.read(fr, -fr.ay * h, fr.ax * h, this.n1, L, oct, 31);
          const dA = Math.abs(nA - n), dC = Math.abs(nB - n);
          return [n, dC / (Math.hypot(dA, dC) || 1), median ? 0 : this.read(fr, 0, 0, this.n2, L / 2, 1, 32)];
        };
      }
      return M.Lattice.pick(this.lats, L / 16, this.latFn, true).at(x, y);
    }

    // The band at a point (0 outside, 1 at the centre), given firmness, how
    // much lowland it lies in (low, 0..1) and the landscape types' shares w.
    // In lowland the band is fuller and its direction counts less, so it
    // does not break into pieces. Its cross-section is a blend of four
    // valley profiles (see DepressionLayer.shapes).
    band(x, y, firm, low = 0, pos = null) {
      const p = this.p, median = p.depMode !== 'ridged';
      const [n, par, n2] = this.lines(x, y);
      // Width from firmness: loose is wider. depSoft stretches the profile
      // outward from the line: softer edges.
      const wd = p.depWidth * (1.5 - firm) * (1 + 0.5 * p.depSoft);
      const sw = DepressionLayer.shapes(pos === null ? 3 * firm : pos, 1 - low, p);
      const align = 1 - p.depAlign * (1 - 0.8 * low) * (1 - S(0.3, 0.95, par));
      let band = DepressionLayer.profile(Math.abs(n) / wd, sw) * align;
      if (!median) {
        // Second octave: half the size, narrower and shallower, its own lines.
        band = Math.max(band, 0.6 * DepressionLayer.profile(Math.abs(n2) / (0.5 * wd), sw) * align);
      }
      // Fuller in lowland: the middle of the band reaches full depth sooner.
      return band + low * band * (1 - band);
    }

    // Sink v at a point. vb: base value (without the middle layer), inland:
    // inland weight, firm: firmness, large: the large part of the base,
    // plain: the share of plains, w: the place among the types (pos).
    // Returns { band, v }.
    //
    // Lowland is read from the large part, which is smooth, so it holds along
    // a whole depression. There the floor is pulled hard toward sea level
    // (depLow, more in plains: depPlain), so the sea follows the depressions
    // far in: long fjords, and islands and sounds where bands lie close. The
    // inland threshold gives way in proportion. In highland the floor is the
    // base value minus the depth, and the inland threshold holds.
    at(x, y, v, vb, inland, firm, large, plain = 0, w = null) {
      const p = this.p, bp = this.base.p;
      if (vb < bp.tSea - 0.6) return { band: 0, v };
      const low = 1 - S(bp.tSea, bp.tHigh, large);
      const band = this.band(x, y, firm, low, w); // w: the place among the types (pos)
      if (band <= 0) return { band, v };
      const pull = Math.min(1, low * (p.depLow + p.depPlain * plain));
      const floor = (1 - pull) * (vb - p.depDepth) + pull * (bp.tSea - 0.15);
      let d = band * (Math.min(v, floor) - v);
      const keep = inland * (1 - pull);
      if (keep > 0 && v >= bp.tSea) d = (1 - keep) * d + keep * M.BaseLayer.keepAbove(d, v - bp.tSea - 0.05);
      return { band, v: v + d };
    }
  }

  // The four valley profiles, over t = distance from the line / half width
  // (1 at the centre, 0 from t = 1 out):
  //   '['  flat floor, steep sides        (loose ground)
  //   '('  soft, rounded: a U-valley      (hills and highland)
  //   '{'  two soft steps, a flat bench,  (plateaus)
  //        a steep gorge in the middle: a canyon
  //   '<'  straight sides meeting in a point: a V-valley (fjellsk)
  DepressionLayer.PROFILES = [
    { sym: '[', name: 'flat bunn, bratte sider', f: (t) => 1 - S(0.8, 1, t) },
    { sym: '(', name: 'U-dal', f: (t) => (t < 1 ? 1 - t * t : 0) },
    { sym: '{', name: 'kanyon', f: (t) => 0.45 * (1 - S(0.55, 1, t)) + 0.55 * (1 - S(0.12, 0.22, t)) },
    { sym: '<', name: 'V-dal', f: (t) => Math.max(0, 1 - t) },
  ];
  // Shares of the four profiles, from two thresholds sets you drag: along
  // the landscape types (pos, 0 slette .. 3 fjellsk: vA1..vA3) and along the
  // height (hrel, 0 lowland .. 1 highland: vB1..vB3). Each set is three
  // S-curves passing a share on from '[' to '(' to '{' to '<'; the two are
  // blended, the height by vH. The soft threshold of the depression takes the
  // shape the other layers give it.
  DepressionLayer.split = (v, t1, t2, t3, soft) => {
    const s1 = S(t1 - soft, t1 + soft, v), s2 = S(t2 - soft, t2 + soft, v), s3 = S(t3 - soft, t3 + soft, v);
    return [1 - s1, s1 * (1 - s2), s1 * s2 * (1 - s3), s1 * s2 * s3];
  };
  DepressionLayer.shapes = (pos, hrel, p) => {
    const a = DepressionLayer.split(pos, p.vA1, p.vA2, p.vA3, 0.2), b = DepressionLayer.split(hrel, p.vB1, p.vB2, p.vB3, 0.08);
    const h = p.vH;
    return a.map((v, k) => (1 - h) * v + h * b[k]);
  };
  DepressionLayer.profile = (t, sw) => {
    let v = 0;
    for (let k = 0; k < 4; k++) if (sw[k] > 0) v += sw[k] * DepressionLayer.PROFILES[k].f(t);
    return v;
  };
  M.DepressionLayer = DepressionLayer;
})(window.Markr = window.Markr || {});
