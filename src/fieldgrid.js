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

    // Height and its gradient (m per m) at world point (x, y).
    heightGrad(x, y) {
      const r = this.res;
      const h = this.sample(x, y)[3];
      const gx = (this.sample(x + r, y)[3] - this.sample(x - r, y)[3]) / (2 * r);
      const gy = (this.sample(x, y + r)[3] - this.sample(x, y - r)[3]) / (2 * r);
      return [h, gx, gy];
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

  // Grid with jumps: every vertex is set by one local operation, so there are no
  // seams at all; a vertex depends only on the terrain around it.
  //
  // The lines that matter are the coast (0 m) and a set of contours, every
  // `step` metres. Where those lie closer than two cells, every second (or
  // fourth ...) is used instead, so the lines stay spread out.
  //
  // 1. Snap. For each vertex, the distance to the nearest line, measured along
  //    the slope, refined with one Newton step. Moving one vertex along the
  //    grid changes that distance by `sigma` (the cell size times the larger
  //    component of the slope direction), so exactly one vertex per row across
  //    the line is within sigma / 2 of it: that vertex is snapped onto the line.
  //    As the line drifts across the grid, the nearest vertex changes to the
  //    next row, and the neighbouring grid line takes the line over: a jump. A
  //    vertex never moves more than half a cell, so turning stays within
  //    +-45 degrees and nothing adds up over distance.
  // 2. Weight. A line only pulls where it is clear: the coast always, contours
  //    where the slope is above `minSlope`. `pull` scales the snap.
  // 3. Neighbours. A vertex that is not on a line takes a weighted mean of how
  //    far its 8 neighbours moved (edge neighbours count twice the diagonal
  //    ones), times `spread`, so rows bend round the snapped vertices and cells
  //    turn with them.
  function snapGrid(field, opts) {
    const t0 = performance.now();
    const { i0, j0, sections, cells } = opts;
    const N = sections * cells, row = N + 1;
    // One extra ring of vertices round the map, for the neighbour step.
    const R = N + 3, at = (a, b) => (b + 1) * R + (a + 1);
    const SX = new Float64Array(R * R), SY = new Float64Array(R * R), lvl = new Float64Array(R * R).fill(NaN);
    const step = opts.step, minSlope = opts.minSlope, pull = opts.pull;
    const RUN = opts.run, T = opts.reach;
    // Where line L crosses the grid line through (x, y): along y with x fixed
    // (rows), or along x with y fixed (columns). Newton steps; null if it does
    // not converge within a few cells.
    const crossing = (x, y, L, alongY) => {
      let p = alongY ? y : x;
      for (let it = 0; it < 6; it++) {
        const [h, gx, gy] = alongY ? field.heightGrad(x, p) : field.heightGrad(p, y);
        const d = alongY ? gy : gx;
        if (Math.abs(d) < 1e-4) return null;
        const dp = Math.max(-2 * C, Math.min(2 * C, -(h - L) / d));
        p += dp;
        if (Math.abs(dp) < 0.05) return Math.abs(p - (alongY ? y : x)) < 3 * C ? p : null;
      }
      return null;
    };
    for (let b = -1; b <= N + 1; b++) {
      for (let a = -1; a <= N + 1; a++) {
        const x = (i0 + a) * C, y = (j0 + b) * C;
        const [h, gx, gy] = field.heightGrad(x, y);
        const g = Math.hypot(gx, gy);
        if (g < 1e-4) continue;
        // Lines running mostly along the rows are taken by rows (moved up or
        // down), the others by columns (moved sideways).
        const rows = Math.abs(gy) >= Math.abs(gx);
        // Candidate lines: the coast, and the two nearest contours of the set,
        // spread to at least two cells apart.
        const cands = [[0, 1]];
        if (h > 0 && g > minSlope) {
          let s = step;
          while (s / g < 2 * C) s *= 2;
          const w = smoothstep(minSlope, minSlope * 2, g);
          for (const Ln of [Math.floor(h / s) * s, Math.ceil(h / s) * s]) if (Ln > 0) cands.push([Ln, w]);
        }
        // This grid line runs in strips of RUN cells, fixed in index space. In
        // each strip, the line that is nearest the contour at the middle of the
        // strip owns it all the way along; at the next strip it may pass to
        // another line: a jump.
        const along = rows ? a : b, own = rows ? b : a;
        const mid = Math.floor(along / RUN) * RUN + RUN / 2;
        let best = null;
        for (const [L, w] of cands) {
          const pm = rows ? crossing((i0 + mid) * C, y, L, true) : crossing(x, (j0 + mid) * C, L, false);
          if (pm === null) continue;
          const owner = Math.round(pm / C - (rows ? j0 : i0));
          if (owner !== own) continue;
          const pv = rows ? crossing(x, y, L, true) : crossing(x, y, L, false);
          if (pv === null) continue;
          const d = pv / C - (rows ? j0 + b : i0 + a);
          // Beyond `reach` cells the line gives up here.
          if (Math.abs(d) > T) continue;
          if (!best || L === 0 || Math.abs(d) < Math.abs(best[1])) best = [L, d, w];
          if (L === 0) break;
        }
        if (!best) continue;
        const k = at(a, b);
        const [L, d, w] = best;
        SX[k] = rows ? 0 : pull * w * d;
        SY[k] = rows ? pull * w * d : 0;
        lvl[k] = L;
      }
    }
    const X = new Float64Array(row * row), Y = new Float64Array(row * row);
    const snapped = new Float64Array(row * row).fill(NaN);
    const spread = opts.spread;
    for (let b = 0; b <= N; b++) {
      for (let a = 0; a <= N; a++) {
        const k = at(a, b), o = b * row + a;
        let dx = SX[k], dy = SY[k];
        if (Number.isNaN(lvl[k])) {
          let sx = 0, sy = 0, sw = 0;
          for (let db = -1; db <= 1; db++) {
            for (let da = -1; da <= 1; da++) {
              if (!da && !db) continue;
              const kn = at(a + da, b + db), wn = da && db ? 1 : 2;
              if (Number.isNaN(lvl[kn])) continue;
              sx += wn * SX[kn];
              sy += wn * SY[kn];
              sw += wn;
            }
          }
          // Mean over the snapped neighbours, scaled by how many there are.
          if (sw) {
            const f = (spread * sw) / 12;
            dx = (sx / sw) * f;
            dy = (sy / sw) * f;
          }
        } else {
          snapped[o] = lvl[k];
        }
        X[o] = i0 + a + dx;
        Y[o] = j0 + b + dy;
      }
    }
    return { X, Y, row, N, i0, j0, time: performance.now() - t0, seam: 0, snapped };
  }

  M.snapGrid = snapGrid;
  M.TerrainField = TerrainField;
  M.solveGrid = solveGrid;
  M.buildGrid = buildGrid;
})(window.Markr = window.Markr || {});
