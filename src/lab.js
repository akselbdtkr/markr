// Grid lab: a small map with contour lines, the cross field and a grid that
// follows the terrain, with measurements to compare settings.
(function (M) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const C = M.CELL_SIZE;
  const canvas = $('map'), ctx = canvas.getContext('2d');

  const state = {
    seed: 1848, region: -1, sections: 8, cells: 8, align: 1, size: 0.5, anchor: 0.02, smoothing: 1,
    mode: 'global', buffer: 16, iters: 300, contour: 10,
    method: 'jumps', step: 50, minSlope: 0.06, pull: 1, showSnaps: true, run: 4, reach: 0.9,
    coastRun: 4, coastReach: 1.3, reachOut: 6, run: 6, reach: 1.1,
    ridges: 1, ridgeRun: 6, ridgeReach: 1.1, curvature: 0.003, startKind: 'rugged', rough: 0.7,
    slopeLines: 0.6, slopeSpacing: 3, slopeReach: 0.6, narrow: 0.6, gap: 0.3, sizeStrength: 3, minRidge: 100,
    showContours: true, showGrid: true, showField: false, showSections: true, showFolds: true, fillCells: false,
  };
  let terrain, field, grid, start, stats = {};
  const view = { scale: 1, ox: 0, oy: 0 }; // pixels per metre, offset
  let bg = null, contours = null, hover = null;

  const toScreen = (x, y) => [x * view.scale + view.ox, y * view.scale + view.oy];
  const toWorld = (sx, sy) => [(sx - view.ox) / view.scale, (sy - view.oy) / view.scale];
  const wrap45 = (a) => a - (Math.PI / 2) * Math.round(a / (Math.PI / 2));
  const deg = (a) => (a * 180) / Math.PI;

  // A place where 1 km holds both sea and slopes. Returns metres.
  function findStart(t) {
    const span = state.sections * state.cells * C;
    let best = [0, 0], bs = -Infinity;
    for (let gy = -12; gy <= 12; gy++) {
      for (let gx = -12; gx <= 12; gx++) {
        const x = gx * 3000, y = gy * 3000;
        let water = 0, lo = Infinity, hi = -Infinity, steep = 0;
        for (let k = 0; k < 25; k++) {
          const px = x + ((k % 5) / 4 - 0.5) * span, py = y + (Math.floor(k / 5) / 4 - 0.5) * span;
          const h = t.elevation(px, py, 50);
          if (h < 0) water++;
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
          if (state.startKind === 'rugged' && h > 0) steep += Math.abs(t.elevation(px + 30, py) - t.elevation(px - 30, py)) / 60;
        }
        // Rugged: the most relief, with a little coast. Varied: sea and slopes.
        const score =
          state.startKind === 'rugged'
            ? (water >= 2 && water <= 8 ? 150 : 0) + Math.min(hi - lo, 700) + 40 * steep - Math.hypot(gx, gy)
            : (water >= 3 && water <= 10 ? 200 : 0) + Math.min(hi, 200) - Math.hypot(gx, gy);
        if (score > bs) {
          bs = score;
          best = [x, y];
        }
      }
    }
    return best;
  }

  // The terrain, with optional extra ruggedness on land: branching ridges and
  // gullies about 400 m apart, in patches. The coast stays where it is.
  function newTerrain() {
    const base = new M.Terrain(state.seed, { region: state.region });
    const { createPerlin, fbm, ridged } = M.noise;
    const nR = createPerlin(state.seed * 31 + 5), nP = createPerlin(state.seed * 31 + 6);
    const extra = state.rough;
    terrain = {
      seed: state.seed,
      elevation(x, y, mw = 0) {
        const h = base.elevation(x, y, mw);
        if (!extra || h <= 0 || mw > 400) return h;
        const patch = M.util.smoothstep(-0.1, 0.6, fbm(nP, x / 1800, y / 1800, 2) / 0.2);
        const r = ridged(nR, x / 420, y / 420, 4) - 0.55;
        const hn = h + extra * patch * Math.min(1, h / 30) * 260 * r;
        return Math.max(hn, Math.min(h, 2));
      },
    };
    start = findStart(terrain);
    rebuildField();
  }

  // The map, in cells, around the start point.
  const mapCells = () => {
    const N = state.sections * state.cells;
    return { N, i0: Math.round(start[0] / C - N / 2), j0: Math.round(start[1] / C - N / 2) };
  };

  function rebuildField() {
    const { N, i0, j0 } = mapCells();
    const m = Math.max(state.buffer, 3 * state.cells + 8) + 6;
    const t0 = performance.now();
    field = new M.TerrainField(terrain, (i0 - m) * C, (j0 - m) * C, (N + 2 * m) * C, (N + 2 * m) * C, 8, { smoothing: state.smoothing, coarse: state.cells * C, curvature: state.curvature, minRidge: state.minRidge });
    stats.field = performance.now() - t0;
    bg = null;
    contours = null;
    rebuildGrid();
  }

  function rebuildGrid() {
    const { i0, j0 } = mapCells();
    const o = { i0, j0, sections: state.sections, cells: state.cells };
    grid =
      state.method === 'jumps'
        ? M.snapGrid(field, Object.assign(o, {
            step: state.step, minSlope: state.minSlope, pull: state.pull, run: state.run, reach: state.reach,
            coastRun: state.coastRun, coastReach: state.coastReach, reachOut: state.reachOut,
            ridges: state.ridges, ridgeRun: state.ridgeRun, ridgeReach: state.ridgeReach, curvature: state.curvature,
            slopeLines: state.slopeLines, slopeSpacing: state.slopeSpacing, slopeReach: state.slopeReach,
            narrow: state.narrow, gap: state.gap, sizeStrength: state.sizeStrength,
          }))
        : M.buildGrid(field, Object.assign(o, { buffer: state.buffer, mode: state.mode, align: state.align, size: state.size, anchor: state.anchor, iters: state.iters }));
    document.body.dataset.method = state.method;
    measure();
    draw();
  }

  // Vertex (a, b) of the map, in metres.
  const vtx = (a, b) => [grid.X[b * grid.row + a] * C, grid.Y[b * grid.row + a] * C];

  // How well the cells follow the lines, how many fold, how big the seams are.
  function measure() {
    let err = 0, base = 0, wsum = 0, folds = 0;
    for (let b = 0; b < grid.N; b++) {
      for (let a = 0; a < grid.N; a++) {
        const q = [vtx(a, b), vtx(a + 1, b), vtx(a + 1, b + 1), vtx(a, b + 1)];
        if (!convex(q)) folds++;
        const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
        const [th, s] = field.direction(cx, cy);
        if (s < 0.3) continue;
        // The cell's own axis: from the middle of its left side to its right side.
        const ax = (q[1][0] + q[2][0] - q[0][0] - q[3][0]) / 2, ay = (q[1][1] + q[2][1] - q[0][1] - q[3][1]) / 2;
        err += s * Math.abs(wrap45(Math.atan2(ay, ax) - th));
        base += s * Math.abs(th);
        wsum += s;
      }
    }
    // Edges between two vertices on the same line: grid edges that lie on it.
    let onLine = 0, onCoast = 0;
    if (grid.snappedR) {
      const row = grid.row;
      for (let b = 0; b <= grid.N; b++) {
        for (let a = 0; a <= grid.N; a++) {
          const k = b * row + a;
          // Row lines run along rows, column lines along columns.
          for (const [S, kn] of [[grid.snappedR, a < grid.N ? k + 1 : -1], [grid.snappedC, b < grid.N ? k + row : -1]]) {
            if (kn < 0 || Number.isNaN(S[k]) || S[kn] !== S[k]) continue;
            const [x0, y0] = vtx(a, b), [x1, y1] = kn === k + 1 ? vtx(a + 1, b) : vtx(a, b + 1);
            const l = Math.hypot(x1 - x0, y1 - y0);
            onLine += l;
            if (S[k] === 300000) onCoast += l;
          }
        }
      }
    }
    stats.onLine = onLine;
    stats.onCoast = onCoast;
    stats.err = wsum ? deg(err / wsum) : 0;
    stats.base = wsum ? deg(base / wsum) : 0;
    stats.folds = folds;
    stats.seam = grid.seam;
    stats.grid = grid.time;
    showStats();
  }

  function convex(p) {
    for (let k = 0; k < 4; k++) {
      const a = p[k], b = p[(k + 1) % 4], c = p[(k + 2) % 4];
      // Strictly turned the wrong way; a corner joined to its neighbour
      // (a collapsed cell) is not a fold.
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < -1e-9) return false;
    }
    return true;
  }

  function showStats() {
    const r = (v, d = 1) => v.toLocaleString('nb-NO', { maximumFractionDigits: d });
    const rows = [
      ['Avvik fra høydekurvene', `${r(stats.err)}° (rett rutenett: ${r(stats.base)}°)`],
      ['Brettede ruter', `${stats.folds}`],
      ...(grid.collapsed !== undefined ? [['Sammenslått i hopp', `${grid.collapsed} ruter til linjer, ${grid.points} til punkter`]] : []),
      ...(state.method === 'jumps' ? [['Kanter på linjene', `${r(stats.onLine / 1000, 2)} km (kyst ${r(stats.onCoast / 1000, 2)} km)`]] : []),
      ['Største søm', state.method === 'jumps' ? '0 m (hvert hjørne regnes lokalt)' : state.mode === 'global' ? 'ingen (hele kartet samlet)' : `${r(stats.seam * C, 2)} m`],
      ['Tid', `felt ${Math.round(stats.field)} ms, rutenett ${Math.round(stats.grid)} ms`],
    ];
    $('stats').innerHTML = '<dl>' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';
  }

  // --- drawing ---------------------------------------------------------------

  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const PAPER = [240, 237, 228];
  function terrainColour(h, gx, gy) {
    let c;
    if (h < 0) c = mix([150, 196, 220], [40, 90, 150], Math.min(1, -h / 60));
    else c = mix(mix([120, 165, 90], [190, 175, 120], Math.min(1, h / 250)), [160, 150, 140], Math.min(1, Math.max(0, (h - 250) / 400)));
    if (h >= 0) {
      const l = (-gx * -0.6 + -gy * -0.6) * 2 + 0.53;
      const f = 0.75 + 0.35 * Math.max(-1, Math.min(1, l));
      c = [c[0] * f, c[1] * f, c[2] * f];
    }
    return mix(c, PAPER, 0.45);
  }

  // The terrain as a picture, one pixel per raster sample.
  function background() {
    if (bg) return bg;
    const { nx, ny, h, res } = field;
    const cv = document.createElement('canvas');
    cv.width = nx;
    cv.height = ny;
    const g = cv.getContext('2d'), img = g.createImageData(nx, ny);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const k = y * nx + x;
        const gx = (h[y * nx + Math.min(nx - 1, x + 1)] - h[y * nx + Math.max(0, x - 1)]) / (2 * res);
        const gy = (h[Math.min(ny - 1, y + 1) * nx + x] - h[Math.max(0, y - 1) * nx + x]) / (2 * res);
        const c = terrainColour(h[k], gx, gy);
        img.data.set([c[0], c[1], c[2], 255], k * 4);
      }
    }
    g.putImageData(img, 0, 0);
    bg = cv;
    return bg;
  }

  // Contour lines by marching squares: segments for minor lines, every fifth
  // line, and the coast.
  function contourLines() {
    if (contours) return contours;
    const { nx, ny, h, res, x0, y0 } = field, I = state.contour;
    const out = { minor: [], major: [], coast: [] };
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const v = [h[y * nx + x], h[y * nx + x + 1], h[(y + 1) * nx + x + 1], h[(y + 1) * nx + x]];
        const lo = Math.min(...v), hi = Math.max(...v);
        for (let L = Math.ceil(lo / I) * I; L <= hi; L += I) {
          if (L < 0) continue;
          const P = [[0, 0], [1, 0], [1, 1], [0, 1]];
          const pts = [];
          for (let e = 0; e < 4; e++) {
            const a = v[e], b = v[(e + 1) % 4];
            if ((a < L) !== (b < L)) {
              const f = (L - a) / (b - a), p = P[e], q = P[(e + 1) % 4];
              pts.push([x0 + (x + p[0] + (q[0] - p[0]) * f) * res, y0 + (y + p[1] + (q[1] - p[1]) * f) * res]);
            }
          }
          const list = L === 0 ? out.coast : L % state.step === 0 ? out.major : out.minor;
          if (pts.length >= 2) list.push(pts[0], pts[1]);
          if (pts.length === 4) list.push(pts[2], pts[3]);
        }
      }
    }
    // Ridge and valley lines that are kept (long enough): where F crosses zero.
    out.ridge = [];
    out.valley = [];
    const F = field.F, RL = field.RL, kindR = field.ridgeKind;
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const k = y * nx + x;
        if (!kindR[k] || RL[k] < 0.5) continue;
        const v = [F[k], F[k + 1], F[k + nx + 1], F[k + nx]];
        const P = [[0, 0], [1, 0], [1, 1], [0, 1]], pts = [];
        for (let e = 0; e < 4; e++) {
          const a = v[e], b = v[(e + 1) % 4];
          if ((a < 0) !== (b < 0)) {
            const f = a / (a - b), p = P[e], q = P[(e + 1) % 4];
            pts.push([x0 + (x + p[0] + (q[0] - p[0]) * f) * res, y0 + (y + p[1] + (q[1] - p[1]) * f) * res]);
          }
        }
        const list = kindR[k] > 0 ? out.ridge : out.valley;
        if (pts.length >= 2) list.push(pts[0], pts[1]);
      }
    }
    contours = out;
    return out;
  }

  function fit() {
    const r = canvas.getBoundingClientRect();
    const { N, i0, j0 } = mapCells();
    const w = N * C, pad = 30;
    view.scale = Math.min((r.width - 2 * pad) / w, (r.height - 2 * pad) / w);
    view.ox = (r.width - w * view.scale) / 2 - i0 * C * view.scale;
    view.oy = (r.height - w * view.scale) / 2 - j0 * C * view.scale;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(r.width * dpr)) {
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--canvas-bg');
    ctx.fillRect(0, 0, r.width, r.height);
    // Terrain
    const img = background();
    const [bx, by] = toScreen(field.x0, field.y0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, bx, by, img.width * field.res * view.scale, img.height * field.res * view.scale);
    // Cells filled with the terrain colour at their centre
    if (state.fillCells) {
      for (let b = 0; b < grid.N; b++) {
        for (let a = 0; a < grid.N; a++) {
          const q = [vtx(a, b), vtx(a + 1, b), vtx(a + 1, b + 1), vtx(a, b + 1)];
          const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
          const [, , slope, h] = field.sample(cx, cy);
          const col = terrainColour(h, 0, 0);
          poly(q);
          ctx.fillStyle = ctx.strokeStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    // Contours
    if (state.showContours) {
      const L = contourLines();
      segs(L.minor, 'rgba(110,80,40,0.45)', 0.8);
      segs(L.major, 'rgba(110,80,40,0.8)', 1.4);
      segs(L.coast, 'rgba(30,80,150,0.95)', 2);
      segs(L.ridge, 'rgba(150,40,120,0.85)', 1.6);
      segs(L.valley, 'rgba(20,130,140,0.85)', 1.6);
    }
    // Folded cells
    if (state.showFolds) {
      ctx.fillStyle = 'rgba(220,40,40,0.55)';
      for (let b = 0; b < grid.N; b++) {
        for (let a = 0; a < grid.N; a++) {
          const q = [vtx(a, b), vtx(a + 1, b), vtx(a + 1, b + 1), vtx(a, b + 1)];
          if (convex(q)) continue;
          poly(q);
          ctx.fill();
        }
      }
    }
    // Grid
    if (state.showGrid) {
      ctx.strokeStyle = 'rgba(25,30,35,0.75)';
      ctx.lineWidth = Math.max(0.5, Math.min(1.2, view.scale * C * 0.05));
      ctx.beginPath();
      for (let b = 0; b <= grid.N; b++) line((k) => vtx(k, b));
      for (let a = 0; a <= grid.N; a++) line((k) => vtx(a, k));
      ctx.stroke();
    }
    // Section borders
    if (state.showSections) {
      ctx.strokeStyle = 'rgba(200,50,50,0.8)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      for (let b = 0; b <= grid.N; b += state.cells) line((k) => vtx(k, b));
      for (let a = 0; a <= grid.N; a += state.cells) line((k) => vtx(a, k));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Each section's rotation: a stroke along the general slope's contours.
    if (state.showSections && grid.rotations) {
      ctx.strokeStyle = 'rgba(200,50,50,0.9)';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const r of grid.rotations) {
        const [sx, sy] = toScreen(r.cx * C, r.cy * C);
        const l = state.cells * C * view.scale * 0.3 * Math.min(1, r.slope / 0.05);
        ctx.moveTo(sx - Math.cos(r.angle) * l, sy - Math.sin(r.angle) * l);
        ctx.lineTo(sx + Math.cos(r.angle) * l, sy + Math.sin(r.angle) * l);
      }
      ctx.stroke();
    }
    // Cross field
    if (state.showField) {
      ctx.strokeStyle = 'rgba(20,90,160,0.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const { N, i0, j0 } = mapCells();
      const step = C;
      for (let y = j0 * C; y <= (j0 + N) * C; y += step) {
        for (let x = i0 * C; x <= (i0 + N) * C; x += step) {
          const [th, s] = field.direction(x, y);
          const l = (0.4 * step * s) * view.scale;
          const [sx, sy] = toScreen(x, y);
          for (const a of [th, th + Math.PI / 2]) {
            ctx.moveTo(sx - Math.cos(a) * l, sy - Math.sin(a) * l);
            ctx.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l);
          }
        }
      }
      ctx.stroke();
    }
    // Vertices snapped onto a line
    if (state.showSnaps && grid.snapped) {
      ctx.fillStyle = 'rgba(200,60,20,0.9)';
      const rr = Math.max(1.5, Math.min(3.5, view.scale * C * 0.12));
      for (let b = 0; b <= grid.N; b++) {
        for (let a = 0; a <= grid.N; a++) {
          if (Number.isNaN(grid.snapped[b * grid.row + a])) continue;
          const [x, y] = toScreen(...vtx(a, b));
          ctx.beginPath();
          ctx.arc(x, y, rr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    // Hover
    if (hover) {
      poly(hover.q);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  function poly(q) {
    ctx.beginPath();
    q.forEach((p, n) => {
      const [x, y] = toScreen(p[0], p[1]);
      if (n) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
  }
  function line(at) {
    for (let k = 0; k <= grid.N; k++) {
      const [x, y] = toScreen(...at(k));
      if (k) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
  }
  function segs(list, colour, width) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let k = 0; k < list.length; k += 2) {
      const [ax, ay] = toScreen(list[k][0], list[k][1]), [bx, by] = toScreen(list[k + 1][0], list[k + 1][1]);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
  }

  // --- interaction ----------------------------------------------------------

  function cellAt(x, y) {
    for (let b = 0; b < grid.N; b++) {
      for (let a = 0; a < grid.N; a++) {
        const q = [vtx(a, b), vtx(a + 1, b), vtx(a + 1, b + 1), vtx(a, b + 1)];
        if (inside(q, x, y)) return { a, b, q };
      }
    }
    return null;
  }
  function inside(p, x, y) {
    let r = false;
    for (let k = 0, l = 3; k < 4; l = k++) {
      const [xi, yi] = p[k], [xj, yj] = p[l];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
    }
    return r;
  }

  function showCell(c) {
    if (!c) {
      $('cell').innerHTML = '<p class="muted">Hold over en rute.</p>';
      return;
    }
    const q = c.q;
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const [th, s] = field.direction(cx, cy);
    const [, , slope, h] = field.sample(cx, cy);
    const ax = (q[1][0] + q[2][0] - q[0][0] - q[3][0]) / 2, ay = (q[1][1] + q[2][1] - q[0][1] - q[3][1]) / 2;
    const rot = Math.atan2(ay, ax);
    const r = (v) => Math.round(v);
    const rows = [
      ['Rute', `(${c.a}, ${c.b}), seksjon (${Math.floor(c.a / state.cells)}, ${Math.floor(c.b / state.cells)})`],
      ['Høyde', `${r(h)} m`],
      ['Helning', `${r(Math.atan(slope) * 57.3)}°`],
      ['Høydekurvene', `${r(deg(th))}°, tydelighet ${r(s * 100)} %`],
      ['Ruta', `${r(deg(wrap45(rot)))}°, avvik ${r(deg(Math.abs(wrap45(rot - th))))}°`],
    ];
    $('cell').innerHTML = '<dl>' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';
  }

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy };
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    if (drag && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) {
      view.ox = drag.ox + e.clientX - drag.x;
      view.oy = drag.oy + e.clientY - drag.y;
      draw();
      return;
    }
    const [x, y] = toWorld(e.clientX - r.left, e.clientY - r.top);
    hover = cellAt(x, y);
    showCell(hover);
    draw();
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015);
    view.ox = sx - (sx - view.ox) * f;
    view.oy = sy - (sy - view.oy) * f;
    view.scale *= f;
    draw();
  }, { passive: false });
  window.addEventListener('resize', () => draw());

  // --- controls -------------------------------------------------------------

  let timer = null;
  const later = (fn) => {
    clearTimeout(timer);
    timer = setTimeout(fn, 200);
  };
  function range(id, key, fmt, then) {
    const el = $(id), out = $(id + '-out');
    el.value = state[key];
    out.textContent = fmt(state[key]);
    el.addEventListener('input', () => {
      state[key] = parseFloat(el.value);
      out.textContent = fmt(state[key]);
      later(then);
    });
  }
  range('align', 'align', (v) => (v ? v.toFixed(2) : 'av'), rebuildGrid);
  range('size', 'size', (v) => v.toFixed(1), rebuildGrid);
  range('anchor', 'anchor', (v) => `${v.toFixed(3)} (rekkevidde ${Math.round(1 / Math.sqrt(v))} ruter)`, rebuildGrid);
  range('smoothing', 'smoothing', (v) => v.toFixed(1), rebuildField);
  range('buffer', 'buffer', (v) => `${v} ruter`, rebuildField);
  range('cells', 'cells', (v) => `${v} × ${v} ruter`, () => {
    rebuildField();
    fit();
    draw();
  });
  range('step', 'step', (v) => `${v} m`, () => {
    contours = null;
    rebuildGrid();
  });
  range('minSlope', 'minSlope', (v) => `${Math.round(Math.atan(v) * 57.3)}°`, rebuildGrid);
  range('pull', 'pull', (v) => v.toFixed(2), rebuildGrid);
  range('run', 'run', (v) => `${v} ruter`, rebuildGrid);
  range('coastRun', 'coastRun', (v) => `${v} ruter`, rebuildGrid);
  range('coastReach', 'coastReach', (v) => `${v.toFixed(2)} rute`, rebuildGrid);
  range('reachOut', 'reachOut', (v) => `${v} ruter`, rebuildGrid);

  range('reach', 'reach', (v) => `${v.toFixed(2)} rute`, rebuildGrid);
  range('ridges', 'ridges', (v) => (v ? v.toFixed(2) : 'av'), rebuildGrid);
  range('ridgeRun', 'ridgeRun', (v) => `${v} ruter`, rebuildGrid);
  range('ridgeReach', 'ridgeReach', (v) => `${v.toFixed(2)} rute`, rebuildGrid);
  range('curvature', 'curvature', (v) => v.toFixed(4), rebuildField);
  range('minRidge', 'minRidge', (v) => `${v} m`, rebuildField);
  range('slopeLines', 'slopeLines', (v) => (v ? v.toFixed(2) : 'av'), rebuildGrid);
  range('slopeSpacing', 'slopeSpacing', (v) => `${v} ruter`, rebuildGrid);
  range('narrow', 'narrow', (v) => (v ? v.toFixed(2) : 'av'), rebuildGrid);
  range('gap', 'gap', (v) => `${v.toFixed(2)} rute`, rebuildGrid);
  range('sizeStrength', 'sizeStrength', (v) => (v ? v.toFixed(1) : 'av'), rebuildGrid);
  $('method').value = state.method;
  $('method').addEventListener('change', (e) => {
    state.method = e.target.value;
    rebuildGrid();
  });
  range('contour', 'contour', (v) => `${v} m`, () => {
    contours = null;
    draw();
  });
  for (const [id, key] of [['showContours', 'showContours'], ['showGrid', 'showGrid'], ['showField', 'showField'], ['showSections', 'showSections'], ['showFolds', 'showFolds'], ['fillCells', 'fillCells'], ['showSnaps', 'showSnaps']]) {
    $(id).checked = state[key];
    $(id).addEventListener('change', (e) => {
      state[key] = e.target.checked;
      draw();
    });
  }
  $('mode').value = state.mode;
  $('mode').addEventListener('change', (e) => {
    state.mode = e.target.value;
    rebuildGrid();
  });
  const regionSel = $('region');
  M.REGIONS.forEach((r, k) => {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = r.name;
    regionSel.appendChild(o);
  });
  regionSel.addEventListener('change', () => {
    state.region = parseInt(regionSel.value, 10);
    newTerrain();
    fit();
    draw();
  });
  range('rough', 'rough', (v) => (v ? v.toFixed(2) : 'av'), () => {
    newTerrain();
    fit();
    draw();
  });
  $('startKind').value = state.startKind;
  $('startKind').addEventListener('change', (e) => {
    state.startKind = e.target.value;
    newTerrain();
    fit();
    draw();
  });
  $('seed').value = state.seed;
  $('seed').addEventListener('change', () => {
    state.seed = parseInt($('seed').value, 10) || 0;
    newTerrain();
    fit();
    draw();
  });
  $('reseed').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 100000);
    $('seed').value = state.seed;
    newTerrain();
    fit();
    draw();
  });
  $('fit').addEventListener('click', () => {
    fit();
    draw();
  });

  newTerrain();
  fit();
  draw();
  showCell(null);
  M.lab = { state, get grid() { return grid; }, get field() { return field; }, stats, rebuildGrid, rebuildField };
})(window.Markr = window.Markr || {});
