// The grid: a plain matrix of cells in index space, deformed in world space.
//
// Index space: cell (i, j) is the unit square [i, i+1] x [j, j+1], vertex (a, b)
// sits at (a, b). Topology never changes: every base cell has exactly four
// neighbours (i±1, j) and (i, j±1), and the grid is always contiguous.
//
// World space: vertices are moved so that cells shrink where the terrain is steep
// and grow where it is flat. Each vertex is relaxed toward a weighted average of
// its four neighbours, where the weight is the terrain "density" on the edge
// between them. With a fixed convex boundary and positive weights this is a
// Tutte embedding, so cells can never fold over or overlap.
(function (M) {
  'use strict';

  const { clamp01, smoothstep } = M.util;
  const bell = (v, mid, width) => Math.exp(-((v - mid) * (v - mid)) / (2 * width * width));

  class Cell {
    constructor(grid, i, j, level, parent, rect) {
      this.grid = grid;
      this.i = i; // matrix index (at this level)
      this.j = j;
      this.level = level; // 0 = base cell, 1 = quarter of a base cell, ...
      this.parent = parent;
      this.base = parent ? parent.base : this;
      // Position inside the base cell in its local (u, v) space, [u0, v0, u1, v1].
      this.rect = rect;
      this.children = null;
      this.values = null;
    }

    get isLeaf() {
      return this.children === null;
    }

    // Corners TL, TR, BR, BL in world space, for a morph t between index (0) and world (1).
    corners(t = 1) {
      const [u0, v0, u1, v1] = this.rect;
      const g = this.grid;
      const b = this.base;
      const q = [
        g.vertex(b.i, b.j, t),
        g.vertex(b.i + 1, b.j, t),
        g.vertex(b.i + 1, b.j + 1, t),
        g.vertex(b.i, b.j + 1, t),
      ];
      return [bilinear(q, u0, v0), bilinear(q, u1, v0), bilinear(q, u1, v1), bilinear(q, u0, v1)];
    }

    // Splits the cell into four. Children get indices (2i..2i+1, 2j..2j+1) on the next level.
    split() {
      if (this.children) return this.children;
      const [u0, v0, u1, v1] = this.rect;
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      const L = this.level + 1, i2 = this.i * 2, j2 = this.j * 2;
      this.children = [
        new Cell(this.grid, i2, j2, L, this, [u0, v0, um, vm]),
        new Cell(this.grid, i2 + 1, j2, L, this, [um, v0, u1, vm]),
        new Cell(this.grid, i2 + 1, j2 + 1, L, this, [um, vm, u1, v1]),
        new Cell(this.grid, i2, j2 + 1, L, this, [u0, vm, um, v1]),
      ];
      for (const c of this.children) c.evaluate();
      return this.children;
    }

    // Merges the four children back into this cell.
    merge() {
      this.children = null;
    }

    *leaves() {
      if (this.isLeaf) {
        yield this;
      } else {
        for (const c of this.children) yield* c.leaves();
      }
    }

    // Samples the terrain and derives land-use values. Always uses world positions.
    evaluate() {
      const p = this.corners(1);
      const area = polygonArea(p);
      const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
      const cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
      const s = this.grid.terrain.sample(cx, cy);
      const steepness = clamp01(s.slope / this.grid.slopeRef);
      // Size is judged against the base-cell equivalent, so a quarter cell counts as small.
      const flat = 1 - steepness;
      this.values = {
        area,
        cx,
        cy,
        elevation: s.elevation,
        moisture: s.moisture,
        ruggedness: s.ruggedness,
        slope: s.slope,
        steepness,
        gx: s.gx,
        gy: s.gy,
        // Large cell, medium moisture -> farmland.
        farmland: smoothstep(0.7, 2.2, area) * bell(s.moisture, 0.55, 0.17) * flat,
        // Medium cell, somewhat dry -> building land.
        building: bell(Math.log(area), 0, 0.5) * bell(s.moisture, 0.35, 0.15) * flat,
        // Small (steep, broken) cells -> resources such as stone, ore, timber.
        resource: smoothstep(0.7, 0.15, area) * (0.4 + 0.6 * s.ruggedness),
      };
      return this.values;
    }

    contains(x, y, t = 1) {
      return pointInPolygon(this.corners(t), x, y);
    }
  }

  class Grid {
    // cols x rows base cells, starting at matrix index (i0, j0).
    constructor(terrain, opts = {}) {
      this.terrain = terrain;
      this.cols = opts.cols ?? 64;
      this.rows = opts.rows ?? 44;
      this.i0 = opts.i0 ?? 0;
      this.j0 = opts.j0 ?? 0;
      this.strength = opts.strength ?? 2.5; // how strongly steepness shrinks cells
      this.warpAmount = opts.warp ?? 0.35; // waviness of grid lines, in cell units
      this.build();
    }

    build() {
      const n = (this.cols + 1) * (this.rows + 1);
      this.rx = new Float64Array(n); // regular (index space) positions
      this.ry = new Float64Array(n);
      this.wx = new Float64Array(n); // deformed (world space) positions
      this.wy = new Float64Array(n);
      for (let b = 0; b <= this.rows; b++) {
        for (let a = 0; a <= this.cols; a++) {
          const k = this.vi(a, b);
          this.rx[k] = this.wx[k] = this.i0 + a;
          this.ry[k] = this.j0 + b;
          this.wy[k] = this.j0 + b;
        }
      }
      this.buildDensity();
      this.relax();
      this.applyWarp();
      this.buildCells();
    }

    vi(a, b) {
      return b * (this.cols + 1) + a;
    }

    // Vertex at the top-left corner of cell (i, j), as [x, y], morphed by t.
    vertex(i, j, t = 1) {
      const k = this.vi(i - this.i0, j - this.j0);
      return [
        this.rx[k] + (this.wx[k] - this.rx[k]) * t,
        this.ry[k] + (this.wy[k] - this.ry[k]) * t,
      ];
    }

    // Raster of terrain density over the window, sampled 4 times per cell unit.
    buildDensity() {
      const R = 4;
      const nx = this.cols * R + 1, ny = this.rows * R + 1;
      const slope = new Float64Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          slope[y * nx + x] = this.terrain.slope(this.i0 + x / R, this.j0 + y / R);
        }
      }
      const sorted = Float64Array.from(slope).sort();
      this.slopeRef = sorted[Math.floor(sorted.length * 0.95)] || 1;
      const density = new Float64Array(nx * ny);
      for (let k = 0; k < density.length; k++) {
        const s = clamp01(slope[k] / this.slopeRef);
        density[k] = Math.exp(this.strength * s);
      }
      this.dens = { R, nx, ny, data: density };
    }

    density(x, y) {
      const { R, nx, ny, data } = this.dens;
      let fx = (x - this.i0) * R, fy = (y - this.j0) * R;
      fx = Math.max(0, Math.min(nx - 1.001, fx));
      fy = Math.max(0, Math.min(ny - 1.001, fy));
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const k = y0 * nx + x0;
      const top = data[k] + (data[k + 1] - data[k]) * tx;
      const bot = data[k + nx] + (data[k + nx + 1] - data[k + nx]) * tx;
      return top + (bot - top) * ty;
    }

    // Weighted Laplacian relaxation (successive over-relaxation).
    // Boundary vertices slide along their edge; the four corners stay put.
    relax(maxIter = 400, omega = 1.3) {
      const { cols, rows, wx, wy } = this;
      for (let it = 0; it < maxIter; it++) {
        let maxMove = 0;
        for (let b = 0; b <= rows; b++) {
          for (let a = 0; a <= cols; a++) {
            const onX = a === 0 || a === cols;
            const onY = b === 0 || b === rows;
            if (onX && onY) continue;
            const k = this.vi(a, b);
            const x = wx[k], y = wy[k];
            let sx = 0, sy = 0, sw = 0;
            const add = (kn) => {
              const w = this.density((x + wx[kn]) / 2, (y + wy[kn]) / 2);
              sx += w * wx[kn];
              sy += w * wy[kn];
              sw += w;
            };
            if (!onX && !onY) {
              add(k - 1); add(k + 1); add(k - cols - 1); add(k + cols + 1);
              const dx = omega * (sx / sw - x), dy = omega * (sy / sw - y);
              wx[k] += dx;
              wy[k] += dy;
              maxMove = Math.max(maxMove, Math.abs(dx), Math.abs(dy));
            } else if (onY) {
              add(k - 1); add(k + 1);
              const dx = omega * (sx / sw - x);
              wx[k] += dx;
              maxMove = Math.max(maxMove, Math.abs(dx));
            } else {
              add(k - cols - 1); add(k + cols + 1);
              const dy = omega * (sy / sw - y);
              wy[k] += dy;
              maxMove = Math.max(maxMove, Math.abs(dy));
            }
          }
        }
        if (maxMove < 1e-4) break;
      }
    }

    // Smooth noise displacement so grid lines meander. Small relative to its
    // wavelength, so it cannot fold cells. Fades out toward the window edge.
    applyWarp() {
      const { cols, rows, wx, wy } = this;
      for (let b = 0; b <= rows; b++) {
        for (let a = 0; a <= cols; a++) {
          const k = this.vi(a, b);
          const edge = Math.min(a, b, cols - a, rows - b);
          const fade = smoothstep(0, 3, edge) * this.warpAmount;
          // Keep the warp small where cells are already compressed.
          const scale = fade / Math.sqrt(this.density(wx[k], wy[k]));
          const [dx, dy] = this.terrain.warp(wx[k], wy[k]);
          wx[k] += dx * scale;
          wy[k] += dy * scale;
        }
      }
    }

    buildCells() {
      this.cells = [];
      for (let b = 0; b < this.rows; b++) {
        const row = [];
        for (let a = 0; a < this.cols; a++) {
          const c = new Cell(this, this.i0 + a, this.j0 + b, 0, null, [0, 0, 1, 1]);
          c.evaluate();
          row.push(c);
        }
        this.cells.push(row);
      }
    }

    // Base cell by matrix index, or null outside the window.
    cell(i, j) {
      const row = this.cells[j - this.j0];
      return (row && row[i - this.i0]) || null;
    }

    *baseCells() {
      for (const row of this.cells) yield* row;
    }

    *leaves() {
      for (const c of this.baseCells()) yield* c.leaves();
    }

    // Leaf cell under a point, for morph t.
    leafAt(x, y, t = 1) {
      for (const c of this.baseCells()) {
        if (!c.contains(x, y, t)) continue;
        let cur = c;
        while (!cur.isLeaf) {
          cur = cur.children.find((ch) => ch.contains(x, y, t)) || cur.children[0];
        }
        return cur;
      }
      return null;
    }

    // Splits every leaf larger than maxArea, repeatedly (up to maxLevel).
    autoSplit(maxArea, maxLevel = 3) {
      for (const c of this.baseCells()) c.merge();
      if (!maxArea) return;
      const stack = [...this.baseCells()];
      while (stack.length) {
        const c = stack.pop();
        if (c.values.area > maxArea && c.level < maxLevel) stack.push(...c.split());
      }
    }
  }

  function bilinear(q, u, v) {
    const top = [q[0][0] + (q[1][0] - q[0][0]) * u, q[0][1] + (q[1][1] - q[0][1]) * u];
    const bot = [q[3][0] + (q[2][0] - q[3][0]) * u, q[3][1] + (q[2][1] - q[3][1]) * u];
    return [top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v];
  }

  function polygonArea(p) {
    let s = 0;
    for (let k = 0; k < p.length; k++) {
      const a = p[k], b = p[(k + 1) % p.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
  }

  function pointInPolygon(p, x, y) {
    let inside = false;
    for (let k = 0, l = p.length - 1; k < p.length; l = k++) {
      const [xi, yi] = p[k], [xj, yj] = p[l];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  M.Grid = Grid;
  M.Cell = Cell;
})(window.Markr = window.Markr || {});
