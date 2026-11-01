// Rivers on the cell grid, built from what the cell formula already knows.
//
// Firmness: high, dry ground is firm; low, wet ground is loose. Firm ground
// keeps a river narrow and straight and lets it cut deep; loose ground lets it
// widen and meander, and deform the cells around it more.
//
// Drainage: priority flood from the edge of the window gives every cell a way
// down (pits fill up; filled cells deep enough are lakes). Accumulation (the
// number of cells draining through a cell) gives the river's flow, and so its
// width: width grows with the square root of the catchment, not with the number
// of sources. Sources only decide where a stream becomes visible: the head of a
// valley (a valley cell whose uphill cell is not a valley), steep enough.
(function (M) {
  'use strict';

  const C = M.CELL_SIZE;
  const S = M.scurve;
  const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  class Heap {
    constructor() {
      this.k = [];
      this.v = [];
    }
    get size() {
      return this.k.length;
    }
    push(key, val) {
      const k = this.k, v = this.v;
      let n = k.length;
      k.push(key);
      v.push(val);
      while (n > 0) {
        const u = (n - 1) >> 1;
        if (k[u] <= k[n]) break;
        [k[u], k[n]] = [k[n], k[u]];
        [v[u], v[n]] = [v[n], v[u]];
        n = u;
      }
    }
    pop() {
      const k = this.k, v = this.v, top = v[0];
      const lk = k.pop(), lv = v.pop();
      if (k.length) {
        k[0] = lk;
        v[0] = lv;
        let n = 0;
        for (;;) {
          const l = 2 * n + 1, r = l + 1;
          let m = n;
          if (l < k.length && k[l] < k[m]) m = l;
          if (r < k.length && k[r] < k[m]) m = r;
          if (m === n) break;
          [k[m], k[n]] = [k[n], k[m]];
          [v[m], v[n]] = [v[n], v[m]];
          n = m;
        }
      }
      return top;
    }
  }

  // H(i, j): height; cellAt(i, j): cell formula output; moist(i, j, h): 0..1.
  // The window is cells [a0, a0 + w) x [b0, b0 + w).
  function riverNet(H, cellAt, moist, a0, b0, w, p) {
    const n = w * w, at = (i, j) => (j - b0) * w + (i - a0);
    const inside = (i, j) => i >= a0 && j >= b0 && i < a0 + w && j < b0 + w;
    const h = new Float32Array(n), firm = new Float32Array(n);
    for (let j = b0; j < b0 + w; j++) {
      for (let i = a0; i < a0 + w; i++) {
        const k = at(i, j), hh = H(i, j);
        h[k] = hh;
        firm[k] = 0.5 * S(p.firmLow, p.firmHigh, hh) + 0.5 * (1 - moist(i, j, hh));
      }
    }
    // Priority flood from the edge (and from the sea): filled height F, the way
    // down `to`, and the order cells were reached in (downstream first).
    const F = new Float32Array(n).fill(NaN), to = new Int32Array(n).fill(-1), order = [];
    const heap = new Heap();
    for (let j = b0; j < b0 + w; j++) {
      for (let i = a0; i < a0 + w; i++) {
        const k = at(i, j);
        if (i === a0 || j === b0 || i === a0 + w - 1 || j === b0 + w - 1 || h[k] < 0) {
          F[k] = h[k];
          heap.push(h[k], k);
        }
      }
    }
    while (heap.size) {
      const k = heap.pop();
      order.push(k);
      const i = a0 + (k % w), j = b0 + Math.floor(k / w);
      for (const [di, dj] of N8) {
        const ii = i + di, jj = j + dj;
        if (!inside(ii, jj)) continue;
        const kn = at(ii, jj);
        if (!Number.isNaN(F[kn])) continue;
        F[kn] = Math.max(h[kn], F[k] + 1e-3);
        to[kn] = k;
        heap.push(F[kn], kn);
      }
    }
    // Accumulation, upstream first.
    const acc = new Float32Array(n).fill(1);
    for (let q = order.length - 1; q >= 0; q--) {
      const k = order[q];
      if (to[k] >= 0) acc[to[k]] += acc[k];
    }
    // Lakes: filled deeper than lakeDepth, on land.
    const lake = new Uint8Array(n);
    for (let k = 0; k < n; k++) if (h[k] >= 0 && F[k] - h[k] > p.lakeDepth) lake[k] = 1;

    // Sources: the head of a valley, steep enough, spaced apart.
    const cand = [];
    for (let j = b0 + 1; j < b0 + w - 1; j++) {
      for (let i = a0 + 1; i < a0 + w - 1; i++) {
        const c = cellAt(i, j), k = at(i, j);
        if (!c || c.kind !== 'valley' || (c.edge || 0) < 0.3 || h[k] < 0) continue;
        if (S(p.sourceFrom, p.sourceTo, c.slope) < 0.5) continue;
        // Head: no valley cell drains into it.
        let fed = false;
        for (const [di, dj] of N8) {
          const ii = i + di, jj = j + dj;
          if (!inside(ii, jj)) continue;
          const kn = at(ii, jj), cn = cellAt(ii, jj);
          if (to[kn] === k && cn && cn.kind === 'valley' && (cn.edge || 0) >= 0.3) fed = true;
        }
        if (!fed) cand.push([h[k], i, j]);
      }
    }
    cand.sort((x, y) => y[0] - x[0]);
    const onRiver = new Int32Array(n).fill(-1), sources = [];
    for (const [, i, j] of cand) {
      if (sources.some(([si, sj]) => Math.max(Math.abs(si - i), Math.abs(sj - j)) < p.sourceSpacing)) continue;
      sources.push([i, j]);
    }
    // Trace each source down to the sea, the edge, or a river already traced.
    const rivers = [];
    for (const [si, sj] of sources) {
      let k = at(si, sj);
      if (onRiver[k] >= 0) continue;
      const id = rivers.length, cells = [];
      let joins = -1;
      while (k >= 0) {
        if (onRiver[k] >= 0) {
          joins = onRiver[k];
          cells.push(k);
          break;
        }
        onRiver[k] = id;
        cells.push(k);
        if (h[k] < 0) break;
        k = to[k];
      }
      rivers.push({ cells, joins });
    }
    // Shape each river: centreline through cell centres (smoothed), width from
    // the catchment and the ground, and meanders on loose ground: a sideways
    // swing, as large as the river is wide and the ground loose, with a
    // wavelength of about twelve widths. The phase comes from the source, so it
    // is the same every time.
    const shaped = [];
    for (const [r, rv] of rivers.entries()) {
      if (rv.cells.length < 2) continue;
      let pts = rv.cells.map((k) => [a0 + (k % w) + 0.5, b0 + Math.floor(k / w) + 0.5, k]);
      for (let it = 0; it < 2; it++) {
        const out = [pts[0]];
        for (let q = 0; q < pts.length - 1; q++) {
          const [x0, y0, k0] = pts[q], [x1, y1, k1] = pts[q + 1];
          out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1, k0], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1, k1]);
        }
        out.push(pts[pts.length - 1]);
        pts = out;
      }
      const phase = (((rv.cells[0] * 2654435761) >>> 0) / 4294967296) * Math.PI * 2;
      let s = 0;
      const line = [];
      for (let q = 0; q < pts.length; q++) {
        const [x, y, k] = pts[q];
        if (q) s += Math.hypot(x - pts[q - 1][0], y - pts[q - 1][1]);
        const loose = 1 - firm[k];
        const width = Math.min(p.maxWidth, (p.width * Math.sqrt(acc[k]) * (0.6 + 0.8 * loose)) / 4); // metres
        const wl = Math.max(3, (12 * width) / C); // cells
        const amp = Math.min(1.2, (p.meander * loose * width) / C); // cells
        const a = q > 0 ? pts[q - 1] : pts[q], b = q < pts.length - 1 ? pts[q + 1] : pts[q];
        let nx = -(b[1] - a[1]), ny = b[0] - a[0];
        const l = Math.hypot(nx, ny) || 1;
        nx /= l;
        ny /= l;
        // Fade the swing in from the source and out where the river leaves.
        const fade = Math.min(1, q / 8, (pts.length - 1 - q) / 8);
        const off = amp * fade * Math.sin((2 * Math.PI * s) / wl + phase);
        line.push({ x: x + nx * off, y: y + ny * off, width, firm: firm[k], depth: (p.incise * firm[k] * Math.sqrt(acc[k])) / 4, acc: acc[k] });
      }
      shaped.push({ id: r, joins: rv.joins, line });
    }
    // River samples in buckets per cell, for the vertex formula.
    const buckets = new Map();
    for (const rv of shaped) {
      for (const pt of rv.line) {
        const key = Math.floor(pt.x) + ',' + Math.floor(pt.y);
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = []));
        b.push(pt);
      }
    }
    const lakeAt = (i, j) => (inside(i, j) ? lake[at(i, j)] === 1 : false);
    const firmAt = (i, j) => (inside(i, j) ? firm[at(i, j)] : 0.5);
    const accAt = (i, j) => (inside(i, j) ? acc[at(i, j)] : 1);
    // Nearest river sample to (x, y) within r cells.
    const nearest = (x, y, r) => {
      let best = null, bd = r;
      const ci = Math.floor(x), cj = Math.floor(y), R = Math.ceil(r);
      for (let j = cj - R; j <= cj + R; j++) {
        for (let i = ci - R; i <= ci + R; i++) {
          const b = buckets.get(i + ',' + j);
          if (!b) continue;
          for (const pt of b) {
            const d = Math.hypot(pt.x - x, pt.y - y);
            if (d < bd) {
              bd = d;
              best = pt;
            }
          }
        }
      }
      return best ? { pt: best, d: bd } : null;
    };
    return { rivers: shaped, sources, lakeAt, firmAt, accAt, nearest, lakes: lake.reduce((a, b) => a + b, 0) };
  }

  M.riverNet = riverNet;
})(window.Markr = window.Markr || {});
