// Formula lab: the cell formula and the vertex formula on a small map, with the
// thresholds as adjustable S-curves.
(function (M) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const C = M.CELL_SIZE;
  const canvas = $('map'), ctx = canvas.getContext('2d');

  // The thresholds. Each S-curve has a start and an end (`from`, `to`).
  const CURVES = [
    { id: 'follow', label: 'Følge høydekurvene', unit: '° helning', min: 0, max: 40, step: 0.5, from: 3, to: 12, hint: 'Hvor bratt det må være før rutene roterer etter kurvene.' },
    { id: 'edge', label: 'Egg eller dal', unit: ' m forskjell', min: 0, max: 12, step: 0.25, from: 1, to: 4, hint: 'Hvor mye lavere (egg) eller høyere (dal) naboene langs kurven må ligge.' },
    { id: 'size', label: 'Mindre ruter i bratt', unit: '° helning', min: 0, max: 70, step: 1, from: 25, to: 50, hint: 'Hvor bratt det må være før rutene krymper.' },
  ];
  const state = {
    seed: 1848, region: -1, rough: 0.25, startKind: 'rugged', smooth: 32, contour: 10,
    strength: 1, maxRot: 30, blend: 15, sizeAmount: 0.5, edgeSize: 0.6, edgePull: 0.5, split2: 0.54, split4: 0.3, jumpMix: 1,
    layer: 'grid', showContours: true, showSections: false,
  };
  for (const c of CURVES) {
    state[c.id + 'From'] = c.from;
    state[c.id + 'To'] = c.to;
  }
  let terrain, field, grid, start, view = { scale: 1, ox: 0, oy: 0 }, bg = null, contours = null, hover = null, quads = [];
  const toScreen = (x, y) => [x * view.scale + view.ox, y * view.scale + view.oy];
  const toWorld = (sx, sy) => [(sx - view.ox) / view.scale, (sy - view.oy) / view.scale];
  const N = 64;

  // --- terrain --------------------------------------------------------------

  function newTerrain() {
    const base = new M.Terrain(state.seed, { region: state.region });
    const { createPerlin, fbm, ridged } = M.noise;
    const nR = createPerlin(state.seed * 31 + 5), nP = createPerlin(state.seed * 31 + 6);
    terrain = {
      elevation(x, y, mw = 0) {
        const h = base.elevation(x, y, mw);
        if (!state.rough || h <= 0 || mw > 400) return h;
        const patch = M.util.smoothstep(-0.1, 0.6, fbm(nP, x / 1800, y / 1800, 2) / 0.2);
        const r = ridged(nR, x / 420, y / 420, 2) - 0.55;
        return Math.max(h + state.rough * patch * Math.min(1, h / 30) * 90 * r, Math.min(h, 2));
      },
    };
    start = findStart(terrain);
    rebuildField();
  }

  // A place with relief and a little coast, but not alpine cliffs.
  function findStart(t) {
    const span = N * C;
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
          if (h > 0) {
            const sl = Math.abs(t.elevation(px + 30, py) - t.elevation(px - 30, py)) / 60;
            steep += Math.min(0.6, sl) - 2 * Math.max(0, sl - 0.8);
          }
        }
        const score =
          state.startKind === 'rugged'
            ? (water >= 2 && water <= 8 ? 150 : 0) + Math.min(hi - lo, 400) + 40 * steep - (hi > 900 ? 300 : 0) - Math.hypot(gx, gy)
            : (water >= 3 && water <= 10 ? 200 : 0) + Math.min(hi, 200) - Math.hypot(gx, gy);
        if (score > bs) {
          bs = score;
          best = [x, y];
        }
      }
    }
    return best;
  }

  const origin = () => [Math.round(start[0] / C - N / 2), Math.round(start[1] / C - N / 2)];

  function rebuildField() {
    const [i0, j0] = origin(), m = 24;
    field = new M.TerrainField(terrain, (i0 - m) * C, (j0 - m) * C, (N + 2 * m) * C, (N + 2 * m) * C, 8, { smoothing: 0.5, coarse: 64, denseSmooth: state.smooth });
    bg = null;
    contours = null;
    rebuildGrid();
  }

  function params() {
    const p = { seed: state.seed };
    for (const k of ['strength', 'maxRot', 'blend', 'sizeAmount', 'edgeSize', 'edgePull', 'split2', 'split4', 'jumpMix']) p[k] = state[k];
    for (const c of CURVES) {
      p[c.id + 'From'] = state[c.id + 'From'];
      p[c.id + 'To'] = state[c.id + 'To'];
    }
    return p;
  }

  function rebuildGrid() {
    const [i0, j0] = origin();
    grid = M.formulaGrid((x, y) => field.samp(field.hm, x, y), i0, j0, N, params());
    buildQuads();
    showStats();
    draw();
  }

  const vtx = (a, b) => [grid.X[b * grid.row + a] * C, grid.Y[b * grid.row + a] * C];
  const bil = (q, u, v) => {
    const t = [q[0][0] + (q[1][0] - q[0][0]) * u, q[0][1] + (q[1][1] - q[0][1]) * u];
    const d = [q[3][0] + (q[2][0] - q[3][0]) * u, q[3][1] + (q[2][1] - q[3][1]) * u];
    return [t[0] + (d[0] - t[0]) * v, t[1] + (d[1] - t[1]) * v];
  };
  // Every cell as drawn: whole, in two (parallel to the contour) or in four.
  function buildQuads() {
    quads = [];
    let s2 = 0, s4 = 0;
    for (let b = 0; b < N; b++) {
      for (let a = 0; a < N; a++) {
        const q = [vtx(a, b), vtx(a + 1, b), vtx(a + 1, b + 1), vtx(a, b + 1)];
        const c = grid.cells[b * N + a];
        const parts = c.split === 4 ? [[0, 0, 0.5, 0.5], [0.5, 0, 1, 0.5], [0.5, 0.5, 1, 1], [0, 0.5, 0.5, 1]] : c.split === 2 ? (c.rowsW >= 0.5 ? [[0, 0, 1, 0.5], [0, 0.5, 1, 1]] : [[0, 0, 0.5, 1], [0.5, 0, 1, 1]]) : [[0, 0, 1, 1]];
        if (c.split === 4) s4++;
        else if (c.split === 2) s2++;
        for (const [u0, v0, u1, v1] of parts) quads.push({ q: [bil(q, u0, v0), bil(q, u1, v0), bil(q, u1, v1), bil(q, u0, v1)], c, a, b, part: parts.length > 1 });
      }
    }
    grid.s2 = s2;
    grid.s4 = s4;
  }

  function convex(p) {
    for (let k = 0; k < 4; k++) {
      const a = p[k], b = p[(k + 1) % 4], c = p[(k + 2) % 4];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < -1e-9) return false;
    }
    return true;
  }

  function showStats() {
    let folds = 0;
    const kinds = { ridge: 0, valley: 0, peak: 0, pit: 0 };
    for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) if (!convex([vtx(a, b), vtx(a + 1, b), vtx(a + 1, b + 1), vtx(a, b + 1)])) folds++;
    for (const c of grid.cells) if (c.edge > 0.5 && kinds[c.kind] !== undefined) kinds[c.kind]++;
    for (const c of grid.cells) if (c.kind === 'peak' || c.kind === 'pit') kinds[c.kind]++;
    const rows = [
      ['Brettede ruter', `${folds}`],
      ['Hopp langs radene', `${grid.jumps}`],
      ['Delt', `${grid.s2} i to, ${grid.s4} i fire`],
      ['Egger / daler', `${kinds.ridge} / ${kinds.valley} ruter`],
      ['Topper / bunner', `${kinds.peak} / ${kinds.pit}`],
      ['Tid', `${Math.round(grid.time)} ms`],
    ];
    $('stats').innerHTML = '<dl>' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';
  }

  // --- drawing ---------------------------------------------------------------

  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const PAPER = [240, 237, 228];
  // Terrain colour with hill shading (light from the north-west).
  function terrainColour(h, gx, gy, fade = 0.45) {
    let c;
    if (h < 0) c = mix([150, 196, 220], [40, 90, 150], Math.min(1, -h / 60));
    else c = mix(mix([120, 165, 90], [190, 175, 120], Math.min(1, h / 250)), [160, 150, 140], Math.min(1, Math.max(0, (h - 250) / 400)));
    if (h >= 0) {
      const l = (gx * 0.6 + gy * 0.6) * 2 + 0.53;
      const f = 0.75 + 0.35 * Math.max(-1, Math.min(1, l));
      c = [c[0] * f, c[1] * f, c[2] * f];
    }
    return mix(c, PAPER, fade);
  }
  const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

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
        img.data.set([...terrainColour(h[k], -gx, -gy), 255], k * 4);
      }
    }
    g.putImageData(img, 0, 0);
    bg = cv;
    return bg;
  }

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
          const P = [[0, 0], [1, 0], [1, 1], [0, 1]], pts = [];
          for (let e = 0; e < 4; e++) {
            const a = v[e], b = v[(e + 1) % 4];
            if ((a < L) !== (b < L)) {
              const f = (L - a) / (b - a), p = P[e], q = P[(e + 1) % 4];
              pts.push([x0 + (x + p[0] + (q[0] - p[0]) * f) * res, y0 + (y + p[1] + (q[1] - p[1]) * f) * res]);
            }
          }
          const list = L === 0 ? out.coast : L % (5 * I) === 0 ? out.major : out.minor;
          if (pts.length >= 2) list.push(pts[0], pts[1]);
          if (pts.length === 4) list.push(pts[2], pts[3]);
        }
      }
    }
    contours = out;
    return out;
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

  const KIND_COLOUR = { ridge: [200, 70, 110], valley: [40, 140, 160], peak: [230, 120, 40], pit: [40, 90, 200] };

  function draw() {
    const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--canvas-bg');
    ctx.fillRect(0, 0, r.width, r.height);
    const img = background();
    const [bx, by] = toScreen(field.x0, field.y0);
    ctx.drawImage(img, bx, by, img.width * field.res * view.scale, img.height * field.res * view.scale);

    // Filled cells: the terrain colour and shading at each cell's centre.
    if (state.layer === 'filled' || state.layer === 'kinds') {
      for (const { q, c } of quads) {
        const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
        const [h, gx, gy] = field.heightGrad(cx, cy);
        let col = terrainColour(h, -gx, -gy, 0.25);
        if (state.layer === 'kinds') {
          const k = KIND_COLOUR[c.kind];
          const w = c.kind === 'peak' || c.kind === 'pit' ? 1 : c.edge;
          if (k) col = mix(mix(col, PAPER, 0.5), k, 0.85 * w);
          else col = mix(col, PAPER, 0.5);
        }
        poly(q);
        ctx.fillStyle = ctx.strokeStyle = rgb(col);
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      }
    }
    if (state.showContours) {
      const L = contourLines();
      seg(L.minor, 'rgba(110,80,40,0.4)', 0.8);
      seg(L.major, 'rgba(110,80,40,0.75)', 1.3);
      seg(L.coast, 'rgba(30,80,150,0.95)', 2);
    }
    // Grid
    ctx.strokeStyle = 'rgba(25,30,35,0.8)';
    const lw = Math.max(0.5, Math.min(1.2, view.scale * C * 0.05));
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (const { q } of quads) {
      q.forEach((p, n) => {
        const [x, y] = toScreen(p[0], p[1]);
        if (n) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
    }
    ctx.stroke();
    // Folded cells
    ctx.fillStyle = 'rgba(220,40,40,0.6)';
    for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) {
      const q = [vtx(a, b), vtx(a + 1, b), vtx(a + 1, b + 1), vtx(a, b + 1)];
      if (!convex(q)) {
        poly(q);
        ctx.fill();
      }
    }
    if (state.showSections) {
      ctx.strokeStyle = 'rgba(200,50,50,0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      for (let b = 0; b <= N; b += 8) for (let a = 0; a <= N; a++) {
        const [x, y] = toScreen(...vtx(a, b));
        if (a) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      for (let a = 0; a <= N; a += 8) for (let b = 0; b <= N; b++) {
        const [x, y] = toScreen(...vtx(a, b));
        if (b) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (hover) {
      poly(hover.q);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  function seg(list, colour, width) {
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

  function fit() {
    const r = canvas.getBoundingClientRect();
    const [i0, j0] = origin();
    const w = N * C, pad = 24;
    view.scale = Math.min((r.width - 2 * pad) / w, (r.height - 2 * pad) / w);
    view.ox = (r.width - w * view.scale) / 2 - i0 * C * view.scale;
    view.oy = (r.height - w * view.scale) / 2 - j0 * C * view.scale;
  }

  // --- interaction ----------------------------------------------------------

  function inside(p, x, y) {
    let r = false;
    for (let k = 0, l = 3; k < 4; l = k++) {
      const [xi, yi] = p[k], [xj, yj] = p[l];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
    }
    return r;
  }
  const NAMES = { ridge: 'egg', valley: 'dal', peak: 'topp', pit: 'bunn', water: 'vann' };
  function showCell(h) {
    if (!h) {
      $('cell').innerHTML = '<p class="muted">Hold over en rute.</p>';
      return;
    }
    const c = h.c, r = (v, d = 0) => v.toLocaleString('nb-NO', { maximumFractionDigits: d });
    const kind = c.kind === 'peak' || c.kind === 'pit' || c.kind === 'water' ? NAMES[c.kind] : `${NAMES[c.kind]} ${r(c.edge * 100)} %`;
    const rows = [
      ['Rute', `(${h.a}, ${h.b})`],
      ['Helning', `${r(c.slope, 1)}°`],
      ['Rotasjon', `${r((c.theta * 180) / Math.PI)}°, følger ${r(c.follow * 100)} %`],
      ['Type', kind],
      ['Forskjell langs kurven', `${r(c.d2 || 0, 1)} m`],
      ['Ønsket størrelse', `${r(c.size * 100)} %`],
      ['Deling', c.split ? `i ${c.split}` : 'ingen'],
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
    hover = quads.find((t) => inside(t.q, x, y)) || null;
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
    timer = setTimeout(fn, 150);
  };

  // One S-curve control: two sliders (start, end) and a small picture of the curve.
  function curveControl(c) {
    const box = document.createElement('div');
    box.className = 'curve';
    box.innerHTML = `
      <div class="curve-head"><span>${c.label}</span><output id="${c.id}-out"></output></div>
      <canvas class="curve-plot" id="${c.id}-plot" width="260" height="46" aria-hidden="true"></canvas>
      <div class="curve-pair">
        <label>fra<input id="${c.id}From" type="range" min="${c.min}" max="${c.max}" step="${c.step}"></label>
        <label>til<input id="${c.id}To" type="range" min="${c.min}" max="${c.max}" step="${c.step}"></label>
      </div>
      <p class="hint">${c.hint}</p>`;
    $('curves').appendChild(box);
    const plot = () => {
      const a = state[c.id + 'From'], b = state[c.id + 'To'];
      $(c.id + '-out').textContent = `${a}–${b}${c.unit}`;
      const cv = $(c.id + '-plot'), g = cv.getContext('2d');
      const W = cv.width, H = cv.height;
      g.clearRect(0, 0, W, H);
      g.strokeStyle = getComputedStyle(document.body).getPropertyValue('--border');
      g.lineWidth = 1;
      g.strokeRect(0.5, 0.5, W - 1, H - 1);
      g.strokeStyle = getComputedStyle(document.body).getPropertyValue('--accent');
      g.lineWidth = 2;
      g.beginPath();
      for (let x = 0; x <= W; x += 2) {
        const v = c.min + ((c.max - c.min) * x) / W;
        const y = H - 4 - (H - 8) * M.scurve(a, b, v);
        if (x) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();
    };
    for (const end of ['From', 'To']) {
      const el = $(c.id + end);
      el.value = state[c.id + end];
      el.addEventListener('input', () => {
        state[c.id + end] = parseFloat(el.value);
        if (state[c.id + 'From'] > state[c.id + 'To']) {
          if (end === 'From') state[c.id + 'To'] = state[c.id + 'From'];
          else state[c.id + 'From'] = state[c.id + 'To'];
          $(c.id + 'From').value = state[c.id + 'From'];
          $(c.id + 'To').value = state[c.id + 'To'];
        }
        plot();
        later(rebuildGrid);
      });
    }
    plot();
  }
  CURVES.forEach(curveControl);

  function range(id, fmt, then) {
    const el = $(id), out = $(id + '-out');
    el.value = state[id];
    out.textContent = fmt(state[id]);
    el.addEventListener('input', () => {
      state[id] = parseFloat(el.value);
      out.textContent = fmt(state[id]);
      later(then);
    });
  }
  const pct = (v) => `${Math.round(v * 100)} %`;
  range('strength', (v) => v.toFixed(2), rebuildGrid);
  range('maxRot', (v) => `${v}°`, rebuildGrid);
  range('sizeAmount', pct, rebuildGrid);
  range('edgePull', (v) => v.toFixed(2), rebuildGrid);
  range('split2', (v) => `under ${pct(v)}`, rebuildGrid);
  range('split4', (v) => `under ${pct(v)}`, rebuildGrid);
  range('jumpMix', (v) => (v ? `${Math.round(v * 16)} ruter` : 'på rekke'), rebuildGrid);
  range('blend', (v) => `±${v}°`, rebuildGrid);
  range('smooth', (v) => `${v} m`, rebuildField);
  range('contour', (v) => `${v} m`, () => {
    contours = null;
    draw();
  });
  range('rough', (v) => (v ? v.toFixed(2) : 'av'), () => {
    newTerrain();
    fit();
    draw();
  });
  $('layer').value = state.layer;
  $('layer').addEventListener('change', (e) => {
    state.layer = e.target.value;
    draw();
  });
  for (const id of ['showContours', 'showSections']) {
    $(id).checked = state[id];
    $(id).addEventListener('change', (e) => {
      state[id] = e.target.checked;
      draw();
    });
  }
  const regionSel = $('region');
  M.REGIONS.forEach((r, k) => {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = r.name;
    regionSel.appendChild(o);
  });
  const reTerrain = () => {
    newTerrain();
    fit();
    draw();
  };
  regionSel.addEventListener('change', () => {
    state.region = parseInt(regionSel.value, 10);
    reTerrain();
  });
  $('startKind').value = state.startKind;
  $('startKind').addEventListener('change', (e) => {
    state.startKind = e.target.value;
    reTerrain();
  });
  $('seed').value = state.seed;
  $('seed').addEventListener('change', () => {
    state.seed = parseInt($('seed').value, 10) || 0;
    reTerrain();
  });
  $('reseed').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 100000);
    $('seed').value = state.seed;
    reTerrain();
  });
  $('fit').addEventListener('click', () => {
    fit();
    draw();
  });

  newTerrain();
  fit();
  draw();
  showCell(null);
  M.formel = { state, get grid() { return grid; }, rebuildGrid, rebuildField };
})(window.Markr = window.Markr || {});
