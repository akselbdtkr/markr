// Seeded Perlin noise and fractal helpers.
(function (M) {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;

  function grad(h, x, y) {
    switch (h & 7) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  }

  // Integer hash of a lattice point. No permutation table, so the noise never
  // repeats: the map can continue in every direction.
  function hash2(seed, x, y) {
    let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }

  // Returns a function (x, y) -> roughly [-1, 1].
  function createPerlin(seed) {
    const s = (mulberry32(seed)() * 4294967296) | 0;
    return function (x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const u = fade(xf), v = fade(yf);
      const x1 = lerp(grad(hash2(s, xi, yi), xf, yf), grad(hash2(s, xi + 1, yi), xf - 1, yf), u);
      const x2 = lerp(grad(hash2(s, xi, yi + 1), xf, yf - 1), grad(hash2(s, xi + 1, yi + 1), xf - 1, yf - 1), u);
      return lerp(x1, x2, v);
    };
  }

  // Fractal Brownian motion: several octaves summed, normalised to about [-1, 1].
  function fbm(noise, x, y, octaves, lacunarity = 2, gain = 0.5) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x * freq + o * 17.31, y * freq - o * 9.73);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  // Ridged noise: sharp crests, used for mountain ridges. Range [0, 1].
  function ridged(noise, x, y, octaves, lacunarity = 2, gain = 0.5) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(noise(x * freq + o * 31.7, y * freq + o * 11.3));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  M.noise = { mulberry32, createPerlin, fbm, ridged };
})(window.Markr = window.Markr || {});
