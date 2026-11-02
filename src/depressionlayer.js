// Nedsenkslaget: valleys, ravines, canyons, rivers and fjords. A band where a
// noise layer passes a middle value sinks the land toward the base
// displacement (the base value without the middle layer, minus a depth), so
// inside the band the middle layer is nearly flattened away. Near the coast
// the floor is pulled further down and can fall below the sea threshold:
// fjords, islands and small sounds, even where the inland threshold would
// keep the sea out.
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
    // depWidth, depSoft (edge S-curve), depStretch, depAlign (0..1).
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

    band(x, y, firm) {
      const p = this.p, median = p.depMode !== 'ridged';
      const [n, par, n2] = this.lines(x, y);
      // Width and sides from firmness: loose is wider with a flat floor and
      // steep sides, firm is narrow with soft sides.
      // depSoft widens the S-curve outward from the line: softer edges.
      const w = p.depWidth * (1.5 - firm), a = 0.5 * (1 - firm) / (1 + p.depSoft);
      const prof = (t) => 1 - S(a, 1 + p.depSoft, t);
      const align = 1 - p.depAlign * (1 - S(0.3, 0.95, par));
      let band = prof(Math.abs(n) / w) * align;
      if (!median) {
        // Second octave: half the size, narrower and shallower, its own lines.
        band = Math.max(band, 0.6 * prof(Math.abs(n2) / (0.5 * w)) * align);
      }
      return band;
    }

    // Sink v at a point. vb: base value (without the middle layer), inland:
    // inland weight, firm: firmness. Returns { band, v }.
    at(x, y, v, vb, inland, firm) {
      const p = this.p, bp = this.base.p;
      if (vb < bp.tSea - 0.6) return { band: 0, v };
      const band = this.band(x, y, firm);
      if (band <= 0) return { band, v };
      // Near the coast the floor is pulled down further (depCoast, reaching
      // depReach above the sea threshold), so the sea follows the depressions
      // in: fjords, and islands and small sounds where bands lie close. Within
      // that reach it overrides the inland threshold: a depression may bring
      // the sea in where the other layers would not.
      const coast = 1 - S(bp.tSea, bp.tSea + p.depReach, vb);
      const floor = vb - p.depDepth - p.depCoast * coast;
      let d = band * (Math.min(v, floor) - v);
      // Further inland the inland threshold still holds: no sea there.
      const keep = inland * (1 - coast);
      if (keep > 0 && v >= bp.tSea) d = (1 - keep) * d + keep * M.BaseLayer.keepAbove(d, v - bp.tSea - 0.05);
      return { band, v: v + d };
    }
  }

  M.DepressionLayer = DepressionLayer;
})(window.Markr = window.Markr || {});
