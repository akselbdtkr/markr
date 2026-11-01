// Grunnforskyvning: a window onto the base displacement layer alone.
(function (M) {
  'use strict';

  const CONTROLS = [
    { id: 'scale', label: 'Skala', min: 100, max: 500, step: 10, def: 250, fmt: (v) => `${v} km` },
    { id: 'offset', label: 'Forskyvning (mer land →)', min: -1.5, max: 1.5, step: 0.05, def: 0.25, fmt: (v) => v.toFixed(2) },
    { id: 'basin', label: 'Havbasseng, størrelse', min: 1, max: 5, step: 0.1, def: 3, fmt: (v) => `× ${v.toFixed(1)}` },
    { id: 'basinW', label: 'Havbasseng, vekt', min: 0, max: 1, step: 0.05, def: 0.7, fmt: (v) => v.toFixed(2) },
    { id: 'warp', label: 'Vridning av kystene', min: 0, max: 0.8, step: 0.05, def: 0.2, fmt: (v) => v.toFixed(2) },
    { group: 'Terskler' },
    { id: 'tSea', label: 'Hav under', min: -1.5, max: 1, step: 0.05, def: 0, fmt: (v) => v.toFixed(2) },
    { id: 'tHigh', label: 'Høyland over', min: -0.5, max: 2, step: 0.05, def: 0.8, fmt: (v) => v.toFixed(2) },
    { id: 'tDivide', label: 'Vanndeling over', min: 0, max: 3, step: 0.05, def: 1.6, fmt: (v) => v.toFixed(2) },
    { group: 'Høyder' },
    { id: 'lowTop', label: 'Lavland stiger til', min: 50, max: 800, step: 10, def: 300, fmt: (v) => `${v} m` },
    { id: 'highTop', label: 'Høyland stiger til', min: 400, max: 3000, step: 50, def: 1500, fmt: (v) => `${v} m` },
    { id: 'shelf', label: 'Sokkel', min: 20, max: 600, step: 10, def: 200, fmt: (v) => `−${v} m` },
    { id: 'deep', label: 'Dyphav', min: 1000, max: 5000, step: 100, def: 5000, fmt: (v) => `−${v} m` },
    { group: 'Sund' },
    { id: 's1', label: 'Store sund, styrke', min: 0, max: 1.5, step: 0.05, def: 1, fmt: (v) => (v ? v.toFixed(2) : 'av') },
    { id: 'w1', label: 'Store sund, bredde', min: 0.02, max: 0.3, step: 0.01, def: 0.06, fmt: (v) => v.toFixed(2) },
    { id: 's2', label: 'Små sund, styrke', min: 0, max: 1.5, step: 0.05, def: 0.8, fmt: (v) => (v ? v.toFixed(2) : 'av') },
    { id: 'w2', label: 'Små sund, bredde', min: 0.02, max: 0.3, step: 0.01, def: 0.06, fmt: (v) => v.toFixed(2) },
  ];

  const state = { seed: 1848, shade: true, lines: true };
  for (const c of CONTROLS) if (c.id) state[c.id] = c.def;

  const canvas = document.getElementById('map');
  const ctx = canvas.getContext('2d');
  // View: centre in metres, metres per CSS pixel.
  const view = { cx: 0, cy: 0, mpp: 2500 };
  let layer = null, job = 0, hover = null;

  const rebuild = () => {
    const p = {};
    for (const c of CONTROLS) if (c.id) p[c.id] = state[c.id];
    p.tHigh = Math.max(p.tHigh, p.tSea + 0.05);
    p.tDivide = Math.max(p.tDivide, p.tHigh + 0.05);
    layer = new M.BaseLayer(state.seed, p);
    measureReference();
    render();
  };

  // Colours: blue by depth, then green, brown, grey, white.
  const SEA = [[0, [150, 200, 225]], [200, [110, 170, 210]], [1000, [60, 120, 180]], [5000, [20, 45, 95]]];
  const LAND = [[0, [120, 165, 95]], [300, [170, 185, 110]], [900, [175, 150, 105]], [1500, [140, 120, 100]], [2500, [150, 145, 140]], [4000, [240, 240, 240]]];
  const ramp = (stops, t) => {
    if (t <= stops[0][0]) return stops[0][1];
    for (let k = 1; k < stops.length; k++) {
      if (t <= stops[k][0]) {
        const [a, ca] = stops[k - 1], [b, cb] = stops[k], f = (t - a) / (b - a);
        return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f];
      }
    }
    return stops[stops.length - 1][1];
  };

  // Render in passes: coarse blocks first, then sharper.
  function render() {
    const id = ++job;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const passes = [8, 3, 1.5];
    let k = 0;
    const step = () => {
      if (id !== job) return;
      const t0 = performance.now();
      draw(passes[k], W, H, dpr);
      M.grunn.lastPass = { block: passes[k], ms: performance.now() - t0 };
      measureView();
      if (++k < passes.length) requestAnimationFrame(step);
      else M.grunn.done = true;
    };
    M.grunn.done = false;
    step();
  }

  function draw(block, W, H, dpr) {
    const nx = Math.ceil(W / block) + 1, ny = Math.ceil(H / block) + 1;
    const hs = new Float32Array(nx * ny), cl = new Uint8Array(nx * ny);
    const x0 = view.cx - (W / 2) * view.mpp, y0 = view.cy - (H / 2) * view.mpp, d = block * view.mpp;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = layer.value(x0 + (i + 0.5) * d, y0 + (j + 0.5) * d);
        hs[j * nx + i] = layer.height(v);
        cl[j * nx + i] = layer.cls(v);
      }
    }
    const img = ctx.createImageData(canvas.width, canvas.height), px = img.data;
    const bs = block * dpr;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i, h = hs[k];
        let c = h < 0 ? ramp(SEA, -h) : ramp(LAND, h);
        if (state.shade && h > 0) {
          const hx = hs[j * nx + Math.min(nx - 1, i + 1)] - hs[j * nx + Math.max(0, i - 1)];
          const hy = hs[Math.min(ny - 1, j + 1) * nx + i] - hs[Math.max(0, j - 1) * nx + i];
          const sh = Math.max(-0.35, Math.min(0.35, (-(hx + hy) / (4 * d)) * 12));
          c = [c[0] * (1 + sh), c[1] * (1 + sh), c[2] * (1 + sh)];
        }
        // Threshold lines: where the class changes to the right or below.
        if (state.lines && cl[k] > 0 && ((i + 1 < nx && cl[k + 1] !== cl[k]) || (j + 1 < ny && cl[k + nx] !== cl[k]))) {
          c = cl[k] === 1 ? [70, 90, 60] : [90, 60, 40];
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
    // Scale bar.
    ctx.save();
    ctx.scale(dpr, dpr);
    const km = niceKm(150 * view.mpp / 1000), len = (km * 1000) / view.mpp;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(12, H - 34, len + 16, 24);
    ctx.fillStyle = '#222';
    ctx.fillRect(20, H - 18, len, 3);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`${km} km`, 20, H - 22);
    ctx.restore();
  }
  const niceKm = (v) => {
    const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
    return (f < 2 ? 1 : f < 5 ? 2 : 5) * e;
  };

  // Measurement over a grid: mean, extremes, class shares, connected seas.
  function measure(x0, y0, span, n) {
    const d = span / n, cls = new Uint8Array(n * n);
    let sum = 0, lo = Infinity, hi = -Infinity;
    const share = [0, 0, 0, 0];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const v = layer.value(x0 + (i + 0.5) * d, y0 + (j + 0.5) * d), h = layer.height(v), c = layer.cls(v);
        sum += h;
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
        share[c]++;
        cls[j * n + i] = c;
      }
    }
    // Connected seas (4-neighbours).
    const lab = new Int32Array(n * n).fill(-1), sizes = [];
    for (let s = 0; s < n * n; s++) {
      if (cls[s] !== 0 || lab[s] >= 0) continue;
      const id = sizes.length, stack = [s];
      lab[s] = id;
      let size = 0;
      while (stack.length) {
        const q = stack.pop(), qi = q % n, qj = (q - qi) / n;
        size++;
        for (const [a, b] of [[qi + 1, qj], [qi - 1, qj], [qi, qj + 1], [qi, qj - 1]]) {
          if (a < 0 || b < 0 || a >= n || b >= n) continue;
          const r = b * n + a;
          if (cls[r] === 0 && lab[r] < 0) {
            lab[r] = id;
            stack.push(r);
          }
        }
      }
      sizes.push(size);
    }
    sizes.sort((a, b) => b - a);
    const seaN = share[0];
    return {
      mean: sum / (n * n), lo, hi,
      share: share.map((s) => s / (n * n)),
      seas: sizes.length,
      largestSea: seaN ? sizes[0] / seaN : 0,
    };
  }

  const fmtM = (v) => `${Math.round(v).toLocaleString('nb-NO')} m`;
  const pctS = (v) => `${Math.round(v * 100)} %`;
  function statsHtml(s, warn) {
    const ok = s.mean >= -100 && s.mean <= 1500;
    return `<dl>
      <dt>Snitthøyde</dt><dd${warn && !ok ? ' class="warn"' : ''}>${fmtM(s.mean)}${warn && !ok ? ' (utenfor −100…1500)' : ''}</dd>
      <dt>Lavest / høyest</dt><dd>${fmtM(s.lo)} / ${fmtM(s.hi)}</dd>
      ${BaseLayerClasses().map((n, k) => `<dt>${n[0].toUpperCase() + n.slice(1)}</dt><dd>${pctS(s.share[k])}</dd>`).join('')}
      <dt>Havområder</dt><dd>${s.seas}, største ${pctS(s.largestSea)} av havet</dd>
    </dl>`;
  }
  const BaseLayerClasses = () => M.BaseLayer.CLASSES;

  function measureReference() {
    const t0 = performance.now();
    const s = measure(-4e6, -4e6, 8e6, 200);
    M.grunn.reference = s;
    document.getElementById('ref').innerHTML = statsHtml(s, true) + `<p class="hint">8000 × 8000 km, 200 × 200 prøver, ${Math.round(performance.now() - t0)} ms</p>`;
  }
  function measureView() {
    const W = canvas.clientWidth, H = canvas.clientHeight, span = Math.min(W, H) * view.mpp;
    const s = measure(view.cx - span / 2, view.cy - span / 2, span, 100);
    M.grunn.view = s;
    document.getElementById('viewstats').innerHTML = statsHtml(s, false);
  }

  function showHover() {
    const el = document.getElementById('hover');
    if (!hover) {
      el.innerHTML = '<span class="muted">Pek på kartet.</span>';
      return;
    }
    const [x, y] = hover, r = layer.at(x, y);
    el.innerHTML = `<dl>
      <dt>Posisjon</dt><dd>${Math.round(x / 1000)}, ${Math.round(y / 1000)} km</dd>
      <dt>Høyde</dt><dd>${fmtM(r.h)}</dd>
      <dt>Verdi</dt><dd>${r.v.toFixed(2)}</dd>
      <dt>Klasse</dt><dd>${M.BaseLayer.CLASSES[r.cls]}</dd>
    </dl>`;
  }

  // --- controls ---------------------------------------------------------------

  let timer = 0;
  const later = (f) => {
    clearTimeout(timer);
    timer = setTimeout(f, 120);
  };
  const box = document.getElementById('controls');
  for (const c of CONTROLS) {
    if (c.group) {
      const h = document.createElement('h2');
      h.textContent = c.group;
      box.appendChild(h);
      continue;
    }
    const lab = document.createElement('label'), out = document.createElement('output'), inp = document.createElement('input');
    lab.textContent = c.label + ' ';
    lab.htmlFor = c.id;
    lab.appendChild(out);
    Object.assign(inp, { id: c.id, type: 'range', min: c.min, max: c.max, step: c.step, value: c.def });
    out.textContent = c.fmt(c.def);
    inp.addEventListener('input', () => {
      state[c.id] = +inp.value;
      out.textContent = c.fmt(state[c.id]);
      later(rebuild);
    });
    box.appendChild(lab);
    box.appendChild(inp);
  }
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
  for (const id of ['shade', 'lines']) {
    const el = document.getElementById(id);
    el.checked = state[id];
    el.addEventListener('change', () => {
      state[id] = el.checked;
      render();
    });
  }
  document.getElementById('home').addEventListener('click', () => {
    Object.assign(view, { cx: 0, cy: 0, mpp: 2500 });
    render();
  });

  // --- pan and zoom -----------------------------------------------------------

  const pointers = new Map();
  let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  });
  canvas.addEventListener('pointermove', (e) => {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    hover = [view.cx + (e.offsetX - W / 2) * view.mpp, view.cy + (e.offsetY - H / 2) * view.mpp];
    showHover();
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
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
    showHover();
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
  window.addEventListener('resize', () => later(render));

  M.grunn = { state, view, rebuild, render, get layer() { return layer; } };
  showHover();
  rebuild();
})(window.Markr = window.Markr || {});
