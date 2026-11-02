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
    at(x, y, pos, band, sw, edge, mount = 0) {
      const p = this.p;
      const H = this.at4('lcH', pos) * 150 * p.scaleV * (p.locW ?? 1);
      const L = Math.max(16, this.at4('lcS', pos) * 3000 * (p.locK ?? 1)) * p.scaleH;
      const sharp = this.at4('lcR', pos), stretch = 1 + this.at4('lcT', pos) * 9, gain = 0.3 + 0.4 * this.at4('lcU', pos);
      // The noise is read only at fixed sizes (powers of two) and fixed
      // stretches, then blended: with a size or stretch that changes from
      // place to place, x / L drifts in phase far from the origin and draws
      // rings along the type's contours.
      let dz = 0;
      if (H > 0) {
        const lg = Math.log2(L), l0 = Math.floor(lg), fl = lg - l0, ts = Math.min(1, (stretch - 1) / 9);
        const one = (Lq) => (1 - ts) * this.stretchedAt(x, y, Lq, 1, sharp, gain) + (ts > 0 ? ts * this.stretchedAt(x, y, Lq, 10, sharp, gain) : 0);
        dz = H * ((1 - fl) * one(Math.pow(2, l0)) + (fl > 0.02 ? fl * one(Math.pow(2, l0 + 1)) : 0));
      }
      // Mountain arêtes: a sharp ridge noise (two octaves, the crest cubed
      // so it comes to an edge), stretched along the slope of the land
      // below, so the arêtes run with it. Along each arête, notches at even
      // spacing (cols between peaks), read from the level of the base, so
      // they fall at the same height on neighbouring arêtes. Mostly lifting,
      // so the mountains grow above the divide.
      if (mount > 0 && p.mtH > 0) {
        const Lm = p.mtS * p.scaleH, nm = this.nm;
        const ridge = (u, v) => {
          const r1 = 1 - Math.abs(nm(u, v)), r2 = 1 - Math.abs(nm(2 * u + 17.3, 2 * v - 9.1));
          return (r1 * r1 * r1 + 0.35 * r2 * r2) / 1.35;
        };
        const r = this.stretchedAt(x, y, Lm, 1 + p.mtT, 1, 0.5, ridge);
        let notch = 1;
        if (p.mtNotch > 0 && p.mtBreak > 0) {
          const fr = this.base.slopeFrame(x, y), spacing = p.mtBreak * p.scaleH * this.base.typicalSlope();
          const t = fr.B / spacing + 0.35 * nm(x / (3 * Lm) + 5.1, y / (3 * Lm) - 2.7);
          const ph = t - Math.floor(t), dn = 2 * Math.min(ph, 1 - ph);
          // Only on the crest itself (r high): elsewhere it would draw rings
          // round the level lines.
          notch = 1 - p.mtNotch * (1 - S(0, 0.45, dn)) * S(0.45, 0.85, r);
        }
        dz += mount * p.mtH * p.scaleV * (1.3 * r * notch - 0.25);
      }
      if (dz === 0) return 0;
      if (band > 0 && sw) {
        // Floor damped, sides strengthened, by the valley profile.
        const floor = p.locFlat * band * band * (sw[0] + sw[2] + 0.5 * sw[1]);
        const side = p.locSide * 4 * band * (1 - band) * (sw[0] + sw[2] + sw[3]);
        dz *= (1 - floor) * (1 + side);
      }
      // Near the water the detail fades out, so banks run down to it.
      if (edge < Infinity) dz *= S(0, Math.max(1, p.locBank), edge);
      return dz;
    }
  }

  LocalLayer.CURVES = CURVES;
  M.LocalLayer = LocalLayer;
})(window.Markr = window.Markr || {});
