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

  // Landscape regions: each is a set of settings for the layers below. A large
  // noise layer (100 km, two values) places every point among the regions, and
  // their settings are blended with soft weights, so one region fades into the
  // next. `at` is the region's place in the space of the two noise values.
  //   sea      more (+) or less (-) sea          hills   + gives more plains
  //   plateau  + gives less plateau              pLift   plateau height factor
  //   mount    + gives fewer mountains           mLift   mountain height factor
  //   mSea     mountains may rise from the sea   relief  rolling relief factor
  //   shelf    sea floor slope factor            rise    land rise inland (m per unit)
  //   cliff    coastal cliff height (m)          fjord   valleys cut below sea level
  //   lakes    inland lakes                      sounds  small straits between islands
  //   wet      moisture added                    delta   rivers split into deltas
  //   streams  factor on stream sources
  const PARAMS = ['sea', 'hills', 'plateau', 'pLift', 'mount', 'mLift', 'mSea', 'relief', 'shelf', 'rise', 'cliff', 'fjord', 'lakes', 'sounds', 'wet', 'delta', 'streams'];
  const REGIONS = [
    { name: 'blandet kyst', colour: [190, 160, 100], at: [0, 0],
      p: { sea: 0, hills: 0, plateau: 0, pLift: 1, mount: 0, mLift: 1, mSea: 0, relief: 1, shelf: 1, rise: 50, cliff: 70, fjord: 0, lakes: 0, sounds: 0, wet: -0.1, delta: 0, streams: 0.8 } },
    { name: 'fjordland', colour: [70, 110, 120], at: [1.1, 0.7],
      p: { sea: -0.1, hills: -0.2, plateau: -0.9, pLift: 1.3, mount: -0.04, mLift: 1, mSea: 0, relief: 1, shelf: 1.2, rise: 60, cliff: 0, fjord: 1, lakes: 0.3, sounds: 0.2, wet: 0.1, delta: 0, streams: 1.3 } },
    { name: 'innsjøland', colour: [60, 150, 140], at: [-1.1, 0.7],
      p: { sea: -0.3, hills: -0.4, plateau: 2, pLift: 1, mount: 0.3, mLift: 1, mSea: 0, relief: 0.55, shelf: 0.6, rise: 30, cliff: 0, fjord: 0, lakes: 1, sounds: 0.3, wet: 0.2, delta: 0.2, streams: 1.5 } },
    { name: 'deltasletter', colour: [170, 200, 110], at: [-0.8, -1.0],
      p: { sea: 0, hills: 1.6, plateau: 2, pLift: 1, mount: 0.3, mLift: 1, mSea: 0, relief: 0.35, shelf: 0.15, rise: 28, cliff: 0, fjord: 0, lakes: 0.15, sounds: 0, wet: 0.05, delta: 1, streams: 1.2 } },
    { name: 'skjærgård', colour: [110, 120, 160], at: [0.9, -1.0],
      p: { sea: 0.35, hills: 0, plateau: 0.3, pLift: 0.8, mount: -0.06, mLift: 1.6, mSea: 1, relief: 1.1, shelf: 0.25, rise: 40, cliff: 0, fjord: 0.5, lakes: 0.2, sounds: 1, wet: 0.05, delta: 0, streams: 1 } },
  ];
  const L_REGION = 100000;
  // How wide the blend between regions is, in the space of the two noise values.
  const REGION_SPREAD = 0.45;

  // Wavelengths (m) of the landscape layers at landscape scale 1. Short enough
  // that a few kilometres hold a bit of everything.
  const L_OCEAN = 80000, OCEAN_WEIGHT = 3.5;
  const L_STRAIT = 150000, STRAIT_DEPTH = 1.4;
  const L_COAST = 9000, L_HILLS = 2500, L_PLATEAU = 10000, L_EDGE = 2500, L_MOUNT = 4500, L_WARP = 6000;
  // Defaults for the four controls in the UI: coast level, plains|hills, plateau
  // level and mountain level (higher gives less plateau and fewer mountains).
  const BOUNDS = [-0.75, 0.1, 1.0, 0.77];

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
      // A region index to use everywhere, or -1 to let the region layer decide.
      this.region = opts.region ?? -1;
      this.regionCache = new Map();
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
      this.nOcean = P(19);
      this.nStrait = P(20);
      this.nRegionA = P(21);
      this.nRegionB = P(22);
      this.nSounds = P(23);
      this.nFjord = P(24);
      this.nLakes = P(25);
    }

    // The landscape at a point, as separate layers, all seen through a gentle
    // domain warp so coasts and ranges bend naturally:
    // - coast: oceans and continents (80 km), straits joining the seas (150 km),
    //   and the coastline (9 km). Land where the value is above the coast level.
    // - hills: plains or hills (2.5 km), blending softly.
    // - plateau: its own layer (10 km), so large areas can lie on a plateau. How
    //   sharp its edge is varies (2.5 km noise): steep like an old coastline in
    //   some places, a soft rise from the hills in others.
    // - mountains: connected, branching ranges (ridged noise, 4.5 km), inside or
    //   outside plateaus.
    layers(x, y) {
      const s = this.scale;
      const R = this.regionParams(x, y);
      const [b0, b1, b2, b3] = this.bounds;
      const qx = x + 1500 * s * fbm(this.nWarpL, x / (L_WARP * s), y / (L_WARP * s), 2);
      const qy = y + 1500 * s * fbm(this.nWarpL2, x / (L_WARP * s), y / (L_WARP * s), 2);
      // Oceans and continents (80 km) decide where the large connected seas are;
      // the coast layer (9 km) gives the coastline its shape.
      const ocean = fbm(this.nOcean, x / (L_OCEAN * s), y / (L_OCEAN * s), 4) / FBM_STD[4];
      const coast = fbm(this.nType, qx / (L_COAST * s), qy / (L_COAST * s), 5) / FBM_STD[5];
      // Straits: a network of connected lines (ridged noise, 150 km) lowers the land
      // along it, so the large seas join up instead of lying as separate basins.
      const strait = smoothstep(0.72, 0.92, ridged(this.nStrait, x / (L_STRAIT * s), y / (L_STRAIT * s), 3));
      // Small sounds between islands, where the region has them (ridged, 5 km).
      const sounds = R.sounds > 0.01 ? R.sounds * smoothstep(0.7, 0.9, ridged(this.nSounds, qx / (5000 * s), qy / (5000 * s), 3)) : 0;
      const u = (OCEAN_WEIGHT * ocean + coast) / Math.hypot(OCEAN_WEIGHT, 1) - STRAIT_DEPTH * strait - 0.9 * sounds - b0 - R.sea;
      const land = smoothstep(-0.05, 0.05, u);
      const hv = fbm(this.nTypeLocal, qx / (L_HILLS * s), qy / (L_HILLS * s), 3) / FBM_STD[3];
      const hills = smoothstep(b1 + R.hills - 0.8, b1 + R.hills + 0.8, hv);
      const pv = fbm(this.nPlateau, qx / (L_PLATEAU * s), qy / (L_PLATEAU * s), 4) / FBM_STD[4];
      const soft = smoothstep(-0.5, 0.5, fbm(this.nEdge, x / (L_EDGE * s), y / (L_EDGE * s), 2) / FBM_STD[2]);
      const edge = 0.22 + 0.6 * soft;
      const plateau = smoothstep(b2 + R.plateau - edge, b2 + R.plateau + edge, pv) * land;
      // Mountains stand on land, or, where the region allows, rise from the sea.
      const ground = smoothstep(0, 0.6, u) + (1 - smoothstep(0, 0.6, u)) * R.mSea * smoothstep(-1.5, 0, u);
      const b3r = b3 + R.mount;
      const mount = smoothstep(b3r - 0.02, b3r + 0.16, ridged(this.nMount, qx / (L_MOUNT * s), qy / (L_MOUNT * s), 4)) * ground;
      // Type scale: marine 0, plains 0.25, hills 0.5, plateau 0.75, alpine 1.
      let tau = land * (0.25 + 0.25 * hills);
      tau += (0.75 - tau) * plateau;
      tau += (1 - tau) * mount;
      return { u, land, hills, plateau, mount, soft, tau, R };
    }

    // Weights of the landscape regions at a point (they sum to 1).
    regionWeights(x, y) {
      if (this.region >= 0) return REGIONS.map((r, k) => (k === this.region ? 1 : 0));
      const L = L_REGION * this.scale;
      const a = fbm(this.nRegionA, x / L, y / L, 3) / FBM_STD[3], b = fbm(this.nRegionB, x / L, y / L, 3) / FBM_STD[3];
      const w = REGIONS.map((r) => Math.exp(-((a - r.at[0]) ** 2 + (b - r.at[1]) ** 2) / (2 * REGION_SPREAD * REGION_SPREAD)));
      const sum = w.reduce((p, q) => p + q, 0) || 1;
      return w.map((v) => v / sum);
    }

    // Blended region settings at a point, as {sea, hills, ..., weights}. Worked
    // out at section centres and interpolated between them (the regions are huge).
    // The four surrounding centres are kept between calls, since neighbouring
    // points ask for the same ones.
    regionParams(x, y) {
      const u = x / SECTION_M - 0.5, v = y / SECTION_M - 0.5;
      const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
      if (i !== this.rci || j !== this.rcj) {
        this.rci = i;
        this.rcj = j;
        this.rc = [this.regionAt(i, j), this.regionAt(i + 1, j), this.regionAt(i, j + 1), this.regionAt(i + 1, j + 1)];
      }
      const [p00, p10, p01, p11] = this.rc;
      const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
      const val = (k) => p00[k] * w00 + p10[k] * w10 + p01[k] * w01 + p11[k] * w11;
      const NP = PARAMS.length;
      return {
        sea: val(0), hills: val(1), plateau: val(2), pLift: val(3), mount: val(4), mLift: val(5), mSea: val(6),
        relief: val(7), shelf: val(8), rise: val(9), cliff: val(10), fjord: val(11), lakes: val(12), sounds: val(13),
        wet: val(14), delta: val(15), streams: val(16),
        get weights() {
          return REGIONS.map((r, n) => val(NP + n));
        },
      };
    }

    // Region settings and weights at section centre (si, sj), cached.
    regionAt(si, sj) {
      const id = (si + 1048576) * 2097152 + (sj + 1048576);
      let p = this.regionCache.get(id);
      if (!p) {
        const w = this.regionWeights((si + 0.5) * SECTION_M, (sj + 0.5) * SECTION_M);
        p = new Float64Array(PARAMS.length + REGIONS.length);
        PARAMS.forEach((name, k) => {
          p[k] = REGIONS.reduce((sum, r, n) => sum + w[n] * r.p[name], 0);
        });
        w.forEach((wn, n) => (p[PARAMS.length + n] = wn));
        this.regionCache.set(id, p);
        if (this.regionCache.size > 100000) this.regionCache.clear();
      }
      return p;
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
      const R = L.R;
      // Base: sea floor falls away from the coast (gently on a shallow shelf), land
      // rises slowly inland; a hard coast rises in a cliff.
      let h = L.u < 0 ? 900 * R.shelf * L.u : R.rise * L.u + R.cliff * smoothstep(0, 0.12, L.u);
      h += 60 * L.hills * L.land;
      // Plateaus lift the land about 500-800 m and smooth it. The lift varies
      // slowly, so a plateau stays fairly level across.
      const lift = 650 + 80 * fbm(this.nPlateauH, x / (16000 * this.scale), y / (16000 * this.scale), 2) / FBM_STD[2];
      h += L.plateau * Math.max(300, lift) * R.pLift;
      // Rolling relief: plains are gentle, hills more, plateaus smoother again.
      let amp = 50 + (18 + 132 * L.hills - 50) * L.land;
      amp *= (1 - 0.65 * L.plateau) * rug * R.relief;
      if (minWavelength < 1800) h += fade(900) * amp * fbm(this.nHills, x / 900, y / 900, 4);
      // Mountains: lifted and ridged, on top of whatever they stand on.
      // The ridges are centred on their mean, so peaks and valleys shape the range
      // rather than one smooth tent along it.
      if (L.mount > 0) h += L.mount * R.mLift * (150 + 1500 * (0.4 + 0.6 * r) * (ridged(this.nRidge, x / 1400, y / 1400, 5) - 0.45));
      // Fjords: a network of valleys (ridged, 6 km) cut down to a floor that lies
      // below the sea near the coast and rises inland, so the valleys fill with
      // sea where they meet it.
      if (R.fjord > 0.01) {
        const valley = smoothstep(0.66, 0.9, ridged(this.nFjord, x / (6000 * this.scale), y / (6000 * this.scale), 4));
        const floor = -140 + 520 * smoothstep(1.2, 4, L.u);
        if (h > floor) h -= R.fjord * valley * (h - floor);
      }
      // Lakes in low country: patches pushed just below 0 m.
      if (R.lakes > 0.01 && h > 0) {
        const z = fbm(this.nLakes, x / (1400 * this.scale), y / (1400 * this.scale), 3) / FBM_STD[3];
        const lake = R.lakes * smoothstep(0.9, 1.5, z) * (1 - smoothstep(150, 400, h)) * L.land;
        h -= lake * (h + 12);
      }
      // Rugged anomalies: knolls, skerries and gullies wherever ruggedness is high.
      if (r > 0.7 && minWavelength < 700) h += fade(350) * 140 * smoothstep(0.7, 0.95, r) * (2 * ridged(this.nAnomaly, x / 350, y / 350, 3) - 1);
      if (minWavelength < 220) h += fade(110) * (2 + 0.06 * amp) * fbm(this.nDetail, x / 110, y / 110, 3);
      return H_MAX * Math.tanh(h / H_MAX);
    }

    // Moisture [0, 0.9]. Water (below 0 m) is always 1. Streams add more later.
    moisture(x, y, elevation) {
      if (elevation < 0) return 1;
      let m = 0.5 + 0.45 * fbm(this.nMoist, x / 20000, y / 20000, 3) + 0.3 * fbm(this.nMoistLocal, x / 700, y / 700, 3);
      m += this.regionParams(x, y).wet;
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
  M.REGIONS = REGIONS;
  M.BOUNDS = BOUNDS;
  M.util = { clamp01, smoothstep };
})(window.Markr = window.Markr || {});
