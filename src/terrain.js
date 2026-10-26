// Terrain: continuous fields defined for every world point (x, y) in metres.
// The fields exist everywhere; the grid only samples the part we look at.
(function (M) {
  'use strict';

  const { createPerlin, fbm, ridged } = M.noise;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smoothstep = (a, b, v) => {
    const t = clamp01((v - a) / (b - a));
    return t * t * (3 - 2 * t);
  };

  // A base cell is 16 m across. Each split halves it: 8, 4, 2, 1 m.
  const CELL_SIZE = 16;
  const MAX_LEVEL = 4;

  // Elevation limits and the centre of the common band (-100 .. 1000 m).
  const H_MIN = -5000, H_MAX = 5000;
  const H_MEAN = 400, H_STD = 480;

  // Measured standard deviation of the 5-octave fbm, used to turn it into a
  // standard normal value.
  const FBM5_STD = 0.157;

  class Terrain {
    constructor(seed) {
      this.seed = seed;
      const P = (k) => createPerlin(seed * 13 + k);
      this.nBase = P(1);
      this.nRidge = P(2);
      this.nHills = P(3);
      this.nDetail = P(4);
      this.nRough = P(5);
      this.nRoughLocal = P(6);
      this.nMoist = P(7);
      this.nMoistLocal = P(8);
      this.nWarpX = P(9);
      this.nWarpY = P(10);
    }

    // Ruggedness [0, 1]: regional mountain belts plus local broken patches.
    ruggedness(x, y) {
      const regional = smoothstep(-0.3, 0.4, fbm(this.nRough, x / 30000, y / 30000, 3));
      const local = fbm(this.nRoughLocal, x / 900, y / 900, 2);
      return clamp01(0.8 * regional + 0.45 * local + 0.1);
    }

    // Elevation in metres, [-5000, 5000]. The broad landform is roughly normal
    // with most land between -100 and 1000 m; ruggedness scales every relief layer.
    // minWavelength drops layers too fine to see (for zoomed-out views).
    elevation(x, y, minWavelength = 0) {
      const z = fbm(this.nBase, x / 90000, y / 90000, 5) / FBM5_STD;
      let h = H_MEAN + H_STD * z;
      if (z < -1) h -= 700 * (z + 1) * (z + 1); // deeper sea floor
      const r = this.ruggedness(x, y);
      const ridge = ridged(this.nRidge, x / 7000, y / 7000, 4);
      h += r * r * (4400 * ridge * ridge - 1400);
      const fade = (w) => smoothstep(minWavelength, minWavelength * 2, w);
      if (minWavelength < 1800) h += fade(900) * (30 + 220 * r) * fbm(this.nHills, x / 900, y / 900, 3);
      if (minWavelength < 220) h += fade(110) * (3 + 25 * r) * fbm(this.nDetail, x / 110, y / 110, 3);
      return H_MAX * Math.tanh(h / H_MAX);
    }

    // Moisture [0, 1]. Water (below 0 m) is always 1.
    moisture(x, y, elevation) {
      if (elevation < 0) return 1;
      let m = 0.5 + 0.45 * fbm(this.nMoist, x / 20000, y / 20000, 3) + 0.3 * fbm(this.nMoistLocal, x / 700, y / 700, 3);
      m -= 0.25 * (elevation / 1500); // drier with height
      m += 0.2 * Math.exp(-elevation / 15); // wet just above the shoreline
      return clamp01(m);
    }

    gradient(x, y, h = 4, minWavelength = 0) {
      return [
        (this.elevation(x + h, y, minWavelength) - this.elevation(x - h, y, minWavelength)) / (2 * h),
        (this.elevation(x, y + h, minWavelength) - this.elevation(x, y - h, minWavelength)) / (2 * h),
      ];
    }

    // Slope of the surface (m per m). Water surfaces are flat.
    slope(x, y, h = 4) {
      const e = (px, py) => Math.max(0, this.elevation(px, py));
      return Math.hypot((e(x + h, y) - e(x - h, y)) / (2 * h), (e(x, y + h) - e(x, y - h)) / (2 * h));
    }

    // Low-frequency vector field used to make grid lines wavy.
    warp(x, y) {
      return [this.nWarpX(x / 90, y / 90), this.nWarpY(x / 90, y / 90)];
    }

    sample(x, y, step = 4, minWavelength = 0) {
      const elevation = this.elevation(x, y, minWavelength);
      const [gx, gy] = this.gradient(x, y, step, minWavelength);
      return {
        elevation,
        water: elevation < 0,
        moisture: this.moisture(x, y, elevation),
        ruggedness: this.ruggedness(x, y),
        slope: elevation < 0 ? 0 : Math.hypot(gx, gy),
        gx,
        gy,
      };
    }
  }

  M.Terrain = Terrain;
  M.CELL_SIZE = CELL_SIZE;
  M.MAX_LEVEL = MAX_LEVEL;
  M.H_MIN = H_MIN;
  M.H_MAX = H_MAX;
  M.util = { clamp01, smoothstep };
})(window.Markr = window.Markr || {});
