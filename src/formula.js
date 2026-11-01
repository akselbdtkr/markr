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

  // Direction of the contour through a 3 x 3 window, as an angle a in
  // (-90, 90] degrees (a line has no sense of direction), plus slope and
  // curvature. Shared by the cell formula and the section formula.
  function windowShape(w, spacing) {
    const gx = apply(KERNELS.gx, w) / spacing, gy = apply(KERNELS.gy, w) / spacing;
    const hxx = apply(KERNELS.hxx, w) / (spacing * spacing), hyy = apply(KERNELS.hyy, w) / (spacing * spacing);
    const hxy = apply(KERNELS.hxy, w) / (spacing * spacing);
    const g = Math.hypot(gx, gy);
    let a = Math.atan2(gx, -gy); // contour direction
    if (a > Math.PI / 2) a -= Math.PI;
    if (a <= -Math.PI / 2) a += Math.PI;
    let d2 = 0;
    if (g > 1e-4) {
      const tx = -gy / g, ty = gx / g;
      d2 = 0.5 * C * C * (tx * tx * hxx + 2 * tx * ty * hxy + ty * ty * hyy);
    }
    return { gx, gy, g, slope: Math.atan(g) * DEG, a, d2 };
  }

  // The cell formula. H(i, j) gives the height at the centre of cell (i, j).
  // Returns {a, follow, edge, kind, size, pull, slope, d2, h}.
  function cellFormula(H, i, j, p) {
    // The 3 x 3 window of heights.
    const w = [-1, 0, 1].map((dj) => [-1, 0, 1].map((di) => H(i + di, j + dj)));
    const h0 = w[1][1];
    let lo = Infinity, hi = -Infinity;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (r !== 1 || c !== 1) {
      lo = Math.min(lo, w[r][c]);
      hi = Math.max(hi, w[r][c]);
    }
    const sh = windowShape(w, 1);
    // Coast: near 0 m with land and water both in the window.
    if (Math.abs(h0) < p.coastBand && Math.min(lo, h0) < 0 && Math.max(hi, h0) >= 0) {
      return { a: sh.a, follow: 1, edge: 0, kind: 'coast', size: 1, pull: 0, slope: sh.slope, d2: 0, h: h0 };
    }
    if (h0 < 0) return { a: 0, follow: 0, edge: 0, kind: 'water', size: 1, pull: 0, slope: 0, d2: 0, h: h0 };
    // Ridge or valley: curvature along the contour, t^T Hess t, as the height
    // difference (m) between the cell and its neighbours one cell along the
    // contour on each side. Negative: both sides lower (ridge); positive: valley.
    let kind = sh.d2 < 0 ? 'ridge' : 'valley';
    if (h0 > hi) kind = 'peak';
    else if (h0 < lo) kind = 'pit';
    // S-curves.
    const follow = S(p.followFrom, p.followTo, sh.slope);
    const edge = S(p.edgeFrom, p.edgeTo, Math.abs(sh.d2)) * S(p.followFrom * 0.5, p.followTo * 0.5, sh.slope);
    const steep = S(p.sizeFrom, p.sizeTo, sh.slope);
    const size = 1 - p.sizeAmount * Math.max(steep, edge * p.edgeSize);
    const pull = p.sizeAmount * steep * 0.5 + p.edgePull * edge;
    // Flat cells push their corners out (a negative pull), so they grow where
    // steep neighbours shrink: more spread in cell size.
    const flat = (1 - S(p.followFrom, p.sizeFrom, sh.slope)) * (p.sizeSpread ?? 0) * 0.25;
    return { a: sh.a, follow: Math.max(follow, edge), edge, kind, size, pull: pull - flat, slope: sh.slope, d2: sh.d2, h: h0 };
  }

  // The section formula: the same window, over the mean heights of a section
  // and its 8 neighbours, gives the general direction of the land over a
  // section. Sections rotate more but do not change size.
  function sectionFormula(HS, si, sj, p) {
    const w = [-1, 0, 1].map((dj) => [-1, 0, 1].map((di) => HS(si + di, sj + dj)));
    const sh = windowShape(w, SECTION);
    const weight = S(p.secFrom, p.secTo, sh.slope);
    return { a: sh.a, weight, slope: sh.slope };
  }

  const SECTION = 8;

  // Builds the grid of cells [i0, i0 + n) x [j0, j0 + n). height(x, y) in metres.
  function formulaGrid(height, i0, j0, n, p) {
    const t0 = performance.now();
    const MG = ORIGIN + 2 * SECTION; // margin of cells, so every row sum and section starts inside
    const R = n + 2 * MG, at = (i, j) => (j - j0 + MG) * R + (i - i0 + MG);
    const Hc = new Float32Array(R * R);
    for (let j = j0 - MG; j < j0 + n + MG; j++) for (let i = i0 - MG; i < i0 + n + MG; i++) Hc[at(i, j)] = height((i + 0.5) * C, (j + 0.5) * C);
    const H = (i, j) => {
      i = Math.max(i0 - MG, Math.min(i0 + n + MG - 1, i));
      j = Math.max(j0 - MG, Math.min(j0 + n + MG - 1, j));
      return Hc[at(i, j)];
    };
    // Sections: mean height, and the section formula, cached.
    const secH = new Map(), secF = new Map();
    const HS = (si, sj) => {
      const k = si + ',' + sj;
      let v = secH.get(k);
      if (v === undefined) {
        v = 0;
        for (let y = 0; y < SECTION; y++) for (let x = 0; x < SECTION; x++) v += H(si * SECTION + x, sj * SECTION + y);
        v /= SECTION * SECTION;
        secH.set(k, v);
      }
      return v;
    };
    const section = (si, sj) => {
      const k = si + ',' + sj;
      let f = secF.get(k);
      if (!f) secF.set(k, (f = sectionFormula(HS, si, sj, p)));
      return f;
    };
    // The section direction at a cell, as a vector at twice the angle, blended
    // between the four nearest section centres: smooth across section edges.
    const sectionVec = (i, j) => {
      const u = (i + 0.5) / SECTION - 0.5, v = (j + 0.5) / SECTION - 0.5;
      const si = Math.floor(u), sj = Math.floor(v), fu = u - si, fv = v - sj;
      let x = 0, y = 0;
      for (const [di, dj, w] of [[0, 0, (1 - fu) * (1 - fv)], [1, 0, fu * (1 - fv)], [0, 1, (1 - fu) * fv], [1, 1, fu * fv]]) {
        const s = section(si + di, sj + dj);
        x += w * s.weight * Math.cos(2 * s.a);
        y += w * s.weight * Math.sin(2 * s.a);
      }
      return [x, y];
    };
    const DEFAULT = { a: 0, theta: 0, rowsW: 1, follow: 0, edge: 0, pull: 0, size: 1, kind: 'flat', h: 0 };
    const cells = new Array(R * R);
    for (let j = j0 - MG + 1; j < j0 + n + MG - 1; j++) {
      for (let i = i0 - MG + 1; i < i0 + n + MG - 1; i++) {
        const c = cellFormula(H, i, j, p);
        // The cell's own direction, and the section's, added as vectors at
        // twice the angle (a line pointing either way is the same line). Where
        // the cell is flat the section decides; on clear slopes the cell does.
        const [sx, sy] = c.kind === 'water' ? [0, 0] : sectionVec(i, j);
        const vx = c.follow * Math.cos(2 * c.a) + p.secStrength * sx, vy = c.follow * Math.sin(2 * c.a) + p.secStrength * sy;
        const aEff = Math.atan2(vy, vx) / 2;
        c.aEff = aEff;
        c.followEff = c.kind === 'coast' ? 1 : Math.min(1, Math.hypot(vx, vy));
        // Rows take lines lying along the rows, columns the others; around 45
        // degrees both, sliding from one to the other.
        c.rowsW = S(45 - p.blend, 45 + p.blend, 90 - Math.abs(aEff) * DEG);
        c.theta = aEff - (Math.PI / 2) * Math.round(aEff / (Math.PI / 2));
        cells[at(i, j)] = c;
      }
    }
    const cell = (i, j) => cells[at(i, j)] || DEFAULT;
    // Largest rotation used, so there are at least a few cells between jumps.
    const maxRot = ((p.maxRot ?? 30) * Math.PI) / 180;
    const clampRot = (t) => Math.max(-maxRot, Math.min(maxRot, t));
    // Row step between vertex (a, b) and (a + 1, b): the two cells beside it.
    const rowTan = (a, b) => {
      let s = 0;
      for (const c of [cell(a, b - 1), cell(a, b)]) s += Math.tan(clampRot(c.theta)) * c.followEff * c.rowsW * p.strength;
      return s / 2;
    };
    const colTan = (a, b) => {
      let s = 0;
      for (const c of [cell(a - 1, b), cell(a, b)]) s += -Math.tan(clampRot(c.theta)) * c.followEff * (1 - c.rowsW) * p.strength;
      return s / 2;
    };
    // Where row b starts summing (from 0): every ORIGIN cells, shifted by smooth
    // Perlin noise over the row number. Neighbouring rows start near each other,
    // so they follow nearly the same course, but the restarts (and the jumps)
    // do not line up in one column. `jumpMix` sets how far the shift reaches.
    const noise = M.noise.createPerlin(p.seed * 7 + 3);
    const originOf = (k) => Math.floor((noise(k * 0.13, 0.5) * 0.5 + 0.5) * ORIGIN * p.jumpMix);
    // The row's deviation from its own place, from the running sum: it rises
    // with the slope of the line, then falls back over a share `jumpSoft` of the
    // period, so a jump is spread over a cell or two instead of one edge.
    const f = Math.max(0, Math.min(0.5, p.jumpSoft));
    const saw = (I) => {
      const u = I + 0.5 - Math.floor(I + 0.5);
      if (f <= 0) return u - 0.5;
      return u < 1 - f ? -0.5 + u / (1 - f) : 0.5 - (u - (1 - f)) / f;
    };
    const row = n + 1, X = new Float64Array(row * row), Y = new Float64Array(row * row);
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
        let wR = 0, wC = 0, fol = 0, tr = 0;
        for (const c of c4) {
          wR += (c.followEff * c.rowsW) / 4;
          wC += (c.followEff * (1 - c.rowsW)) / 4;
          fol += c.followEff / 4;
          tr += (4 * c.rowsW * (1 - c.rowsW)) / 4; // 1 at 45 degrees, 0 away from it
        }
        // In the hand-over between row lines and column lines, every other row
        // and every other column follows the line fully instead of all of them
        // halfway, so the line stays unbroken through the turn.
        const alt = (p.alternate ?? 0) * tr;
        if (alt > 0) {
          if (((vb % 2) + 2) % 2 === 0) wR += (fol - wR) * alt;
          if (((va % 2) + 2) % 2 === 0) wC += (fol - wC) * alt;
        }
        // At full height the rows reach ±0.5, so a row ends where the next one
        // begins: the line carries on unbroken, and the pinched cell between
        // them is merged by the cell checks below.
        const amp = p.jumpReach ?? 1;
        let dy = amp * saw(I) * Math.min(1, wR * p.strength), dx = amp * saw(J) * Math.min(1, wC * p.strength);
        // The four cells around pull the vertex toward their centres: the 2 x 2
        // matrix of their pulls times the kernels [[-1, 1], [-1, 1]] (x) and
        // [[-1, -1], [1, 1]] (y), times a quarter.
        const P = [[c4[0].pull, c4[1].pull], [c4[2].pull, c4[3].pull]];
        dx += (-P[0][0] + P[0][1] - P[1][0] + P[1][1]) * 0.25;
        dy += (-P[0][0] - P[0][1] + P[1][0] + P[1][1]) * 0.25;
        // Coast: where the four cells around hold both land and water, the
        // vertex is pulled hard onto the 0 m line (one Newton step along the
        // slope of the four heights).
        const h4 = c4.map((c) => c.h);
        if (Math.min(...h4) < 0 && Math.max(...h4) >= 0 && c4.some((c) => c.kind === 'coast')) {
          const hv = (h4[0] + h4[1] + h4[2] + h4[3]) / 4;
          const gx = (h4[1] + h4[3] - h4[0] - h4[2]) / (2 * C), gy = (h4[2] + h4[3] - h4[0] - h4[1]) / (2 * C);
          const g2 = gx * gx + gy * gy;
          if (g2 > 1e-8) {
            const sx = (-hv * gx) / g2 / C, sy = (-hv * gy) / g2 / C;
            dx += p.coastPull * (sx - dx);
            dy += p.coastPull * (sy - dy);
          }
        }
        const lim = Math.max(LIMIT, amp / 2);
        dx = Math.max(-lim, Math.min(lim, dx));
        dy = Math.max(-lim, Math.min(lim, dy));
        X[b * row + a] = va + dx;
        Y[b * row + a] = vb + dy;
      }
    }

    // Cell checks, in three steps, a hard limit: a cell with one edge too short
    // (or a corner pushed in) joins that edge's two corners: a triangle. A cell
    // too narrow across its rows (or columns) joins two and two corners: a line.
    // A cell too small both ways joins all four: a point. Neighbouring cells
    // share the corners, so they end on the triangle, line or point.
    const minC = p.minCell / C;
    const V = (a, b) => b * row + a;
    const join = (ks) => {
      let sx = 0, sy = 0;
      for (const q of ks) {
        sx += X[q];
        sy += Y[q];
      }
      for (const q of ks) {
        X[q] = sx / ks.length;
        Y[q] = sy / ks.length;
      }
    };
    const len = (q, r) => Math.hypot(X[r] - X[q], Y[r] - Y[q]);
    const counts = { triangle: 0, line: 0, point: 0 };
    const state = new Uint8Array(n * n); // 0 whole, 3 triangle, 2 line, 1 point
    for (let round = 0; round < 8; round++) {
      let changed = false;
      for (let b = 0; b < n; b++) {
        for (let a = 0; a < n; a++) {
          if (state[b * n + a] === 1) continue;
          const q = [V(a, b), V(a + 1, b), V(a + 1, b + 1), V(a, b + 1)];
          const e = [len(q[0], q[1]), len(q[1], q[2]), len(q[2], q[3]), len(q[3], q[0])];
          // Height across the rows (left and right sides measured across the
          // cell's row direction) and width across the columns.
          const ux = (X[q[1]] - X[q[0]] + X[q[2]] - X[q[3]]) / 2, uy = (Y[q[1]] - Y[q[0]] + Y[q[2]] - Y[q[3]]) / 2;
          const vx = (X[q[3]] - X[q[0]] + X[q[2]] - X[q[1]]) / 2, vy = (Y[q[3]] - Y[q[0]] + Y[q[2]] - Y[q[1]]) / 2;
          const lu = Math.hypot(ux, uy) || 1, lv = Math.hypot(vx, vy) || 1;
          const hL = (ux * (Y[q[3]] - Y[q[0]]) - uy * (X[q[3]] - X[q[0]])) / lu, hR = (ux * (Y[q[2]] - Y[q[1]]) - uy * (X[q[2]] - X[q[1]])) / lu;
          const wT = -(vx * (Y[q[1]] - Y[q[0]]) - vy * (X[q[1]] - X[q[0]])) / lv, wB = -(vx * (Y[q[2]] - Y[q[3]]) - vy * (X[q[2]] - X[q[3]])) / lv;
          const narrow = (h1, h2) => {
            const z1 = Math.abs(h1) < 1e-6, z2 = Math.abs(h2) < 1e-6;
            if (z1 && z2) return false;
            return (!z1 && h1 < 0) || (!z2 && h2 < 0) || Math.max(h1, h2) < minC;
          };
          const rowsN = narrow(hL, hR), colsN = narrow(wT, wB);
          if (rowsN && colsN) {
            join(q);
            state[b * n + a] = 1;
            counts.point++;
            changed = true;
            continue;
          }
          if (rowsN || colsN) {
            if (state[b * n + a] === 2) continue;
            if (rowsN) {
              join([q[0], q[3]]);
              join([q[1], q[2]]);
            } else {
              join([q[0], q[1]]);
              join([q[3], q[2]]);
            }
            state[b * n + a] = 2;
            counts.line++;
            changed = true;
            continue;
          }
          if (state[b * n + a]) continue;
          // Triangle: the shortest non-zero edge below half the smallest cell,
          // or a corner pushed inward, joins its two ends.
          let k = -1;
          for (let c = 0; c < 4; c++) {
            const A = q[(c + 3) % 4], B = q[c], D = q[(c + 1) % 4];
            const turn = (X[B] - X[A]) * (Y[D] - Y[B]) - (Y[B] - Y[A]) * (X[D] - X[B]);
            if (turn < -1e-9 && e[(c + 3) % 4] > 1e-6 && e[c] > 1e-6) k = e[(c + 3) % 4] < e[c] ? (c + 3) % 4 : c;
          }
          if (k < 0) {
            let m = Infinity;
            for (let c = 0; c < 4; c++) if (e[c] > 1e-6 && e[c] < minC * 0.5 && e[c] < m) (m = e[c]), (k = c);
          }
          if (k >= 0) {
            join([q[k], q[(k + 1) % 4]]);
            state[b * n + a] = 3;
            counts.triangle++;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }

    // Splitting, a hard local limit: a cell is split when it is clearly larger
    // than it should be on its slope, in two along the contour, or in four;
    // never into parts smaller than the smallest cell.
    const cellsOut = [];
    for (let b = 0; b < n; b++) {
      for (let a = 0; a < n; a++) {
        const c = Object.assign({}, cell(i0 + a, j0 + b));
        const q = [V(a, b), V(a + 1, b), V(a + 1, b + 1), V(a, b + 1)];
        const area = Math.abs((X[q[0]] - X[q[2]]) * (Y[q[1]] - Y[q[3]]) - (X[q[1]] - X[q[3]]) * (Y[q[0]] - Y[q[2]])) / 2;
        const side = Math.sqrt(area), ratio = side / c.size;
        c.collapse = state[b * n + a];
        c.split = c.collapse || side / 2 < minC ? 0 : ratio > p.split4 ? 4 : ratio > p.split2 ? 2 : 0;
        cellsOut.push(c);
      }
    }
    let jumps = 0;
    for (let b = 0; b <= n; b++) for (let a = 0; a < n; a++) if (Math.abs(Y[b * row + a + 1] - Y[b * row + a]) > 0.6) jumps++;
    const sections = [];
    for (let sj = Math.floor(j0 / SECTION); sj < Math.ceil((j0 + n) / SECTION); sj++) {
      for (let si = Math.floor(i0 / SECTION); si < Math.ceil((i0 + n) / SECTION); si++) sections.push(Object.assign({ si, sj }, section(si, sj)));
    }
    return { X, Y, row, N: n, i0, j0, cells: cellsOut, jumps, counts, sections, time: performance.now() - t0 };
  }

  M.cellFormula = cellFormula;
  M.sectionFormula = sectionFormula;
  M.SECTION_CELLS = SECTION;
  M.formulaGrid = formulaGrid;
  M.scurve = S;
  M.KERNELS = KERNELS;
})(window.Markr = window.Markr || {});
