// Streams: small, from the head of a valley down to water, within a window of a
// section and its neighbour ring. No catchment: a stream's width comes from the
// moisture where it runs. Streams end in the sea, a river, a lake, or another
// stream. A pit on the way fills locally (at most LAKE_MAX cells) and becomes a
// lake if it is deep enough; the stream carries on from where it spills.
// Streams are water: they colour the cells they run through.
(function (M) {
  'use strict';

  const S = M.scurve;
  const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const LAKE_MAX = 40, STEPS = 400;

  // H(i, j): height; cellAt(i, j): cell formula output; moist(i, j, h): 0..1.
  // The window is cells [a0, a0 + w) x [b0, b0 + w).
  function streamNet(H, cellAt, moist, a0, b0, w, p) {
    const inside = (i, j) => i >= a0 && j >= b0 && i < a0 + w && j < b0 + w;
    const key = (i, j) => i + ',' + j;
    const isWater = (i, j) => {
      const c = cellAt(i, j);
      return c && (c.kind === 'water' || c.kind === 'river' || c.kind === 'coast');
    };
    const out = new Map(); // key -> {width, firm, lake}

    // Sources: the head of a valley (no valley cell drains into it), steep
    // enough, spaced apart, highest first.
    const cand = [];
    for (let j = b0 + 1; j < b0 + w - 1; j++) {
      for (let i = a0 + 1; i < a0 + w - 1; i++) {
        const c = cellAt(i, j);
        if (!c || c.kind !== 'valley' || (c.edge || 0) < 0.3) continue;
        if (S(p.sourceFrom, p.sourceTo, c.slope) < 0.5) continue;
        const h = H(i, j);
        let fed = false;
        for (const [di, dj] of N8) {
          const cn = cellAt(i + di, j + dj);
          if (cn && cn.kind === 'valley' && (cn.edge || 0) >= 0.3 && H(i + di, j + dj) > h) {
            // A higher valley cell next to it: is it draining here?
            let low = Infinity, li = 0, lj = 0;
            for (const [ei, ej] of N8) {
              const hh = H(i + di + ei, j + dj + ej);
              if (hh < low) {
                low = hh;
                li = i + di + ei;
                lj = j + dj + ej;
              }
            }
            if (li === i && lj === j) fed = true;
          }
        }
        if (!fed) cand.push([h, i, j]);
      }
    }
    cand.sort((x, y) => y[0] - x[0]);
    const sources = [];
    for (const [, i, j] of cand) {
      if (sources.some(([si, sj]) => Math.max(Math.abs(si - i), Math.abs(sj - j)) < p.sourceSpacing)) continue;
      sources.push([i, j]);
    }

    const mark = (i, j, lake) => {
      const h = H(i, j), m = moist(i, j, h);
      const firm = cellAt(i, j) ? cellAt(i, j).firm ?? 0.5 : 0.5;
      out.set(key(i, j), { i, j, width: 2 + 4 * m + 2 * (1 - firm), firm, lake });
    };

    // A pit: fill it, lowest neighbour first, until a cell lower than the
    // level is reached (the spill). Returns the spill cell, or null.
    const fill = (i, j) => {
      const level0 = H(i, j);
      const region = new Set([key(i, j)]);
      const edge = [];
      const add = (a, b) => {
        for (const [di, dj] of N8) {
          const k = key(a + di, b + dj);
          if (region.has(k) || !inside(a + di, b + dj)) continue;
          edge.push([H(a + di, b + dj), a + di, b + dj]);
        }
      };
      add(i, j);
      let level = level0;
      for (let n = 0; n < LAKE_MAX && edge.length; n++) {
        edge.sort((x, y) => x[0] - y[0]);
        const [h, a, b] = edge.shift();
        if (region.has(key(a, b))) continue;
        if (h < level) {
          // Spill: the lake is the region below `level`.
          if (level - level0 > p.lakeDepth) for (const k of region) {
            const [ri, rj] = k.split(',').map(Number);
            if (H(ri, rj) < level) mark(ri, rj, true);
          }
          return [a, b];
        }
        level = h;
        region.add(key(a, b));
        add(a, b);
      }
      return null;
    };

    for (const [si, sj] of sources) {
      let i = si, j = sj;
      for (let step = 0; step < STEPS; step++) {
        if (!inside(i, j) || isWater(i, j)) break;
        const k = key(i, j);
        if (out.has(k) && step > 0) break; // joins another stream
        mark(i, j, false);
        let bi = i, bj = j, bh = H(i, j);
        for (const [di, dj] of N8) {
          const hh = H(i + di, j + dj);
          if (hh < bh) {
            bh = hh;
            bi = i + di;
            bj = j + dj;
          }
        }
        if (bi === i && bj === j) {
          const sp = fill(i, j);
          if (!sp) break;
          [i, j] = sp;
        } else {
          i = bi;
          j = bj;
        }
      }
    }

    // Stream cells by position, for the vertex formula's pull.
    const pts = [...out.values()].filter((v) => !v.lake).map((v) => ({ x: v.i + 0.5, y: v.j + 0.5, firm: v.firm }));
    const nearest = (x, y, r) => {
      let best = null, bd = r;
      for (const pt of pts) {
        const d = Math.hypot(pt.x - x, pt.y - y);
        if (d < bd) {
          bd = d;
          best = pt;
        }
      }
      return best ? { pt: best, d: bd } : null;
    };
    const lakes = [...out.values()].filter((v) => v.lake).length;
    return { sources, cellAt: (i, j) => out.get(key(i, j)) || null, nearest, streams: out.size - lakes, lakes };
  }

  M.streamNet = streamNet;
})(window.Markr = window.Markr || {});
