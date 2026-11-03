// Det lokale laget: the terrain's own detail, shaped by every layer below.
//
// Its form follows the landscape type, through curves along the chain
// slette → åser → platå → fjellsk (the type place pos, 0..3), each set by
// the player:
//   height     how much it lifts and sinks (m on screen)
//   size       the wavelength of its forms (m on screen)
//   sharpness  from rolling fbm (0) to ridged crests (1)
//   stretch    how much it is drawn out along the slope of the base
//   roughness  how much the small octaves count: abrupt changes
// Scale and weight multiply size and height for all types. Mountain arêtes
// are a layer of their own (see at).
// Fjellsk lies above the old ice and rivers, so it keeps the most local
// deformation: high, sharp, rough, and little stretched. Hills are rolling
// and stretched the most; plateaus soft and low; plains almost flat.
//
// It works with the valley profiles: on the floor of a depression the detail
// is damped (flat floors for '[' and '{', less for '('), on its sides it is
// strengthened (steep sides for '[', '{' and '<'), and near a river it fades
// out to the water, so banks come out natural.
(function (M) {
  'use strict';

  const S = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const frac = (v) => v - Math.floor(v);
  const OCT = 4;

  // The curves: values 0..1 at the four types, times these maxima.
  const CURVES = [
    { key: 'lcH', name: 'Høyde', max: 150, unit: 'm' },
    { key: 'lcS', name: 'Størrelse', max: 3000, unit: 'm' },
    { key: 'lcR', name: 'Skarphet', max: 1, unit: '' },
    { key: 'lcT', name: 'Strekking', max: 10, unit: '×' },
    { key: 'lcU', name: 'Ruhet', max: 1, unit: '' },
  ];

  class LocalLayer {
    // base: a BaseLayer. p: the curves (lcH, lcS, lcR, lcT, lcU: 4 values
    // each), locFlat, locSide, scaleH, scaleV.
    constructor(base, seed, p) {
      this.base = base;
      this.p = p;
      this.n = M.noise.createPerlin(seed * 71 + 1);
      this.nm = M.noise.createPerlin(seed * 71 + 2);
    }

    // A curve's value at the type place pos (0..3), piecewise linear.
    at4(key, pos) {
      const v = this.p[key], i = Math.max(0, Math.min(2, Math.floor(pos))), f = Math.max(0, Math.min(1, pos - i));
      return v[i] + (v[i + 1] - v[i]) * f;
    }

    // fbm or ridged mix, with gain from roughness, about -1..1.
    noiseAt(x, y, sharp, gain) {
      let sum = 0, amp = 1, freq = 1, norm = 0, rid = 0;
      for (let o = 0; o < OCT; o++) {
        const v = this.n(x * freq + o * 17.31, y * freq - o * 9.73);
        sum += amp * v;
        const r = 1 - Math.abs(v);
        rid += amp * r * r;
        norm += amp;
        amp *= gain;
        freq *= 2;
      }
      const f = (sum / norm) * 2.5, r = (rid / norm) * 2 - 1;
      return (1 - sharp) * f + sharp * r * 1.4;
    }

    // Stretched along the slope of the base: read at the two nearest level
    // lines (as in BaseLayer.stretched) and blend.
    stretchedAt(x, y, L, stretch, sharp, gain, reader = null) {
      const b = this.base, fr = b.slopeFrame(x, y);
      // One noise for every level line (no offset per level): the reads at
      // two levels still blend seamlessly, and the levels do not show as
      // rings around the tops of the base.
      const read = reader ? (qx, qy) => reader(qx / L, qy / L) : (qx, qy) => this.noiseAt(qx / L, qy / L, sharp, gain);
      if (stretch <= 1.05 || fr.g < 1e-12) return read(x, y, 0);
      const len = Math.min(stretch * L, 0.25 * b.p.basinSize * 1000), dB = len * b.typicalSlope();
      const u = fr.B / dB, k = Math.floor(u), f = u - k;
      const lim = fr.kappa > 0 ? Math.min(len, 0.5 / fr.kappa) : len;
      const cap = (d) => (d <= 0 ? 0 : 1 / Math.pow(Math.pow(d, -4) + Math.pow(lim, -4), 0.25));
      const d0 = fr.fade * cap((f * dB) / fr.g), d1 = fr.fade * cap(((1 - f) * dB) / fr.g);
      const n0 = read(x - fr.ax * d0, y - fr.ay * d0, k), n1 = read(x + fr.ax * d1, y + fr.ay * d1, k + 1);
      const w1 = f * f * (3 - 2 * f), w0 = 1 - w1;
      return (w0 * n0 + w1 * n1) / Math.hypot(w0, w1);
    }

    // The local change in height (sim units) at a land point. pos: type
    // place; band: depression band 0..1; sw: valley profile shares; edge:
    // distance from a river's water (sim units), or Infinity.
    // mount: how much of a mountain the point is (fjellsk share, and more
    // the higher above the divide threshold).
    at(x, y, pos, band, sw, edge, mount = 0, firm = 0.5, hRel = 0, ew = 1) {
      const p = this.p;
      // Firmness: loose ground is lower and softer, firm ground higher and
      // sharper (locFirm sets how much).
      const fk = (p.locFirm ?? 0) * (firm - 0.5);
      const H = this.at4('lcH', pos) * 150 * p.scaleV * (p.locW ?? 1) * Math.max(0, 1 + 1.2 * fk);
      const L = Math.max(16, this.at4('lcS', pos) * 3000 * (p.locK ?? 1)) * p.scaleH;
      const sharp = Math.max(0, Math.min(1, this.at4('lcR', pos) + fk)), stretch = 1 + this.at4('lcT', pos) * 9, gain = 0.3 + 0.4 * this.at4('lcU', pos);
      // The noise is read only at fixed sizes (powers of two) and fixed
      // stretches, then blended: with a size or stretch that changes from
      // place to place, x / L drifts in phase far from the origin and draws
      // rings along the type's contours.
      let dz = 0;
      // A noise of height A and size L has slopes of about A·2π/L times the
      // octaves' share; this caps A so the steepest slopes stay near the
      // given angle on screen.
      const cap = (A, Lsim, deg, oct, g) => {
        if (!(deg > 0)) return A;
        let num = 0, den = 0;
        for (let o = 0, a = 1, f = 1; o < oct; o++, a *= g, f *= 2) {
          num += a * f;
          den += a;
        }
        const max = ((Lsim / p.scaleH) * Math.tan((deg * Math.PI) / 180) * p.scaleV) / (2 * Math.PI * (num / den));
        return Math.min(A, 2 * max);
      };
      const Hc = cap(H, L, p.locSlope, 4, gain);
      if (Hc > 0) {
        const lg = Math.log2(L), l0 = Math.floor(lg), fl = lg - l0, ts = Math.min(1, (stretch - 1) / 9);
        const one = (Lq) => (1 - ts) * this.stretchedAt(x, y, Lq, 1, sharp, gain) + (ts > 0 ? ts * this.stretchedAt(x, y, Lq, 10, sharp, gain) : 0);
        dz = Hc * ((1 - fl) * one(Math.pow(2, l0)) + (fl > 0.02 ? fl * one(Math.pow(2, l0 + 1)) : 0));
      }
      const parts = (this.parts = [dz, 0, 0]); // detail, arêtes, cols (for viewing)
      // Mountain arêtes: a ridge noise (two octaves, squared: a sharp crest
      // with steep, hollowed flanks), stretched
      // along the slope of the land below at a fixed stretch, so the arêtes
      // run with it. Mostly lifting, so the mountains grow above the divide.
      if (mount > 0 && p.mtH > 0) {
        const Lm = p.mtS * p.scaleH, nm = this.nm;
        const ridge = (u, v) => {
          const r1 = 1 - Math.abs(nm(u, v)), r2 = 1 - Math.abs(nm(2 * u + 17.3, 2 * v - 9.1));
          return (r1 * r1 + 0.3 * r2 * r2) / 1.3;
        };
        const r = this.stretchedAt(x, y, Lm, 1 + p.mtT, 1, 0.5, ridge);
        parts[1] = mount * cap(p.mtH * p.scaleV, Lm, p.mtSlope, 2, 0.5) * (1.6 * r - 0.15);
        dz += parts[1];
        this.crest = r;
      } else this.crest = 0;
      // Cols: plain noise (fbm, not stretched), its high parts cutting in,
      // in mountains (mostly into the crests) and in hills: deeper cuts
      // higher up, smaller ones lower down.
      const hills = Math.max(0, 1 - Math.abs(pos - 1));
      const cw = Math.max(p.mtH > 0 ? mount : 0, hills);
      if (cw > 0 && p.cutH > 0) {
        const Lc = p.cutS * p.scaleH;
        const f = M.noise.fbm(this.nm, x / Lc + 41.3, y / Lc - 7.7, 3) / 0.173;
        const cut = S(0, 1.5, f);
        const high = 0.25 + 0.75 * Math.max(0, Math.min(1, hRel));
        parts[2] = -cw * cap(p.cutH * p.scaleV, Lc, p.mtSlope, 3, 0.5) * cut * high * (mount > 0 ? 0.4 + 0.6 * this.crest : 0.6);
        dz += parts[2];
      }
      // Along a depression the mountains and cols give way, so the valley
      // runs smoothly into the mountain instead of meeting it with a wall.
      if (band > 0 && (parts[1] || parts[2])) {
        const g = 1 - (p.locDep ?? 0.8) * Math.min(1, band);
        dz -= (parts[1] + parts[2]) * (1 - g);
        parts[1] *= g;
        parts[2] *= g;
      }
      if (dz === 0) return 0;
      if (band > 0 && sw) {
        // Floor damped, sides strengthened, by the valley profile.
        const floor = p.locFlat * band * band * (sw[0] + sw[2] + 0.5 * sw[1]);
        const side = p.locSide * 4 * band * (1 - band) * (sw[0] + sw[2] + sw[3]);
        // On the sides only cuts are deepened; bumps are damped, so the sides
        // get steeper without a raised rim along the valley.
        dz *= (1 - floor) * (dz < 0 ? 1 + side : Math.max(0, 1 - side));
      }
      // Near the water the detail fades out, so banks run down to it.
      if (edge < Infinity) {
        // The fade toward the water is as wide as the change needs to stay
        // under the bank slope (riverSlope), up to the river's reach.
        const need = p.riverSlope > 0 ? ((Math.abs(dz) / p.scaleV) / Math.tan((p.riverSlope * Math.PI) / 180)) * p.scaleH : 0;
        const dist = Math.min(Math.max(p.locBank, need), Math.max(p.locBank, 0.8 * (p.riverReach || 0)));
        const k = 1 - ew * (1 - S(0, Math.max(1, dist), edge));
        dz *= k;
        for (let q = 0; q < 3; q++) parts[q] *= k;
      }
      return dz;
    }
  }

  LocalLayer.CURVES = CURVES;
  M.LocalLayer = LocalLayer;
})(window.Markr = window.Markr || {});
