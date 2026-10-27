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

      // Coarse height: the terrain smoothed over about a section (`coarse`
      // metres). Its contours give the general slope of a section and its
      // neighbours, the section's rotation.
      const rc = Math.max(1, Math.round((opts.coarse ?? 128) / res / 2));
      this.hc = blur(blur(this.h, nx, ny, rc), nx, ny, rc);
      // Slope smoothed the same way, for cell sizes at section level.
      this.slopeC = blur(blur(this.slope, nx, ny, rc), nx, ny, rc);

      // Ridges and valleys, from the lightly smoothed height. Along a contour
      // (direction t), the height curves down on a ridge and up in a valley; the
      // ridge or valley line is where the cross term of the curvature (along t
      // and across, n) is zero. F holds that cross term; RK holds the curvature
      // along the contour (negative on ridges, positive in valleys).
      const hs = blur(this.h, nx, ny, 2);
      this.F = new Float32Array(n);
      this.RK = new Float32Array(n);
      const H = (xx, yy) => hs[Math.max(0, Math.min(ny - 1, yy)) * nx + Math.max(0, Math.min(nx - 1, xx))];
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const k = y * nx + x;
          const hx = (H(x + 1, y) - H(x - 1, y)) / (2 * res), hy = (H(x, y + 1) - H(x, y - 1)) / (2 * res);
          const g = Math.hypot(hx, hy);
          if (g < 1e-4 || hs[k] < 0) continue;
          const hxx = (H(x + 1, y) - 2 * hs[k] + H(x - 1, y)) / (res * res);
          const hyy = (H(x, y + 1) - 2 * hs[k] + H(x, y - 1)) / (res * res);
          const hxy = (H(x + 1, y + 1) - H(x + 1, y - 1) - H(x - 1, y + 1) + H(x - 1, y - 1)) / (4 * res * res);
          const nxv = hx / g, nyv = hy / g, tx = -nyv, ty = nxv;
          this.F[k] = tx * (hxx * nxv + hxy * nyv) + ty * (hxy * nxv + hyy * nyv);
          this.RK[k] = tx * tx * hxx + 2 * tx * ty * hxy + ty * ty * hyy;
        }
      }
    }

    // Bilinear sample of one raster at world point (x, y).
    samp(arr, x, y) {
      let fx = (x - this.x0) / this.res, fy = (y - this.y0) / this.res;
      fx = Math.max(0, Math.min(this.nx - 1.001, fx));
      fy = Math.max(0, Math.min(this.ny - 1.001, fy));
      const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
      const k = j * this.nx + i, nx = this.nx;
      return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - ty) + (arr[k + nx] * (1 - tx) + arr[k + nx + 1] * tx) * ty;
    }

    // A raster's value and gradient at (x, y).
    gradOf(arr, x, y) {
      const r = this.res;
      return [this.samp(arr, x, y), (this.samp(arr, x + r, y) - this.samp(arr, x - r, y)) / (2 * r), (this.samp(arr, x, y + r) - this.samp(arr, x, y - r)) / (2 * r)];
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

  // Box blur of a raster, radius r samples, applied along x then y.
  function blur(src, nx, ny, r) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let s = 0, m = 0;
        for (let d = -r; d <= r; d++) {
          const xx = x + d;
          if (xx < 0 || xx >= nx) continue;
          s += src[y * nx + xx];
          m++;
        }
        tmp[y * nx + x] = s / m;
      }
    }
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let s = 0, m = 0;
        for (let d = -r; d <= r; d++) {
          const yy = y + d;
          if (yy < 0 || yy >= ny) continue;
          s += tmp[yy * nx + x];
          m++;
        }
        out[y * nx + x] = s / m;
      }
    }
    return out;
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

  // Grid with jumps, in two levels.
  //
  // Level 1, sections: the corners of the sections are placed first, with a
  // weighted Laplacian on the coarse lattice of section corners, so sections are
  // smaller where the land is steep and larger where it is flat. The vertices
  // inside a section start on the straight lines between its corners. This
  // gives the sections irregular shapes.
  //
  // Level 2, lines and jumps. The lines that matter, strongest first:
  //   coast (0 m), ridges and steep valleys, a set of contours every `step` m
  //   (spread to at least two cells apart), and the contours of the coarse
  //   height (the general slope of a section and its neighbours: the section's
  //   rotation). Each kind has its own thresholds: how long a grid line follows
  //   it before it may jump (`run`), and how far it may move to do so (`reach`).
  // Pass 1 follows the lines: in strips of `run` cells the grid line nearest a
  //   line at the middle of the strip takes it all along, within `reach`; at the
  //   next strip the line may pass to another grid line (a jump). Next to a
  //   jump the vertices move toward it, so the jump cell is narrower.
  // Check: where two line vertices in one column (or row) would come too close
  //   or cross, the weaker one lets go. This is what folded cells at jumps.
  // Pass 2 moves every other vertex between the nearest lines on either side,
  //   in its own column and the two next to it (weighted 1, 2, 1), so whole
  //   slopes bend with their lines, smoothly, in one pass.
  // Every vertex depends only on the terrain around it: no seams.
  function snapGrid(field, opts) {
    const t0 = performance.now();
    const { i0, j0, sections, cells } = opts;
    const N = sections * cells, row = N + 1;
    const K = opts.reachOut;
    const MG = K + 2, R = N + 1 + 2 * MG, at = (a, b) => (b + MG) * R + (a + MG);

    // --- level 1: section corners -------------------------------------------
    const SM = Math.ceil(MG / cells) + 1; // sections of margin
    const ns = sections + 2 * SM, crow = ns + 1;
    const CX = new Float64Array(crow * crow), CY = new Float64Array(crow * crow);
    for (let q = 0; q <= ns; q++) {
      for (let p = 0; p <= ns; p++) {
        CX[q * crow + p] = i0 + (p - SM) * cells;
        CY[q * crow + p] = j0 + (q - SM) * cells;
      }
    }
    const sz = opts.sizeStrength;
    if (sz > 0) {
      const dens = (x, y) => Math.exp(sz * Math.min(1, field.samp(field.slopeC, x * C, y * C) / 0.4));
      for (let it = 0; it < 200; it++) {
        for (let q = 1; q < ns; q++) {
          for (let p = 1; p < ns; p++) {
            const k = q * crow + p;
            let sx = 0, sy = 0, sw = 0;
            for (const kn of [k - 1, k + 1, k - crow, k + crow]) {
              const w = dens((CX[k] + CX[kn]) / 2, (CY[k] + CY[kn]) / 2);
              sx += w * CX[kn];
              sy += w * CY[kn];
              sw += w;
            }
            CX[k] = sx / sw;
            CY[k] = sy / sw;
          }
        }
      }
    }
    // Base position of every vertex: bilinear between its section's corners.
    const BX = new Float64Array(R * R), BY = new Float64Array(R * R);
    for (let b = -MG; b <= N + MG; b++) {
      for (let a = -MG; a <= N + MG; a++) {
        const p = Math.floor(a / cells) + SM, q = Math.floor(b / cells) + SM;
        const u = a / cells - Math.floor(a / cells), v = b / cells - Math.floor(b / cells);
        const k = q * crow + p;
        const top = [CX[k] + (CX[k + 1] - CX[k]) * u, CY[k] + (CY[k + 1] - CY[k]) * u];
        const bot = [CX[k + crow] + (CX[k + crow + 1] - CX[k + crow]) * u, CY[k + crow] + (CY[k + crow + 1] - CY[k + crow]) * u];
        BX[at(a, b)] = top[0] + (bot[0] - top[0]) * v;
        BY[at(a, b)] = top[1] + (bot[1] - top[1]) * v;
      }
    }

    // --- level 2: line families ---------------------------------------------
    const minSlope = opts.minSlope, step = opts.step;
    const heightGrad = (x, y) => field.heightGrad(x, y);
    const fams = [
      { prio: 3, run: opts.coastRun, reach: opts.coastReach, f: heightGrad, levels: () => [0], weight: () => 1 },
    ];
    if (opts.ridges > 0) {
      const k0 = opts.curvature;
      fams.push({
        prio: 2, run: opts.ridgeRun, reach: opts.ridgeReach,
        f: (x, y) => field.gradOf(field.F, x, y),
        levels: () => [0],
        // Ridges by their curvature; valleys only where they are also steep.
        weight: (x, y, g) => {
          const rk = field.samp(field.RK, x, y);
          const w = smoothstep(k0, 2 * k0, Math.abs(rk));
          return opts.ridges * (rk < 0 ? w : w * smoothstep(minSlope, 0.3, g));
        },
      });
    }
    fams.push({
      prio: 1, run: opts.run, reach: opts.reach, f: heightGrad,
      levels: (v, g) => {
        if (v <= 0 || g <= minSlope) return [];
        let s = step;
        while (s / g < 2 * C) s *= 2;
        return [Math.floor(v / s) * s, Math.ceil(v / s) * s].filter((L) => L > 0);
      },
      // Steep contours are followed further than gentle ones.
      weight: (x, y, g) => smoothstep(minSlope, minSlope * 2, g),
      reachFor: (g) => opts.reach * (0.7 + 0.5 * smoothstep(minSlope, 0.6, g)),
    });
    if (opts.slopeLines > 0) {
      const D = opts.slopeSpacing;
      fams.push({
        prio: 0, run: opts.run, reach: opts.slopeReach,
        f: (x, y) => field.gradOf(field.hc, x, y),
        levels: (v, g) => {
          if (g < 0.005) return [];
          let s = 1;
          while (s / g < D * C) s *= 2;
          return [Math.floor(v / s) * s, Math.ceil(v / s) * s];
        },
        weight: (x, y, g) => opts.slopeLines * smoothstep(0.005, 0.03, g),
      });
    }

    // Where level L of field f crosses the line through (x, y): along y with x
    // fixed (rows) or along x with y fixed (columns). Newton steps, in metres.
    const crossing = (f, x, y, L, alongY) => {
      let p = alongY ? y : x;
      for (let it = 0; it < 6; it++) {
        const [v, gx, gy] = alongY ? f(x, p) : f(p, y);
        const d = alongY ? gy : gx;
        if (Math.abs(d) < 1e-6) return null;
        const dp = Math.max(-2 * C, Math.min(2 * C, -(v - L) / d));
        p += dp;
        if (Math.abs(dp) < 0.05) return Math.abs(p - (alongY ? y : x)) < 3 * C ? p : null;
      }
      return null;
    };
    // Which grid line owns level L of family `fm` in the strip around index
    // `mid` (along), for the grid line `own` (across). Positions are measured
    // against the base grid. Returns the owning index, or null.
    const ownerAt = (fm, L, rows, mid, own) => {
      const k = rows ? at(mid, own) : at(own, mid);
      const x = BX[k] * C, y = BY[k] * C;
      const pm = crossing(fm.f, x, y, L, rows);
      if (pm === null) return null;
      const kn = rows ? at(mid, own + 1) : at(own + 1, mid);
      const sp = rows ? (BY[kn] - BY[k]) * C : (BX[kn] - BX[k]) * C;
      return own + Math.round((pm - (rows ? y : x)) / sp);
    };

    const SX = new Float64Array(R * R), SY = new Float64Array(R * R);
    const AX = new Float64Array(R * R), AY = new Float64Array(R * R); // narrowing at jumps
    const lvl = new Float64Array(R * R).fill(NaN), fam = new Uint8Array(R * R), pri = new Int8Array(R * R).fill(-1);
    const narrow = opts.narrow;
    const lim = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    for (let b = -MG; b < N + MG; b++) {
      for (let a = -MG; a < N + MG; a++) {
        const k = at(a, b), x = BX[k] * C, y = BY[k] * C;
        let best = null;
        for (const fm of fams) {
          if (best && best.prio > fm.prio) break; // a stronger kind already holds
          const [v, gx, gy] = fm.f(x, y);
          const g = Math.hypot(gx, gy);
          if (g < 1e-6) continue;
          const w = fm.weight(x, y, g);
          if (w < 0.05) continue;
          const rows = Math.abs(gy) >= Math.abs(gx);
          const along = rows ? a : b, own = rows ? b : a;
          const s0 = Math.floor(along / fm.run) * fm.run, mid = lim(s0 + fm.run / 2, -MG, N + MG - 1);
          const reach = fm.reachFor ? fm.reachFor(g) : fm.reach;
          for (const L of fm.levels(v, g)) {
            if (ownerAt(fm, L, rows, mid, own) !== own) continue;
            const pv = crossing(fm.f, x, y, L, rows);
            if (pv === null) continue;
            const kn = rows ? at(a, b + 1) : at(a + 1, b);
            const sp = rows ? BY[kn] - BY[k] : BX[kn] - BX[k];
            const d = (pv / C - (rows ? BY[k] : BX[k])) / sp; // in local cells
            if (Math.abs(d) > reach) continue; // the line gives up here
            if (!best || fm.prio > best.prio || Math.abs(d) < Math.abs(best.d)) {
              best = { prio: fm.prio, L, d: d * sp, w, rows, fm, along, own, s0, sp };
            }
          }
        }
        if (!best) continue;
        const { rows, d, w, fm, along, own, s0, L } = best;
        SX[k] = rows ? 0 : opts.pull * w * d;
        SY[k] = rows ? opts.pull * w * d : 0;
        lvl[k] = best.prio * 100000 + L;
        fam[k] = rows ? 1 : 2;
        pri[k] = best.prio;
        // Narrower cells at a jump: if the line belongs to another grid line in
        // the strip before (or after), move this vertex toward the jump.
        if (narrow > 0 && fm.run >= 3) {
          const u = along - s0;
          let shift = 0;
          if (u === 0) {
            const prev = ownerAt(fm, L, rows, lim(s0 - fm.run / 2, -MG, N + MG - 1), own);
            if (prev !== own) shift = -narrow / 2;
          } else if (u === fm.run - 1) {
            const next = ownerAt(fm, L, rows, lim(s0 + fm.run + fm.run / 2, -MG, N + MG - 1), own);
            if (next !== own) shift = narrow / 2;
          }
          if (shift) {
            const kn = rows ? at(a + 1, b) : at(a, b + 1);
            const len = rows ? BX[kn] - BX[k] : BY[kn] - BY[k];
            if (rows) AX[k] = shift * len;
            else AY[k] = shift * len;
          }
        }
      }
    }

    // Check: two line vertices in one column (rows) or one row (columns) that
    // come closer than `gap` of a cell, or cross: the weaker lets go.
    const gap = opts.gap;
    const drop = (k) => {
      fam[k] = 0;
      lvl[k] = NaN;
      SX[k] = SY[k] = AX[k] = AY[k] = 0;
    };
    for (let b = -MG; b < N + MG; b++) {
      for (let a = -MG; a < N + MG; a++) {
        const k = at(a, b);
        for (const [kn, f, pos] of [[at(a, b + 1), 1, (q) => BY[q] + SY[q]], [at(a + 1, b), 2, (q) => BX[q] + SX[q]]]) {
          if (fam[k] !== f || fam[kn] !== f) continue;
          const base = f === 1 ? BY[kn] - BY[k] : BX[kn] - BX[k];
          if (pos(kn) - pos(k) >= gap * base) continue;
          if (pri[k] > pri[kn]) drop(kn);
          else drop(k);
        }
      }
    }

    // Pass 2: everything else, in one pass. Along a column, the nearest row line
    // above and below are interpolated linearly (or, with a line on one side
    // only, faded out over K cells); this is done for the column and the two
    // next to it, weighted 1, 2, 1. Columns lines likewise along rows.
    const between = (k, dk, f, D) => {
      if (fam[k] === f) return D[k];
      let up = -1, dn = -1, du = 0, dd = 0;
      for (let s = 1; s <= K; s++) {
        if (up < 0 && fam[k - s * dk] === f) {
          up = k - s * dk;
          du = s;
        }
        if (dn < 0 && fam[k + s * dk] === f) {
          dn = k + s * dk;
          dd = s;
        }
        if (up >= 0 && dn >= 0) break;
      }
      if (up >= 0 && dn >= 0) return (D[up] * dd + D[dn] * du) / (du + dd);
      if (up >= 0) return D[up] * Math.max(0, 1 - du / K);
      if (dn >= 0) return D[dn] * Math.max(0, 1 - dd / K);
      return 0;
    };
    const X = new Float64Array(row * row), Y = new Float64Array(row * row);
    const snapped = new Float64Array(row * row).fill(NaN);
    for (let b = 0; b <= N; b++) {
      for (let a = 0; a <= N; a++) {
        const k = at(a, b), o = b * row + a;
        const dy = fam[k] === 1 ? SY[k] : (between(k - 1, R, 1, SY) + 2 * between(k, R, 1, SY) + between(k + 1, R, 1, SY)) / 4;
        const dx = fam[k] === 2 ? SX[k] : (between(k - R, 1, 2, SX) + 2 * between(k, 1, 2, SX) + between(k + R, 1, 2, SX)) / 4;
        if (fam[k]) snapped[o] = lvl[k];
        X[o] = BX[k] + dx + AX[k];
        Y[o] = BY[k] + dy + AY[k];
      }
    }
    // Section corners in index units, and each section's rotation (degrees,
    // -45..45) from the coarse height at its middle.
    const rotations = [];
    for (let sy = 0; sy < sections; sy++) {
      for (let sx = 0; sx < sections; sx++) {
        const k = (sy + SM) * crow + sx + SM;
        const cx = (CX[k] + CX[k + 1] + CX[k + crow] + CX[k + crow + 1]) / 4, cy = (CY[k] + CY[k + 1] + CY[k + crow] + CY[k + crow + 1]) / 4;
        const [, gx, gy] = field.gradOf(field.hc, cx * C, cy * C);
        const th = Math.atan2(gy, gx) + Math.PI / 2;
        rotations.push({ cx, cy, angle: th - (Math.PI / 2) * Math.round(th / (Math.PI / 2)), slope: Math.hypot(gx, gy) });
      }
    }
    return { X, Y, row, N, i0, j0, time: performance.now() - t0, seam: 0, snapped, rotations };
  }

  M.snapGrid = snapGrid;
  M.TerrainField = TerrainField;
  M.solveGrid = solveGrid;
  M.buildGrid = buildGrid;
})(window.Markr = window.Markr || {});
