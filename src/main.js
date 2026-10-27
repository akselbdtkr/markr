// UI wiring: controls, endless pan/zoom, generation of sections on demand, hover
// info, split/merge on click and the overview map.
(function (M) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('map');
  const renderer = new M.Renderer(canvas);
  const C = M.CELL_SIZE, S = M.SECTION;

  const state = { b0: M.BOUNDS[0], b1: M.BOUNDS[1], b2: M.BOUNDS[2], b3: M.BOUNDS[3], lscale: 1, region: -1, seed: 1848, strength: 2.5, warp: 0.35, contour: 100, buffer: 6, sources: 2, autoSplit: 28, overview: 15000 };
  let terrain, world;
  const edits = new Map(); // the player's split/merge edits; the only state worth saving

  const km = (m) => (m / 1000).toLocaleString('nb-NO', { maximumFractionDigits: 1 });
  const splitSide = () => (state.autoSplit >= 8 ? state.autoSplit : 0);

  // Picks a start point where a small area holds a bit of everything: as many
  // landscape types as possible, and some sea. Returns metres.
  function findStart(t) {
    const span = 2000 * t.scale, step = 3000 * t.scale;
    let best = [0, 0], bestScore = -Infinity;
    for (let gy = -10; gy <= 10; gy++) {
      for (let gx = -10; gx <= 10; gx++) {
        const x = gx * step, y = gy * step;
        const types = new Set();
        let water = 0;
        for (let k = 0; k < 36; k++) {
          const px = x + ((k % 6) / 5 - 0.5) * span, py = y + (Math.floor(k / 6) / 5 - 0.5) * span * 0.7;
          types.add(Math.round(t.layers(px, py).tau * 4));
          if (t.elevation(px, py, 50) < 0) water++;
        }
        const score = types.size * 100 + (water >= 4 && water <= 16 ? 80 : 0) - Math.hypot(gx, gy);
        if (score > bestScore) {
          bestScore = score;
          best = [x, y];
        }
      }
    }
    return best;
  }

  // New world with the current settings. Keeps cached elevations when the seed is unchanged.
  function makeWorld() {
    const bounds = [state.b0, state.b1, state.b2, state.b3];
    const same = terrain && terrain.seed === state.seed && terrain.bounds.join() === bounds.join() && terrain.scale === state.lscale && terrain.region === state.region;
    const keep = world && same ? world.elev : undefined;
    if (!same) {
      terrain = new M.Terrain(state.seed, { bounds, scale: state.lscale, region: state.region });
      showShares();
    }
    world = new M.World(terrain, {
      strength: state.strength,
      warp: state.warp,
      buffer: state.buffer,
      contour: state.contour,
      sources: state.sources,
      autoSplit: splitSide(),
      edits,
      elevCache: keep,
    });
    renderer.hover = null;
    lastBuild = [];
  }

  // Share of each landscape type with the current transitions.
  const SHARE_COLOURS = ['#4677aa', '#9fbf70', '#6a9450', '#b89a62', '#8f8a94'];
  function showShares() {
    const shares = terrain.landscapeShares();
    $('shares').innerHTML = shares
      .map((v, k) => `<span style="flex:${v};background:${SHARE_COLOURS[k]}" title="${M.LANDSCAPES[k].name} ${Math.round(v * 100)} %">${v > 0.08 ? `${M.LANDSCAPES[k].name} ${Math.round(v * 100)}%` : ''}</span>`)
      .join('');
  }

  // --- generation loop --------------------------------------------------------
  // Missing sections are generated nearest-first, a few per frame, so the view
  // stays responsive when the player jumps somewhere new.
  let lastBuild = [];
  let pumping = false;
  function pump() {
    if (pumping) return;
    pumping = true;
    requestAnimationFrame(function step() {
      const t0 = performance.now();
      let missing = 0;
      for (const [sx, sy] of renderer.visibleSections()) {
        if (world.loaded(sx, sy)) continue;
        if (performance.now() - t0 > 40) {
          missing++;
          continue;
        }
        const s = world.section(sx, sy);
        lastBuild.push(s.buildTime);
        if (lastBuild.length > 30) lastBuild.shift();
      }
      renderer.draw(world);
      updateStatus(missing);
      if (missing) requestAnimationFrame(step);
      else pumping = false;
    });
  }

  let drawPending = false;
  function draw() {
    pump();
    if (drawPending || pumping) return;
    drawPending = true;
    requestAnimationFrame(() => {
      drawPending = false;
      renderer.draw(world);
    });
  }

  function updateStatus(missing) {
    const vis = renderer.visibleSections().map(([sx, sy]) => world.loaded(sx, sy)).filter(Boolean);
    const nonConvex = vis.reduce((n, s) => n + s.nonConvex, 0);
    const outside = vis.reduce((n, s) => n + s.outside, 0);
    const avg = lastBuild.length ? Math.round(lastBuild.reduce((a, b) => a + b, 0) / lastBuild.length) : 0;
    const [cx, cy] = renderer.centre;
    $('status').textContent =
      `Midt i bildet: x ${km(cx * C)} km, y ${km(cy * C)} km. ` +
      `${vis.length} seksjoner synlige${missing ? `, ${missing} genereres` : ''}, ${world.sections.size} i minnet. ` +
      `Snitt ${avg} ms per seksjon. Ikke-konvekse ruter i bildet: ${nonConvex}. ` +
      `Punkter utenfor egen seksjon: ${outside}. Versjon ${M.VERSION}.`;
    drawOverview();
  }

  // --- overview -------------------------------------------------------------
  const overview = $('overview');
  let overviewInfo = null, overviewKey = '';
  function drawOverview(force) {
    const [cx, cy] = renderer.centre;
    // Re-render the terrain only when the view has moved noticeably.
    const k = `${state.seed}|${terrain.bounds.join()}|${terrain.scale}|${terrain.region}|${state.overview}|${Math.round((cx * C) / (state.overview / 40))}|${Math.round((cy * C) / (state.overview / 40))}`;
    const [x0, y0] = renderer.toWorld(0, 0), [x1, y1] = renderer.toWorld(renderer.cssW, renderer.cssH);
    if (k !== overviewKey || force) {
      overviewKey = k;
      overviewInfo = M.drawOverview(overview, terrain, cx * C, cy * C, state.overview, 'terrain', [x0 * C, y0 * C, x1 * C, y1 * C]);
      overviewInfo.cx = cx * C;
      overviewInfo.cy = cy * C;
    }
  }
  overview.addEventListener('click', (e) => {
    const r = overview.getBoundingClientRect();
    const { W, H, mpp, cx, cy } = overviewInfo;
    const x = cx + (e.clientX - r.left - W / 2) * mpp, y = cy + (e.clientY - r.top - H / 2) * mpp;
    renderer.centreOn(x / C, y / C);
    draw();
  });
  const extentSel = $('extent');
  extentSel.value = state.overview;
  extentSel.addEventListener('change', () => {
    state.overview = parseFloat(extentSel.value);
    drawOverview(true);
  });
  const move = (fx, fy) => {
    renderer.view.ox -= fx * renderer.cssW;
    renderer.view.oy -= fy * renderer.cssH;
    draw();
  };
  $('go-n').addEventListener('click', () => move(0, -0.5));
  $('go-s').addEventListener('click', () => move(0, 0.5));
  $('go-w').addEventListener('click', () => move(-0.5, 0));
  $('go-e').addEventListener('click', () => move(0.5, 0));

  // --- controls -----------------------------------------------------------
  const modeSel = $('mode');
  for (const [k, m] of Object.entries(M.MODES)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = m.label;
    modeSel.appendChild(o);
  }
  modeSel.addEventListener('change', () => {
    renderer.mode = modeSel.value;
    updateLegend();
    draw();
  });

  function updateLegend() {
    const m = M.MODES[renderer.mode];
    const el = $('legend');
    if (!m.ramp) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const stops = m.ramp.map((c, k) => `${M.colors.rgb(c)} ${(k / (m.ramp.length - 1)) * 100}%`);
    el.querySelector('.bar').style.background = `linear-gradient(to right, ${stops.join(',')})`;
    const [lo, hi] = m.legend || ['lav', 'høy'];
    el.querySelector('.lo').textContent = lo;
    el.querySelector('.hi').textContent = hi;
  }

  function bindRange(id, k, fmt, onInput) {
    const input = $(id);
    const out = $(id + '-out');
    input.value = state[k];
    out.textContent = fmt(state[k]);
    input.addEventListener('input', () => {
      state[k] = parseFloat(input.value);
      out.textContent = fmt(state[k]);
      onInput();
    });
  }

  let rebuildTimer = null;
  const rebuildSoon = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      makeWorld();
      draw();
    }, 150);
  };

  bindRange('strength', 'strength', (v) => v.toFixed(1), rebuildSoon);
  bindRange('warp', 'warp', (v) => v.toFixed(2), rebuildSoon);
  bindRange('contour', 'contour', (v) => (v ? `hver ${v} m` : 'bare kysten'), rebuildSoon);
  bindRange('buffer', 'buffer', (v) => `${v} ruter`, rebuildSoon);
  for (let k = 0; k < 4; k++) bindRange('b' + k, 'b' + k, (v) => v.toFixed(2), rebuildSoon);
  const regionSel = $('region');
  M.REGIONS.forEach((r, k) => {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = `Bare ${r.name}`;
    regionSel.appendChild(o);
  });
  regionSel.addEventListener('change', () => {
    state.region = parseInt(regionSel.value, 10);
    rebuildSoon();
  });
  bindRange('lscale', 'lscale', (v) => `× ${v.toFixed(2)}`, rebuildSoon);
  bindRange('sources', 'sources', (v) => `${v}`, rebuildSoon);
  bindRange('autosplit', 'autoSplit', (v) => (v >= 8 ? `side > ${v} m` : 'av'), () => {
    world.autoSplit = splitSide();
    for (const s of world.sections.values()) s.autoSplit(world.autoSplit);
    renderer.hover = null;
    draw();
  });

  const morph = $('morph');
  morph.addEventListener('input', () => {
    renderer.morph = parseFloat(morph.value);
    $('morph-out').textContent = renderer.morph === 0 ? 'indeks' : renderer.morph === 1 ? 'verden' : renderer.morph.toFixed(2);
    draw();
  });

  const seedInput = $('seed');
  seedInput.value = state.seed;
  const newSeed = (seed) => {
    state.seed = seed;
    seedInput.value = seed;
    edits.clear();
    makeWorld();
    const [x, y] = findStart(terrain);
    renderer.centreOn(x / C, y / C);
    overviewKey = '';
    drawOverview(true);
    draw();
  };
  seedInput.addEventListener('change', () => newSeed(parseInt(seedInput.value, 10) || 0));
  $('reseed').addEventListener('click', () => newSeed(Math.floor(Math.random() * 100000)));

  for (const [id, prop] of [['lines', 'showLines'], ['labels', 'showLabels'], ['sections', 'showSections'], ['streams', 'showStreams'], ['blend', 'blend'], ['waves', 'waves']]) {
    $(id).checked = renderer[prop];
    $(id).addEventListener('change', (e) => {
      renderer[prop] = e.target.checked;
      draw();
    });
  }

  const zoomBy = (f, sx = renderer.cssW / 2, sy = renderer.cssH / 2) => {
    const v = renderer.view;
    const ns = Math.max(4, Math.min(400, v.scale * f));
    v.ox = sx - ((sx - v.ox) * ns) / v.scale;
    v.oy = sy - ((sy - v.oy) * ns) / v.scale;
    v.scale = ns;
    draw();
  };
  $('zoom-in').addEventListener('click', () => zoomBy(1.4));
  $('zoom-out').addEventListener('click', () => zoomBy(1 / 1.4));
  $('home').addEventListener('click', () => {
    const [x, y] = findStart(terrain);
    renderer.view.scale = 16;
    renderer.centreOn(x / C, y / C);
    draw();
  });

  // --- hover info -----------------------------------------------------------
  const pct = (v) => `${Math.round(v * 100)} %`;
  const compass = ([dx, dy]) => {
    const names = ['Ø', 'SØ', 'S', 'SV', 'V', 'NV', 'N', 'NØ'];
    return 'mot ' + names[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
  };
  const dl = (rows) => '<dl>' + rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('') + '</dl>';

  // The section under the cursor, or else the one in the middle of the view.
  function showSection(sx, sy) {
    const s = world.sectionInfo(sx, sy);
    const m = (x) => Math.round(x).toLocaleString('nb-NO');
    const drain = s.drain ? `${compass([s.drain[0] - sx, s.drain[1] - sy])} til (${s.drain[0]}, ${s.drain[1]})` : s.sea ? 'hav' : 'innsjø (ingen utløp)';
    const regions = s.regions
      .map((w, k) => [w, M.REGIONS[k].name])
      .filter(([w]) => w >= 0.1)
      .sort((p, q) => q[0] - p[0])
      .map(([w, name]) => `${name} ${Math.round(w * 100)} %`)
      .join(', ');
    $('section-info').innerHTML = dl([
      ['Seksjon', `(${sx}, ${sy})`],
      ['Område', regions],
      ['Landskap', `${M.landscapeName(s.landscape)} (${s.landscape.toFixed(2)})`],
      ['Høyde midt', s.sea ? `${m(-s.height)} m dyp` : `${m(s.height)} moh.`],
      ['Til hav', s.sea ? 'er hav' : Number.isFinite(s.seaDist) ? `${km(s.seaDist * S * C)} km` : 'ikke innen rekkevidde'],
      ['Drenerer', drain],
      ['Nedbørfelt', `${s.catchment} kilder (${s.upstream} inn, ${s.sources} egne)`],
    ]);
  }

  function showInfo(c) {
    const el = $('info');
    if (!c) {
      el.innerHTML = '<p class="muted">Hold over en rute for å se verdiene.</p>';
      const [cx, cy] = renderer.centre;
      showSection(Math.floor(cx / S), Math.floor(cy / S));
      return;
    }
    showSection(c.section.sx, c.section.sy);
    const v = c.values;
    const path = [];
    for (let p = c; p; p = p.parent) path.unshift(`(${p.i}, ${p.j})`);
    const m = (x) => Math.round(x).toLocaleString('nb-NO');
    const rows = [
      ['Indeks', path.join(' → ')],
      ['Nivå', `${c.level} (${c.nominalSize} m${c.level === 0 ? ', grunnrute' : ''})`],
      ['Areal', `${m(v.area)} m² (≈ ${v.side.toFixed(1)} m)`],
      [v.water ? 'Dybde' : 'Høyde', v.water ? `${m(-v.elevation)} m` : `${m(v.elevation)} moh.`],
      ['Fuktighet', pct(v.moisture)],
      ['Ulendthet', pct(v.ruggedness)],
      ['Helning', pct(v.steepness)],
      ['Rotasjon', `${Math.round(v.rotation)}°`],
      ['Landskap', `${M.landscapeName(v.landscape)} (${v.landscape.toFixed(2)})`],
      ['Vassdrag', v.streams ? `størrelse ${v.streams.toFixed(1)}, ${compass(v.streamDir)}, skala ${v.streamScale}${v.carved > 0.5 ? `, skåret ${Math.round(v.carved)} m ned` : ''}` : '–'],
      ['Jordbruk', pct(v.farmland)],
      ['Byggegrunn', pct(v.building)],
      ['Ressurser', pct(v.resource)],
    ];
    el.innerHTML = dl(rows);
  }

  // --- pointer: pan, hover, click ------------------------------------------
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, ox: renderer.view.ox, oy: renderer.view.oy, moved: false, button: e.button };
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        renderer.view.ox = drag.ox + dx;
        renderer.view.oy = drag.oy + dy;
        draw();
        return;
      }
    }
    const [x, y] = renderer.toWorld(e.clientX - r.left, e.clientY - r.top);
    const c = world.leafAt(x, y, renderer.morph);
    if (c !== renderer.hover) {
      renderer.hover = c;
      showInfo(c);
      if (!pumping) renderer.compose(world);
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) {
      const r = canvas.getBoundingClientRect();
      const [x, y] = renderer.toWorld(e.clientX - r.left, e.clientY - r.top);
      const c = world.leafAt(x, y, renderer.morph);
      const merge = drag.button === 2 || document.querySelector('input[name=click]:checked').value === 'merge';
      if (c) {
        if (merge) {
          if (c.parent) {
            c.parent.merge();
            world.recordEdit(c.parent, 'merge');
          }
          renderer.hover = c.parent || c;
        } else {
          const kids = c.split();
          if (kids) {
            world.recordEdit(c, 'split');
            renderer.hover = kids[0];
          }
        }
        showInfo(renderer.hover);
        draw();
      }
    }
    drag = null;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerleave', () => {
    renderer.hover = null;
    showInfo(null);
    if (!pumping) renderer.compose(world);
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false }
  );

  window.addEventListener('resize', () => {
    renderer.resize();
    drawOverview(true);
    draw();
  });

  // Waves: redraw about 15 times a second while there is coast in view and the
  // page is visible. Skipped while sections are still being generated.
  function waveTick() {
    if (renderer.waves && renderer.hasShore && !pumping && !document.hidden && world.sections.size) {
      renderer.compose(world);
    }
    setTimeout(() => requestAnimationFrame(waveTick), 66);
  }

  renderer.resize();
  updateLegend();
  newSeed(state.seed);
  showInfo(null);
  waveTick();

  M.app = { get world() { return world; }, renderer, state, edits };
})(window.Markr = window.Markr || {});
