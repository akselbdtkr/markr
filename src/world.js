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
  const S = M.SECTION; // cells per section side (512 m)
  // Slope (m per m) treated as fully steep when shaping cells: about 27 degrees.
  const STEEP_SLOPE = 0.5;
  // Open water gets a fixed middling density so the coast does not pull it into strips.
  const WATER_SLOPE = 0.2;
  // Extra steepness from a stream (log of its size), across a band set by its scale.
  const RIVER_STEEP = 0.3;
  // Largest block a stream looks at, in cells per side.
  const MAX_SCALE = 16;
  // A block counts as flat when it falls less than this per metre across its width.
  const FLAT_SLOPE = 0.04;
  // Sources in a section must be at least this many cells apart.
  const SOURCE_SPACING = 8;
  // Metres of jitter per unit of scale when a stream picks its next step.
  const MEANDER = 0.6;
  // How far (in sections) to look for the sea from a section.
  const SEA_SEARCH = 80;
  // Levels of section blocks in the drainage network: 2, 4, 8, 16 sections.
  const NET_LEVELS = 4;
  // Share of the max source count by landscape type (tau): marine, plains, hills,
  // plateau, alpine.
  const SOURCE_SHARE = [[0, 0.3], [0.25, 0.2], [0.5, 0.9], [0.75, 0.2], [1, 1]];
  // Rivers at least this large split into a delta where they reach the sea.
  const DELTA_SIZE = 6;
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
      // Stream pieces owned by a base cell, as a texture in the cell's own (u, v)
      // space: [{a: [u, v], b: [u, v], size, scale}], entering at a, leaving at b.
      this.pieces = null;
    }

    // Adds a piece of a stream from world point a to b (index units).
    addStream(a, b, size, scale) {
      const q = this.corners(1);
      const piece = { a: invBilinear(q, a[0], a[1]), b: invBilinear(q, b[0], b[1]), size, scale, dir: [b[0] - a[0], b[1] - a[1]] };
      (this.pieces = this.pieces || []).push(piece);
    }

    // The largest stream piece in this cell (or, for a sub-cell, crossing it), or null.
    get stream() {
      const pieces = this.base.pieces;
      if (!pieces) return null;
      let best = null;
      for (const p of pieces) {
        if (this.level > 0 && !pieceInRect(p, this.rect)) continue;
        if (!best || p.size > best.size) best = p;
      }
      return best;
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
      const stream = this.stream;
      const steepness = water ? 0 : clamp01(s.slope / STEEP_SLOPE + w.riverSteepAt(cx / C, cy / C));
      // Streams wet the land around them. A cell the channel fills is fully wet.
      let moisture = water ? 1 : Math.min(1, s.moisture + w.wetAt(cx / C, cy / C));
      if (stream && channelWidth(stream.size) >= 0.4 * Math.sqrt(area)) moisture = 1;
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
        landscape: s.landscape,
        streams: stream ? stream.size : 0,
        streamScale: stream ? stream.scale : 0,
        streamDir: stream ? stream.dir : null,
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

    // Weighted Laplacian relaxation (Gauss-Seidel) of the free vertices. Every
    // update is a weighted average of the neighbours, so it cannot run away even
    // where density varies a lot; over-relaxation (omega > 1) can, and did.
    relax(maxIter = 400, omega = 1) {
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
      this.outside = this.countOutside();
      this.markStreams();
      for (const c of this.baseCells()) c.evaluate();
      this.autoSplit(world.autoSplit);
      this.buildTime = performance.now() - t0;
    }

    // Inner vertices that ended up outside the section's own boundary. Such a
    // vertex makes cells overlap their neighbours, so it should always be 0.
    countOutside() {
      const a0 = this.a0, b0 = this.b0, poly = [];
      for (let k = 0; k < S; k++) poly.push(this.vertex(a0 + k, b0));
      for (let k = 0; k < S; k++) poly.push(this.vertex(a0 + S, b0 + k));
      for (let k = S; k > 0; k--) poly.push(this.vertex(a0 + k, b0 + S));
      for (let k = S; k > 0; k--) poly.push(this.vertex(a0, b0 + k));
      let n = 0;
      for (let b = 1; b < S; b++) {
        for (let a = 1; a < S; a++) {
          const [x, y] = this.vertex(a0 + a, b0 + b);
          if (!pointInPolygon(poly, x, y)) n++;
        }
      }
      return n;
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

    // Streams are lines in world space, smoothed through their lattice points.
    // Every base cell the line crosses owns the piece inside it: where it enters
    // and leaves, the stream's size and scale. A cell is a stream cell because the
    // water runs through it, whatever its index.
    markStreams() {
      const w = this.world, a0 = this.a0, b0 = this.b0, MARGIN = 3, STEP = 0.125;
      const seen = new Set();
      let hint = null;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const path of w.flowData(this.sx + dx, this.sy + dy).paths) {
            if (seen.has(path)) continue;
            seen.add(path);
            const line = smoothLine(path.pts);
            let cur = null;
            const finish = () => {
              if (cur) cur.cell.addStream(cur.a, cur.b, cur.size, cur.scale);
              cur = null;
            };
            for (let k = 1; k < line.length; k++) {
              const [x0, y0, n0] = line[k - 1], [x1, y1] = line[k];
              const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STEP));
              for (let s = 0; s < steps; s++) {
                const x = x0 + ((x1 - x0) * s) / steps, y = y0 + ((y1 - y0) * s) / steps;
                if (x < a0 - MARGIN || y < b0 - MARGIN || x > a0 + S + MARGIN || y > b0 + S + MARGIN) {
                  finish();
                  continue;
                }
                const c = hint && hint.contains(x, y) ? hint : this.cellAt(x, y, 8, hint);
                if (!c || c.water) {
                  finish();
                  continue;
                }
                hint = c;
                const [pi, pj] = path.pts[n0];
                const size = w.flow(pi, pj), scale = path.scales[n0];
                if (cur && cur.cell === c) {
                  cur.b = [x, y];
                  cur.size = Math.max(cur.size, size);
                  cur.scale = Math.max(cur.scale, scale);
                } else {
                  finish();
                  cur = { cell: c, a: [x, y], b: [x, y], size, scale };
                }
              }
            }
            finish();
          }
        }
      }
    }

    // Base cell of this section containing world point (x, y), searching index
    // positions within r cells of the point.
    cellAt(x, y, r, hint) {
      if (hint && hint.section === this) {
        for (const [di, dj] of N8) {
          const c = this.cell(hint.i + di, hint.j + dj);
          if (c && c.contains(x, y)) return c;
        }
      }
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
      this.sourceCount = opts.sources ?? 3; // max stream sources per section
      this.autoSplit = opts.autoSplit ?? 0;
      this.edits = opts.edits ?? new Map(); // the player's split/merge edits, by section
      this.elev = opts.elevCache ?? new Map();
      this.src = new Map();
      this.flows = new Map();
      this.fields = new Map();
      this.blockCache = new Map();
      this.secHeight = new Map();
      this.secSeaDist = new Map();
      this.secBlocks = new Map();
      this.quota = new Map();
      this.secRoute = new Map();
      this.secCatch = new Map();
      this.crossCache = new Map();
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

    // Elevation at the centre of every cell of a section. The section's stream
    // sources are picked on the way: the highest points, kept apart.
    sectionElev(sx, sy) {
      const id = key(sx, sy);
      let e = this.elev.get(id);
      if (!e) {
        e = new Float32Array(S * S);
        const picker = new SourcePicker(this.sourceQuota(sx, sy), SOURCE_SPACING);
        for (let b = 0; b < S; b++) {
          for (let a = 0; a < S; a++) {
            const h = this.terrain.elevation((sx * S + a + 0.5) * C, (sy * S + b + 0.5) * C);
            e[b * S + a] = h;
            picker.offer(h, sx * S + a, sy * S + b);
          }
        }
        this.elev.set(id, e);
        this.src.set(id, picker.list);
        cap(this.elev, 6000);
      }
      return e;
    }

    cellElevation(i, j) {
      const sx = fdiv(i, S), sy = fdiv(j, S);
      return this.sectionElev(sx, sy)[(j - sy * S) * S + (i - sx * S)];
    }

    // --- streams -------------------------------------------------------------
    // Streams are traced on a regular 16 m lattice in world space: point (i, j) is
    // the world position ((i + 0.5) * 16 m, (j + 0.5) * 16 m). The cells that the
    // stream line crosses own the stream (see Section.markStreams).

    // How many stream sources a section gets. Alpine land and hills get the most,
    // plains and plateaus few, so water there gathers in fewer, larger rivers. The
    // count is the maximum times the type's share, rounded by a fixed per-section
    // random value, so 0.3 of 3 gives 1 in most sections and 0 or 2 in some.
    sourceQuota(sx, sy) {
      const id = key(sx, sy);
      let q = this.quota.get(id);
      if (q === undefined) {
        const tau = this.terrain.landscape((sx + 0.5) * S * C, (sy + 0.5) * S * C)[1];
        const share = piecewise(SOURCE_SHARE, tau);
        q = Math.floor(this.sourceCount * share + hash01(this.terrain.seed + 7, sx, sy));
        this.quota.set(id, q);
        cap(this.quota, 200000);
      }
      return q;
    }

    // Stream sources of a section: up to its quota of highest points, kept apart.
    sources(sx, sy) {
      const id = key(sx, sy);
      let list = this.src.get(id);
      if (!list) {
        // Elevations came from a cache made with other settings: pick again.
        const e = this.sectionElev(sx, sy);
        const picker = new SourcePicker(this.sourceQuota(sx, sy), SOURCE_SPACING);
        for (let k = 0; k < e.length; k++) picker.offer(e[k], sx * S + (k % S), sy * S + Math.floor(k / S));
        list = picker.list;
        this.src.set(id, list);
      }
      return list;
    }

    // Mean, min, max and lowest point of the b x b blocks of a section, b = 2..16.
    blocks(sx, sy) {
      const id = key(sx, sy);
      let bl = this.blockCache.get(id);
      if (bl) return bl;
      const e = this.sectionElev(sx, sy);
      bl = {};
      for (let b = 2; b <= MAX_SCALE; b *= 2) {
        const n = S / b;
        const mean = new Float32Array(n * n), min = new Float32Array(n * n), max = new Float32Array(n * n);
        const arg = new Int32Array(n * n);
        for (let q = 0; q < n * n; q++) {
          const ba = (q % n) * b, bb = Math.floor(q / n) * b;
          let sum = 0, lo = Infinity, hi = -Infinity, at = 0;
          for (let y = bb; y < bb + b; y++) {
            for (let x = ba; x < ba + b; x++) {
              const h = e[y * S + x];
              sum += h;
              if (h < lo) {
                lo = h;
                at = y * S + x;
              }
              if (h > hi) hi = h;
            }
          }
          mean[q] = sum / (b * b);
          min[q] = lo;
          max[q] = hi;
          arg[q] = at;
        }
        bl[b] = { n, mean, min, max, arg };
      }
      this.blockCache.set(id, bl);
      cap(this.blockCache, 6000);
      return bl;
    }

    // Stats of the b x b block with block index (bi, bj): {mean, min, max, i, j}.
    block(b, bi, bj) {
      if (b === 1) {
        const h = this.cellElevation(bi, bj);
        return { mean: h, min: h, max: h, i: bi, j: bj };
      }
      const sx = fdiv(bi * b, S), sy = fdiv(bj * b, S);
      const bl = this.blocks(sx, sy)[b];
      const q = (bj - (sy * S) / b) * bl.n + (bi - (sx * S) / b);
      const at = bl.arg[q];
      return { mean: bl.mean[q], min: bl.min[q], max: bl.max[q], i: sx * S + (at % S), j: sy * S + Math.floor(at / S) };
    }

    // How far a stream looks from point (i, j): the largest block around it that is
    // flat. Steep, rugged land gives 1 (single cells); flatter or lower land gives
    // blocks of 2, 4, 8 and 16 cells.
    scaleOf(i, j) {
      for (let b = MAX_SCALE; b >= 2; b /= 2) {
        const bl = this.block(b, fdiv(i, b), fdiv(j, b));
        const flat = FLAT_SLOPE * (bl.mean < 50 ? 2 : 1);
        if (bl.max - bl.min < b * C * flat) return b;
      }
      return 1;
    }

    // --- drainage network between sections -----------------------------------
    // Every stream ends in the sea. The network is built from coarse section values
    // only, so any section can work it out without knowing other sections' cells,
    // and the result never depends on the order sections are visited in.
    //
    // It is hierarchical, like streams inside a section: sections are grouped in
    // blocks of 2, 4, 8 and 16 sections. A top-level block drains to a neighbour
    // block nearer the sea. Inside a block, every sub-block drains toward the
    // block's outlet, and so on down to single sections. So the water of a whole
    // block gathers at one outlet: streams join into trunks instead of running
    // side by side. Blocks with sea in them drain to their nearest sea instead.

    // Coarse height of a section: the terrain at its centre, without fine detail.
    sectionHeight(sx, sy) {
      const id = key(sx, sy);
      let h = this.secHeight.get(id);
      if (h === undefined) {
        h = this.terrain.elevation((sx + 0.5) * S * C, (sy + 0.5) * S * C, 600);
        this.secHeight.set(id, h);
        cap(this.secHeight, 200000);
      }
      return h;
    }

    isSea(sx, sy) {
      return this.sectionHeight(sx, sy) < 0;
    }

    // Nearest sea section, searching rings outward: [distance, sx, sy], distance in
    // sections. Infinity if there is none within SEA_SEARCH sections.
    nearestSea(sx, sy) {
      const id = key(sx, sy);
      let r0 = this.secSeaDist.get(id);
      if (r0) return r0;
      r0 = this.isSea(sx, sy) ? [0, sx, sy] : [Infinity, 0, 0];
      for (let r = 1; r <= SEA_SEARCH && r <= r0[0]; r++) {
        for (let dy = -r; dy <= r; dy++) {
          const step = Math.abs(dy) === r ? 1 : 2 * r;
          for (let dx = -r; dx <= r; dx += step) {
            const d = Math.hypot(dx, dy);
            if (d < r0[0] && this.isSea(sx + dx, sy + dy)) r0 = [d, sx + dx, sy + dy];
          }
        }
      }
      this.secSeaDist.set(id, r0);
      cap(this.secSeaDist, 200000);
      return r0;
    }

    seaDist(sx, sy) {
      return this.nearestSea(sx, sy)[0];
    }

    // Block of sections at level k (2^k sections per side): mean coarse height,
    // and whether any of its sections is sea.
    blockInfo(k, bx, by) {
      const id = `${k}:${bx},${by}`;
      let b = this.secBlocks.get(id);
      if (b) return b;
      const n = 1 << k;
      let sum = 0, sea = false;
      for (let y = by * n; y < (by + 1) * n; y++) {
        for (let x = bx * n; x < (bx + 1) * n; x++) {
          const h = this.sectionHeight(x, y);
          sum += h;
          if (h < 0) sea = true;
        }
      }
      b = { mean: sum / (n * n), sea };
      this.secBlocks.set(id, b);
      cap(this.secBlocks, 100000);
      return b;
    }

    // Pick along a row of candidates (values h[0..n-1]): the deepest dip below the
    // straight line between the ends, with a slight pull to the middle. On a slope
    // the plain lowest point is nearly always an end, which sent water along
    // section edges from corner to corner; the dip is where a valley crosses.
    static pickDip(h, margin = 0) {
      const n = h.length;
      let best = -1, bs = Infinity;
      for (let q = margin; q < n - margin; q++) {
        const f = n === 1 ? 0 : q / (n - 1);
        const trend = h[0] * (1 - f) + h[n - 1] * f;
        const range = Math.abs(h[n - 1] - h[0]) + 1;
        const score = h[q] - trend + 0.15 * range * Math.abs(f - 0.5);
        if (score < bs) {
          bs = score;
          best = q;
        }
      }
      return best;
    }

    // How block (k, bx, by) drains: {o: [sx, sy], d: [dx, dy]} — its outlet section
    // and the direction water leaves it in — or null if the water ends inside
    // (the block holds sea). Level 0 is a single section.
    route(k, bx, by) {
      const id = `${k}:${bx},${by}`;
      if (this.secRoute.has(id)) return this.secRoute.get(id);
      const n = 1 << k;
      let res = null;
      const sea = k === 0 ? this.isSea(bx, by) : this.blockInfo(k, bx, by).sea;
      if (!sea) {
        const mean = (x, y) => (k === 0 ? this.sectionHeight(x, y) : this.blockInfo(k, x, y).mean);
        let d = null, inherited = null;
        if (k === NET_LEVELS) {
          // Top level: to the lowest neighbour block nearer the sea.
          const c = n >> 1;
          const d0 = this.seaDist(bx * n + c, by * n + c);
          let bh = Infinity;
          for (const [dx, dy] of N4) {
            if (this.seaDist((bx + dx) * n + c, (by + dy) * n + c) < d0 && mean(bx + dx, by + dy) < bh) {
              bh = mean(bx + dx, by + dy);
              d = [dx, dy];
            }
          }
          if (!d) {
            // Close to the sea: head for the neighbour block that holds it.
            const [, tx, ty] = this.nearestSea(bx * n + c, by * n + c);
            const ox = fdiv(tx, n) - bx, oy = fdiv(ty, n) - by;
            d = Math.abs(ox) >= Math.abs(oy) ? [Math.sign(ox), 0] : [0, Math.sign(oy)];
          }
        } else {
          const px = bx >> 1, py = by >> 1, pn = n * 2;
          const pr = this.route(k + 1, px, py);
          if (pr && fdiv(pr.o[0], n) === bx && fdiv(pr.o[1], n) === by) {
            inherited = pr; // this block holds the parent's outlet
          } else {
            // Toward the parent's outlet, or, if the parent holds sea, its nearest sea.
            let gx, gy;
            if (pr) {
              [gx, gy] = pr.o;
            } else {
              const cx = bx * n + n / 2, cy = by * n + n / 2;
              let bd = Infinity;
              for (let y = py * pn; y < (py + 1) * pn; y++) {
                for (let x = px * pn; x < (px + 1) * pn; x++) {
                  const dd = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
                  if (dd < bd && this.isSea(x, y)) {
                    bd = dd;
                    gx = x;
                    gy = y;
                  }
                }
              }
            }
            const gbx = fdiv(gx, n), gby = fdiv(gy, n);
            const d0 = Math.hypot(gbx - bx, gby - by);
            let bh = Infinity;
            for (const [dx, dy] of N4) {
              const nx = bx + dx, ny = by + dy;
              if (nx >> 1 !== px || ny >> 1 !== py) continue;
              if (Math.hypot(gbx - nx, gby - ny) < d0 && mean(nx, ny) < bh) {
                bh = mean(nx, ny);
                d = [dx, dy];
              }
            }
          }
        }
        if (inherited) {
          res = { o: inherited.o, d: inherited.d };
        } else if (k === 0) {
          res = { o: [bx, by], d };
        } else {
          // Outlet: the section on the edge facing d where a valley crosses.
          const edge = [];
          for (let q = 0; q < n; q++) {
            const x = d[0] ? bx * n + (d[0] > 0 ? n - 1 : 0) : bx * n + q;
            const y = d[1] ? by * n + (d[1] > 0 ? n - 1 : 0) : by * n + q;
            edge.push([x, y]);
          }
          const q = World.pickDip(edge.map(([x, y]) => this.sectionHeight(x, y)));
          res = { o: edge[q], d };
        }
      }
      this.secRoute.set(id, res);
      cap(this.secRoute, 200000);
      return res;
    }

    // The neighbour a section drains to, or null where the water ends (sea).
    drainTo(sx, sy) {
      const r = this.route(0, sx, sy);
      return r ? [sx + r.d[0], sy + r.d[1]] : null;
    }

    // Neighbours that drain into this section.
    upstream(sx, sy) {
      const out = [];
      for (const [dx, dy] of N4) {
        const d = this.drainTo(sx + dx, sy + dy);
        if (d && d[0] === sx && d[1] === sy) out.push([sx + dx, sy + dy]);
      }
      return out;
    }

    // Size of the water leaving a section: its own sources plus everything that
    // drains into it from upstream. Sea sections add nothing of their own.
    catchment(sx, sy) {
      const memo = this.secCatch;
      const id0 = key(sx, sy);
      if (memo.has(id0)) return memo.get(id0);
      const stack = [[sx, sy, false]];
      while (stack.length) {
        const [x, y, done] = stack.pop();
        const id = key(x, y);
        if (memo.has(id)) continue;
        const ups = this.upstream(x, y);
        if (!done) {
          stack.push([x, y, true]);
          for (const [ux, uy] of ups) if (!memo.has(key(ux, uy))) stack.push([ux, uy, false]);
        } else {
          let sum = this.isSea(x, y) ? 0 : this.sourceQuota(x, y);
          for (const [ux, uy] of ups) sum += memo.get(key(ux, uy));
          memo.set(id, sum);
        }
      }
      return memo.get(id0);
    }

    // Where water crosses from section (sx, sy) to its neighbour (sx + dx, sy + dy):
    // the deepest dip along the middle of their shared edge, sampled from the
    // terrain itself. Both sections get the same answer.
    // Returns {inside, outside}: the lattice points on this and the other side.
    crossing(sx, sy, dx, dy) {
      const vertical = dx !== 0;
      const edge = vertical ? sx + Math.max(dx, 0) : sy + Math.max(dy, 0); // edge line, in sections
      const id = `${vertical ? 'v' : 'h'}${edge},${vertical ? sy : sx}`;
      let k = this.crossCache.get(id);
      if (k === undefined) {
        const h = [];
        for (let n = 0; n < S; n++) {
          const along = (vertical ? sy : sx) * S + n + 0.5;
          h.push(vertical ? this.terrain.elevation(edge * S * C, along * C) : this.terrain.elevation(along * C, edge * S * C));
        }
        // Only the middle half of the edge: crossings near a corner made water
        // come in and go out near the same corner and run along the edges.
        k = World.pickDip(h, S / 4);
        this.crossCache.set(id, k);
        cap(this.crossCache, 50000);
      }
      const line = edge * S, along = (vertical ? sy : sx) * S + k;
      const pos = vertical ? [[line - 1, along], [line, along]] : [[along, line - 1], [along, line]];
      // pos[0] lies before the edge line, pos[1] after it.
      const fwd = dx + dy > 0;
      return { inside: fwd ? pos[0] : pos[1], outside: fwd ? pos[1] : pos[0] };
    }

    // Block means at scale b, interpolated between block centres: the terrain seen
    // at that scale, without steps at block edges (which made streams run along
    // the edge of a lower block in straight lines).
    smoothMean(b, i, j) {
      const fx = (i + 0.5) / b - 0.5, fy = (j + 0.5) / b - 0.5;
      const bi = Math.floor(fx), bj = Math.floor(fy), tx = fx - bi, ty = fy - bj;
      const m = (x, y) => this.block(b, x, y).mean;
      const top = m(bi, bj) * (1 - tx) + m(bi + 1, bj) * tx;
      const bot = m(bi, bj + 1) * (1 - tx) + m(bi + 1, bj + 1) * tx;
      return top * (1 - ty) + bot * ty;
    }

    // One step of a stream inside section (sx, sy) on its way to target: any
    // neighbour that gets closer to the target. At scale 1 the lowest one wins.
    // At larger scales neighbours are judged by the terrain seen at that scale
    // (smoothed 2-, 4-, 8- or 16-block means), so the stream heads for lower
    // ground; a fixed per-point jitter keeps it winding instead of straight.
    stepToward(sx, sy, [i, j], [ti, tj]) {
      const d0 = Math.hypot(ti - i, tj - j);
      const b = this.scaleOf(i, j), jitter = MEANDER * b;
      let best = null, bs = Infinity;
      for (const [di, dj] of N8) {
        const ni = i + di, nj = j + dj;
        if (fdiv(ni, S) !== sx || fdiv(nj, S) !== sy) continue;
        if (Math.hypot(ti - ni, tj - nj) >= d0) continue;
        const h = b === 1 ? this.cellElevation(ni, nj) : this.smoothMean(b, ni, nj);
        const score = h + jitter * (hash01(this.terrain.seed, ni, nj) - 0.5);
        if (score < bs) {
          bs = score;
          best = [ni, nj];
        }
      }
      return best;
    }

    // Water points of a section that touch land: where rivers can reach the sea.
    waterPoints(sx, sy) {
      const e = this.sectionElev(sx, sy), out = [];
      for (let b = 0; b < S; b++) {
        for (let a = 0; a < S; a++) {
          if (e[b * S + a] >= 0) continue;
          const land = N4.some(([da, db]) => {
            const na = a + da, nb = b + db;
            return na >= 0 && nb >= 0 && na < S && nb < S && e[nb * S + na] >= 0;
          });
          if (land) out.push([sx * S + a, sy * S + b]);
        }
      }
      return out;
    }

    // Waypoint between a stream's way in and the outlet: off to one side of the
    // straight line by a fixed per-section amount (up to a fifth of a section
    // either way), then moved to the lowest ground nearby. In a valley it lands in
    // the valley; on flat land it makes the river swing.
    waypoint(sx, sy, [ai, aj], [ti, tj]) {
      const len = Math.hypot(ti - ai, tj - aj);
      if (len < 8) return null;
      const px = -(tj - aj) / len, py = (ti - ai) / len;
      const off = (hash01(this.terrain.seed + 11, sx, sy) - 0.5) * S * 0.45;
      const lo = sx * S + 3, hi = sx * S + S - 4, lo2 = sy * S + 3, hi2 = sy * S + S - 4;
      const cx = Math.round(Math.max(lo, Math.min(hi, (ai + ti) / 2 + px * off)));
      const cy = Math.round(Math.max(lo2, Math.min(hi2, (aj + tj) / 2 + py * off)));
      let best = [cx, cy], bh = Infinity;
      for (let j = Math.max(lo2, cy - 5); j <= Math.min(hi2, cy + 5); j++) {
        for (let i = Math.max(lo, cx - 5); i <= Math.min(hi, cx + 5); i++) {
          const h = this.smoothMean(2, i, j) + 0.3 * Math.hypot(i - cx, j - cy);
          if (h < bh) {
            bh = h;
            best = [i, j];
          }
        }
      }
      return best;
    }

    // Lowest lattice point of a section (where a basin with no outlet collects).
    lowestPoint(sx, sy) {
      const e = this.sectionElev(sx, sy);
      let k = 0;
      for (let q = 1; q < e.length; q++) if (e[q] < e[k]) k = q;
      return [sx * S + (k % S), sy * S + Math.floor(k / S)];
    }

    // A stream inside one section, from start to target (then across the edge to
    // `out`, if the section drains on). In a sea section it ends at the first
    // water; elsewhere it runs on through lakes and bays to its outlet.
    walk(sx, sy, start, target, out, weight) {
      const pts = [start];
      const sea = this.isSea(sx, sy);
      let cur = start;
      for (let guard = 0; guard < 4 * S; guard++) {
        if (sea && this.cellElevation(cur[0], cur[1]) < 0) break;
        if (cur[0] === target[0] && cur[1] === target[1]) {
          if (out) pts.push(out);
          break;
        }
        const nx = this.stepToward(sx, sy, cur, target);
        if (!nx) break;
        pts.push(nx);
        cur = nx;
      }
      return { pts, scales: pts.map(([pi, pj]) => this.scaleOf(pi, pj)), weight };
    }

    // The streams of one section: water coming in from upstream sections at their
    // crossings (carrying their catchment), and the section's own sources (1 each),
    // all heading for the section's outlet. They meet on the way, and the first
    // stream sets the course the rest join.
    flowData(sx, sy) {
      const id = key(sx, sy);
      let d = this.flows.get(id);
      if (d) return d;
      const drain = this.drainTo(sx, sy);
      let target = null, out = null;
      if (drain) {
        const c = this.crossing(sx, sy, drain[0] - sx, drain[1] - sy);
        target = c.inside;
        out = c.outside;
      } else {
        target = this.lowestPoint(sx, sy);
      }
      // In a sea section the water ends in the sea. Large rivers split into a delta:
      // up to three branches to separate points of water near where they come in.
      const sea = !drain && this.isSea(sx, sy);
      const water = sea ? this.waterPoints(sx, sy) : null;
      const goals = (start, weight) => {
        if (!water || !water.length) return [[target, weight]];
        const near = water.map((p) => [Math.hypot(p[0] - start[0], p[1] - start[1]), p]).sort((a, b) => a[0] - b[0]);
        const picked = [];
        for (const [dist, p] of near) {
          if (picked.length >= (weight >= DELTA_SIZE ? 3 : 1) || dist > near[0][0] * 1.6 + 6) break;
          if (picked.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) >= 6)) picked.push(p);
        }
        return picked.map((p) => [p, weight / picked.length]);
      };
      const starts = [];
      for (const [ux, uy] of this.upstream(sx, sy)) {
        starts.push([this.crossing(ux, uy, sx - ux, sy - uy).outside, this.catchment(ux, uy)]);
      }
      for (const [i, j] of this.sources(sx, sy)) starts.push([[i, j], 1]);
      const size = new Float32Array(S * S), scale = new Uint8Array(S * S);
      const paths = [];
      // A bend: the main stream (the largest coming in, or the highest source) and
      // every other stream pass a waypoint before the outlet, so they join there
      // and the course swings instead of running straight from edge to edge.
      let wp = null;
      if (drain && starts.length) {
        const main = starts.reduce((a, b) => (b[1] > a[1] ? b : a));
        wp = this.waypoint(sx, sy, main[0], target);
      }
      for (const [start, w0] of starts) {
        for (const [goal, weight] of goals(start, w0)) {
          let path = this.walk(sx, sy, start, goal, out, weight);
          if (wp && !water) {
            const first = this.walk(sx, sy, start, wp, null, weight);
            const rest = this.walk(sx, sy, wp, goal, out, weight);
            path = { pts: first.pts.concat(rest.pts.slice(1)), scales: first.scales.concat(rest.scales.slice(1)), weight };
          }
          path.pts.forEach(([pi, pj], k) => {
            const a = pi - sx * S, b = pj - sy * S;
            if (a < 0 || b < 0 || a >= S || b >= S) return;
            size[b * S + a] += weight;
            scale[b * S + a] = Math.max(scale[b * S + a], path.scales[k]);
          });
          paths.push(path);
        }
      }
      d = { size, scale, paths, drain, target };
      this.flows.set(id, d);
      cap(this.flows, 3000);
      return d;
    }

    // Section facts for the info panel.
    sectionInfo(sx, sy) {
      return {
        landscape: this.terrain.landscape((sx + 0.5) * S * C, (sy + 0.5) * S * C)[1],
        height: this.sectionHeight(sx, sy),
        sea: this.isSea(sx, sy),
        seaDist: this.seaDist(sx, sy),
        drain: this.drainTo(sx, sy),
        upstream: this.upstream(sx, sy).length,
        catchment: this.catchment(sx, sy),
        sources: this.sources(sx, sy).length,
      };
    }

    flow(i, j) {
      const sx = fdiv(i, S), sy = fdiv(j, S);
      return this.flowData(sx, sy).size[(j - sy * S) * S + (i - sx * S)];
    }

    // What streams do to the land around them, on the lattice of a section:
    // steep, which makes cells smaller, and wet, which raises moisture. Both reach
    // across the stream as far as its scale: a stream that looks at 8-blocks
    // affects a band about 8 cells wide. The strongest stream nearby wins; since a
    // stream's size adds up where streams meet, more streams give a larger effect.
    riverField(sx, sy) {
      const id = key(sx, sy);
      let f = this.fields.get(id);
      if (f) return f;
      const steep = new Float32Array(S * S), wet = new Float32Array(S * S);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const fd = this.flowData(sx + dx, sy + dy);
          for (let k = 0; k < S * S; k++) {
            const z = fd.size[k];
            if (!z) continue;
            const pi = (sx + dx) * S + (k % S), pj = (sy + dy) * S + Math.floor(k / S);
            const sc = fd.scale[k];
            const ws = Math.max(0.8, 0.35 * sc), ww = Math.max(1.2, 0.6 * sc);
            const es = RIVER_STEEP * Math.log2(1 + z), ew = Math.min(0.35, 0.1 * Math.log2(1 + z));
            const r = Math.ceil(2 * ww);
            for (let b = pj - r; b <= pj + r; b++) {
              const lb = b - sy * S;
              if (lb < 0 || lb >= S) continue;
              for (let a = pi - r; a <= pi + r; a++) {
                const la = a - sx * S;
                if (la < 0 || la >= S) continue;
                const d2 = (a - pi) * (a - pi) + (b - pj) * (b - pj);
                const q = lb * S + la;
                steep[q] = Math.max(steep[q], es * Math.exp(-d2 / (ws * ws)));
                wet[q] = Math.max(wet[q], ew * Math.exp(-d2 / (ww * ww)));
              }
            }
          }
        }
      }
      f = { steep, wet };
      this.fields.set(id, f);
      cap(this.fields, 3000);
      return f;
    }

    // A river field value, bilinear between lattice points, at index-space (x, y).
    fieldAt(name, x, y) {
      const fx = x - 0.5, fy = y - 0.5;
      const i = Math.floor(fx), j = Math.floor(fy);
      const tx = fx - i, ty = fy - j;
      const v = (ii, jj) => {
        const sx = fdiv(ii, S), sy = fdiv(jj, S);
        return this.riverField(sx, sy)[name][(jj - sy * S) * S + (ii - sx * S)];
      };
      const top = v(i, j) * (1 - tx) + v(i + 1, j) * tx;
      const bot = v(i, j + 1) * (1 - tx) + v(i + 1, j + 1) * tx;
      return top * (1 - ty) + bot * ty;
    }

    riverSteepAt(x, y) {
      return this.fieldAt('steep', x, y);
    }

    wetAt(x, y) {
      return this.fieldAt('wet', x, y);
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

  // Keeps the highest points offered, at most `count`, none closer than `spacing`
  // cells to a higher one. Points are offered one by one as a section is made.
  class SourcePicker {
    constructor(count, spacing) {
      this.count = count;
      this.spacing = spacing;
      this.list = []; // [i, j, h], highest first
    }
    offer(h, i, j) {
      const L = this.list;
      if (h < 0 || this.count === 0) return;
      if (L.length === this.count && h <= L[L.length - 1][2]) return;
      const near = (p) => Math.max(Math.abs(p[0] - i), Math.abs(p[1] - j)) < this.spacing;
      if (L.some((p) => near(p) && p[2] >= h)) return; // too close to a higher point
      const keep = L.filter((p) => !near(p)); // drop lower points that are too close
      let k = 0;
      while (k < keep.length && keep[k][2] > h) k++;
      keep.splice(k, 0, [i, j, h]);
      if (keep.length > this.count) keep.length = this.count;
      this.list = keep;
    }
  }

  function piecewise(knots, t) {
    if (t <= knots[0][0]) return knots[0][1];
    for (let k = 1; k < knots.length; k++) {
      if (t <= knots[k][0]) {
        const [t0, v0] = knots[k - 1], [t1, v1] = knots[k];
        return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
      }
    }
    return knots[knots.length - 1][1];
  }

  // Deterministic pseudo-random value in [0, 1) for a lattice point.
  function hash01(seed, x, y) {
    let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // Width of a stream's channel in metres, from its size.
  function channelWidth(size) {
    return Math.min(40, 1.2 + 1.1 * Math.sqrt(size));
  }

  // Chaikin smoothing of lattice points (index units, at point centres). Each
  // output point is [x, y, n], n being the path point it came from.
  function smoothLine(pts) {
    let line = pts.map(([i, j], n) => [i + 0.5, j + 0.5, n]);
    for (let it = 0; it < 2; it++) {
      if (line.length < 3) break;
      const out = [line[0]];
      for (let k = 0; k < line.length - 1; k++) {
        const [x0, y0, n0] = line[k], [x1, y1, n1] = line[k + 1];
        out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1, n0], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1, n1]);
      }
      out.push(line[line.length - 1]);
      line = out;
    }
    return line;
  }

  // (u, v) of world point (x, y) inside the bilinear quad q, by Newton steps.
  function invBilinear(q, x, y) {
    let u = 0.5, v = 0.5;
    for (let it = 0; it < 8; it++) {
      const p = bilinear(q, u, v);
      const ex = p[0] - x, ey = p[1] - y;
      // Partial derivatives of the bilinear map.
      const xu = (1 - v) * (q[1][0] - q[0][0]) + v * (q[2][0] - q[3][0]);
      const yu = (1 - v) * (q[1][1] - q[0][1]) + v * (q[2][1] - q[3][1]);
      const xv = (1 - u) * (q[3][0] - q[0][0]) + u * (q[2][0] - q[1][0]);
      const yv = (1 - u) * (q[3][1] - q[0][1]) + u * (q[2][1] - q[1][1]);
      const det = xu * yv - xv * yu;
      if (Math.abs(det) < 1e-12) break;
      u -= (ex * yv - ey * xv) / det;
      v -= (ey * xu - ex * yu) / det;
    }
    return [Math.max(0, Math.min(1, u)), Math.max(0, Math.min(1, v))];
  }

  // True if a stream piece passes through a sub-cell's (u, v) rectangle.
  function pieceInRect(p, [u0, v0, u1, v1]) {
    for (let k = 0; k <= 4; k++) {
      const u = p.a[0] + ((p.b[0] - p.a[0]) * k) / 4, v = p.a[1] + ((p.b[1] - p.a[1]) * k) / 4;
      if (u >= u0 && u <= u1 && v >= v0 && v <= v1) return true;
    }
    return false;
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
  M.channelWidth = channelWidth;
  M.bilinear = bilinear;
})(window.Markr = window.Markr || {});
