// Nedbørsfeltene i de store lagene: which land drains to the sea, and which
// drains into a closed hollow (a lukket basseng) with no sea in it.
//
// Read from the base value alone (kontinent, havbasseng, grunnlag and the
// straits: the large, smooth layers), on a coarse grid of nodes:
//
// 1. Flood from the ocean (priority flood): the sea that touches the edge of
//    the grid, and the edge itself (its outlet is unknown), are the sources.
//    Nodes are taken in order of the lowest level water must rise to before
//    it can run out to them: the fill level F >= v. Where F > v the node lies
//    in a hollow: if it filled with water, it would be a lake up to F.
// 2. Every node runs down its steepest slope (D8) to a pit, to the sea or
//    off the grid. The pit's hollow names the node's field.
// 3. The hollows are joined into fields: one per connected group of filled
//    nodes, with its spill point (where the water would run over) and the
//    lowest path from there on to the ocean (the parents in the flood).
//
// A hollow with sea in it is an innhav: sea cut off from the ocean. Its spill
// level says how high the land between it and the ocean is, and the path
// says where a strait would have to run.
(function (M) {
  'use strict';

  // A binary heap of node indices by key.
  class Heap {
    constructor(n) {
      this.k = new Float64Array(n);
      this.i = new Int32Array(n);
      this.n = 0;
    }
    push(key, idx) {
      let c = this.n++;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (this.k[p] <= key) break;
        this.k[c] = this.k[p];
        this.i[c] = this.i[p];
        c = p;
      }
      this.k[c] = key;
      this.i[c] = idx;
    }
    pop() {
      const top = this.i[0], key = this.k[--this.n], idx = this.i[this.n];
      let c = 0;
      for (;;) {
        let m = 2 * c + 1;
        if (m >= this.n) break;
        if (m + 1 < this.n && this.k[m + 1] < this.k[m]) m++;
        if (this.k[m] >= key) break;
        this.k[c] = this.k[m];
        this.i[c] = this.i[m];
        c = m;
      }
      this.k[c] = key;
      this.i[c] = idx;
      return top;
    }
  }

  const DI = [1, 1, 0, -1, -1, -1, 0, 1], DJ = [0, 1, 1, 1, 0, -1, -1, -1];
  const DL = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

  // The fields over [x0, x0 + nx·G) × [y0, y0 + ny·G), nodes G apart.
  // value(x, y): the base value. tSea: the sea threshold. eps: how much a
  // node must lie under its fill level to count as in a hollow.
  function analyse(value, x0, y0, nx, ny, G, tSea, eps = 0.002) {
    const t0 = performance.now(), n = nx * ny;
    const v = new Float32Array(n);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = value(x0 + (i + 0.5) * G, y0 + (j + 0.5) * G);
    const sea = new Uint8Array(n);
    for (let k = 0; k < n; k++) sea[k] = v[k] < tSea ? 1 : 0;

    // The ocean: sea connected to the edge of the grid (diagonals too, as
    // in the flood).
    const ocean = new Uint8Array(n), stack = [];
    for (let k = 0; k < n; k++) {
      const i = k % nx, j = (k / nx) | 0;
      if (sea[k] && (i === 0 || j === 0 || i === nx - 1 || j === ny - 1)) {
        ocean[k] = 1;
        stack.push(k);
      }
    }
    while (stack.length) {
      const k = stack.pop(), i = k % nx, j = (k / nx) | 0;
      for (let d = 0; d < 8; d++) {
        const a = i + DI[d], b = j + DJ[d];
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const q = b * nx + a;
        if (sea[q] && !ocean[q]) {
          ocean[q] = 1;
          stack.push(q);
        }
      }
    }

    // 1. The flood: fill level F and the node the water came from.
    const F = new Float32Array(n), parent = new Int32Array(n).fill(-1), order = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n), heap = new Heap(n * 2);
    for (let k = 0; k < n; k++) {
      const i = k % nx, j = (k / nx) | 0;
      if (ocean[k] || i === 0 || j === 0 || i === nx - 1 || j === ny - 1) {
        F[k] = ocean[k] ? Math.min(v[k], tSea) : v[k];
        done[k] = 1;
        heap.push(F[k], k);
      }
    }
    let seq = 0;
    while (heap.n) {
      const k = heap.pop();
      order[k] = seq++;
      const i = k % nx, j = (k / nx) | 0;
      for (let d = 0; d < 8; d++) {
        const a = i + DI[d], b = j + DJ[d];
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const q = b * nx + a;
        if (done[q]) continue;
        done[q] = 1;
        F[q] = Math.max(v[q], F[k]);
        parent[q] = k;
        heap.push(F[q], q);
      }
    }
    const edgeOf = (k) => {
      const i = k % nx, j = (k / nx) | 0;
      return i === 0 || j === 0 || i === nx - 1 || j === ny - 1;
    };
    // Where the flood came from in the end: ocean (1) or the grid's edge (2).
    const source = new Uint8Array(n);
    const srcOf = (k) => {
      if (source[k]) return source[k];
      const path = [];
      let q = k;
      while (!source[q] && parent[q] >= 0) {
        path.push(q);
        q = parent[q];
      }
      const s = source[q] || (ocean[q] ? 1 : 2);
      source[q] = s;
      for (const p of path) source[p] = s;
      return s;
    };

    // 3. Hollows: connected groups of nodes under their fill level (and
    // inland sea, which is a hollow by itself).
    const hollow = new Int32Array(n).fill(-1), fields = [];
    for (let k = 0; k < n; k++) {
      if (hollow[k] >= 0 || ocean[k] || !(F[k] > v[k] + eps || (sea[k] && !ocean[k]))) continue;
      const id = fields.length, f = { id, nodes: 0, lake: 0, sea: 0, level: F[k], deepest: 0, first: k, area: 0 };
      fields.push(f);
      hollow[k] = id;
      stack.push(k);
      while (stack.length) {
        const p = stack.pop(), i = p % nx, j = (p / nx) | 0;
        f.lake++;
        if (sea[p]) f.sea++;
        f.deepest = Math.max(f.deepest, F[p] - v[p]);
        if (order[p] < order[f.first]) f.first = p;
        for (let d = 0; d < 8; d++) {
          const a = i + DI[d], b = j + DJ[d];
          if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
          const q = b * nx + a;
          if (hollow[q] >= 0 || ocean[q] || !(F[q] > v[q] + eps || (sea[q] && !ocean[q]))) continue;
          if (Math.abs(F[q] - F[p]) > eps) continue; // one water level per hollow
          hollow[q] = id;
          stack.push(q);
        }
      }
      // Where it spills: the node the flood first reached it from, and the
      // path from there to the ocean (or off the grid).
      f.spill = parent[f.first] >= 0 ? parent[f.first] : f.first;
      f.toOcean = srcOf(f.spill) === 1;
      f.inlandSea = f.sea > 0;
    }

    // 2. Down the steepest slope to a pit, the sea or off the grid; the pit's
    // hollow (or -1 the ocean, -2 off the grid) names the field.
    const field = new Int32Array(n).fill(-3);
    const down = (k) => {
      const i = k % nx, j = (k / nx) | 0;
      let best = -1, bs = 0;
      for (let d = 0; d < 8; d++) {
        const a = i + DI[d], b = j + DJ[d];
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const q = b * nx + a, s = (v[k] - v[q]) / DL[d];
        if (s > bs) {
          bs = s;
          best = q;
        }
      }
      return best;
    };
    for (let k = 0; k < n; k++) {
      if (field[k] !== -3) continue;
      const path = [];
      let q = k, lab = -3;
      for (;;) {
        if (field[q] !== -3) {
          lab = field[q];
          break;
        }
        if (ocean[q]) {
          lab = -1;
          break;
        }
        if (hollow[q] >= 0) {
          lab = hollow[q];
          break;
        }
        path.push(q);
        if (edgeOf(q)) {
          lab = -2;
          break;
        }
        const d = down(q);
        if (d < 0) {
          // A pit outside any hollow (flat within eps): it drains with the
          // flood that reached it.
          lab = srcOf(q) === 1 ? -1 : -2;
          break;
        }
        q = d;
      }
      for (const p of path) field[p] = lab;
      if (field[k] === -3) field[k] = lab;
    }
    for (let k = 0; k < n; k++) if (field[k] >= 0) fields[field[k]].nodes++;
    for (const f of fields) f.area = f.nodes * G * G;
    // A field is closed when its whole drainage stays inside it: not when it
    // spills on (water that runs over leaves through the spill point).
    return { x0, y0, nx, ny, G, v, F, sea, ocean, hollow, field, parent, fields, time: performance.now() - t0 };
  }

  // The lowest path from a node on to the ocean or off the grid.
  function pathOut(a, k) {
    const out = [];
    let q = k;
    while (q >= 0 && out.length < 100000) {
      out.push(q);
      if (a.ocean[q]) break;
      q = a.parent[q];
    }
    return out;
  }

  M.Basins = { analyse, pathOut };
})(window.Markr = window.Markr || {});
