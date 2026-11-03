// Markr by: the start of the city logic. The grunn map (every layer, from
// grunnchain.js) is the height under the cell formulas (formula.js), and the
// cells are drawn as filled, opaque quads: the landscape is not drawn, only
// the cells, each in the colour of the land it stands on.
//
// Units: the view works in metres on screen. A cell is 16 m on screen; the
// grunn layers keep their own units, scaleH times larger across and scaleV
// times larger in height.
(function (M) {
  'use strict';

  const C = M.CELL_SIZE; // 16 m
  const TILE = 64; // cells per tile, worked out and cached one at a time
  const BORDER = 3; // cells around a tile, worked out but not drawn
  const REACH = 32 + BORDER + 1; // cells the formula reads around a tile // cells per height chunk
  const MIN_W = 100, MAX_W = 10000; // the view's width on screen, m

  const state = { ...structuredClone(M.GRUNN_DEFAULTS), colour: 'land', outline: true, shade: true };

  // The cell formulas, with the formel window's defaults.
  const FORMULA = {
    strength: 1, maxRot: 18, blend: 20, sizeAmount: 0.6, edgeSize: 0.6, edgePull: 0.8, sizeSpread: 1, alternate: 1, edgeReach: 0.6, contourFit: 0.5, coastJump: 1.8, ridgeJump: 1.6, contourJump: 1.4, narrow: 0.25, secSize: 1, secBudget: 0.25, split2: 2.5, split4: 3.6, jumpMix: 1,
    secStrength: 0.5, jumpSoft: 0, jumpReach: 1, coastBand: 8, coastPull: 1, minCell: 3,
    streams: false, riverPull: 0.6, lakeDepth: 1, sourceSpacing: 6,
    followFrom: 3, followTo: 12, edgeFrom: 1, edgeTo: 4, secFrom: 1, secTo: 6, sourceFrom: 8, sourceTo: 16, firmHFrom: 50, firmHTo: 600, dryFrom: 20, dryTo: 80, sizeFrom: 25, sizeTo: 50,
  };

  // --- the grunn chain (bychunk.js), always with every layer and the
  // section rivers, so a cell's height never depends on the zoom ---------------
  // Heights are worked out in chunks by a pool of workers, side by side; if
  // workers cannot start, here on the page.
  const CHUNK = M.BY_CHUNK;
  let chain = null;
  let chunks = new Map(), tiles = new Map(), gen = 0;
  const inflight = new Set();
  let queue = [];
  const pool = [];
  try {
    const n = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    for (let k = 0; k < n; k++) {
      const w = new Worker('src/byworker.js');
      w.busy = 0;
      w.onmessage = (e) => {
        const m = e.data;
        w.busy--;
        if (m.gen === gen) {
          const key = m.ci + ',' + m.cj;
          inflight.delete(key);
          chunks.set(key, m.ch);
        }
        pump();
        schedule();
      };
      w.onerror = (e) => {
        e.preventDefault();
        noWorkers();
      };
      pool.push(w);
    }
  } catch (err) {
    pool.length = 0;
  }
  function noWorkers() {
    for (const w of pool) w.terminate();
    pool.length = 0;
    inflight.clear();
    schedule();
  }
  function rebuild() {
    chain = M.byChain(state);
    chunks = new Map();
    tiles = new Map();
    inflight.clear();
    queue = [];
    gen++;
    const plain = JSON.parse(JSON.stringify(state));
    for (const w of pool) {
      w.busy = 0;
      w.postMessage({ type: 'init', state: plain, gen });
    }
  }
  function pump() {
    for (const w of pool) {
      while (w.busy < 2 && queue.length) {
        const [ci, cj] = queue.shift(), key = ci + ',' + cj;
        if (chunks.has(key) || inflight.has(key)) continue;
        inflight.add(key);
        w.busy++;
        w.postMessage({ type: 'chunk', gen, ci, cj });
      }
    }
  }
  // A chunk, worked out here if it is not ready (no workers, or the pointer).
  function chunk(ci, cj) {
    const k = ci + ',' + cj;
    let ch = chunks.get(k);
    if (!ch) chunks.set(k, (ch = M.byChunk(chain, state, ci, cj)));
    return ch;
  }
  const cellData = (i, j) => {
    const ci = Math.floor(i / CHUNK), cj = Math.floor(j / CHUNK);
    return [chunk(ci, cj), (j - cj * CHUNK) * CHUNK + (i - ci * CHUNK)];
  };
  const H = (i, j) => {
    const [ch, q] = cellData(i, j);
    return ch.h[q];
  };
  const cellOf = (x) => Math.floor(x / C);

  function params() {
    const p = { seed: state.seed, ...FORMULA };
    // Rivers: the river's cells lie just under their own water level, so the
    // formula reads them as river and their banks as a shore.
    p.waterLevel = (x, y) => {
      const i = cellOf(x), j = cellOf(y);
      return wetOf(i, j) === 2 ? H(i, j) + 0.5 : null;
    };
    p.firmness = (x, y) => {
      const [ch, q] = cellData(cellOf(x), cellOf(y));
      return ch.firm[q];
    };
    return p;
  }

  // --- colours ---------------------------------------------------------------
  const SEA = [61, 111, 168], RIVER = [72, 128, 186];
  const SAND = [226, 210, 160], RIDGE = [252, 246, 230], VALLEY = [46, 78, 58];
  const KIND_RGB = { water: SEA, river: RIVER, coast: [226, 208, 150], ridge: [176, 108, 84], valley: [104, 156, 104], peak: [150, 70, 60], pit: [70, 120, 130], flat: [214, 210, 196] };
  const KIND_NAMES = { water: 'hav', river: 'elv', coast: 'kyst', ridge: 'egg', valley: 'dal', peak: 'topp', pit: 'bunn', flat: 'flat' };
  const LIGHT = (() => {
    const l = [-1, -1, 1.4], n = Math.hypot(...l);
    return l.map((v) => v / n);
  })();
  // Water under a cell: 0 none, 1 sea, 2 river. A river counts already
  // when it covers a small share of the cell (RIVER_COVER), so narrow
  // rivers stay an unbroken line of cells.
  const RIVER_COVER = 0.1;
  function wetOf(i, j) {
    const [ch, q] = cellData(i, j);
    if (ch.cls[q] === 4 || ch.cov[q] >= RIVER_COVER) return 2;
    if (ch.cls[q] === 0 || ch.h[q] < 0) return 1;
    return 0;
  }
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  // What a cell is drawn as: hav, elv, kyst (land next to the sea: sand),
  // bredde (land next to a river: halfway to blue) or land.
  function cellRole(c, i, j) {
    const wet = wetOf(i, j);
    if (c.kind === 'water' || wet === 1) return 'sea';
    if (c.kind === 'river' || wet === 2) return 'river';
    // A shore cell under its water level is water: the sea reaches the coast.
    if (c.kind === 'coast' && c.h < 0) return c.level > 0 ? 'river' : 'sea';
    let sea = 0, river = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const w = wetOf(i + di, j + dj);
      if (w === 1) sea++;
      else if (w === 2) river++;
    }
    if (sea || (c.kind === 'coast' && !(c.level > 0))) return 'coast';
    if (river || c.kind === 'coast') return 'bank';
    return 'land';
  }
  const S = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  function cellColour(c, i, j) {
    const role = cellRole(c, i, j);
    c.role = role;
    if (role === 'sea') return `rgb(${SEA.join(',')})`;
    if (role === 'river') return `rgb(${RIVER.join(',')})`;
    // Ridges and valleys: a hard step, from the strength of the edge.
    const e = S(0.35, 0.6, c.edge || 0);
    let rgb;
    if (state.colour === 'kind') {
      rgb = e > 0.5 && KIND_RGB[c.kind] ? KIND_RGB[c.kind] : KIND_RGB.flat;
    } else {
      const [ch, q] = cellData(i, j);
      rgb = [ch.rgb[3 * q], ch.rgb[3 * q + 1], ch.rgb[3 * q + 2]];
      // Tops and pits count like ridges and valleys, by their edge, so small
      // bumps on flat land do not show as dots.
      if (c.kind === 'ridge' || c.kind === 'peak') rgb = mix(rgb, RIDGE, 0.55 * e);
      else if (c.kind === 'valley' || c.kind === 'pit') rgb = mix(rgb, VALLEY, 0.45 * e);
    }
    if (role === 'coast') rgb = SAND;
    else if (role === 'bank') rgb = mix(rgb, RIVER, 0.5);
    let k = 1;
    if (state.shade) {
      // Lambert light from the top left, from the cell's real slope; less on
      // sand and banks, so they stay a clear band.
      const gx = (H(i + 1, j) - H(i - 1, j)) / (2 * C), gy = (H(i, j + 1) - H(i, j - 1)) / (2 * C);
      const n = Math.hypot(gx, gy, 1);
      const d = (-gx * LIGHT[0] - gy * LIGHT[1] + LIGHT[2]) / n;
      k = 0.55 + (0.45 * Math.max(0, d)) / LIGHT[2];
      if (role !== 'land') k = 0.85 + 0.15 * k;
    }
    // Quantised, so the cells share a few paths.
    const qz = (v) => Math.max(0, Math.min(255, Math.round((v * k) / 6) * 6));
    return `rgb(${qz(rgb[0])},${qz(rgb[1])},${qz(rgb[2])})`;
  }

  // --- tiles: the formula over 32 x 32 cells, drawn as quads ----------------
  const bil = (q, u, v) => {
    const t = [q[0][0] + (q[1][0] - q[0][0]) * u, q[0][1] + (q[1][1] - q[0][1]) * u];
    const d = [q[3][0] + (q[2][0] - q[3][0]) * u, q[3][1] + (q[2][1] - q[3][1]) * u];
    return [t[0] + (d[0] - t[0]) * v, t[1] + (d[1] - t[1]) * v];
  };
  function buildTile(ti, tj) {
    const t0 = performance.now();
    const i0 = ti * TILE, j0 = tj * TILE;
    // Worked out with a border of cells, drawn without it: the corners a
    // tile shares with its neighbours then see the same cells on both sides
    // (cells joined to triangles, lines or points reach across the edge).
    const n = TILE + 2 * BORDER;
    const grid = M.formulaGrid((x, y) => H(cellOf(x), cellOf(y)), i0 - BORDER, j0 - BORDER, n, params());
    const vtx = (a, b) => [grid.X[(b + BORDER) * grid.row + a + BORDER] * C, grid.Y[(b + BORDER) * grid.row + a + BORDER] * C];
    const byColour = new Map(), cells = [];
    for (let b = 0; b < TILE; b++) {
      for (let a = 0; a < TILE; a++) {
        const c = grid.cells[(b + BORDER) * n + a + BORDER];
        const q = [vtx(a, b), vtx(a + 1, b), vtx(a + 1, b + 1), vtx(a, b + 1)];
        cells.push({ q, c });
        if (c.collapse === 1) continue; // a point
        const parts = c.split === 4 ? [[0, 0, 0.5, 0.5], [0.5, 0, 1, 0.5], [0.5, 0.5, 1, 1], [0, 0.5, 0.5, 1]] : c.split === 2 ? (c.rowsW >= 0.5 ? [[0, 0, 1, 0.5], [0, 0.5, 1, 1]] : [[0, 0, 0.5, 1], [0.5, 0, 1, 1]]) : [[0, 0, 1, 1]];
        const col = cellColour(c, i0 + a, j0 + b);
        let list = byColour.get(col);
        if (!list) byColour.set(col, (list = []));
        for (const [u0, v0, u1, v1] of parts) {
          const p = [bil(q, u0, v0), bil(q, u1, v0), bil(q, u1, v1), bil(q, u0, v1)];
          list.push(p[0][0], p[0][1], p[1][0], p[1][1], p[2][0], p[2][1], p[3][0], p[3][1]);
        }
      }
    }
    // One path per colour: fills, and the same path for the outlines.
    const fills = [], lines = new Path2D();
    for (const [col, list] of byColour) {
      const path = new Path2D();
      for (let k = 0; k < list.length; k += 8) {
        path.moveTo(list[k], list[k + 1]);
        path.lineTo(list[k + 2], list[k + 3]);
        path.lineTo(list[k + 4], list[k + 5]);
        path.lineTo(list[k + 6], list[k + 7]);
        path.closePath();
      }
      fills.push([col, path]);
      lines.addPath(path);
    }
    return { fills, lines, cells, grid, time: performance.now() - t0 };
  }

  // --- view --------------------------------------------------------------------
  const canvas = document.getElementById('map'), ctx = canvas.getContext('2d');
  const view = { cx: 0, cy: 0, mpp: 4 }; // m on screen per css pixel
  let W = 0, Hc = 0, dpr = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = r.width;
    Hc = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(Hc * dpr);
    clampZoom();
    schedule();
  }
  function clampZoom() {
    if (!W) return;
    view.mpp = Math.max(MIN_W / W, Math.min(MAX_W / W, view.mpp));
  }
  // Tiles in view (and a ring around it), nearest the centre first.
  function wanted() {
    const ts = TILE * C, x0 = view.cx - (W / 2) * view.mpp, y0 = view.cy - (Hc / 2) * view.mpp;
    const a0 = Math.floor(x0 / ts) - 1, a1 = Math.floor((x0 + W * view.mpp) / ts) + 1;
    const b0 = Math.floor(y0 / ts) - 1, b1 = Math.floor((y0 + Hc * view.mpp) / ts) + 1;
    const out = [];
    for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) {
      const inside = a > a0 && a < a1 && b > b0 && b < b1;
      out.push({ a, b, inside, d: Math.hypot((a + 0.5) * ts - view.cx, (b + 0.5) * ts - view.cy) });
    }
    out.sort((p, q) => (q.inside - p.inside) || p.d - q.d);
    return out;
  }

  // A tile's cells, filled, on a context already set to metres; k: device
  // pixels per metre.
  function paintTile(g, t, k, seam = 0.6) {
    // A thin stroke in the fill's own colour closes the seams between cells
    // (wider in tile images, so they overlap their neighbours a little).
    g.lineWidth = seam / k;
    g.lineJoin = 'round';
    for (const [col, path] of t.fills) {
      g.fillStyle = col;
      g.fill(path);
      g.strokeStyle = col;
      g.stroke(path);
    }
    const cellPx = (C * k) / dpr;
    if (state.outline && cellPx >= 5) {
      g.strokeStyle = 'rgba(30,32,36,' + Math.min(0.45, 0.06 * (cellPx - 4)).toFixed(3) + ')';
      g.lineWidth = 1 / k;
      g.stroke(t.lines);
    }
  }
  // Zoomed out, each tile is kept as an image per zoom step (a power of two
  // pixels per metre), so panning and new tiles do not redraw every cell.
  const PAD = 2 * C; // the cells reach a little past their tile
  function tileImage(t, a, b, k) {
    const step = Math.pow(2, Math.ceil(Math.log2(k)));
    const key = step + (state.outline ? 'o' : '');
    if (t.img && t.imgKey === key) return t.img;
    const ts = TILE * C, px = Math.ceil((ts + 2 * PAD) * step);
    const c = t.img && t.img.width === px ? t.img : document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, px, px);
    g.setTransform(step, 0, 0, step, -(a * ts - PAD) * step, -(b * ts - PAD) * step);
    paintTile(g, t, step, 1.4);
    t.img = c;
    t.imgKey = key;
    return c;
  }
  function draw() {
    const css = getComputedStyle(document.documentElement);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = css.getPropertyValue('--empty').trim() || '#d8d6d0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const k = dpr / view.mpp, ts = TILE * C;
    // Images while a tile is at most 1024 device pixels; nearer in, the
    // few tiles in view are drawn as cells directly.
    const images = ts * k <= 1024;
    ctx.setTransform(k, 0, 0, k, (W / 2) * dpr - view.cx * k, (Hc / 2) * dpr - view.cy * k);
    ctx.imageSmoothingEnabled = true;
    let missing = 0;
    for (const w of wanted()) {
      const t = tiles.get(w.a + ',' + w.b);
      if (!t) {
        if (w.inside) missing++;
        continue;
      }
      if (images) {
        const img = tileImage(t, w.a, w.b, k);
        ctx.drawImage(img, w.a * ts - PAD, w.b * ts - PAD, ts + 2 * PAD, ts + 2 * PAD);
      } else paintTile(ctx, t, k);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScale();
    status(missing);
  }

  function drawScale() {
    const target = W * 0.22 * view.mpp, p = Math.pow(10, Math.floor(Math.log10(target)));
    const len = [1, 2, 5, 10].map((f) => f * p).filter((v) => v <= target).pop() || p;
    const px = len / view.mpp, x = 16, y = Hc - 18;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x - 6, y - 20, px + 12, 28);
    ctx.strokeStyle = '#22262b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = '#22262b';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(len >= 1000 ? len / 1000 + ' km' : len + ' m', x, y - 8);
  }

  // Work through missing tiles a slice at a time, drawing as they come.
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(step);
  }
  // The chunks a tile reads (the formula looks REACH cells around it).
  function chunksOf(a, b) {
    const out = [];
    const c0 = Math.floor((a * TILE - REACH) / CHUNK), c1 = Math.floor((a * TILE + TILE + REACH) / CHUNK);
    const d0 = Math.floor((b * TILE - REACH) / CHUNK), d1 = Math.floor((b * TILE + TILE + REACH) / CHUNK);
    for (let cj = d0; cj <= d1; cj++) for (let ci = c0; ci <= c1; ci++) out.push([ci, cj]);
    return out;
  }
  function step() {
    pending = false;
    const t0 = performance.now();
    let more = false;
    queue = [];
    for (const w of wanted()) {
      const key = w.a + ',' + w.b;
      if (tiles.has(key)) continue;
      const need = chunksOf(w.a, w.b);
      const missing = pool.length ? need.filter(([ci, cj]) => !chunks.has(ci + ',' + cj)) : [];
      if (missing.length) {
        for (const c of missing) queue.push(c);
        continue;
      }
      if (performance.now() - t0 > 40) {
        more = true;
        continue;
      }
      tiles.set(key, buildTile(w.a, w.b));
    }
    pump();
    draw();
    if (more) schedule();
  }

  const $ = (id) => document.getElementById(id);
  function status(missing) {
    let cells = 0, ms = 0;
    for (const t of tiles.values()) {
      cells += TILE * TILE;
      ms += t.time;
    }
    $('status').textContent = `Utsnitt ${fmtM(W * view.mpp)} · ${tiles.size} felt, ${cells.toLocaleString('no')} ruter · ${missing ? 'regner ut …' : 'ferdig'}`;
  }
  const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1).replace('.', ',') + ' km' : Math.round(m) + ' m');

  // --- pointer: pan, zoom, the cell under the pointer -------------------------
  const pointers = new Map();
  let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return showCell(e);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX;
      p.y = e.clientY;
      const d1 = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch && d0 > 0) zoomAt(d0 / d1, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = 1;
      return;
    }
    view.cx -= (e.clientX - p.x) * view.mpp;
    view.cy -= (e.clientY - p.y) * view.mpp;
    p.x = e.clientX;
    p.y = e.clientY;
    schedule();
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    pinch = 0;
    canvas.style.cursor = '';
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY);
  }, { passive: false });
  function zoomAt(f, sx, sy) {
    const r = canvas.getBoundingClientRect(), px = sx - r.left - W / 2, py = sy - r.top - Hc / 2;
    const wx = view.cx + px * view.mpp, wy = view.cy + py * view.mpp;
    view.mpp *= f;
    clampZoom();
    view.cx = wx - px * view.mpp;
    view.cy = wy - py * view.mpp;
    schedule();
  }

  function inside(q, x, y) {
    let s = false;
    for (let k = 0, l = 3; k < 4; l = k++) {
      const [xa, ya] = q[k], [xb, yb] = q[l];
      if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) s = !s;
    }
    return s;
  }
  function showCell(e) {
    const r = canvas.getBoundingClientRect();
    const x = view.cx + (e.clientX - r.left - W / 2) * view.mpp, y = view.cy + (e.clientY - r.top - Hc / 2) * view.mpp;
    const ts = TILE * C, a = Math.floor(x / ts), b = Math.floor(y / ts);
    let hit = null;
    for (let db = -1; db <= 1 && !hit; db++) for (let da = -1; da <= 1 && !hit; da++) {
      const t = tiles.get(a + da + ',' + (b + db));
      if (t) for (const cq of t.cells) if (inside(cq.q, x, y)) { hit = cq; break; }
    }
    const box = $('cell');
    if (!hit) {
      box.innerHTML = '<p class="muted">Pek på en rute.</p>';
      return;
    }
    const c = hit.c, [ch, q] = cellData(cellOf(x), cellOf(y));
    const type = ch.cls[q] === 0 || ch.cls[q] === 4 ? '–' : M.RegionLayer.TYPES[ch.type[q]].name;
    const rows = [
      ['Rute', ({ sea: 'hav', river: 'elv', coast: 'kyst', bank: 'bredde' })[c.role] || KIND_NAMES[c.kind] || c.kind],
      ['Egg/dal-styrke', (c.edge || 0).toFixed(2).replace('.', ',')],
      ['Høyde', `${Math.round(c.h + (c.level || 0))} m`],
      ['Helning', `${c.slope.toFixed(1).replace('.', ',')}°`],
      ['Landskap', type],
      ['Fasthet', ch.firm[q].toFixed(2).replace('.', ',')],
      ['Rotasjon', `${Math.round(((c.theta || 0) * 180) / Math.PI)}°`],
      ['Delt', c.collapse ? ['', 'punkt', 'linje', 'trekant'][c.collapse] : c.split ? `i ${c.split}` : 'nei'],
    ];
    box.innerHTML = '<dl>' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';
  }

  // --- panel ---------------------------------------------------------------------
  for (const b of document.querySelectorAll('#colour button')) {
    b.addEventListener('click', () => {
      state.colour = b.dataset.v;
      for (const o of document.querySelectorAll('#colour button')) o.setAttribute('aria-pressed', String(o === b));
      $('kindLegend').hidden = state.colour !== 'kind';
      $('typeLegend').hidden = state.colour === 'kind';
      tiles = new Map(); // colours are baked into the tiles; heights stay
      schedule();
    });
  }
  const sw = (rgb, name) => `<span><i style="background:rgb(${rgb.map(Math.round).join(',')})"></i>${name}</span>`;
  const WATER_LEGEND = sw(SAND, 'kyst') + sw(mix([168, 176, 120], RIVER, 0.5), 'bredde') + sw(SEA, 'vann');
  $('kindLegend').innerHTML = ['ridge', 'valley', 'peak', 'pit', 'flat'].map((k) => sw(KIND_RGB[k], KIND_NAMES[k])).join('') + WATER_LEGEND;
  $('typeLegend').innerHTML = M.RegionLayer.TYPES.map((t) => sw(t.colour, t.name)).join('') + sw(RIDGE, 'egg') + sw(VALLEY, 'dal') + WATER_LEGEND;
  $('outline').addEventListener('change', (e) => {
    state.outline = e.target.checked;
    schedule();
  });
  $('shade').addEventListener('change', (e) => {
    state.shade = e.target.checked;
    tiles = new Map();
    schedule();
  });
  $('seed').value = state.seed;
  $('seed').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v)) return;
    state.seed = v;
    rebuild();
    findStart();
    schedule();
  });
  // Settings copied from the grunn window, pasted here.
  $('apply').addEventListener('click', () => {
    let o;
    try {
      o = JSON.parse($('settings').value);
    } catch (err) {
      $('applyMsg').textContent = 'Kunne ikke lese innstillingene.';
      return;
    }
    let n = 0;
    for (const k of Object.keys(M.GRUNN_DEFAULTS)) if (o[k] !== undefined) {
      state[k] = o[k];
      n++;
    }
    $('seed').value = state.seed;
    $('applyMsg').textContent = `${n} innstillinger lest inn.`;
    rebuild();
    schedule();
  });
  for (const [id, w] of [['z100', 100], ['z1', 1000], ['z10', 10000]]) {
    $(id).addEventListener('click', () => {
      view.mpp = w / W;
      clampZoom();
      schedule();
    });
  }

  // A place to start: land near the middle of the map, not under water,
  // with something going on (sea or a river within a few km).
  function findStart() {
    const s = state.scaleH, f = (x, y) => chain.fullCore(x * s, y * s, false);
    let best = null;
    for (let r = 0; r <= 60 && !best; r++) {
      for (let k = 0; k < Math.max(1, 8 * r) && !best; k++) {
        const a = (k / Math.max(1, 8 * r)) * 2 * Math.PI, x = Math.cos(a) * r * 4000, y = Math.sin(a) * r * 4000;
        const p = f(x, y);
        if (p.cls < 1 || p.cls > 3) continue;
        // Water within 3 km: the coast or a river makes a varied first view.
        let water = false;
        for (let q = 0; q < 8 && !water; q++) {
          const b = (q / 8) * 2 * Math.PI, w = f(x + Math.cos(b) * 2500, y + Math.sin(b) * 2500);
          water = w.cls === 0 || w.cls === 4;
        }
        if (water) best = [x, y];
      }
    }
    [view.cx, view.cy] = best || [0, 0];
  }

  rebuild();
  findStart();
  view.mpp = 2000 / Math.max(1, canvas.getBoundingClientRect().width);
  window.addEventListener('resize', resize);
  resize();

  M.by = { state, view, tiles: () => tiles, chunks: () => chunks, pool, schedule, rebuild, buildTile };
})(window.Markr = window.Markr || {});
