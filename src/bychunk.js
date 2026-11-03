// One chunk of the city window's cells: height (m on screen), class,
// firmness, land colour and main landscape type at each cell centre, from
// the grunn chain. Shared by the city window and its workers.
(function (M) {
  'use strict';

  M.BY_CHUNK = 32; // cells per side
  M.byChunk = function (chain, state, ci, cj) {
    const N = M.BY_CHUNK, n = N * N, C = 16, s = state.scaleH;
    const ch = { h: new Float32Array(n), cls: new Uint8Array(n), firm: new Float32Array(n), rgb: new Uint8Array(3 * n), type: new Uint8Array(n), cov: new Float32Array(n) };
    // The rivers per section must be built before they are read: without
    // them only the rivers worked out point by point show.
    const sec = chain.sections;
    if (sec) {
      const x0 = ci * N * C * s, x1 = (ci + 1) * N * C * s, y0 = cj * N * C * s, y1 = (cj + 1) * N * C * s;
      for (let sj = Math.floor(y0 / sec.size); sj <= Math.floor((y1 - 1) / sec.size); sj++) {
        for (let si = Math.floor(x0 / sec.size); si <= Math.floor((x1 - 1) / sec.size); si++) sec.build(si, sj);
      }
    }
    for (let b = 0; b < N; b++) {
      for (let a = 0; a < N; a++) {
        const i = ci * N + a, j = cj * N + b, q = b * N + a;
        const f = chain.fullCore((i + 0.5) * C * s, (j + 0.5) * C * s, true);
        ch.h[q] = f.h / state.scaleV;
        ch.cls[q] = f.cls;
        ch.firm[q] = f.region ? f.region.firm : 0.5;
        ch.cov[q] = f.tint || 0; // a river narrower than the cell: the share it covers
        const col = f.region ? M.RegionLayer.colour(f.region.w) : [214, 212, 206];
        ch.rgb[3 * q] = col[0];
        ch.rgb[3 * q + 1] = col[1];
        ch.rgb[3 * q + 2] = col[2];
        if (f.region) {
          let best = 0;
          for (let t = 1; t < f.region.w.length; t++) if (f.region.w[t] > f.region.w[best]) best = t;
          ch.type[q] = best;
        }
      }
    }
    return ch;
  };
  // The chain as the city window uses it: every layer, the section rivers,
  // and lattices fixed to the cell, so a height never depends on the zoom.
  M.byChain = function (state) {
    const on = { cont: true, basin: true, base: true, s1: true, inland: true, mid: true, stretch: true, firm: true, type: true, regStretch: true, dep: true, depStretch: true, river: true, sections: true, local: true, mount: true, cut: true, spring: true };
    M.Lattice.pixel = 32 * state.scaleH;
    M.Lattice.section = 16 * state.scaleH;
    return M.grunnChain(state, on, { lod: { river: true, dep: true, region: true, local: true }, pix: 16 * state.scaleH });
  };
})(window.Markr = window.Markr || {});
