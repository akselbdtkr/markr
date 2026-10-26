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
  // A section is 32 x 32 base cells (512 m).
  const SECTION = 32;
  const SECTION_M = SECTION * CELL_SIZE;

  const H_MIN = -5000, H_MAX = 5000;
  // Natural moisture stays below this; only streams and water reach 1.
  const MOISTURE_MAX = 0.9;

  // Measured standard deviation of 5-octave fbm, to turn it into a normal value.
  const FBM5_STD = 0.157;

  // Landscape types along the section layer, from marine (0) to alpine (1).
  // base: typical height (m). relief: typical height variation (m).
  const LANDSCAPES = [
    { t: 0, name: 'marin' },
    { t: 0.25, name: 'slette' },
    { t: 0.5, name: 'åser' },
    { t: 0.75, name: 'platå' },
    { t: 1, name: 'alpin' },
  ];
  // Each type has a fairly flat band of heights; the steps between types are
  // where the land rises (escarpments, coastal slopes).
  const BASE = [[-0.6, -3500], [0.05, -200], [0.15, 5], [0.18, 20], [0.32, 70], [0.4, 150], [0.6, 500], [0.68, 880], [0.82, 960], [0.9, 1300], [1, 1600], [1.5, 2600]];
  const RELIEF = [[-0.6, 200], [0.05, 60], [0.15, 20], [0.35, 20], [0.4, 160], [0.6, 160], [0.65, 35], [0.85, 35], [0.95, 1200], [1.5, 1800]];
  // Section layer: mean and spread of the type value, so most land is plains and hills.
  const T_MEAN = 0.42, T_STD = 0.25;
  // How far a section's direction shifts the type inside it.
  const TILT = 0.15;

  function piecewise(knots, t) {
    if (t <= knots[0][0]) return knots[0][1];
    for (let k = 1; k < knots.length; k++) {
      if (t <= knots[k][0]) {
        const [t0, v0] = knots[k - 1], [t1, v1] = knots[k];
        return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
      }
    }
    return knots[knots.length - 1][1];
  }

  class Terrain {
    constructor(seed) {
      this.seed = seed;
      const P = (k) => createPerlin(seed * 17 + k);
      this.nType = P(1);
      this.nTypeLocal = P(2);
      this.nDirX = P(3);
      this.nDirY = P(4);
      this.nHills = P(5);
      this.nRidge = P(6);
      this.nDetail = P(7);
      this.nRough = P(8);
      this.nRoughLocal = P(9);
      this.nAnomaly = P(10);
      this.nMoist = P(11);
      this.nMoistLocal = P(12);
      this.nWarpX = P(13);
      this.nWarpY = P(14);
      this.sections = new Map();
    }

    // The section layer: each section gets a type value (marine .. alpine) and a
    // direction, both from Perlin noise sampled at the section centre.
    sectionParams(sx, sy) {
      const id = (sx + 1048576) * 2097152 + (sy + 1048576);
      let p = this.sections.get(id);
      if (!p) {
        const cx = (sx + 0.5) * SECTION_M, cy = (sy + 0.5) * SECTION_M;
        const t = T_MEAN + (T_STD * fbm(this.nType, cx / 30000, cy / 30000, 5)) / FBM5_STD;
        let dx = this.nDirX(cx / 7000, cy / 7000), dy = this.nDirY(cx / 7000, cy / 7000);
        const len = Math.hypot(dx, dy) || 1;
        p = { t, dx: dx / len, dy: dy / len };
        this.sections.set(id, p);
        if (this.sections.size > 50000) this.sections.clear();
      }
      return p;
    }

    // Landscape type value at a point, [base, character]. Section values are blended
    // between section centres. Inside each section its direction raises the type on
    // one side and lowers it on the other, so a boundary (marine/plains, say) can run
    // through the middle of a section. The shift is zero at section edges, so the
    // field stays continuous. Height (base) follows the local variation and the
    // shift only slightly, or they would raise cliffs; the character of the
    // terrain (relief, ridges) follows them fully.
    landscape(x, y) {
      const u = x / SECTION_M - 0.5, v = y / SECTION_M - 0.5;
      const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
      const t00 = this.sectionParams(i, j).t, t10 = this.sectionParams(i + 1, j).t;
      const t01 = this.sectionParams(i, j + 1).t, t11 = this.sectionParams(i + 1, j + 1).t;
      let t = (t00 * (1 - fu) + t10 * fu) * (1 - fv) + (t01 * (1 - fu) + t11 * fu) * fv;
      const local = 0.12 * fbm(this.nTypeLocal, x / 4000, y / 4000, 3);
      const sx = Math.floor(x / SECTION_M), sy = Math.floor(y / SECTION_M);
      const lu = x / SECTION_M - sx, lv = y / SECTION_M - sy;
      const p = this.sectionParams(sx, sy);
      const bubble = Math.sin(Math.PI * lu) * Math.sin(Math.PI * lv);
      const tilt = TILT * 2 * (p.dx * (lu - 0.5) + p.dy * (lv - 0.5)) * bubble;
      return [t + 0.25 * local + 0.03 * tilt, t + local + tilt];
    }

    // Ruggedness [0, 1]. Strong enough to override the landscape type: steep
    // patches in marine and plains, flatter patches in alpine terrain.
    ruggedness(x, y) {
      return clamp01(0.5 + 0.9 * fbm(this.nRough, x / 2500, y / 2500, 3) + 0.4 * fbm(this.nRoughLocal, x / 600, y / 600, 2));
    }

    // Elevation in metres, [-5000, 5000].
    // minWavelength drops layers too fine to see (for zoomed-out views).
    elevation(x, y, minWavelength = 0) {
      const [tb, tc] = this.landscape(x, y);
      const r = this.ruggedness(x, y);
      const amp = piecewise(RELIEF, tc) * (0.25 + 1.5 * r * Math.sqrt(r));
      const rw = smoothstep(0.8, 1, tc); // alpine ridges
      let relief = 0;
      const fade = (w) => smoothstep(minWavelength, minWavelength * 2, w);
      if (minWavelength < 1800) relief += (1 - rw) * fade(900) * fbm(this.nHills, x / 900, y / 900, 4);
      if (rw > 0) relief += rw * (2 * ridged(this.nRidge, x / 4000, y / 4000, 5) - 1);
      let h = piecewise(BASE, tb) + amp * relief;
      // Rugged anomalies: knolls, skerries and gullies wherever ruggedness is high.
      if (r > 0.7 && minWavelength < 700) h += fade(350) * 140 * smoothstep(0.7, 0.95, r) * (2 * ridged(this.nAnomaly, x / 350, y / 350, 3) - 1);
      if (minWavelength < 220) h += fade(110) * (2 + 0.06 * amp) * fbm(this.nDetail, x / 110, y / 110, 3);
      return H_MAX * Math.tanh(h / H_MAX);
    }

    // Moisture [0, 0.9]. Water (below 0 m) is always 1. Streams add more later.
    moisture(x, y, elevation) {
      if (elevation < 0) return 1;
      let m = 0.5 + 0.45 * fbm(this.nMoist, x / 20000, y / 20000, 3) + 0.3 * fbm(this.nMoistLocal, x / 700, y / 700, 3);
      m -= 0.25 * (elevation / 1500); // drier with height
      m += 0.2 * Math.exp(-elevation / 15); // wet just above the shoreline
      return Math.max(0, Math.min(MOISTURE_MAX, m));
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
        landscape: this.landscape(x, y)[1],
        slope: elevation < 0 ? 0 : Math.hypot(gx, gy),
        gx,
        gy,
      };
    }
  }

  // Name of the nearest landscape type for a type value.
  function landscapeName(t) {
    let best = LANDSCAPES[0];
    for (const l of LANDSCAPES) if (Math.abs(l.t - t) < Math.abs(best.t - t)) best = l;
    return best.name;
  }

  M.Terrain = Terrain;
  M.CELL_SIZE = CELL_SIZE;
  M.MAX_LEVEL = MAX_LEVEL;
  M.SECTION = SECTION;
  M.H_MIN = H_MIN;
  M.H_MAX = H_MAX;
  M.landscapeName = landscapeName;
  M.util = { clamp01, smoothstep };
})(window.Markr = window.Markr || {});
