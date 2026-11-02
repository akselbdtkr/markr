// Markr grunnlag: a window onto the large layers: the base displacement, the
// middle layer and the region layers.
// Visual first: a profile of height against the layer value with a handle for
// each threshold, one line per noise layer, and a box for the point under the
// pointer.
(function (M) {
  'use strict';

  const state = {
    seed: 7844,
    contSize: 3010, contW: 2.6, basinSize: 940, basinW: 1.75, baseSize: 240, baseW: 1.2, s1Size: 710, s1W: 2.8, s1Width: 0.26,
    tSea: -0.33, tHigh: 1.15, tDivide: 1.98, divSteep: 2.5,
    lowTop: 260, highTop: 1600, shelf: 320, deep: 3500,
    midSize: 185, midW: 0.9, midStretch: 10, tInland: 0,
    firmSize: 75, firmW: 0.8, firmInherit: 1, typeSize: 110, typeW: 1.05, typeFirm: 0.4, typeHeight: 0.3, regStretch: 3,
    tT1: -0.34, tT2: 1.01, tT3: 1.85, typeSoft: 0.6,
    depMode: 'median', depSize: 100, depDepth: 0.3, depWidth: 0.61, depSoft: 0.6, depStretch: 3, depAlign: 0.7, depLow: 0.8, depPlain: 0.5,
    vA1: 0.6, vA2: 1.6, vA3: 2.4, vB1: 0.25, vB2: 0.7, vB3: 0.9, vH: 0.4,
    riverAlign: 0.6, riverWidth: 50000, riverDeep: 4, riverZone: 4,
    rvH: [1, 0.6, 0.41, 0.4, 0.35, 0.35], rvF: [1, 0.6, 0.4, 0.37, 0.41, 0.44], riverMin: 1200, riverBraid: 0.7, riverDrop: 0.03, riverRise: 0.5,
    secZoom: 5000, riverGap: 30000, riverWalk: 50000, riverBend: 0.6, riverMeander: 1, showNodes: false,
    // Scale: the simulation keeps its own units; on screen one unit is
    // 1/scaleH m across and 1/scaleV m in height (1:50 and 1:10).
    scaleH: 100, scaleV: 1,
    show: 'map', contours: false, lineDivide: false, lineDep: false, mono: false,
  };

  const canvas = document.getElementById('map'), ctx = canvas.getContext('2d');
  const prof = document.getElementById('profile');
  const view = { cx: 0, cy: 0, mpp: 2500 };
  let layer = null, region = null, dep = null, river = null, sections = null, useSections = false, job = 0, hover = null, pixNow = 0;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Layers can be turned off without changing their values: their weight
  // goes to 0, while the normalisation stays as if they were on.
  const on = { cont: true, basin: true, base: true, s1: true, inland: true, mid: true, stretch: true, firm: true, type: true, regStretch: true, dep: true, depStretch: true, river: true, sections: true };
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
    river = dep && on.river ? new M.RiverLine(layer, region, dep, state.seed, { ...state }) : null;
    // The per-section step: its own store of rivers, built when zoomed in.
    sections = river && on.sections
      ? new M.RiverSections(river, (x, y) => {
          const f = fullCore(x, y, false);
          return { h: f.h, cls: f.cls };
        }, { cell: 16 * state.scaleH, gap: state.riverGap, walk: state.riverWalk, bend: state.riverBend, meander: state.riverMeander, tSea: state.tSea, minW: state.riverMin, rise: 5 * state.scaleV })
      : null;
  }
  // The whole chain at a point: base, middle layer, regions, depression.
  const full = (x, y) => fullCore(x, y, useSections);
  function fullCore(x, y, withSections) {
    const [vb, v0, inland, large] = layer.valueParts(x, y);
    const r = regionAt(x, y, v0);
    let v = v0, band = 0;
    if (dep) {
      const d = dep.at(x, y, v0, vb, inland, r ? r.firm : 0.5, large, r ? r.w[0] : 0, r ? r.pos : null);
      v = d.v;
      band = d.band;
    }
    // Rivers: class 4 (elv), on land only.
    let water = false, sea = false, tint = 0;
    // Large views draw only large rivers: skip the river sum where even the
    // widest river here would be under two drawn points (no section step).
    const small = !withSections && r && river && river.maxWidth(layer.height(v0), r.firm) < 2 * pixNow;
    if (river && v >= state.tSea && !small) {
      const mask = withSections && sections ? sections.waterAt(x, y) : undefined;
      const rv = river.at(x, y, v, mask);
      if (mask && !mask.water && !rv.water) tint = mask.cover;
      v = rv.v;
      water = rv.water;
      sea = !!rv.sea;
    }
    return { v, h: layer.height(v), cls: sea ? 0 : water ? 4 : layer.cls(v), region: r, band, tint };
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
  const RIVER = SEA; // one water colour, so rivers meet the sea without a seam
  const CLASS_COLOUR = [SEA, [214, 212, 206], [168, 166, 161], [112, 110, 106], RIVER];
  const CLASS_NAMES = [...M.BaseLayer.CLASSES, 'elv'];
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
    // Never finer than one cell (16 m on screen): the map has no more detail
    // than the game's cells, so close up the passes stop at the cell size.
    const cellPx = (16 * state.scaleH) / view.mpp;
    const passes = [Math.max(8, 4 * cellPx), Math.max(3, 2 * cellPx), Math.max(1.5, cellPx)];
    let k = 0;
    M.grunn.done = false;
    // Zoomed in far enough (the view's width on screen under secZoom): build
    // the per-section rivers for every visible section, once.
    const viewM = (W * view.mpp) / state.scaleH;
    useSections = !!sections && viewM <= state.secZoom;
    if (useSections) {
      // Always build on the same lattice: one cell, so a section's rivers do
      // not depend on what was drawn before.
      M.Lattice.section = 16 * state.scaleH;
      M.Lattice.pixel = 32 * state.scaleH; // two cells: enough for the lines
      const t0 = performance.now(), size = sections.size;
      const i0 = Math.floor((view.cx - (W / 2) * view.mpp) / size), i1 = Math.floor((view.cx + (W / 2) * view.mpp) / size);
      const j0 = Math.floor((view.cy - (H / 2) * view.mpp) / size), j1 = Math.floor((view.cy + (H / 2) * view.mpp) / size);
      for (let sj = j0; sj <= j1; sj++) for (let si = i0; si <= i1; si++) sections.build(si, sj);
      M.grunn.sectionMs = performance.now() - t0;
    }
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
    const tints = new Float32Array(nx * ny); // narrow rivers: share of the cell
    const setCol = (k, c, mode) => {
      col[3 * k] = c[0];
      col[3 * k + 1] = c[1];
      col[3 * k + 2] = c[2];
      how[k] = mode;
    };
    const x0 = view.cx - (W / 2) * view.mpp, y0 = view.cy - (H / 2) * view.mpp, d = block * view.mpp;
    // Lattices need no finer detail than the points drawn now.
    M.Lattice.pixel = d;
    pixNow = d;
    M.Lattice.section = 16 * state.scaleH; // a 16 m cell, in simulation units
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
          else if (state.show === 'dep') hs[k] = dep ? 2400 * dep.band(x, y, r.firm, 0, r.pos) : 0;
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
        tints[k] = f.tint || 0;
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
        else if (cl[k] === 4) c = RIVER;
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
          // A river narrower than the cell: a share of water blue.
          if (tints[k] > 0) {
            const t = Math.min(1, tints[k]);
            c = [c[0] + (SEA[0] - c[0]) * t, c[1] + (SEA[1] - c[1]) * t, c[2] + (SEA[2] - c[2]) * t];
          }
          // Contours every 100 m.
          if (state.contours && h > 0) {
            // Every 10 m on screen (in simulation units: 10 × scaleV).
            const ci = 10 * state.scaleV, lv = Math.floor(h / ci);
            if ((i + 1 < nx && hs[k + 1] > 0 && Math.floor(hs[k + 1] / ci) !== lv) || (j + 1 < ny && hs[k + nx] > 0 && Math.floor(hs[k + nx] / ci) !== lv)) {
              const t = Math.floor(lv / 5) * 5 === lv || Math.floor(Math.max(hs[k + 1] || 0, hs[k + nx] || 0) / ci) % 5 === 0 ? 0.62 : 0.8;
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
    if (state.showNodes && useSections) drawNodes(W, H, dpr);
    // Scale bar, no box.
    ctx.save();
    ctx.scale(dpr, dpr);
    // On screen units: metres per pixel after the scale.
    const mpp = view.mpp / state.scaleH, m = niceKm(120 * mpp), len = m / mpp;
    ctx.fillStyle = 'rgba(20,20,24,0.8)';
    ctx.fillRect(16, H - 20, len, 3);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(m >= 1000 ? `${(m / 1000).toLocaleString('nb-NO')} km` : `${m.toLocaleString('nb-NO')} m`, 16, H - 26);
    ctx.restore();
  }
  // The stored bottom points and links of the visible sections: line links
  // dark blue, bridges red, downhill walks orange, rings violet.
  function drawNodes(W, H, dpr) {
    const X = (x) => ((x - view.cx) / view.mpp + W / 2) * dpr, Y = (y) => ((y - view.cy) / view.mpp + H / 2) * dpr;
    const colour = { line: '#1d3f7a', bridge: '#d4302a', tributary: '#2fa84a', walk: '#e08a1e', source: '#1fa6c9', lake: '#5b6b7a', loose: '#8c9aa8' };
    ctx.save();
    ctx.lineWidth = 1.5 * dpr;
    for (const [, gr] of sections.graphs) {
      for (const sg of gr.segs) {
        ctx.strokeStyle = colour[sg.kind];
        ctx.beginPath();
        ctx.moveTo(X(sg.a.x), Y(sg.a.y));
        ctx.lineTo(X(sg.b.x), Y(sg.b.y));
        ctx.stroke();
      }
      ctx.strokeStyle = '#8a3fb8';
      for (const r of gr.rings) {
        ctx.beginPath();
        r.poly.forEach((n, i) => (i ? ctx.lineTo(X(n.x), Y(n.y)) : ctx.moveTo(X(n.x), Y(n.y))));
        ctx.closePath();
        ctx.stroke();
      }
    }
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

  // --- valley profiles: which cross-section arises where -----------------------
  // Across: the type value (slette to fjellsk, with your thresholds); up:
  // lowland to highland. Each cell shows the blended cross-section and the
  // sign of its main profile, on the colour of the landscape there.
  function drawValleys() {
    const cv = document.getElementById('depprofile');
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !region) return;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const c2 = cv.getContext('2d');
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.clearRect(0, 0, W, H);
    const cols = 7, rows = 4, L = 16, B = 14, cw = (W - L) / cols, ch = (H - B) / rows, P = M.DepressionLayer.PROFILES;
    const ink = css('--text');
    for (let r = 0; r < rows; r++) {
      const low = (r + 0.5) / rows; // top row: highland (little lowland)
      const hrel = 1 - low;
      const fm = Math.max(0, Math.min(1, 0.5 + 0.5 * Math.tanh(state.firmInherit * (2 * hrel - 1) * 0.75)));
      for (let q = 0; q < cols; q++) {
        const z = -3 + (6 * (q + 0.5)) / cols, w = region.weights(z), sw = M.DepressionLayer.shapes(region.posOf(z), 1 - low, state);
        const x0 = L + q * cw, y0 = r * ch, col = M.RegionLayer.colour(w);
        c2.fillStyle = `rgba(${col.map((v) => v | 0).join(',')},0.55)`;
        c2.fillRect(x0 + 1, y0 + 1, cw - 2, ch - 2);
        // The cross-section, as a valley cut down from the top of the cell.
        c2.strokeStyle = ink;
        c2.lineWidth = 1.5;
        c2.beginPath();
        for (let k = 0; k <= 24; k++) {
          const t = -1.25 + (2.5 * k) / 24, px = x0 + 3 + ((cw - 6) * k) / 24, py = y0 + 13 + (ch - 18) * M.DepressionLayer.profile(Math.abs(t), sw);
          k ? c2.lineTo(px, py) : c2.moveTo(px, py);
        }
        c2.stroke();
        const top = sw.indexOf(Math.max(...sw));
        c2.fillStyle = ink;
        c2.font = '600 11px ui-monospace, monospace';
        c2.textAlign = 'center';
        c2.fillText(P[top].sym, x0 + cw / 2, y0 + 10);
      }
    }
    c2.fillStyle = css('--muted');
    c2.font = '10px system-ui, sans-serif';
    c2.textAlign = 'left';
    c2.fillText('slette', L, H - 3);
    c2.textAlign = 'right';
    c2.fillText('fjellsk', W, H - 3);
    c2.save();
    c2.translate(10, H - B);
    c2.rotate(-Math.PI / 2);
    c2.textAlign = 'left';
    c2.fillText('lavland → høyland', 0, 0);
    c2.restore();
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
  // Valley profile thresholds: along the types and along the height.
  const VALLEY_COLOURS = ['#a8823f', '#4f8a48', '#a8552f', '#6c5c94'];
  const valleyA = makeProfile({
    canvas: document.getElementById('valleyA'), keys: ['vA1', 'vA2', 'vA3'], min: 0, max: 3,
    binColour: () => [220, 220, 220],
    curves: () => VALLEY_COLOURS.map((c, k) => [(v, plotH) => shareY(M.DepressionLayer.split(v, state.vA1, state.vA2, state.vA3, 0.2)[k], plotH), c]),
  });
  const valleyB = makeProfile({
    canvas: document.getElementById('valleyB'), keys: ['vB1', 'vB2', 'vB3'], min: 0, max: 1,
    binColour: () => [220, 220, 220],
    curves: () => VALLEY_COLOURS.map((c, k) => [(v, plotH) => shareY(M.DepressionLayer.split(v, state.vB1, state.vB2, state.vB3, 0.08)[k], plotH), c]),
  });
  function drawProfile() {
    valleyA.draw();
    valleyB.draw();
    baseProfile.draw();
    typeProfile.draw();
    curveH.draw();
    curveF.draw();
    drawValleys();
  }
  // --- size curves for rivers: points dragged up and down ---------------------

  // Fractional index of x among the points xs (0 .. xs.length - 1).
  const pos = (xs, x) => {
    if (x <= xs[0]) return 0;
    for (let k = 1; k < xs.length; k++) if (x <= xs[k]) return k - 1 + (x - xs[k - 1]) / (xs[k] - xs[k - 1]);
    return xs.length - 1;
  };
  // o: { canvas, xs, key (array in state), label(x) }. Bars behind: where
  // river bottoms lie along x (P.bins over xs' range).
  function makeCurve(o) {
    const cv = o.canvas, c2 = cv.getContext('2d'), P = { bins: null };
    // The points stand evenly spaced, whatever their values.
    const geom = () => {
      const W = cv.clientWidth, H = cv.clientHeight, n = o.xs.length - 1;
      return { W, H, plotH: H - 18, X: (x) => PAD + (pos(o.xs, x) / n) * (W - 2 * PAD), Y: (v) => H - 18 - v * (H - 26) };
    };
    P.draw = () => {
      const dpr = window.devicePixelRatio || 1, g = geom();
      if (!g.W) return;
      cv.width = Math.round(g.W * dpr);
      cv.height = Math.round(g.H * dpr);
      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2.clearRect(0, 0, g.W, g.H);
      if (P.bins) {
        const max = Math.max(...P.bins) || 1, bw = (g.W - 2 * PAD) / P.bins.length;
        c2.fillStyle = 'rgb(160, 190, 222)';
        for (let b = 0; b < P.bins.length; b++) {
          const hgt = (P.bins[b] / max) * (g.plotH - 6);
          c2.fillRect(PAD + b * bw, g.plotH - hgt, bw + 0.5, hgt);
        }
      }
      const ys = state[o.key];
      c2.strokeStyle = css('--text');
      c2.lineWidth = 2;
      c2.beginPath();
      o.xs.forEach((x, k) => (k ? c2.lineTo(g.X(x), g.Y(ys[k])) : c2.moveTo(g.X(x), g.Y(ys[k]))));
      c2.stroke();
      c2.fillStyle = css('--handle');
      for (let k = 0; k < o.xs.length; k++) c2.fillRect(g.X(o.xs[k]) - 6, g.Y(ys[k]) - 6, 12, 12);
      c2.fillStyle = css('--muted');
      c2.font = '10px system-ui, sans-serif';
      c2.textAlign = 'center';
      for (const k of [0, o.xs.length - 1]) c2.fillText(o.label(o.xs[k]), Math.min(g.W - 14, Math.max(14, g.X(o.xs[k]))), g.H - 4);
    };
    let drag = -1, keyK = 0;
    const set = (k, v) => {
      state[o.key][k] = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
      P.draw();
      later(rebuild, 250);
    };
    cv.addEventListener('pointerdown', (e) => {
      const g = geom();
      let best = -1, bd = 16;
      o.xs.forEach((x, k) => {
        const d = Math.abs(g.X(x) - e.offsetX);
        if (d < bd) {
          bd = d;
          best = k;
        }
      });
      if (best < 0) return;
      drag = best;
      cv.setPointerCapture(e.pointerId);
      set(drag, (g.H - 18 - e.offsetY) / (g.H - 26));
    });
    cv.addEventListener('pointermove', (e) => {
      const g = geom();
      cv.style.cursor = drag >= 0 || o.xs.some((x) => Math.abs(g.X(x) - e.offsetX) < 16) ? 'ns-resize' : 'default';
      if (drag >= 0) set(drag, (g.H - 18 - e.offsetY) / (g.H - 26));
    });
    const end = () => (drag = -1);
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') keyK = (keyK + 1) % o.xs.length;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') set(keyK, state[o.key][keyK] + (e.key === 'ArrowUp' ? 0.05 : -0.05));
      else return;
      e.preventDefault();
    });
    return P;
  }
  const curveH = makeCurve({ canvas: document.getElementById('rvH'), xs: M.RiverLine.CURVE_H, key: 'rvH', label: (x) => (x ? `vanndeling ${Math.round(layer.height(state.tDivide) / state.scaleV)} m` : '0 m') });
  const curveF = makeCurve({ canvas: document.getElementById('rvF'), xs: M.RiverLine.CURVE_F, key: 'rvF', label: (x) => (x ? 'fast' : 'løs') });
  // Where river bottoms lie, by height on screen and by firmness.
  function riverBins() {
    const bh = new Float32Array(30), bf = new Float32Array(30);
    if (!river) return [bh, bf];
    const xh = M.RiverLine.CURVE_H, top = xh[xh.length - 1];
    for (let k = 0; k < 2500; k++) {
      const x = (((Math.sin(k * 12.9898) * 43758.5) % 1) - 0.5) * 4e6, y = (((Math.sin(k * 78.233) * 43758.5) % 1) - 0.5) * 4e6;
      const bt = river.bottom(x, y);
      if (!bt) continue;
      const vq = layer.valueParts(bt.qx, bt.qy)[1], hq = layer.height(vq) / Math.max(1, layer.height(state.tDivide));
      const n = xh.length - 1;
      bh[Math.min(29, Math.floor((pos(xh, hq) / n) * 30))]++;
      bf[Math.min(29, Math.floor((pos(M.RiverLine.CURVE_F, bt.firm) / n) * 30))]++;
    }
    return [bh, bf];
  }

  function histograms() {
    M.Lattice.direct = true;
    try {
      histogramsDirect();
      [curveH.bins, curveF.bins] = riverBins();
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

  // unit: 'h' for lengths and 'v' for heights. The field shows the value on
  // screen (after the scale) and stores it in simulation units; step, min
  // and max are in simulation units too.
  const factor = (unit) => (unit === 'h' ? 1 / state.scaleH : unit === 'v' ? 1 / state.scaleV : 1);
  const round3 = (v) => (v === 0 ? 0 : +v.toPrecision(3));
  const unitInputs = [];
  function numInput(key, step, min, max, after, unit) {
    const el = document.createElement('input');
    const show = () => {
      const f = factor(unit);
      Object.assign(el, { type: 'number', step: round3(step * f), min: round3(min * f), max: round3(max * f), value: round3(state[key] * f) });
    };
    show();
    if (unit) unitInputs.push(show);
    el.setAttribute('aria-label', key);
    el.addEventListener('change', () => {
      const v = +el.value / factor(unit);
      if (!Number.isFinite(v)) return show();
      state[key] = Math.max(min, Math.min(max, v));
      show();
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
    row(baseTable, L.name, L.type, [numInput(L.id + 'Size', 10, 20, 10000, null, 'h'), numInput(L.id + 'W', 0.05, 0, 3), eye(L.id, L.name)], L.id);
  }
  row(baseTable, 'Sundbredde', 'ridged', [null, numInput('s1Width', 0.01, 0.01, 0.8), null]);
  row(baseTable, 'Innland', 'terskel', [null, null, eye('inland', 'Innland')], 'inland');
  row(baseTable, 'Vanndeling stiger', 'brattere: høyere', [null, numInput('divSteep', 0.1, 0.2, 10), null]);
  const midTable = document.getElementById('midlayers');
  head(midTable);
  row(midTable, 'Mellomlag', 'fbm', [numInput('midSize', 5, 10, 1000, null, 'h'), numInput('midW', 0.05, 0, 3), eye('mid', 'Mellomlaget')], 'mid');
  row(midTable, 'Strekking', 'langs helningen', [null, numInput('midStretch', 0.5, 1, 20), null], 'stretch');
  const regTable = document.getElementById('reglayers');
  head(regTable);
  row(regTable, 'Fasthet', 'fbm, strukket', [numInput('firmSize', 5, 10, 1000, null, 'h'), numInput('firmW', 0.05, 0, 3), eye('firm', 'Fasthet')], 'firm');
  row(regTable, 'Arv fra høyden', 'lavland løsere', [null, numInput('firmInherit', 0.05, 0, 3), null]);
  row(regTable, 'Landskapstype', 'fbm, strukket', [numInput('typeSize', 5, 10, 1000, null, 'h'), numInput('typeW', 0.05, 0, 3), eye('type', 'Landskapstype')], 'type');
  row(regTable, 'Fasthet → type', 'fastere → fjellsk', [null, numInput('typeFirm', 0.05, 0, 3), null]);
  row(regTable, 'Overgang', 'S-kurve', [null, numInput('typeSoft', 0.05, 0.01, 3), null]);
  row(regTable, 'Høyde → type', 'høyere → fjellsk', [null, numInput('typeHeight', 0.05, 0, 3), null]);
  row(regTable, 'Fuktighet', 'type og fasthet', [null, null, eye('moist', 'Fuktighet')]);
  row(regTable, 'Strekking', 'langs helningen', [null, numInput('regStretch', 0.5, 1, 20), null], 'regStretch');
  document.getElementById('legend').innerHTML = M.RegionLayer.TYPES.map((t) => `<span><i style="background:rgb(${t.colour.join(',')})"></i>${t.name}</span>`).join('');
  const depTable = document.getElementById('deplayers');
  head(depTable);
  row(depTable, 'Nedsenk', 'strukket', [numInput('depSize', 5, 5, 1000, null, 'h'), numInput('depDepth', 0.05, 0, 3), eye('dep', 'Nedsenk')], 'dep');
  row(depTable, 'Linjebredde', 'løs grunn: bredere', [null, numInput('depWidth', 0.01, 0.01, 3), null]);
  row(depTable, 'Myke kanter', 'S-kurve', [null, numInput('depSoft', 0.05, 0, 3), null]);
  row(depTable, 'Retning', 'grunt på tvers av helningen', [null, numInput('depAlign', 0.05, 0, 1), null]);
  row(depTable, 'Strekking', 'langs helningen', [null, numInput('depStretch', 0.5, 1, 20), null], 'depStretch');
  row(depTable, 'Høyden teller', 'i dalprofilen, 0–1', [null, numInput('vH', 0.05, 0, 1), null]);
  row(depTable, 'Mot havnivå', 'i lavland: fjorder', [null, numInput('depLow', 0.05, 0, 3), null]);
  row(depTable, 'Ekstra i sletter', 'mot havnivå', [null, numInput('depPlain', 0.05, 0, 3), null]);
  const rivTable = document.getElementById('rivers');
  for (const t of ['', '', '', 'verdi', '']) {
    const d = document.createElement('div');
    d.className = 'col-head';
    d.textContent = t;
    rivTable.appendChild(d);
  }
  row(rivTable, 'Elver', 'langs nedsenkene', [null, null, null], 'river');
  row(rivTable, 'Bredde', 'm, ved havet i løs grunn', [null, numInput('riverWidth', 500, 50, 250000, null, 'h'), null]);
  row(rivTable, 'Minste bredde', 'm, synlig helt opp', [null, numInput('riverMin', 100, 0, 50000, null, 'h'), null]);
  row(rivTable, 'Dybde, fast mot løs', 'dypere er smalere', [null, numInput('riverDeep', 0.5, 1, 20), null]);
  row(rivTable, 'Dypt nok nedsenk', 'terskel 0–1', [null, numInput('riverAlign', 0.05, 0, 1), null]);
  row(rivTable, 'Område rundt', 'km, formes av elva', [null, numInput('riverZone', 0.5, 0, 50, null, 'h'), null]);
  row(rivTable, 'Per seksjon', 'når utsnittet er under, m', [null, numInput('secZoom', 500, 200, 100000, () => render()), null], 'sections');
  row(rivTable, 'Koble ender', 'm, rette kjeder 2 ×', [null, numInput('riverGap', 1000, 0, 500000, null, 'h'), null]);
  row(rivTable, 'Følg nedover', 'm, opptil', [null, numInput('riverWalk', 1000, 0, 500000, null, 'h'), null]);
  row(rivTable, 'Bøyd kjede', 'blir innsjø, rettethet under', [null, numInput('riverBend', 0.05, 0, 1), null]);
  row(rivTable, 'Slyng i koblinger', '0–2', [null, numInput('riverMeander', 0.1, 0, 2), null]);
  row(rivTable, 'Flere løp', 'nær havet', [null, numInput('riverBraid', 0.05, 0, 1), null]);
  row(rivTable, 'Høyde beholdt', 'lavere elver: mindre', [null, numInput('riverRise', 0.05, 0, 1), null]);
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
  for (const id of ['scaleH', 'scaleV']) {
    const el = document.getElementById(id);
    el.value = state[id];
    el.addEventListener('change', () => {
      const v = Math.round(+el.value);
      if (!(v >= 1)) return (el.value = state[id]);
      state[id] = v;
      for (const f of unitInputs) f();
      rebuild();
    });
  }
  for (const [id, key] of [['contours', 'contours'], ['lineDivide', 'lineDivide'], ['lineDep', 'lineDep'], ['showNodes', 'showNodes']]) {
    const el = document.getElementById(id);
    el.checked = state[key];
    el.addEventListener('change', () => {
      state[key] = el.checked;
      document.getElementById('nodeLegend').hidden = !state.showNodes;
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
    let col = c === 0 ? SEA : c === 4 ? RIVER : landColour(hover.h), name = hover.tint > 0 ? 'bekk' : CLASS_NAMES[c];
    if (r && on.type && !state.mono && c !== 4) {
      const top = r.w.indexOf(Math.max(...r.w));
      col = M.RegionLayer.TYPES[top].colour;
      name = `${M.RegionLayer.TYPES[top].name} · ${name}`;
    }
    box.innerHTML = `<span class="swatch" style="background:rgb(${col.map((v) => v | 0).join(',')})"></span>${name}<span class="h">${Math.round(hover.h / state.scaleV).toLocaleString('nb-NO')} m</span>`;
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
    view.mpp = Math.max(1, Math.min(20000, view.mpp * f));
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
    const d = span / n, cls = new Uint8Array(n * n), share = [0, 0, 0, 0, 0];
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

  M.grunn = { state, view, rebuild, render, stats, full, get sections() { return sections; }, get layer() { return layer; }, get river() { return river; } };
  rebuild();
})(window.Markr = window.Markr || {});
