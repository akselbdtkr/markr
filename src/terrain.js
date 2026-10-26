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

  // Measured standard deviation of fbm by octave count, to turn it into a
  // normal value.
  const FBM_STD = { 2: 0.197, 3: 0.173, 4: 0.163, 5: 0.157 };
  const FBM5_STD = FBM_STD[5];

  // Landscape types, on the type scale tau used for colours, names and sources.
  const LANDSCAPES = [
    { t: 0, name: 'marin' },
    { t: 0.25, name: 'slette' },
    { t: 0.5, name: 'åser' },
    { t: 0.75, name: 'platå' },
    { t: 1, name: 'alpin' },
  ];

  // Wavelengths (m) of the landscape layers at landscape scale 1. Short enough
  // that a few kilometres hold a bit of everything.
  const L_COAST = 9000, L_HILLS = 2500, L_PLATEAU = 10000, L_EDGE = 2500, L_MOUNT = 4500, L_WARP = 6000;
  // Defaults for the four controls in the UI: coast level, plains|hills, plateau
  // level and mountain level (higher gives less plateau and fewer mountains).
  const BOUNDS = [-0.5, 0.1, 1.0, 0.77];

  // Interpolates between knots. With smooth = true the curve eases in and out of
  // every knot, so there are no kinks (which showed as sharp bands on the land).
  function piecewise(knots, t, smooth = false) {
    if (t <= knots[0][0]) return knots[0][1];
    for (let k = 1; k < knots.length; k++) {
      if (t <= knots[k][0]) {
        const [t0, v0] = knots[k - 1], [t1, v1] = knots[k];
        let f = (t - t0) / (t1 - t0);
        if (smooth) f = f * f * (3 - 2 * f);
        return v0 + (v1 - v0) * f;
      }
    }
    return knots[knots.length - 1][1];
  }

  class Terrain {
    constructor(seed, opts = {}) {
      this.seed = seed;
      this.bounds = opts.bounds || BOUNDS;
      this.scale = opts.scale || 1; // landscape scale: multiplies the layer wavelengths
      const P = (k) => createPerlin(seed * 17 + k);
      this.nType = P(1);
      this.nTypeLocal = P(2);
      this.nMount = P(3);
      this.nWarpL = P(4);
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
      this.nWarpL2 = P(15);
      this.nPlateau = P(16);
      this.nEdge = P(17);
      this.nPlateauH = P(18);
    }

    // The landscape at a point, as separate layers, all seen through a gentle
    // domain warp so coasts and ranges bend naturally:
    // - coast: continents (9 km). Land where the value is above the coast level.
    // - hills: plains or hills (2.5 km), blending softly.
    // - plateau: its own layer (10 km), so large areas can lie on a plateau. How
    //   sharp its edge is varies (2.5 km noise): steep like an old coastline in
    //   some places, a soft rise from the hills in others.
    // - mountains: connected, branching ranges (ridged noise, 4.5 km), inside or
    //   outside plateaus.
    layers(x, y) {
      const s = this.scale;
      const [b0, b1, b2, b3] = this.bounds;
      const qx = x + 1500 * s * fbm(this.nWarpL, x / (L_WARP * s), y / (L_WARP * s), 2);
      const qy = y + 1500 * s * fbm(this.nWarpL2, x / (L_WARP * s), y / (L_WARP * s), 2);
      const u = fbm(this.nType, qx / (L_COAST * s), qy / (L_COAST * s), 5) / FBM_STD[5] - b0;
      const land = smoothstep(-0.05, 0.05, u);
      const hv = fbm(this.nTypeLocal, qx / (L_HILLS * s), qy / (L_HILLS * s), 3) / FBM_STD[3];
      const hills = smoothstep(b1 - 0.8, b1 + 0.8, hv);
      const pv = fbm(this.nPlateau, qx / (L_PLATEAU * s), qy / (L_PLATEAU * s), 4) / FBM_STD[4];
      const soft = smoothstep(-0.5, 0.5, fbm(this.nEdge, x / (L_EDGE * s), y / (L_EDGE * s), 2) / FBM_STD[2]);
      const edge = 0.22 + 0.6 * soft;
      const plateau = smoothstep(b2 - edge, b2 + edge, pv) * land;
      const mount = smoothstep(b3 - 0.02, b3 + 0.16, ridged(this.nMount, qx / (L_MOUNT * s), qy / (L_MOUNT * s), 4)) * smoothstep(0, 0.6, u);
      // Type scale: marine 0, plains 0.25, hills 0.5, plateau 0.75, alpine 1.
      let tau = land * (0.25 + 0.25 * hills);
      tau += (0.75 - tau) * plateau;
      tau += (1 - tau) * mount;
      return { u, land, hills, plateau, mount, soft, tau };
    }

    // Landscape type at a point on the tau scale, as [base, character] (the same).
    landscape(x, y) {
      const tau = this.layers(x, y).tau;
      return [tau, tau];
    }

    // Share of each landscape type, from a fixed sample of points.
    landscapeShares(n = 3000) {
      const rand = M.noise.mulberry32(this.seed + 99);
      const counts = [0, 0, 0, 0, 0];
      for (let k = 0; k < n; k++) {
        const tc = this.layers((rand() - 0.5) * 400000 * this.scale, (rand() - 0.5) * 400000 * this.scale).tau;
        counts[Math.max(0, Math.min(4, Math.floor((tc + 0.125) / 0.25)))]++;
      }
      return counts.map((c) => c / n);
    }

    // Ruggedness [0, 1]. Strong enough to override the landscape type: steep
    // patches in marine and plains, flatter patches in alpine terrain.
    ruggedness(x, y) {
      return clamp01(0.5 + 0.9 * fbm(this.nRough, x / 2500, y / 2500, 3) + 0.4 * fbm(this.nRoughLocal, x / 600, y / 600, 2));
    }

    // Elevation in metres, [-5000, 5000].
    // minWavelength drops layers too fine to see (for zoomed-out views).
    elevation(x, y, minWavelength = 0) {
      const L = this.layers(x, y);
      const r = this.ruggedness(x, y);
      const rug = 0.25 + 1.5 * r * Math.sqrt(r);
      const fade = (w) => smoothstep(minWavelength, minWavelength * 2, w);
      // Base: sea floor falls away from the coast, land rises slowly inland.
      let h = L.u < 0 ? 900 * L.u : 50 * L.u;
      h += 60 * L.hills * L.land;
      // Plateaus lift the land about 500-800 m and smooth it. The lift varies
      // slowly, so a plateau stays fairly level across.
      const lift = 650 + 80 * fbm(this.nPlateauH, x / (16000 * this.scale), y / (16000 * this.scale), 2) / FBM_STD[2];
      h += L.plateau * Math.max(300, lift);
      // Rolling relief: plains are gentle, hills more, plateaus smoother again.
      let amp = 50 + (18 + 132 * L.hills - 50) * L.land;
      amp *= (1 - 0.65 * L.plateau) * rug;
      if (minWavelength < 1800) h += fade(900) * amp * fbm(this.nHills, x / 900, y / 900, 4);
      // Mountains: lifted and ridged, on top of whatever they stand on.
      // The ridges are centred on their mean, so peaks and valleys shape the range
      // rather than one smooth tent along it.
      if (L.mount > 0) h += L.mount * (150 + 1500 * (0.4 + 0.6 * r) * (ridged(this.nRidge, x / 1400, y / 1400, 5) - 0.45));
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
  M.LANDSCAPES = LANDSCAPES;
  M.BOUNDS = BOUNDS;
  M.util = { clamp01, smoothstep };
})(window.Markr = window.Markr || {});
