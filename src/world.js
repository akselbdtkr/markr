// The world: an endless grid of cells, built in sections.
//
// Index space: cell (i, j) is the unit square [i, i+1] x [j, j+1] and vertex (a, b)
// sits at (a, b). One index unit is CELL_SIZE (16 m). Topology never changes:
// every base cell has exactly four neighbours and the grid is always contiguous.
//
// World space: vertices move so that cells shrink in steep terrain and along
// streams, and grow on flat land and open water. Each vertex is relaxed toward a
// weighted average of its four neighbours, weighted by terrain density.
//
// Sections: the grid is cut into sections of S x S cells. Every seam between two
// sections is solved on its own, in a strip of BUF cells on each side, from the
// terrain alone. Both sections then use the same seam as a fixed edge. So every
// section is a pure function of the seed and its position: it looks the same
// every time, in whatever order the player visits, and nothing needs to be saved.
(function (M) {
  'use strict';

  const { clamp01, smoothstep } = M.util;
  const C = M.CELL_SIZE;
  const S = 32; // cells per section side (512 m)
  // Slope (m per m) treated as fully steep when shaping cells: about 27 degrees.
  const STEEP_SLOPE = 0.5;
  // Open water gets a fixed middling density so the coast does not pull it into strips.
  const WATER_SLOPE = 0.2;
  // Extra steepness per stream in a cell (log scale); neighbours get half.
  const RIVER_STEEP = 0.35;
  // A pit floods at most this many cells looking for an outlet; else it is a closed lake.
  const FLOOD_MAX = 600;
  // Density samples per cell side. Samples are shared by all patches.
  const DR = 2;

  const bell = (v, mid, width) => Math.exp(-((v - mid) * (v - mid)) / (2 * width * width));
  const key = (i, j) => i + ',' + j;
  const fdiv = (a, b) => Math.floor(a / b);
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  function cap(map, max) {
    if (map.size <= max) return;
    const drop = map.size - max;
    let k = 0;
    for (const id of map.keys()) {
      if (k++ >= drop) break;
      map.delete(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Cell

  class Cell {
    constructor(section, i, j, level, parent, rect) {
      this.section = section;
      this.i = i; // matrix index (at this level)
      this.j = j;
      this.level = level; // 0 = base cell (16 m), 1 = 8 m, ... 4 = 1 m
      this.parent = parent;
      this.base = parent ? parent.base : this;
      // Position inside the base cell in its local (u, v) space, [u0, v0, u1, v1].
      this.rect = rect;
      this.children = null;
      this.values = null;
      this.water = parent ? parent.water : false;
      this.streams = 0; // streams crossing the base cell (largest count)
    }

    get isLeaf() {
      return this.children === null;
    }

    get key() {
      return `${this.level}:${this.i},${this.j}`;
    }

    // Nominal side length in metres: 16, 8, 4, 2, 1.
    get nominalSize() {
      return C / (1 << this.level);
    }

    // Corners TL, TR, BR, BL, for a morph t between index (0) and world (1) space.
    corners(t = 1) {
      const [u0, v0, u1, v1] = this.rect;
      const s = this.section, b = this.base;
      const q = [s.vertex(b.i, b.j, t), s.vertex(b.i + 1, b.j, t), s.vertex(b.i + 1, b.j + 1, t), s.vertex(b.i, b.j + 1, t)];
      if (this.level === 0) return q;
      return [bilinear(q, u0, v0), bilinear(q, u1, v0), bilinear(q, u1, v1), bilinear(q, u0, v1)];
    }

    // Splits the cell into four. Children get indices (2i..2i+1, 2j..2j+1) on the next
    // level. Returns null at the finest level (1 m).
    split() {
      if (this.children) return this.children;
      if (this.level >= M.MAX_LEVEL) return null;
      const [u0, v0, u1, v1] = this.rect;
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      const L = this.level + 1, i2 = this.i * 2, j2 = this.j * 2;
      this.children = [
        new Cell(this.section, i2, j2, L, this, [u0, v0, um, vm]),
        new Cell(this.section, i2 + 1, j2, L, this, [um, v0, u1, vm]),
        new Cell(this.section, i2 + 1, j2 + 1, L, this, [um, vm, u1, v1]),
        new Cell(this.section, i2, j2 + 1, L, this, [u0, vm, um, v1]),
      ];
      for (const c of this.children) c.evaluate();
      return this.children;
    }

    // Merges the four children back into this cell.
    merge() {
      this.children = null;
    }

    *leaves() {
      if (this.isLeaf) yield this;
      else for (const c of this.children) yield* c.leaves();
    }

    // Samples the terrain and derives land-use values, always at world positions.
    evaluate() {
      const w = this.section.world;
      const p = this.corners(1);
      const area = polygonArea(p) * C * C; // m²
      const rel = area / (C * C); // relative to a nominal base cell
      const cx = ((p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4) * C;
      const cy = ((p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4) * C;
      const s = w.terrain.sample(cx, cy);
      const water = this.water;
      // The cell's class wins over the sample, so the coast follows cell sides.
      let elevation = s.elevation;
      if (water && elevation >= 0) elevation = -0.5;
      if (!water && elevation < 0) elevation = 0.5;
      const streams = this.base.streams;
      const steepness = water ? 0 : clamp01(s.slope / STEEP_SLOPE + w.riverSteepAt(cx / C, cy / C));
      const moisture = water ? 1 : s.moisture;
      const land = water ? 0 : 1;
      const belowTreeline = 1 - smoothstep(800, 1000, elevation);
      const flat = (1 - steepness) * land;
      this.values = {
        area,
        side: Math.sqrt(area),
        cx,
        cy,
        water,
        elevation,
        moisture,
        ruggedness: s.ruggedness,
        slope: s.slope,
        steepness,
        streams,
        gx: s.gx,
        gy: s.gy,
        // Large cell, medium moisture, below the tree line -> farmland.
        farmland: smoothstep(0.7, 2.2, rel) * bell(moisture, 0.55, 0.17) * flat * belowTreeline,
        // Medium cell, somewhat dry -> building land.
        building: bell(Math.log(rel), 0, 0.5) * bell(moisture, 0.35, 0.15) * flat,
        // Small (steep, broken) cells -> resources such as stone, ore, timber.
        resource: smoothstep(0.7, 0.15, rel) * (0.4 + 0.6 * s.ruggedness) * land,
      };
      return this.values;
    }

    contains(x, y, t = 1) {
      return pointInPolygon(this.corners(t), x, y);
    }
  }

  // ---------------------------------------------------------------------------
  // Patch: a rectangle of vertices [a0, a0+na] x [b0, b0+nb] relaxed as one unit.
  // Its outer boundary is fixed; more vertices can be fixed with set().

  class Patch {
    constructor(world, a0, b0, na, nb) {
      this.world = world;
      this.a0 = a0;
      this.b0 = b0;
      this.na = na;
      this.nb = nb;
      const n = (na + 1) * (nb + 1);
      this.x = new Float64Array(n); // relaxed (pre-warp) positions
      this.y = new Float64Array(n);
      this.fixed = new Uint8Array(n);
      for (let b = 0; b <= nb; b++) {
        for (let a = 0; a <= na; a++) {
          const k = b * (na + 1) + a;
          this.x[k] = a0 + a;
          this.y[k] = b0 + b;
          if (a === 0 || b === 0 || a === na || b === nb) this.fixed[k] = 1;
        }
      }
    }

    k(a, b) {
      return (b - this.b0) * (this.na + 1) + (a - this.a0);
    }

    set(a, b, x, y) {
      const k = this.k(a, b);
      this.x[k] = x;
      this.y[k] = y;
      this.fixed[k] = 1;
    }

    // Weighted Laplacian relaxation (successive over-relaxation) of the free vertices.
    relax(maxIter = 300, omega = 1.3) {
      const w = this.world;
      const R = DR;
      // Local copy of the shared density samples, for fast lookups.
      const u0 = (this.a0 - 1) * R, v0 = (this.b0 - 1) * R;
      const nx = (this.na + 2) * R + 1, ny = (this.nb + 2) * R + 1;
      const dens = new Float64Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) dens[y * nx + x] = w.densitySample(u0 + x, v0 + y);
      }
      const density = (px, py) => {
        let fx = px * R - u0, fy = py * R - v0;
        fx = Math.max(0, Math.min(nx - 1.001, fx));
        fy = Math.max(0, Math.min(ny - 1.001, fy));
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const k = y0 * nx + x0;
        const top = dens[k] + (dens[k + 1] - dens[k]) * tx;
        const bot = dens[k + nx] + (dens[k + nx + 1] - dens[k + nx]) * tx;
        return top + (bot - top) * ty;
      };
      const { x: X, y: Y, fixed } = this;
      const row = this.na + 1;
      for (let it = 0; it < maxIter; it++) {
        let maxMove = 0;
        for (let k = 0; k < X.length; k++) {
          if (fixed[k]) continue;
          const x = X[k], y = Y[k];
          const k1 = k - 1, k2 = k + 1, k3 = k - row, k4 = k + row;
          const w1 = density((x + X[k1]) / 2, (y + Y[k1]) / 2);
          const w2 = density((x + X[k2]) / 2, (y + Y[k2]) / 2);
          const w3 = density((x + X[k3]) / 2, (y + Y[k3]) / 2);
          const w4 = density((x + X[k4]) / 2, (y + Y[k4]) / 2);
          const sw = w1 + w2 + w3 + w4;
          const sx = w1 * X[k1] + w2 * X[k2] + w3 * X[k3] + w4 * X[k4];
          const sy = w1 * Y[k1] + w2 * Y[k2] + w3 * Y[k3] + w4 * Y[k4];
          const dx = omega * (sx / sw - x), dy = omega * (sy / sw - y);
          X[k] += dx;
          Y[k] += dy;
          maxMove = Math.max(maxMove, Math.abs(dx), Math.abs(dy));
        }
        if (maxMove < 1e-4) break;
      }
    }

    // Final positions: warp every vertex, classify the cells as land or water, then
    // move vertices on the land/water boundary onto the 0 m contour. known(a, b) can
    // return a final position decided elsewhere (seams), which then wins.
    finalize(known) {
      const w = this.world, n = this.x.length, row = this.na + 1;
      const fx = new Float64Array(n), fy = new Float64Array(n);
      for (let k = 0; k < n; k++) [fx[k], fy[k]] = w.warpPosition(this.x[k], this.y[k]);
      const water = new Uint8Array(this.na * this.nb);
      for (let b = 0; b < this.nb; b++) {
        for (let a = 0; a < this.na; a++) {
          const k = b * row + a;
          const cx = (fx[k] + fx[k + 1] + fx[k + row] + fx[k + row + 1]) / 4;
          const cy = (fy[k] + fy[k + 1] + fy[k + row] + fy[k + row + 1]) / 4;
          water[b * this.na + a] = w.terrain.elevation(cx * C, cy * C) < 0 ? 1 : 0;
        }
      }
      const sx = Float64Array.from(fx), sy = Float64Array.from(fy);
      for (let b = 1; b < this.nb; b++) {
        for (let a = 1; a < this.na; a++) {
          const c = (b - 1) * this.na + (a - 1);
          const sum = water[c] + water[c + 1] + water[c + this.na] + water[c + this.na + 1];
          if (sum === 0 || sum === 4) continue;
          const k = b * row + a;
          let minEdge = Infinity;
          for (const kn of [k - 1, k + 1, k - row, k + row]) minEdge = Math.min(minEdge, Math.hypot(fx[kn] - fx[k], fy[kn] - fy[k]));
          [sx[k], sy[k]] = w.snapToCoast(fx[k], fy[k], 0.5 * minEdge);
        }
      }
      if (known) {
        for (let b = 0; b <= this.nb; b++) {
          for (let a = 0; a <= this.na; a++) {
            const p = known(this.a0 + a, this.b0 + b);
            if (p) {
              const k = b * row + a;
              sx[k] = p[0];
              sy[k] = p[1];
            }
          }
        }
      }
      this.fx = sx;
      this.fy = sy;
      this.water = water;
    }
  }

  // ---------------------------------------------------------------------------
  // Section: S x S base cells with fixed seams on all four sides.

  class Section {
    constructor(world, sx, sy) {
      const t0 = performance.now();
      this.world = world;
      this.sx = sx;
      this.sy = sy;
      const a0 = sx * S, b0 = sy * S;
      this.a0 = a0;
      this.b0 = b0;
      const seams = [
        [world.seamV(sx, sy), (k) => [a0, b0 + k]],
        [world.seamV(sx + 1, sy), (k) => [a0 + S, b0 + k]],
        [world.seamH(sx, sy), (k) => [a0 + k, b0]],
        [world.seamH(sx, sy + 1), (k) => [a0 + k, b0 + S]],
      ];
      const p = new Patch(world, a0, b0, S, S);
      const fin = new Map();
      for (const [seam, at] of seams) {
        for (let k = 0; k <= S; k++) {
          const [a, b] = at(k);
          p.set(a, b, seam.x[k], seam.y[k]);
          fin.set(key(a, b), [seam.fx[k], seam.fy[k]]);
        }
      }
      p.relax();
      p.finalize((a, b) => fin.get(key(a, b)));
      this.patch = p;

      this.cells = [];
      this.nonConvex = 0;
      for (let b = 0; b < S; b++) {
        const rowCells = [];
        for (let a = 0; a < S; a++) {
          const c = new Cell(this, a0 + a, b0 + b, 0, null, [0, 0, 1, 1]);
          c.water = p.water[b * S + a] === 1;
          if (!isConvex(c.corners(1))) this.nonConvex++;
          rowCells.push(c);
        }
        this.cells.push(rowCells);
      }
      this.markStreams();
      for (const c of this.baseCells()) c.evaluate();
      this.autoSplit(world.autoSplit);
      this.buildTime = performance.now() - t0;
    }

    // Vertex at the top-left corner of cell (i, j), as [x, y], morphed by t.
    vertex(i, j, t = 1) {
      const p = this.patch, k = p.k(i, j);
      return [i + (p.fx[k] - i) * t, j + (p.fy[k] - j) * t];
    }

    cell(i, j) {
      const r = this.cells[j - this.b0];
      return (r && r[i - this.a0]) || null;
    }

    // Streams are lines in world space. A cell is a stream cell when a stream point
    // falls inside it, whatever its index, so the cells follow the real water.
    markStreams() {
      const w = this.world, a0 = this.a0, b0 = this.b0, M8 = 8;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = this.sx + dx, sy = this.sy + dy;
          const flow = w.flowData(sx, sy).flow;
          for (let k = 0; k < flow.length; k++) {
            if (!flow[k]) continue;
            const px = sx * S + (k % S) + 0.5, py = sy * S + Math.floor(k / S) + 0.5;
            if (px < a0 - M8 || py < b0 - M8 || px > a0 + S + M8 || py > b0 + S + M8) continue;
            const c = this.cellAt(px, py, M8);
            if (c && flow[k] > c.streams) c.streams = flow[k];
          }
        }
      }
    }

    // Base cell of this section containing world point (x, y), searching index
    // positions within r cells of the point.
    cellAt(x, y, r) {
      const ci = Math.floor(x), cj = Math.floor(y);
      for (let d = 0; d <= r; d++) {
        for (let j = cj - d; j <= cj + d; j++) {
          for (let i = ci - d; i <= ci + d; i++) {
            if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== d) continue;
            const c = this.cell(i, j);
            if (c && c.contains(x, y)) return c;
          }
        }
      }
      return null;
    }

    *baseCells() {
      for (const r of this.cells) yield* r;
    }

    *leaves() {
      for (const c of this.baseCells()) yield* c.leaves();
    }

    // Splits every leaf whose side exceeds maxSide metres, then replays the player's edits.
    autoSplit(maxSide) {
      for (const c of this.baseCells()) c.merge();
      if (maxSide) {
        const stack = [...this.baseCells()];
        while (stack.length) {
          const c = stack.pop();
          if (c.values.side > maxSide && c.level < M.MAX_LEVEL) stack.push(...c.split());
        }
      }
      const edits = this.world.edits.get(key(this.sx, this.sy));
      if (!edits) return;
      const sorted = [...edits].sort((e1, e2) => e1[1].level - e2[1].level);
      for (const [, e] of sorted) {
        const c = this.find(e.level, e.i, e.j);
        if (!c) continue;
        if (e.action === 'split') c.split();
        else c.merge();
      }
    }

    // Cell by level and index, if it exists in the current tree.
    find(level, i, j) {
      let c = this.cell(i >> level, j >> level);
      for (let l = 1; c && l <= level; l++) {
        if (!c.children) return null;
        const ci = (i >> (level - l)) & 1, cj = (j >> (level - l)) & 1;
        c = c.children[[0, 1, 3, 2][cj * 2 + ci]];
      }
      return c;
    }
  }

  // ---------------------------------------------------------------------------
  // World

  class World {
    constructor(terrain, opts = {}) {
      this.terrain = terrain;
      this.strength = opts.strength ?? 2.5; // how strongly steepness shrinks cells
      this.warpAmount = opts.warp ?? 0.35; // waviness of grid lines, in cell units
      this.buffer = opts.buffer ?? 6; // seam strip half-width, in cells
      this.sourceCount = opts.sources ?? 2; // stream sources per section
      this.riverLength = opts.riverLength ?? 128; // max cells per stream
      this.autoSplit = opts.autoSplit ?? 0;
      this.edits = opts.edits ?? new Map(); // the player's split/merge edits, by section
      this.elev = opts.elevCache ?? new Map();
      this.src = new Map();
      this.down = new Map();
      this.paths = new Map();
      this.flows = new Map();
      this.rsteep = new Map();
      this.dens = new Map();
      this.cornerCache = new Map();
      this.seamCacheV = new Map();
      this.seamCacheH = new Map();
      this.sections = new Map();
    }

    static get SECTION() {
      return S;
    }

    // --- cells in index space (pure functions of the seed) ---------------------

    // Elevation at the centre of every cell of a section.
    sectionElev(sx, sy) {
      const id = key(sx, sy);
      let e = this.elev.get(id);
      if (!e) {
        e = new Float32Array(S * S);
        for (let b = 0; b < S; b++) {
          for (let a = 0; a < S; a++) e[b * S + a] = this.terrain.elevation((sx * S + a + 0.5) * C, (sy * S + b + 0.5) * C);
        }
        this.elev.set(id, e);
        cap(this.elev, 6000);
      }
      return e;
    }

    cellElevation(i, j) {
      const sx = fdiv(i, S), sy = fdiv(j, S);
      return this.sectionElev(sx, sy)[(j - sy * S) * S + (i - sx * S)];
    }

    // --- streams -------------------------------------------------------------

    // Stream sources of a section: its highest land cell, then the next highest
    // cell that is not a neighbour of one already chosen, and so on.
    sources(sx, sy) {
      const id = key(sx, sy);
      let list = this.src.get(id);
      if (list) return list;
      list = [];
      const e = this.sectionElev(sx, sy);
      const order = [...e.keys()].sort((p, q) => e[q] - e[p]);
      for (const k of order) {
        if (list.length >= this.sourceCount || e[k] < 0) break;
        const i = sx * S + (k % S), j = sy * S + Math.floor(k / S);
        if (list.some(([si, sj]) => Math.abs(si - i) <= 1 && Math.abs(sj - j) <= 1)) continue;
        list.push([i, j]);
      }
      this.src.set(id, list);
      return list;
    }

    // Streams are traced on a regular 16 m lattice in world space: point (i, j) is
    // the world position ((i + 0.5) * 16 m, (j + 0.5) * 16 m).
    // Next step(s) from a point: its steepest lower neighbour (of eight), or, from
    // a pit, the way out through the lake that fills it. null if no outlet in reach.
    downstream(i, j) {
      const id = key(i, j);
      if (this.down.has(id)) return this.down.get(id);
      const h = this.cellElevation(i, j);
      let best = null, bestDrop = 0;
      for (const [di, dj] of N8) {
        const drop = (h - this.cellElevation(i + di, j + dj)) / (di && dj ? Math.SQRT2 : 1);
        if (drop > bestDrop) {
          bestDrop = drop;
          best = [i + di, j + dj];
        }
      }
      const steps = best ? [best] : this.pitOutlet(i, j, h);
      this.down.set(id, steps);
      cap(this.down, 400000);
      return steps;
    }

    // Flood a pit, lowest cell first, until a cell lower than the pit is found.
    // Every cell draining into the pit is higher than it, so that cell is outside
    // the basin. Returns the path through the lake to it.
    pitOutlet(i, j, h0) {
      const start = key(i, j);
      const nodes = new Map([[start, null]]);
      const heap = new MinHeap();
      const push = (ii, jj, from) => {
        const id = key(ii, jj);
        if (nodes.has(id)) return;
        nodes.set(id, { i: ii, j: jj, from });
        heap.push(this.cellElevation(ii, jj), id);
      };
      for (const [di, dj] of N8) push(i + di, j + dj, start);
      for (let pops = 0; heap.size && pops < FLOOD_MAX; pops++) {
        const [h, id] = heap.pop();
        const n = nodes.get(id);
        if (h < h0) {
          const path = [];
          for (let m = n; m; m = nodes.get(m.from)) path.push([m.i, m.j]);
          return path.reverse();
        }
        for (const [di, dj] of N8) push(n.i + di, n.j + dj, id);
      }
      return null;
    }

    // The path of a stream from a source: downhill until it reaches water, has
    // no outlet, or is riverLength cells long. Streams that meet share the
    // memoised steps, so the second one costs almost nothing.
    riverPath(i, j) {
      const id = key(i, j);
      let path = this.paths.get(id);
      if (path) return path;
      path = [[i, j]];
      let ci = i, cj = j;
      while (path.length < this.riverLength && this.cellElevation(ci, cj) >= 0) {
        const steps = this.downstream(ci, cj);
        if (!steps) break;
        for (const st of steps) {
          path.push(st);
          if (path.length >= this.riverLength) break;
        }
        [ci, cj] = path[path.length - 1];
      }
      this.paths.set(id, path);
      cap(this.paths, 60000);
      return path;
    }

    // Number of streams through each cell of a section, and the paths that cross it.
    // A stream is at most riverLength cells long, so only sources within that many
    // cells can reach this section: the answer is exact and local.
    flowData(sx, sy) {
      const id = key(sx, sy);
      let d = this.flows.get(id);
      if (d) return d;
      const flow = new Uint16Array(S * S);
      const paths = [];
      const R = Math.ceil(this.riverLength / S);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          for (const [i, j] of this.sources(sx + dx, sy + dy)) {
            const path = this.riverPath(i, j);
            let hit = false;
            for (const [pi, pj] of path) {
              const a = pi - sx * S, b = pj - sy * S;
              if (a >= 0 && b >= 0 && a < S && b < S) {
                flow[b * S + a]++;
                hit = true;
              }
            }
            if (hit) paths.push(path);
          }
        }
      }
      d = { flow, paths };
      this.flows.set(id, d);
      cap(this.flows, 3000);
      return d;
    }

    flow(i, j) {
      const sx = fdiv(i, S), sy = fdiv(j, S);
      return this.flowData(sx, sy).flow[(j - sy * S) * S + (i - sx * S)];
    }

    // Extra steepness from streams: the cell a stream crosses gets steeper, its four
    // neighbours half as much. More streams give a larger effect.
    riverSteepData(sx, sy) {
      const id = key(sx, sy);
      let r = this.rsteep.get(id);
      if (r) return r;
      const e = (n) => (n ? RIVER_STEEP * Math.log2(1 + n) : 0);
      r = new Float32Array(S * S);
      for (let b = 0; b < S; b++) {
        for (let a = 0; a < S; a++) {
          const i = sx * S + a, j = sy * S + b;
          let v = e(this.flow(i, j));
          for (const [di, dj] of N4) v += 0.5 * e(this.flow(i + di, j + dj));
          r[b * S + a] = v;
        }
      }
      this.rsteep.set(id, r);
      cap(this.rsteep, 3000);
      return r;
    }

    riverSteepCell(i, j) {
      const sx = fdiv(i, S), sy = fdiv(j, S);
      return this.riverSteepData(sx, sy)[(j - sy * S) * S + (i - sx * S)];
    }

    // Bilinear between cell centres, at index-space point (x, y).
    riverSteepAt(x, y) {
      const fx = x - 0.5, fy = y - 0.5;
      const i = Math.floor(fx), j = Math.floor(fy);
      const tx = fx - i, ty = fy - j;
      const top = this.riverSteepCell(i, j) * (1 - tx) + this.riverSteepCell(i + 1, j) * tx;
      const bot = this.riverSteepCell(i, j + 1) * (1 - tx) + this.riverSteepCell(i + 1, j + 1) * tx;
      return top * (1 - ty) + bot * ty;
    }

    // --- geometry ------------------------------------------------------------

    // Terrain density at sample point (u, v) = index-space (u / DR, v / DR): high where
    // steep or near streams. Cached in blocks matching the sections.
    densitySample(u, v) {
      const n = S * DR;
      const bx = fdiv(u, n), by = fdiv(v, n);
      const id = key(bx, by);
      let d = this.dens.get(id);
      if (!d) {
        d = new Float32Array(n * n);
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const ix = (bx * n + x) / DR, iy = (by * n + y) / DR;
            const wx = ix * C, wy = iy * C;
            let s;
            if (this.terrain.elevation(wx, wy) < 0) s = WATER_SLOPE / STEEP_SLOPE;
            else s = clamp01(this.terrain.slope(wx, wy) / STEEP_SLOPE) + this.riverSteepAt(ix, iy);
            d[y * n + x] = Math.exp(this.strength * Math.min(s, 1.5));
          }
        }
        this.dens.set(id, d);
        cap(this.dens, 3000);
      }
      return d[(v - by * n) * n + (u - bx * n)];
    }

    // Density at any index-space point, bilinear between samples.
    densityAt(x, y) {
      const fx = x * DR, fy = y * DR;
      const u = Math.floor(fx), v = Math.floor(fy);
      const tx = fx - u, ty = fy - v;
      const top = this.densitySample(u, v) * (1 - tx) + this.densitySample(u + 1, v) * tx;
      const bot = this.densitySample(u, v + 1) * (1 - tx) + this.densitySample(u + 1, v + 1) * tx;
      return top * (1 - ty) + bot * ty;
    }

    // Smooth noise displacement so grid lines meander. Small relative to its
    // wavelength, and smaller where cells are compressed, so it cannot fold cells.
    warpPosition(x, y) {
      const [dx, dy] = this.terrain.warp(x * C, y * C);
      const sc = this.warpAmount / Math.sqrt(this.densityAt(x, y));
      return [x + dx * sc, y + dy * sc];
    }

    // Newton steps toward the 0 m contour, moving at most maxD (cell units).
    snapToCoast(x, y, maxD) {
      let px = x * C, py = y * C;
      const step = maxD * C;
      for (let it = 0; it < 5; it++) {
        const h = this.terrain.elevation(px, py);
        const [gx, gy] = this.terrain.gradient(px, py, 2);
        const g2 = gx * gx + gy * gy;
        if (g2 < 1e-10) break;
        let dx = (-h * gx) / g2, dy = (-h * gy) / g2;
        const len = Math.hypot(dx, dy);
        if (len > step) {
          dx *= step / len;
          dy *= step / len;
        }
        px += dx;
        py += dy;
        if (Math.abs(h) < 0.01) break;
      }
      let dx = px / C - x, dy = py / C - y;
      const len = Math.hypot(dx, dy);
      if (len > maxD) {
        dx *= maxD / len;
        dy *= maxD / len;
      }
      return [x + dx, y + dy];
    }

    // Shared vertex where four sections meet, solved in a small patch around it.
    corner(cx, cy) {
      const id = key(cx, cy);
      let c = this.cornerCache.get(id);
      if (c) return c;
      const B = this.buffer, a = cx * S, b = cy * S;
      const p = new Patch(this, a - B, b - B, 2 * B, 2 * B);
      p.relax();
      p.finalize();
      const k = p.k(a, b);
      c = { x: p.x[k], y: p.y[k], fx: p.fx[k], fy: p.fy[k] };
      this.cornerCache.set(id, c);
      cap(this.cornerCache, 4000);
      return c;
    }

    // Seam on the vertical line a = sx * S, from row sy * S to sy * S + S. It is
    // solved in a strip of `buffer` cells on each side, from the terrain alone.
    seamV(sx, sy) {
      return this.seam(this.seamCacheV, sx, sy, true);
    }

    // Seam on the horizontal line b = sy * S, from column sx * S to sx * S + S.
    seamH(sx, sy) {
      return this.seam(this.seamCacheH, sx, sy, false);
    }

    seam(cache, sx, sy, vertical) {
      const id = key(sx, sy);
      let s = cache.get(id);
      if (s) return s;
      const B = this.buffer;
      const a = sx * S, b = sy * S;
      const ends = vertical ? [this.corner(sx, sy), this.corner(sx, sy + 1)] : [this.corner(sx, sy), this.corner(sx + 1, sy)];
      const p = vertical ? new Patch(this, a - B, b - B, 2 * B, S + 2 * B) : new Patch(this, a - B, b - B, S + 2 * B, 2 * B);
      const endAt = vertical ? [[a, b], [a, b + S]] : [[a, b], [a + S, b]];
      endAt.forEach(([ea, eb], n) => p.set(ea, eb, ends[n].x, ends[n].y));
      p.relax();
      p.finalize((va, vb) => {
        if (va === endAt[0][0] && vb === endAt[0][1]) return [ends[0].fx, ends[0].fy];
        if (va === endAt[1][0] && vb === endAt[1][1]) return [ends[1].fx, ends[1].fy];
        return null;
      });
      s = { x: new Float64Array(S + 1), y: new Float64Array(S + 1), fx: new Float64Array(S + 1), fy: new Float64Array(S + 1) };
      for (let n = 0; n <= S; n++) {
        const k = vertical ? p.k(a, b + n) : p.k(a + n, b);
        s.x[n] = p.x[k];
        s.y[n] = p.y[k];
        s.fx[n] = p.fx[k];
        s.fy[n] = p.fy[k];
      }
      cache.set(id, s);
      cap(cache, 4000);
      return s;
    }

    // Section, generated on demand. Least recently used sections are dropped from
    // memory; they come back identical when generated again.
    section(sx, sy) {
      const id = key(sx, sy);
      let s = this.sections.get(id);
      if (s) {
        this.sections.delete(id);
      } else {
        s = new Section(this, sx, sy);
      }
      this.sections.set(id, s);
      cap(this.sections, 160);
      return s;
    }

    loaded(sx, sy) {
      return this.sections.get(key(sx, sy)) || null;
    }

    // Leaf cell under an index-space point, among loaded sections.
    leafAt(x, y, t = 1) {
      const sx = fdiv(x, S), sy = fdiv(y, S);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const s = this.loaded(sx + dx, sy + dy);
          if (!s) continue;
          for (const c of s.baseCells()) {
            if (!c.contains(x, y, t)) continue;
            let cur = c;
            while (!cur.isLeaf) cur = cur.children.find((ch) => ch.contains(x, y, t)) || cur.children[0];
            return cur;
          }
        }
      }
      return null;
    }

    // Records a split or merge so it survives the section being regenerated.
    recordEdit(cell, action) {
      const s = cell.section, id = key(s.sx, s.sy);
      if (!this.edits.has(id)) this.edits.set(id, new Map());
      this.edits.get(id).set(cell.key, { level: cell.level, i: cell.i, j: cell.j, action });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers

  class MinHeap {
    constructor() {
      this.h = [];
      this.v = [];
    }
    get size() {
      return this.h.length;
    }
    push(p, val) {
      const h = this.h, v = this.v;
      let n = h.length;
      h.push(p);
      v.push(val);
      while (n > 0) {
        const up = (n - 1) >> 1;
        if (h[up] <= h[n]) break;
        [h[up], h[n]] = [h[n], h[up]];
        [v[up], v[n]] = [v[n], v[up]];
        n = up;
      }
    }
    pop() {
      const h = this.h, v = this.v;
      const top = [h[0], v[0]];
      const lp = h.pop(), lv = v.pop();
      if (h.length) {
        h[0] = lp;
        v[0] = lv;
        let n = 0;
        for (;;) {
          const l = 2 * n + 1, r = l + 1;
          let m = n;
          if (l < h.length && h[l] < h[m]) m = l;
          if (r < h.length && h[r] < h[m]) m = r;
          if (m === n) break;
          [h[m], h[n]] = [h[n], h[m]];
          [v[m], v[n]] = [v[n], v[m]];
          n = m;
        }
      }
      return top;
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

  // True if every corner turns the same way (y points down, so clockwise on screen).
  function isConvex(p) {
    for (let k = 0; k < 4; k++) {
      const a = p[k], b = p[(k + 1) % 4], c = p[(k + 2) % 4];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0) return false;
    }
    return true;
  }

  function pointInPolygon(p, x, y) {
    let inside = false;
    for (let k = 0, l = p.length - 1; k < p.length; l = k++) {
      const [xi, yi] = p[k], [xj, yj] = p[l];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  M.World = World;
  M.Cell = Cell;
  M.SECTION = S;
})(window.Markr = window.Markr || {});
