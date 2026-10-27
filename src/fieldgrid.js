// A grid that follows the terrain.
//
// 1. Cross field. From the terrain we build, on a raster, the direction of the
//    contour lines. A grid cell looks the same turned by 90 degrees, so the
//    direction is kept at four times its angle, as the vector (cos 4a, sin 4a),
//    scaled by how clear the line is (how steep, or how close to the coast).
//    The vectors are then smoothed: where lines are clear they hold, in flat
//    land they take over from their surroundings.
//
// 2. Grid. The grid keeps its plain matrix of cells. Every edge gets a target:
//    the index direction it stands for (right or down), turned by the field and
//    shortened where it is steep. The vertices are placed so that all edges come
//    as close to their targets as possible together (least squares), so when one
//    edge turns it drags its neighbours along. A weak anchor pulls each vertex
//    toward its place in the plain grid.
//
// 3. Sections. The anchor makes the solution local: the pull of a far vertex
//    fades with distance (over about 1 / sqrt(anchor) cells). A section solved
//    on its own, with a buffer of cells around it, comes out close to the
//    solution for the whole map, with no seams fixed in advance, and the same
//    whatever order sections are made in. Measured, it is not close enough yet:
//    turning and shrinking add up to large displacements, and shared vertices
//    still differ by several metres unless the buffer is very wide.
(function (M) {
  'use strict';

  const { smoothstep } = M.util;
  const C = M.CELL_SIZE;

  class TerrainField {
    // A raster over [x0, x0 + w] x [y0, y0 + h] metres, `res` metres per sample.
    constructor(terrain, x0, y0, w, h, res, opts = {}) {
      this.terrain = terrain;
      this.x0 = x0;
      this.y0 = y0;
      this.res = res;
      const nx = (this.nx = Math.ceil(w / res) + 1), ny = (this.ny = Math.ceil(h / res) + 1);
      const n = nx * ny;
      this.h = new Float32Array(n);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) this.h[y * nx + x] = terrain.elevation(x0 + x * res, y0 + y * res);
      }
      this.slope = new Float32Array(n);
      const dataX = new Float32Array(n), dataY = new Float32Array(n), weight = new Float32Array(n);
      const lineSlope = opts.lineSlope ?? 0.25; // slope at which a line counts as fully clear
      const at = (x, y) => this.h[Math.max(0, Math.min(ny - 1, y)) * nx + Math.max(0, Math.min(nx - 1, x))];
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const k = y * nx + x;
          // Under water only the coast matters, so the sea floor counts as flat.
          const hl = (xx, yy) => Math.max(-3, at(xx, yy));
          const gx = (hl(x + 1, y) - hl(x - 1, y)) / (2 * res), gy = (hl(x, y + 1) - hl(x, y - 1)) / (2 * res);
          const g = Math.hypot(gx, gy);
          this.slope[k] = at(x, y) < 0 ? 0 : g;
          if (g < 1e-6) continue;
          const coast = Math.exp(-Math.abs(at(x, y)) / 4);
          const w0 = Math.min(1, smoothstep(0, lineSlope, g) + coast);
          const a = 4 * Math.atan2(gy, gx);
          dataX[k] = Math.cos(a);
          dataY[k] = Math.sin(a);
          weight[k] = w0;
        }
      }
      // Smooth: each sample is a blend of its own line (held by its weight) and
      // the mean of its neighbours. `smoothing` sets how far lines reach out.
      const lambda = opts.smoothing ?? 1;
      let vx = Float32Array.from(dataX, (v, k) => v * weight[k]), vy = Float32Array.from(dataY, (v, k) => v * weight[k]);
      const iters = Math.round(20 + 60 * lambda);
      for (let it = 0; it < iters; it++) {
        const nxv = new Float32Array(n), nyv = new Float32Array(n);
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++) {
            const k = y * nx + x;
            let sx = 0, sy = 0, m = 0;
            if (x > 0) (sx += vx[k - 1]), (sy += vy[k - 1]), m++;
            if (x < nx - 1) (sx += vx[k + 1]), (sy += vy[k + 1]), m++;
            if (y > 0) (sx += vx[k - nx]), (sy += vy[k - nx]), m++;
            if (y < ny - 1) (sx += vx[k + nx]), (sy += vy[k + nx]), m++;
            const w = weight[k];
            nxv[k] = (w * dataX[k] + lambda * (sx / m)) / (w + lambda);
            nyv[k] = (w * dataY[k] + lambda * (sy / m)) / (w + lambda);
          }
        }
        vx = nxv;
        vy = nyv;
      }
      this.vx = vx;
      this.vy = vy;
    }

    // Bilinear sample at world point (x, y) metres: [vx, vy, slope, h].
    sample(x, y) {
      let fx = (x - this.x0) / this.res, fy = (y - this.y0) / this.res;
      fx = Math.max(0, Math.min(this.nx - 1.001, fx));
      fy = Math.max(0, Math.min(this.ny - 1.001, fy));
      const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
      const k = j * this.nx + i, nx = this.nx;
      const b = (a) => (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + nx] * (1 - tx) + a[k + nx + 1] * tx) * ty;
      return [b(this.vx), b(this.vy), b(this.slope), b(this.h)];
    }

    // Line direction (radians, -45..45 degrees) and how clear it is (0..1).
    direction(x, y) {
      const [vx, vy] = this.sample(x, y);
      return [Math.atan2(vy, vx) / 4, Math.min(1, Math.hypot(vx, vy))];
    }
  }

  // Solves the vertices of cells [a0, a0 + na) x [b0, b0 + nb) (index units).
  // p: {align, size, anchor, iters}. Returns {X, Y} (index units), (na+1) x (nb+1).
  function solveGrid(field, a0, b0, na, nb, p) {
    const row = na + 1, n = row * (nb + 1);
    const X = new Float64Array(n), Y = new Float64Array(n);
    for (let b = 0; b <= nb; b++) {
      for (let a = 0; a <= na; a++) {
        X[b * row + a] = a0 + a;
        Y[b * row + a] = b0 + b;
      }
    }
    const mu = p.anchor, align = p.align, size = p.size;
    // Targets of the edges to the right (H) and down (V) from every vertex. They
    // depend on where the edge is, so they are worked out again every few sweeps.
    const HX = new Float64Array(n), HY = new Float64Array(n), VX = new Float64Array(n), VY = new Float64Array(n);
    const target = (k, m, dx, dy, OX, OY) => {
      const mx = ((X[k] + X[m]) / 2) * C, my = ((Y[k] + Y[m]) / 2) * C;
      const [vx, vy, slope] = field.sample(mx, my);
      const s = Math.min(1, Math.hypot(vx, vy));
      let th = Math.atan2(vy, vx) / 4;
      // Of the four equivalent directions, take the one nearest the edge as it is,
      // so an edge never flips to its neighbour's direction.
      const ex = X[m] - X[k], ey = Y[m] - Y[k];
      const cur = Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey);
      th += (Math.PI / 2) * Math.round((cur - th) / (Math.PI / 2));
      th *= Math.min(1, align * Math.min(1, 2 * s));
      const L = 1 / (1 + size * Math.min(1, slope / 0.5));
      const c = Math.cos(th), sn = Math.sin(th);
      OX[k] = L * (c * dx - sn * dy);
      OY[k] = L * (sn * dx + c * dy);
    };
    const refresh = () => {
      for (let b = 0; b <= nb; b++) {
        for (let a = 0; a <= na; a++) {
          const k = b * row + a;
          if (a < na) target(k, k + 1, 1, 0, HX, HY);
          if (b < nb) target(k, k + row, 0, 1, VX, VY);
        }
      }
    };
    for (let it = 0; it < p.iters; it++) {
      if (it % 8 === 0) refresh();
      let maxMove = 0;
      for (let b = 0; b <= nb; b++) {
        for (let a = 0; a <= na; a++) {
          const k = b * row + a;
          let sx = mu * (a0 + a), sy = mu * (b0 + b), w = mu;
          // Each neighbour, minus the target of the edge to it.
          if (a > 0) {
            sx += X[k - 1] + HX[k - 1];
            sy += Y[k - 1] + HY[k - 1];
            w++;
          }
          if (a < na) {
            sx += X[k + 1] - HX[k];
            sy += Y[k + 1] - HY[k];
            w++;
          }
          if (b > 0) {
            sx += X[k - row] + VX[k - row];
            sy += Y[k - row] + VY[k - row];
            w++;
          }
          if (b < nb) {
            sx += X[k + row] - VX[k];
            sy += Y[k + row] - VY[k];
            w++;
          }
          const nxp = sx / w, nyp = sy / w;
          maxMove = Math.max(maxMove, Math.abs(nxp - X[k]), Math.abs(nyp - Y[k]));
          X[k] = nxp;
          Y[k] = nyp;
        }
      }
      if (maxMove < 1e-5) break;
    }
    return { X, Y };
  }

  // The map: `sections` x `sections` sections of `cells` x `cells` cells, from
  // cell (i0, j0). mode 'global' solves it all at once (with a buffer round the
  // edge); mode 'sections' solves each section on its own with `buffer` cells
  // around it, and shared vertices take the mean of the sections that have them.
  function buildGrid(field, opts) {
    const { i0, j0, sections, cells, buffer } = opts;
    const N = sections * cells, row = N + 1;
    const X = new Float64Array(row * row), Y = new Float64Array(row * row), cnt = new Uint8Array(row * row);
    const FX = new Float64Array(row * row), FY = new Float64Array(row * row);
    // Where sections share a vertex: the largest distance between their answers.
    let seam = 0;
    const take = (sol, a0, b0, na, nb, ca0, cb0, cna, cnb) => {
      const srow = na + 1;
      for (let b = 0; b <= cnb; b++) {
        for (let a = 0; a <= cna; a++) {
          const sk = (cb0 - b0 + b) * srow + (ca0 - a0 + a);
          const k = (cb0 - j0 + b) * row + (ca0 - i0 + a);
          if (cnt[k]) seam = Math.max(seam, Math.hypot(sol.X[sk] - FX[k], sol.Y[sk] - FY[k]));
          else {
            FX[k] = sol.X[sk];
            FY[k] = sol.Y[sk];
          }
          X[k] += sol.X[sk];
          Y[k] += sol.Y[sk];
          cnt[k]++;
        }
      }
    };
    const t0 = performance.now();
    if (opts.mode === 'global') {
      const B = buffer;
      const sol = solveGrid(field, i0 - B, j0 - B, N + 2 * B, N + 2 * B, opts);
      take(sol, i0 - B, j0 - B, N + 2 * B, N + 2 * B, i0, j0, N, N);
    } else {
      for (let sy = 0; sy < sections; sy++) {
        for (let sx = 0; sx < sections; sx++) {
          const ca0 = i0 + sx * cells, cb0 = j0 + sy * cells, B = buffer;
          const sol = solveGrid(field, ca0 - B, cb0 - B, cells + 2 * B, cells + 2 * B, opts);
          take(sol, ca0 - B, cb0 - B, cells + 2 * B, cells + 2 * B, ca0, cb0, cells, cells);
        }
      }
    }
    for (let k = 0; k < X.length; k++) {
      X[k] /= cnt[k];
      Y[k] /= cnt[k];
    }
    return { X, Y, row, N, i0, j0, time: performance.now() - t0, seam };
  }

  M.TerrainField = TerrainField;
  M.solveGrid = solveGrid;
  M.buildGrid = buildGrid;
})(window.Markr = window.Markr || {});
