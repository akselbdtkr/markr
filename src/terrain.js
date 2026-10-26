// Terrain: continuous fields defined for every world point (x, y).
// One world unit equals the nominal size of one base cell.
(function (M) {
  'use strict';

  const { createPerlin, fbm, ridged } = M.noise;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smoothstep = (a, b, v) => {
    const t = clamp01((v - a) / (b - a));
    return t * t * (3 - 2 * t);
  };

  class Terrain {
    constructor(seed) {
      this.seed = seed;
      this.nBase = createPerlin(seed * 7 + 1);
      this.nRidge = createPerlin(seed * 7 + 2);
      this.nHills = createPerlin(seed * 7 + 3);
      this.nRough = createPerlin(seed * 7 + 4);
      this.nMoist = createPerlin(seed * 7 + 5);
      this.nWarpX = createPerlin(seed * 7 + 6);
      this.nWarpY = createPerlin(seed * 7 + 7);
    }

    // Ruggedness layer [0, 1]: where the land is broken up.
    ruggedness(x, y) {
      return smoothstep(-0.3, 0.45, fbm(this.nRough, x / 45, y / 45, 3));
    }

    // Elevation [0, ~1]: broad landforms plus ridges where ruggedness is high.
    elevation(x, y) {
      const base = 0.5 + 0.5 * fbm(this.nBase, x / 60, y / 60, 4);
      const r = this.ruggedness(x, y);
      const ridges = ridged(this.nRidge, x / 16, y / 16, 4);
      const hills = fbm(this.nHills, x / 8, y / 8, 3);
      return 0.55 * base + 0.45 * r * ridges + 0.015 * (0.3 + r) * hills;
    }

    // Moisture layer [0, 1], drier with height.
    moisture(x, y, elevation) {
      const m = 0.5 + 0.65 * fbm(this.nMoist, x / 38, y / 38, 4);
      return clamp01(m - 0.35 * (elevation - 0.45));
    }

    gradient(x, y, h = 0.15) {
      return [
        (this.elevation(x + h, y) - this.elevation(x - h, y)) / (2 * h),
        (this.elevation(x, y + h) - this.elevation(x, y - h)) / (2 * h),
      ];
    }

    slope(x, y) {
      const [gx, gy] = this.gradient(x, y);
      return Math.hypot(gx, gy);
    }

    // Low-frequency vector field used to make grid lines wavy.
    warp(x, y) {
      return [this.nWarpX(x / 5.5, y / 5.5), this.nWarpY(x / 5.5, y / 5.5)];
    }

    sample(x, y) {
      const elevation = this.elevation(x, y);
      const [gx, gy] = this.gradient(x, y);
      return {
        elevation,
        moisture: this.moisture(x, y, elevation),
        ruggedness: this.ruggedness(x, y),
        slope: Math.hypot(gx, gy),
        gx,
        gy,
      };
    }
  }

  M.Terrain = Terrain;
  M.util = { clamp01, smoothstep };
})(window.Markr = window.Markr || {});
