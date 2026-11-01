// Grunnforskyvning: a window onto the base displacement layer alone.
// Visual first: a profile of height against the layer value with a handle for
// each threshold, one line per noise layer, and a box for the point under the
// pointer.
(function (M) {
  'use strict';

  const state = {
    seed: 1848,
    contSize: 3010, contW: 2.6, basinSize: 940, basinW: 1.75, baseSize: 240, baseW: 1.2, s1Size: 710, s1W: 2.8, s1Width: 0.26,
    tSea: -0.55, tHigh: 0.6, tDivide: 1.8,
    lowTop: 260, highTop: 1600, shelf: 320, deep: 3500,
    midSize: 185, midW: 0.9, midStretch: 10, tInland: -0.3,
    show: 'map',
  };

  const canvas = document.getElementById('map'), ctx = canvas.getContext('2d');
  const prof = document.getElementById('profile'), pctx = prof.getContext('2d');
  const view = { cx: 0, cy: 0, mpp: 2500 };
  let layer = null, job = 0, hover = null, hist = null;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Layers can be turned off without changing their values: their weight
  // goes to 0, while the normalisation stays as if they were on.
  const on = { cont: true, basin: true, base: true, s1: true, inland: true, mid: true, stretch: true };
  function newLayer() {
    const p = { ...state, norm: Math.hypot(state.contW, state.basinW, state.baseW) || 1, normCB: Math.hypot(state.contW, state.basinW) || 1 };
    for (const id of ['cont', 'basin', 'base', 's1', 'mid']) if (!on[id]) p[id + 'W'] = 0;
    if (!on.inland) p.tInland = Infinity;
    if (!on.stretch) p.midStretch = 1;
    layer = new M.BaseLayer(state.seed, p);
  }
  function rebuild() {
    newLayer();
    hist = histogram();
    drawProfile();
    render();
  }

  // --- colours: blue sea, one grey ramp over land, dashed divide outline ----

  const SEA = [61, 111, 168];
  // Flat colours per class, for the bars behind the profile.
  const CLASS_COLOUR = [SEA, [214, 212, 206], [168, 166, 161], [112, 110, 106]];
  const landColour = (h) => {
    const t = Math.sqrt(Math.max(0, Math.min(1, h / 3500)));
    const c = 232 - 160 * t;
    return [c, c - 2, c - 6];
  };

  // --- map -----------------------------------------------------------------

  function render() {
    const id = ++job;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const passes = [8, 3, 1.5];
    let k = 0;
    M.grunn.done = false;
    const step = () => {
      if (id !== job) return;
      const t0 = performance.now();
      draw(passes[k], W, H, dpr);
      M.grunn.lastPass = { block: passes[k], ms: performance.now() - t0 };
      if (++k < passes.length) requestAnimationFrame(step);
      else M.grunn.done = true;
    };
    step();
  }

  function draw(block, W, H, dpr) {
    const nx = Math.ceil(W / block) + 1, ny = Math.ceil(H / block) + 1;
    const hs = new Float32Array(nx * ny), cl = new Uint8Array(nx * ny);
    const x0 = view.cx - (W / 2) * view.mpp, y0 = view.cy - (H / 2) * view.mpp, d = block * view.mpp;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * d, y = y0 + (j + 0.5) * d;
        if (state.show !== 'map') {
          // One layer alone, as a height-like grey field.
          const val = layer.single(state.show, x, y);
          hs[j * nx + i] = state.show === 's1' ? 2400 * val : 1200 + 600 * val;
          cl[j * nx + i] = 1;
          continue;
        }
        const v = layer.value(x, y);
        hs[j * nx + i] = layer.height(v);
        cl[j * nx + i] = layer.cls(v);
      }
    }
    const img = ctx.createImageData(canvas.width, canvas.height), px = img.data;
    const bs = block * dpr, dash = Math.max(3, 7 / block); // dash length in blocks
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i, h = hs[k];
        let c;
        if (cl[k] === 0) c = SEA;
        else {
          c = landColour(h);
          // A soft light from the north-west.
          const hx = hs[j * nx + Math.min(nx - 1, i + 1)] - hs[j * nx + Math.max(0, i - 1)];
          const hy = hs[Math.min(ny - 1, j + 1) * nx + i] - hs[Math.max(0, j - 1) * nx + i];
          const sh = Math.max(-0.2, Math.min(0.2, (-(hx + hy) / (4 * d)) * 8));
          c = [c[0] * (1 + sh), c[1] * (1 + sh), c[2] * (1 + sh)];
          // The divide field: a dashed outline.
          const edge = (cl[k] === 3) !== ((i + 1 < nx && cl[k + 1] === 3) || false) || (cl[k] === 3) !== ((j + 1 < ny && cl[k + nx] === 3) || false);
          if (edge && Math.floor((i + j) / dash) % 2 === 0) c = [40, 40, 44];
        }
        const sx0 = Math.floor(i * bs), sy0 = Math.floor(j * bs);
        const sx1 = Math.min(canvas.width, Math.floor((i + 1) * bs)), sy1 = Math.min(canvas.height, Math.floor((j + 1) * bs));
        for (let y = sy0; y < sy1; y++) {
          let o = (y * canvas.width + sx0) * 4;
          for (let x = sx0; x < sx1; x++, o += 4) {
            px[o] = c[0];
            px[o + 1] = c[1];
            px[o + 2] = c[2];
            px[o + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    // Scale bar, no box.
    ctx.save();
    ctx.scale(dpr, dpr);
    const km = niceKm((120 * view.mpp) / 1000), len = (km * 1000) / view.mpp;
    ctx.fillStyle = 'rgba(20,20,24,0.8)';
    ctx.fillRect(16, H - 20, len, 3);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`${km} km`, 16, H - 26);
    ctx.restore();
  }
  const niceKm = (v) => {
    const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
    return (f < 2 ? 1 : f < 5 ? 2 : 5) * e;
  };

  // --- profile: height against v, with the share of land at each v behind ---

  const VMIN = -3, VMAX = 3.5, BINS = 65;
  function histogram() {
    const n = 140, span = 8e6, d = span / n, bins = new Float32Array(BINS);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const v = layer.value(-span / 2 + (i + 0.5) * d, -span / 2 + (j + 0.5) * d);
        const b = Math.floor(((v - VMIN) / (VMAX - VMIN)) * BINS);
        if (b >= 0 && b < BINS) bins[b]++;
      }
    }
    return bins;
  }

  const PAD = 8, RAIL = 22;
  const geom = () => {
    const W = prof.clientWidth, H = prof.clientHeight;
    return { W, H, plotH: H - RAIL, X: (v) => PAD + ((v - VMIN) / (VMAX - VMIN)) * (W - 2 * PAD), V: (x) => VMIN + ((x - PAD) / (W - 2 * PAD)) * (VMAX - VMIN) };
  };
  // Height axis: square root, so lowland shows beside 5000 m.
  const Yof = (h, plotH) => plotH / 2 - Math.sign(h) * Math.sqrt(Math.abs(h) / 5000) * (plotH / 2 - 6);
  const THRESHOLDS = ['tSea', 'tInland', 'tHigh', 'tDivide'];

  function drawProfile() {
    const dpr = window.devicePixelRatio || 1, g = geom();
    prof.width = Math.round(g.W * dpr);
    prof.height = Math.round(g.H * dpr);
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pctx.clearRect(0, 0, g.W, g.H);
    const ink = css('--text'), muted = css('--muted'), accent = css('--handle');
    // Share of the map at each value, coloured as on the map.
    if (hist) {
      const max = Math.max(...hist), bw = (g.W - 2 * PAD) / BINS;
      for (let b = 0; b < BINS; b++) {
        const v = VMIN + ((b + 0.5) / BINS) * (VMAX - VMIN), c = layer.cls(v);
        const hgt = (hist[b] / max) * (g.plotH - 4);
        const col = CLASS_COLOUR[c];
        pctx.fillStyle = `rgb(${col.join(',')})`;
        pctx.fillRect(PAD + b * bw, g.plotH - hgt, bw + 0.5, hgt);
      }
    }
    // Sea level.
    pctx.strokeStyle = muted;
    pctx.setLineDash([2, 3]);
    pctx.lineWidth = 1;
    pctx.beginPath();
    pctx.moveTo(PAD, Yof(0, g.plotH));
    pctx.lineTo(g.W - PAD, Yof(0, g.plotH));
    pctx.stroke();
    pctx.setLineDash([]);
    // The profile.
    pctx.strokeStyle = ink;
    pctx.lineWidth = 2;
    pctx.beginPath();
    for (let x = PAD; x <= g.W - PAD; x++) {
      const y = Yof(layer.height(g.V(x)), g.plotH);
      x === PAD ? pctx.moveTo(x, y) : pctx.lineTo(x, y);
    }
    pctx.stroke();
    // Threshold streaks and their square handles on the rail.
    for (const t of THRESHOLDS) {
      const x = Math.round(g.X(state[t])) + 0.5;
      pctx.strokeStyle = accent;
      pctx.lineWidth = 1;
      // The inland threshold reads the large layers, not v: dashed.
      pctx.setLineDash(t === 'tInland' ? [3, 3] : []);
      pctx.beginPath();
      pctx.moveTo(x, 0);
      pctx.lineTo(x, g.H - 6);
      pctx.stroke();
      pctx.setLineDash([]);
      pctx.fillStyle = accent;
      pctx.fillRect(x - 6, g.H - 16, 12, 12);
    }
    // The point under the pointer.
    if (hover) {
      const x = g.X(hover.v), y = Yof(hover.h, g.plotH);
      pctx.fillStyle = ink;
      pctx.beginPath();
      pctx.arc(x, y, 4, 0, 2 * Math.PI);
      pctx.fill();
    }
  }

  // Drag a threshold: grab the nearest streak.
  let dragT = null;
  prof.addEventListener('pointerdown', (e) => {
    const g = geom();
    let best = null, bd = 14;
    for (const t of THRESHOLDS) {
      const d = Math.abs(g.X(state[t]) - e.offsetX);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    if (!best) return;
    dragT = best;
    prof.setPointerCapture(e.pointerId);
  });
  prof.addEventListener('pointermove', (e) => {
    const g = geom();
    prof.style.cursor = THRESHOLDS.some((t) => Math.abs(g.X(state[t]) - e.offsetX) < 14) || dragT ? 'ew-resize' : 'default';
    if (!dragT) return;
    setThreshold(dragT, g.V(e.offsetX));
  });
  const endDrag = () => {
    if (dragT) later(rebuild);
    dragT = null;
  };
  prof.addEventListener('pointerup', endDrag);
  prof.addEventListener('pointercancel', endDrag);
  function setThreshold(t, v) {
    const gap = 0.05, k = THRESHOLDS.indexOf(t);
    const lo = k > 0 ? state[THRESHOLDS[k - 1]] + gap : VMIN, hi = k < THRESHOLDS.length - 1 ? state[THRESHOLDS[k + 1]] - gap : VMAX;
    state[t] = Math.round(Math.max(lo, Math.min(hi, v)) * 100) / 100;
    newLayer();
    drawProfile();
    later(rebuild, 250);
  }
  // Keyboard: focus the profile, Tab-free: arrows move the selected handle.
  let keyT = 0;
  prof.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') return;
    if (e.key === ' ' || e.key === 'Enter') keyT = (keyT + 1) % THRESHOLDS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') setThreshold(THRESHOLDS[keyT], state[THRESHOLDS[keyT]] + (e.key === 'ArrowLeft' ? -0.05 : 0.05));
    else return;
    e.preventDefault();
  });

  // --- layers: one compact row each, with typed size and weight -------------

  function numInput(key, step, min, max, after) {
    const el = document.createElement('input');
    Object.assign(el, { type: 'number', step, min, max, value: state[key] });
    el.setAttribute('aria-label', key);
    el.addEventListener('change', () => {
      const v = +el.value;
      if (!Number.isFinite(v)) return (el.value = state[key]);
      state[key] = Math.max(min, Math.min(max, v));
      el.value = state[key];
      (after || rebuild)();
    });
    return el;
  }
  // An eye per layer: show that layer alone; again to go back to the map.
  const eyes = [];
  const EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  function eye(id, name) {
    const b = document.createElement('button');
    b.className = 'eye';
    b.innerHTML = EYE;
    b.title = `Vis bare ${name.toLowerCase()}`;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      state.show = state.show === id ? 'map' : id;
      for (const [k, e] of eyes) e.setAttribute('aria-pressed', String(state.show === k));
      render();
    });
    eyes.push([id, b]);
    return b;
  }
  function toggle(id, name) {
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.className = 'onoff';
    c.checked = on[id];
    c.title = `${name} av/på`;
    c.setAttribute('aria-label', `${name} av/på`);
    c.addEventListener('change', () => {
      on[id] = c.checked;
      rebuild();
    });
    return c;
  }
  function row(table, name, type, cells, id) {
    const t = document.createElement('div');
    if (id) t.appendChild(toggle(id, name));
    table.appendChild(t);
    const n = document.createElement('div');
    n.className = 'cell-name';
    n.innerHTML = `${name}<span class="type">${type}</span>`;
    table.appendChild(n);
    for (const c of cells) {
      const d = document.createElement('div');
      if (c) d.appendChild(c);
      table.appendChild(d);
    }
  }
  const head = (table) => {
    for (const t of ['', '', 'km', 'vekt', '']) {
      const d = document.createElement('div');
      d.className = 'col-head';
      d.textContent = t;
      table.appendChild(d);
    }
  };
  const baseTable = document.getElementById('layers');
  head(baseTable);
  for (const L of M.BaseLayer.LAYERS) {
    row(baseTable, L.name, L.type, [numInput(L.id + 'Size', 10, 20, 10000), numInput(L.id + 'W', 0.05, 0, 3), eye(L.id, L.name)], L.id);
  }
  row(baseTable, 'Innland', 'terskel', [null, null, eye('inland', 'Innland')], 'inland');
  const midTable = document.getElementById('midlayers');
  head(midTable);
  row(midTable, 'Mellomlag', 'fbm', [numInput('midSize', 5, 10, 1000), numInput('midW', 0.05, 0, 3), eye('mid', 'Mellomlaget')], 'mid');
  row(midTable, 'Strekking', 'langs helningen', [null, numInput('midStretch', 0.5, 1, 20), null], 'stretch');
  for (const d of document.querySelectorAll('details.sec')) d.addEventListener('toggle', () => d.open && drawProfile());

  // --- the point under the pointer ------------------------------------------

  const box = document.getElementById('pointbox');
  function showPoint(sx, sy) {
    if (!hover) {
      box.hidden = true;
      return;
    }
    const c = hover.cls, col = c === 0 ? SEA : landColour(hover.h);
    box.innerHTML = `<span class="swatch" style="background:rgb(${col.map((v) => v | 0).join(',')})"></span>${M.BaseLayer.CLASSES[c]}<span class="h">${Math.round(hover.h).toLocaleString('nb-NO')} m</span>`;
    box.hidden = false;
    const W = canvas.clientWidth;
    box.style.left = `${Math.min(sx + 14, W - box.offsetWidth - 8)}px`;
    box.style.top = `${sy + 14}px`;
  }

  // --- pan and zoom ----------------------------------------------------------

  let timer = 0;
  function later(f, ms = 150) {
    clearTimeout(timer);
    timer = setTimeout(f, ms);
  }
  const pointers = new Map();
  let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  });
  canvas.addEventListener('pointermove', (e) => {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      const x = view.cx + (e.offsetX - W / 2) * view.mpp, y = view.cy + (e.offsetY - H / 2) * view.mpp;
      hover = layer.at(x, y);
      showPoint(e.offsetX, e.offsetY);
      drawProfile();
      return;
    }
    if (pointers.size === 1) {
      view.cx -= (e.offsetX - prev[0]) * view.mpp;
      view.cy -= (e.offsetY - prev[1]) * view.mpp;
    }
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()], dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) zoom(pinch / dist, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, false);
      pinch = dist;
    }
    later(render);
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    showPoint();
    drawProfile();
  });
  function zoom(f, sx, sy, now = true) {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const wx = view.cx + (sx - W / 2) * view.mpp, wy = view.cy + (sy - H / 2) * view.mpp;
    view.mpp = Math.max(50, Math.min(20000, view.mpp * f));
    view.cx = wx - (sx - W / 2) * view.mpp;
    view.cy = wy - (sy - H / 2) * view.mpp;
    if (now) later(render);
  }
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom(Math.exp(e.deltaY * 0.0015), e.offsetX, e.offsetY);
  }, { passive: false });
  window.addEventListener('resize', () => later(() => {
    drawProfile();
    render();
  }));

  const seedEl = document.getElementById('seed');
  seedEl.value = state.seed;
  seedEl.addEventListener('change', () => {
    state.seed = Math.round(+seedEl.value) || 0;
    rebuild();
  });
  document.getElementById('reseed').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 100000);
    seedEl.value = state.seed;
    rebuild();
  });

  // For tests: shares, mean and connected seas over 8000 km (not shown).
  function stats(n = 200, span = 8e6) {
    const d = span / n, cls = new Uint8Array(n * n), share = [0, 0, 0, 0];
    let sum = 0, lo = Infinity, hi = -Infinity;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const r = layer.at(-span / 2 + (i + 0.5) * d, -span / 2 + (j + 0.5) * d);
        sum += r.h;
        lo = Math.min(lo, r.h);
        hi = Math.max(hi, r.h);
        share[r.cls]++;
        cls[j * n + i] = r.cls;
      }
    }
    const lab = new Int32Array(n * n).fill(-1), sizes = [];
    for (let s = 0; s < n * n; s++) {
      if (cls[s] !== 0 || lab[s] >= 0) continue;
      const stack = [s];
      lab[s] = sizes.length;
      let size = 0;
      while (stack.length) {
        const q = stack.pop(), qi = q % n, qj = (q - qi) / n;
        size++;
        for (const [a, b] of [[qi + 1, qj], [qi - 1, qj], [qi, qj + 1], [qi, qj - 1]]) {
          if (a < 0 || b < 0 || a >= n || b >= n) continue;
          const r = b * n + a;
          if (cls[r] === 0 && lab[r] < 0) {
            lab[r] = sizes.length;
            stack.push(r);
          }
        }
      }
      sizes.push(size);
    }
    sizes.sort((a, b) => b - a);
    return { mean: sum / (n * n), lo, hi, share: share.map((s) => s / (n * n)), seas: sizes.length, small: sizes.filter((z) => z < 10).length, largestSea: share[0] ? sizes[0] / share[0] : 0 };
  }

  M.grunn = { state, view, rebuild, render, stats, get layer() { return layer; } };
  rebuild();
})(window.Markr = window.Markr || {});
