// Markr grunnlag: a window onto the large layers: the base displacement, the
// middle layer and the region layers.
// Visual first: a profile of height against the layer value with a handle for
// each threshold, one line per noise layer, and a box for the point under the
// pointer.
(function (M) {
  'use strict';

  const state = {
    seed: 58942,
    contSize: 3010, contW: 2.6, basinSize: 940, basinW: 1.75, baseSize: 240, baseW: 1.2, s1Size: 710, s1W: 2.8, s1Width: 0.26,
    tSea: -0.33, tHigh: 1.15, tDivide: 2.63,
    lowTop: 260, highTop: 1600, shelf: 320, deep: 3500,
    midSize: 185, midW: 0.9, midStretch: 10, tInland: 0,
    firmSize: 75, firmW: 0.8, firmInherit: 1, typeSize: 110, typeW: 1.05, typeFirm: 0.4, typeHeight: 0.3, regStretch: 3,
    tT1: -0.34, tT2: 1.01, tT3: 1.84, typeSoft: 0.6,
    depMode: 'median', depSize: 100, depDepth: 0.3, depWidth: 0.61, depSoft: 0.6, depStretch: 3, depAlign: 0.7,
    show: 'map', contours: false, lineDivide: false, lineDep: false, mono: false,
  };

  const canvas = document.getElementById('map'), ctx = canvas.getContext('2d');
  const prof = document.getElementById('profile');
  const view = { cx: 0, cy: 0, mpp: 2500 };
  let layer = null, region = null, dep = null, job = 0, hover = null;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Layers can be turned off without changing their values: their weight
  // goes to 0, while the normalisation stays as if they were on.
  const on = { cont: true, basin: true, base: true, s1: true, inland: true, mid: true, stretch: true, firm: true, type: true, regStretch: true, dep: true, depStretch: true };
  function newLayer() {
    const p = { ...state, norm: Math.hypot(state.contW, state.basinW, state.baseW) || 1, normCB: Math.hypot(state.contW, state.basinW) || 1 };
    for (const id of ['cont', 'basin', 'base', 's1', 'mid']) if (!on[id]) p[id + 'W'] = 0;
    if (!on.inland) p.tInland = Infinity;
    if (!on.stretch) p.midStretch = 1;
    layer = new M.BaseLayer(state.seed, p);
    const pr = { ...state };
    if (!on.firm) pr.firmW = 0;
    if (!on.regStretch) pr.regStretch = 1;
    region = new M.RegionLayer(layer, state.seed, pr);
    const pd = { ...state };
    if (!on.depStretch) pd.depStretch = 1;
    dep = on.dep ? new M.DepressionLayer(layer, state.seed, pd) : null;
  }
  // The whole chain at a point: base, middle layer, regions, depression.
  function full(x, y) {
    const [vb, v0, inland] = layer.valueParts(x, y);
    const r = regionAt(x, y, v0);
    let v = v0, band = 0;
    if (dep) {
      const d = dep.at(x, y, v0, vb, inland, r ? r.firm : 0.5);
      v = d.v;
      band = d.band;
    }
    return { v, h: layer.height(v), cls: layer.cls(v), region: r, band };
  }
  // Region at a point (land only), or null.
  const regionAt = (x, y, v) => (v >= state.tSea ? region.at(x, y, v) : null);
  const REGION_VIEWS = ['firm', 'moist', 'type', 'dep'];
  function rebuild() {
    newLayer();
    histograms();
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
    // Land colour from the regions: rgb, and 0 none / 1 shaded / 2 flat.
    const col = new Float32Array(nx * ny * 3), how = new Uint8Array(nx * ny);
    // Inside a depression (band over a half), for its dashed outline.
    const inDep = new Uint8Array(nx * ny);
    const setCol = (k, c, mode) => {
      col[3 * k] = c[0];
      col[3 * k + 1] = c[1];
      col[3 * k + 2] = c[2];
      how[k] = mode;
    };
    const x0 = view.cx - (W / 2) * view.mpp, y0 = view.cy - (H / 2) * view.mpp, d = block * view.mpp;
    // Lattices need no finer detail than the points drawn now.
    M.Lattice.pixel = d;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * d, y = y0 + (j + 0.5) * d;
        const k = j * nx + i;
        if (REGION_VIEWS.includes(state.show)) {
          // A region layer alone: grey 0..1 on land, or the type colours flat.
          const v = layer.value(x, y), r = regionAt(x, y, v);
          if (!r) {
            cl[k] = 0;
            continue;
          }
          cl[k] = 1;
          if (state.show === 'type') setCol(k, M.RegionLayer.colour(r.w), 2);
          else if (state.show === 'dep') hs[k] = dep ? 2400 * dep.band(x, y, r.firm) : 0;
          else hs[k] = 2400 * r[state.show];
          continue;
        }
        if (state.show !== 'map') {
          // One layer alone, as a height-like grey field.
          const val = layer.single(state.show, x, y);
          hs[j * nx + i] = state.show === 's1' ? 2400 * val : 1200 + 600 * val;
          cl[j * nx + i] = 1;
          continue;
        }
        const f = full(x, y);
        hs[k] = f.h;
        cl[k] = f.cls;
        inDep[k] = f.band > 0.5 ? 1 : 0;
        if (on.type && cl[k] > 0 && f.region) setCol(k, M.RegionLayer.colour(f.region.w), 1);
      }
    }
    const img = ctx.createImageData(canvas.width, canvas.height), px = img.data;
    const bs = block * dpr, dash = Math.max(3, 7 / block); // dash length in blocks
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i, h = hs[k];
        let c;
        if (cl[k] === 0) c = SEA;
        else if (how[k] === 2) c = [col[3 * k], col[3 * k + 1], col[3 * k + 2]];
        else {
          if (how[k] === 1 && !state.mono) {
            // Type colour, darker with height.
            const f = 1.06 - 0.45 * Math.sqrt(Math.max(0, Math.min(1, h / 3500)));
            c = [col[3 * k] * f, col[3 * k + 1] * f, col[3 * k + 2] * f];
          } else c = landColour(h);
          // A soft light from the north-west.
          const hx = hs[j * nx + Math.min(nx - 1, i + 1)] - hs[j * nx + Math.max(0, i - 1)];
          const hy = hs[Math.min(ny - 1, j + 1) * nx + i] - hs[Math.max(0, j - 1) * nx + i];
          // Light from the top left: ground rising toward the bottom right
          // (hx, hy > 0) faces the light and is brighter.
          const sh = state.mono ? Math.max(-0.35, Math.min(0.35, ((hx + hy) / (4 * d)) * 14)) : Math.max(-0.2, Math.min(0.2, ((hx + hy) / (4 * d)) * 8));
          c = [c[0] * (1 + sh), c[1] * (1 + sh), c[2] * (1 + sh)];
          // Contours every 100 m.
          if (state.contours && h > 0) {
            const lv = Math.floor(h / 100);
            if ((i + 1 < nx && hs[k + 1] > 0 && Math.floor(hs[k + 1] / 100) !== lv) || (j + 1 < ny && hs[k + nx] > 0 && Math.floor(hs[k + nx] / 100) !== lv)) {
              const t = Math.floor(lv / 5) * 5 === lv || Math.floor(Math.max(hs[k + 1] || 0, hs[k + nx] || 0) / 100) % 5 === 0 ? 0.62 : 0.8;
              c = [c[0] * t, c[1] * t, c[2] * t];
            }
          }
          // Depressions: a thin dashed blue outline.
          if (state.lineDep && state.show === 'map' && ((i + 1 < nx && inDep[k + 1] !== inDep[k]) || (j + 1 < ny && inDep[k + nx] !== inDep[k])) && Math.floor((i + j) / dash) % 2 === 0) c = [45, 105, 200];
          // The divide field: a dashed outline.
          const edge = state.lineDivide && ((cl[k] === 3) !== ((i + 1 < nx && cl[k + 1] === 3) || false) || (cl[k] === 3) !== ((j + 1 < ny && cl[k + nx] === 3) || false));
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

  // --- profiles: a curve over the value of a layer, the share of the map at
  // each value behind it as flat bars, and a dragged streak per threshold ---

  const PAD = 8, RAIL = 22, BINS = 65;
  // o: { canvas, keys (thresholds in state, in order), min, max, dashed,
  //      hist() -> bins, binColour(v), curve(v, plotH) -> y, base(ctx, g),
  //      point() -> [v, y] or null }
  function makeProfile(o) {
    const cv = o.canvas, c2 = cv.getContext('2d');
    const geom = () => {
      const W = cv.clientWidth, H = cv.clientHeight;
      return { W, H, plotH: H - RAIL, X: (v) => PAD + ((v - o.min) / (o.max - o.min)) * (W - 2 * PAD), V: (x) => o.min + ((x - PAD) / (W - 2 * PAD)) * (o.max - o.min) };
    };
    const P = { bins: null };
    P.draw = () => {
      const dpr = window.devicePixelRatio || 1, g = geom();
      if (!g.W) return;
      cv.width = Math.round(g.W * dpr);
      cv.height = Math.round(g.H * dpr);
      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2.clearRect(0, 0, g.W, g.H);
      const ink = css('--text'), accent = css('--handle');
      if (P.bins) {
        const max = Math.max(...P.bins) || 1, bw = (g.W - 2 * PAD) / BINS;
        for (let b = 0; b < BINS; b++) {
          const v = o.min + ((b + 0.5) / BINS) * (o.max - o.min), hgt = (P.bins[b] / max) * (g.plotH - 4);
          c2.fillStyle = `rgb(${o.binColour(v).map((u) => u | 0).join(',')})`;
          c2.fillRect(PAD + b * bw, g.plotH - hgt, bw + 0.5, hgt);
        }
      }
      if (o.base) o.base(c2, g);
      // One curve (ink), or several in their own colours.
      for (const [fn, colour] of o.curves ? o.curves() : [[o.curve, ink]]) {
        c2.strokeStyle = colour;
        c2.lineWidth = 2;
        c2.beginPath();
        for (let x = PAD; x <= g.W - PAD; x++) {
          const y = fn(g.V(x), g.plotH);
          x === PAD ? c2.moveTo(x, y) : c2.lineTo(x, y);
        }
        c2.stroke();
      }
      for (const t of o.keys) {
        const x = Math.round(g.X(state[t])) + 0.5;
        c2.strokeStyle = accent;
        c2.lineWidth = 1;
        c2.setLineDash(o.dashed && o.dashed.includes(t) ? [3, 3] : []);
        c2.beginPath();
        c2.moveTo(x, 0);
        c2.lineTo(x, g.H - 6);
        c2.stroke();
        c2.setLineDash([]);
        c2.fillStyle = accent;
        c2.fillRect(x - 6, g.H - 16, 12, 12);
      }
      const pt = o.point && o.point(g);
      if (pt) {
        c2.fillStyle = ink;
        c2.beginPath();
        c2.arc(g.X(pt[0]), pt[1], 4, 0, 2 * Math.PI);
        c2.fill();
      }
    };
    // Drag a threshold: grab the nearest streak.
    let drag = null, keyT = 0;
    const set = (t, v) => {
      const gap = 0.05, k = o.keys.indexOf(t);
      const lo = k > 0 ? state[o.keys[k - 1]] + gap : o.min, hi = k < o.keys.length - 1 ? state[o.keys[k + 1]] - gap : o.max;
      state[t] = Math.round(Math.max(lo, Math.min(hi, v)) * 100) / 100;
      newLayer();
      P.draw();
      later(rebuild, 250);
    };
    cv.addEventListener('pointerdown', (e) => {
      const g = geom();
      let best = null, bd = 14;
      for (const t of o.keys) {
        const d = Math.abs(g.X(state[t]) - e.offsetX);
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      if (!best) return;
      drag = best;
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      const g = geom();
      cv.style.cursor = drag || o.keys.some((t) => Math.abs(g.X(state[t]) - e.offsetX) < 14) ? 'ew-resize' : 'default';
      if (drag) set(drag, g.V(e.offsetX));
    });
    const end = () => {
      if (drag) later(rebuild);
      drag = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    // Keyboard: space or enter picks the next handle, arrows move it.
    cv.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') keyT = (keyT + 1) % o.keys.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') set(o.keys[keyT], state[o.keys[keyT]] + (e.key === 'ArrowLeft' ? -0.05 : 0.05));
      else return;
      e.preventDefault();
    });
    return P;
  }

  // Sample the map on a coarse grid over 8000 km for the bars.
  function sampleBins(n, min, max, val) {
    const span = 8e6, d = span / n, bins = new Float32Array(BINS);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const v = val(-span / 2 + (i + 0.5) * d, -span / 2 + (j + 0.5) * d);
        if (v === null) continue;
        const b = Math.floor(((v - min) / (max - min)) * BINS);
        if (b >= 0 && b < BINS) bins[b]++;
      }
    }
    return bins;
  }

  // Base profile: height against v. Height axis is a square root, so lowland
  // shows beside 5000 m.
  const Yof = (h, plotH) => plotH / 2 - Math.sign(h) * Math.sqrt(Math.abs(h) / 5000) * (plotH / 2 - 6);
  const baseProfile = makeProfile({
    canvas: prof, keys: ['tSea', 'tInland', 'tHigh', 'tDivide'], min: -3, max: 3.5, dashed: ['tInland'],
    binColour: (v) => CLASS_COLOUR[layer.cls(v)],
    curve: (v, plotH) => Yof(layer.height(v), plotH),
    base: (c2, g) => {
      c2.strokeStyle = css('--muted');
      c2.setLineDash([2, 3]);
      c2.lineWidth = 1;
      c2.beginPath();
      c2.moveTo(PAD, Yof(0, g.plotH));
      c2.lineTo(g.W - PAD, Yof(0, g.plotH));
      c2.stroke();
      c2.setLineDash([]);
    },
    point: (g) => (hover ? [hover.v, Yof(hover.h, g.plotH)] : null),
  });
  // Type profile: the share of each type (0..100 %) against the type value
  // z, one S-curve per threshold, a curve per type in its colour.
  const shareY = (w, plotH) => plotH - 4 - w * (plotH - 10);
  const typeProfile = makeProfile({
    canvas: document.getElementById('typeprofile'), keys: ['tT1', 'tT2', 'tT3'], min: -3, max: 3,
    binColour: (z) => M.RegionLayer.colour(region.weights(z)),
    curves: () => M.RegionLayer.TYPES.map((t, k) => [(z, plotH) => shareY(region.weights(z)[k], plotH), `rgb(${t.colour.map((c) => (c * 0.75) | 0).join(',')})`]),
    point: (g) => {
      if (!hover || !hover.region) return null;
      const w = hover.region.w, k = w.indexOf(Math.max(...w));
      return [hover.region.z, shareY(w[k], g.plotH)];
    },
  });
  function drawProfile() {
    baseProfile.draw();
    typeProfile.draw();
  }
  function histograms() {
    M.Lattice.direct = true;
    try {
      histogramsDirect();
    } finally {
      M.Lattice.direct = false;
    }
  }
  function histogramsDirect() {
    baseProfile.bins = sampleBins(100, -3, 3.5, (x, y) => layer.value(x, y));
    typeProfile.bins = sampleBins(64, -3, 3, (x, y) => {
      const v = layer.value(x, y);
      return v >= state.tSea ? region.at(x, y, v).z : null;
    });
  }

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
  row(baseTable, 'Sundbredde', 'ridged', [null, numInput('s1Width', 0.01, 0.01, 0.8), null]);
  row(baseTable, 'Innland', 'terskel', [null, null, eye('inland', 'Innland')], 'inland');
  const midTable = document.getElementById('midlayers');
  head(midTable);
  row(midTable, 'Mellomlag', 'fbm', [numInput('midSize', 5, 10, 1000), numInput('midW', 0.05, 0, 3), eye('mid', 'Mellomlaget')], 'mid');
  row(midTable, 'Strekking', 'langs helningen', [null, numInput('midStretch', 0.5, 1, 20), null], 'stretch');
  const regTable = document.getElementById('reglayers');
  head(regTable);
  row(regTable, 'Fasthet', 'fbm, strukket', [numInput('firmSize', 5, 10, 1000), numInput('firmW', 0.05, 0, 3), eye('firm', 'Fasthet')], 'firm');
  row(regTable, 'Arv fra høyden', 'lavland løsere', [null, numInput('firmInherit', 0.05, 0, 3), null]);
  row(regTable, 'Landskapstype', 'fbm, strukket', [numInput('typeSize', 5, 10, 1000), numInput('typeW', 0.05, 0, 3), eye('type', 'Landskapstype')], 'type');
  row(regTable, 'Fasthet → type', 'fastere → fjellsk', [null, numInput('typeFirm', 0.05, 0, 3), null]);
  row(regTable, 'Overgang', 'S-kurve', [null, numInput('typeSoft', 0.05, 0.01, 3), null]);
  row(regTable, 'Høyde → type', 'høyere → fjellsk', [null, numInput('typeHeight', 0.05, 0, 3), null]);
  row(regTable, 'Fuktighet', 'type og fasthet', [null, null, eye('moist', 'Fuktighet')]);
  row(regTable, 'Strekking', 'langs helningen', [null, numInput('regStretch', 0.5, 1, 20), null], 'regStretch');
  document.getElementById('legend').innerHTML = M.RegionLayer.TYPES.map((t) => `<span><i style="background:rgb(${t.colour.join(',')})"></i>${t.name}</span>`).join('');
  const depTable = document.getElementById('deplayers');
  head(depTable);
  row(depTable, 'Nedsenk', 'strukket', [numInput('depSize', 5, 5, 1000), numInput('depDepth', 0.05, 0, 3), eye('dep', 'Nedsenk')], 'dep');
  row(depTable, 'Linjebredde', 'løs grunn: bredere', [null, numInput('depWidth', 0.01, 0.01, 3), null]);
  row(depTable, 'Myke kanter', 'S-kurve', [null, numInput('depSoft', 0.05, 0, 3), null]);
  row(depTable, 'Retning', 'grunt på tvers av helningen', [null, numInput('depAlign', 0.05, 0, 1), null]);
  row(depTable, 'Strekking', 'langs helningen', [null, numInput('depStretch', 0.5, 1, 20), null], 'depStretch');
  for (const b of document.querySelectorAll('#viewmode button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mono === String(state.mono)));
    b.addEventListener('click', () => {
      state.mono = b.dataset.mono === 'true';
      for (const o of document.querySelectorAll('#viewmode button')) o.setAttribute('aria-pressed', String(o === b));
      render();
    });
  }
  for (const b of document.querySelectorAll('#depmode button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.depMode));
    b.addEventListener('click', () => {
      state.depMode = b.dataset.mode;
      for (const o of document.querySelectorAll('#depmode button')) o.setAttribute('aria-pressed', String(o === b));
      rebuild();
    });
  }
  for (const [id, key] of [['contours', 'contours'], ['lineDivide', 'lineDivide'], ['lineDep', 'lineDep']]) {
    const el = document.getElementById(id);
    el.checked = state[key];
    el.addEventListener('change', () => {
      state[key] = el.checked;
      render();
    });
  }
  // Copy every setting (and which layers are on) as text to paste in a chat.
  const copyBtn = document.getElementById('copy');
  copyBtn.addEventListener('click', async () => {
    const { show, ...rest } = state;
    const text = 'Markr grunnlag, innstillinger:\n' + JSON.stringify({ ...rest, på: on }, null, 1);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } catch (e2) {}
      ta.remove();
    }
    copyBtn.textContent = ok ? 'Kopiert' : 'Kunne ikke kopiere';
    setTimeout(() => (copyBtn.textContent = 'Kopier innstillinger'), 1500);
  });
  for (const d of document.querySelectorAll('details.sec')) d.addEventListener('toggle', () => d.open && drawProfile());

  // --- the point under the pointer ------------------------------------------

  const box = document.getElementById('pointbox');
  function showPoint(sx, sy) {
    if (!hover) {
      box.hidden = true;
      return;
    }
    const c = hover.cls, r = hover.region;
    let col = c === 0 ? SEA : landColour(hover.h), name = M.BaseLayer.CLASSES[c];
    if (r && on.type && !state.mono) {
      const top = r.w.indexOf(Math.max(...r.w));
      col = M.RegionLayer.TYPES[top].colour;
      name = `${M.RegionLayer.TYPES[top].name} · ${name}`;
    }
    box.innerHTML = `<span class="swatch" style="background:rgb(${col.map((v) => v | 0).join(',')})"></span>${name}<span class="h">${Math.round(hover.h).toLocaleString('nb-NO')} m</span>`;
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
      hover = full(x, y);
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
        const r = full(-span / 2 + (i + 0.5) * d, -span / 2 + (j + 0.5) * d);
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
