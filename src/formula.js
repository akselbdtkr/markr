// Two local formulas for a grid that follows the terrain.
//
// The cell formula reads the height of a cell and its 8 neighbours and gives the
// cell's rotation, kind (ridge, valley, peak, pit), how strongly it follows the
// slope, how strongly it pulls the grid in (ridges, steep land), its wanted size,
// and whether it is split. Every threshold is an S-curve with an adjustable start
// and end.
//
// The vertex formula reads the cells around a vertex and gives its position:
// rows and columns follow the cells' rotation (summed along the row; when the sum
// passes half a cell the neighbouring row takes over: a jump), and the cells
// around pull the vertex in by their pull. Hard limit: no vertex moves more than
// 0.45 of a cell along either axis, so neighbouring rows and columns never cross.
//
// Everything depends only on the terrain near a cell, so any area can be
// generated on its own and fits its neighbours like tiles.
(function (M) {
  'use strict';

  const C = M.CELL_SIZE;
  const S = (a, b, v) => {
    if (a === b) return v >= a ? 1 : 0;
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const DEG = 180 / Math.PI;
  const LIMIT = 0.45;
  // How far apart (cells) the places are where a row starts summing again.
  const ORIGIN = 16;

  // Deterministic value in [0, 1) for an integer pair.
  function hash(seed, a, b) {
    let h = seed ^ Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // The cell formula as matrix operations. The 3 x 3 heights around a cell are
  // multiplied element by element with fixed 3 x 3 kernels and summed: two give
  // the slope (Sobel), three the curvature (Hessian). Rows of each kernel are
  // dj = -1, 0, 1; columns di = -1, 0, 1. Divided by C (or C^2) for m per m.
  const KERNELS = {
    gx: [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]].map((r) => r.map((v) => v / (8 * C))),
    gy: [[-1, -2, -1], [0, 0, 0], [1, 2, 1]].map((r) => r.map((v) => v / (8 * C))),
    hxx: [[1, -2, 1], [2, -4, 2], [1, -2, 1]].map((r) => r.map((v) => v / (4 * C * C))),
    hyy: [[1, 2, 1], [-2, -4, -2], [1, 2, 1]].map((r) => r.map((v) => v / (4 * C * C))),
    hxy: [[1, 0, -1], [0, 0, 0], [-1, 0, 1]].map((r) => r.map((v) => v / (4 * C * C))),
  };
  const apply = (K, w) => {
    let s = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) s += K[r][c] * w[r][c];
    return s;
  };

  // The cell formula. H(i, j) gives the height at the centre of cell (i, j).
  // Returns {theta, rowsW, follow, edge, kind, size, pull, split, slope, d2}.
  function cellFormula(H, i, j, p) {
    // The 3 x 3 window of heights.
    const w = [-1, 0, 1].map((dj) => [-1, 0, 1].map((di) => H(i + di, j + dj)));
    const h0 = w[1][1];
    if (h0 < 0) return { theta: 0, rowsW: 1, follow: 0, edge: 0, kind: 'water', size: 1, pull: 0, split: 0, slope: 0, d2: 0 };
    const gx = apply(KERNELS.gx, w), gy = apply(KERNELS.gy, w);
    const hxx = apply(KERNELS.hxx, w), hyy = apply(KERNELS.hyy, w), hxy = apply(KERNELS.hxy, w);
    const g = Math.hypot(gx, gy);
    const slope = Math.atan(g) * DEG;
    // Rotation: the direction of the contour, folded into -45..45 degrees.
    const a = Math.atan2(gx, -gy);
    const theta = a - (Math.PI / 2) * Math.round(a / (Math.PI / 2));
    // Contours running along the rows are taken by rows, the others by
    // columns; around 45 degrees both, sliding from one to the other.
    const steepAngle = Math.atan2(Math.abs(gy), Math.abs(gx)) * DEG;
    const rowsW = S(45 - p.blend, 45 + p.blend, steepAngle);
    // Ridge or valley: curvature along the contour, t^T Hess t, as the height
    // difference (m) between the cell and its neighbours one cell along the
    // contour on each side. Negative: both sides lower (ridge); positive: valley.
    let d2 = 0;
    if (g > 1e-4) {
      const tx = -gy / g, ty = gx / g;
      d2 = 0.5 * C * C * (tx * tx * hxx + 2 * tx * ty * hxy + ty * ty * hyy);
    }
    let kind = d2 < 0 ? 'ridge' : 'valley';
    let lo = Infinity, hi = -Infinity;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (r !== 1 || c !== 1) {
      lo = Math.min(lo, w[r][c]);
      hi = Math.max(hi, w[r][c]);
    }
    if (h0 > hi) kind = 'peak';
    else if (h0 < lo) kind = 'pit';
    // S-curves.
    const follow = S(p.followFrom, p.followTo, slope);
    const edge = S(p.edgeFrom, p.edgeTo, Math.abs(d2)) * S(p.followFrom * 0.5, p.followTo * 0.5, slope);
    const steep = S(p.sizeFrom, p.sizeTo, slope);
    const size = 1 - p.sizeAmount * Math.max(steep, edge * p.edgeSize);
    const pull = p.sizeAmount * steep * 0.5 + p.edgePull * edge;
    const split = size < p.split4 ? 4 : size < p.split2 ? 2 : 0;
    return { theta, rowsW, follow: Math.max(follow, edge), edge, kind, size, pull, split, slope, d2 };
  }

  // Builds the grid of cells [i0, i0 + n) x [j0, j0 + n). height(x, y) in metres.
  function formulaGrid(height, i0, j0, n, p) {
    const t0 = performance.now();
    const MG = ORIGIN + 2; // margin of cells, so every row sum starts inside
    const R = n + 2 * MG, at = (i, j) => (j - j0 + MG) * R + (i - i0 + MG);
    const Hc = new Float32Array(R * R);
    for (let j = j0 - MG; j < j0 + n + MG; j++) for (let i = i0 - MG; i < i0 + n + MG; i++) Hc[at(i, j)] = height((i + 0.5) * C, (j + 0.5) * C);
    const H = (i, j) => {
      i = Math.max(i0 - MG, Math.min(i0 + n + MG - 1, i));
      j = Math.max(j0 - MG, Math.min(j0 + n + MG - 1, j));
      return Hc[at(i, j)];
    };
    const cells = new Array(R * R);
    for (let j = j0 - MG + 1; j < j0 + n + MG - 1; j++) for (let i = i0 - MG + 1; i < i0 + n + MG - 1; i++) cells[at(i, j)] = cellFormula(H, i, j, p);
    const cell = (i, j) => cells[at(i, j)] || { theta: 0, rowsW: 1, follow: 0, edge: 0, pull: 0, size: 1 };
    // Largest rotation used, so there are at least a few cells between jumps.
    const maxRot = ((p.maxRot ?? 30) * Math.PI) / 180;
    const clampRot = (t) => Math.max(-maxRot, Math.min(maxRot, t));
    // Row step between vertex (a, b) and (a + 1, b): the two cells beside it.
    const rowTan = (a, b) => {
      let s = 0;
      for (const c of [cell(a, b - 1), cell(a, b)]) s += Math.tan(clampRot(c.theta)) * c.follow * c.rowsW * p.strength;
      return s / 2;
    };
    const colTan = (a, b) => {
      let s = 0;
      for (const c of [cell(a - 1, b), cell(a, b)]) s += -Math.tan(clampRot(c.theta)) * c.follow * (1 - c.rowsW) * p.strength;
      return s / 2;
    };
    // Where row b starts summing (from 0): every ORIGIN cells, shifted by smooth
    // Perlin noise over the row number. Neighbouring rows start near each other,
    // so they follow nearly the same course, but the restarts (and the jumps)
    // do not line up in one column. `jumpMix` sets how far the shift reaches.
    const noise = M.noise.createPerlin(p.seed * 7 + 3);
    const originOf = (k) => Math.floor((noise(k * 0.13, 0.5) * 0.5 + 0.5) * ORIGIN * p.jumpMix);
    const sawtooth = (I) => I - Math.round(I);
    const row = n + 1, X = new Float64Array(row * row), Y = new Float64Array(row * row);
    let jumps = 0;
    for (let b = 0; b <= n; b++) {
      for (let a = 0; a <= n; a++) {
        const va = i0 + a, vb = j0 + b;
        // Row: sum the steps from this row's last origin to the vertex.
        const ob = originOf(vb), ra = Math.floor((va - ob) / ORIGIN) * ORIGIN + ob;
        let I = 0;
        for (let x = ra; x < va; x++) I += rowTan(x, vb);
        const oa = originOf(va + 7919), rb = Math.floor((vb - oa) / ORIGIN) * ORIGIN + oa;
        let J = 0;
        for (let y = rb; y < vb; y++) J += colTan(va, y);
        // The sawtooth is as high as the four cells around follow rows (or
        // columns): weak following gives small jumps, and where rows and columns
        // share the line (around 45 degrees) each jumps only part of the way.
        const c4 = [cell(va - 1, vb - 1), cell(va, vb - 1), cell(va - 1, vb), cell(va, vb)];
        let wR = 0, wC = 0;
        for (const c of c4) {
          wR += (c.follow * c.rowsW) / 4;
          wC += (c.follow * (1 - c.rowsW)) / 4;
        }
        let dy = 2 * LIMIT * sawtooth(I) * Math.min(1, wR * p.strength), dx = 2 * LIMIT * sawtooth(J) * Math.min(1, wC * p.strength);
        // The four cells around pull the vertex toward their centres: the 2 x 2
        // matrix of their pulls times the kernels [[-1, 1], [-1, 1]] (x) and
        // [[-1, -1], [1, 1]] (y), times a quarter.
        const P = [[cell(va - 1, vb - 1).pull, cell(va, vb - 1).pull], [cell(va - 1, vb).pull, cell(va, vb).pull]];
        dx += (-P[0][0] + P[0][1] - P[1][0] + P[1][1]) * 0.25;
        dy += (-P[0][0] - P[0][1] + P[1][0] + P[1][1]) * 0.25;
        dx = Math.max(-LIMIT, Math.min(LIMIT, dx));
        dy = Math.max(-LIMIT, Math.min(LIMIT, dy));
        X[b * row + a] = va + dx;
        Y[b * row + a] = vb + dy;
      }
    }
    // Count jumps along rows (for the panel).
    for (let b = 0; b <= n; b++) for (let a = 0; a < n; a++) if (Math.abs(Y[b * row + a + 1] - Y[b * row + a]) > 0.6) jumps++;
    const cellsOut = [];
    for (let j = j0; j < j0 + n; j++) for (let i = i0; i < i0 + n; i++) cellsOut.push(cell(i, j));
    return { X, Y, row, N: n, i0, j0, cells: cellsOut, jumps, time: performance.now() - t0 };
  }

  M.cellFormula = cellFormula;
  M.formulaGrid = formulaGrid;
  M.scurve = S;
  M.KERNELS = KERNELS;
})(window.Markr = window.Markr || {});
