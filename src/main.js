// UI wiring: controls, pan/zoom, hover info, split/merge on click, overview map.
(function (M) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('map');
  const renderer = new M.Renderer(canvas);

  const C = M.CELL_SIZE;
  const state = { seed: 1848, cols: 64, strength: 2.5, warp: 0.35, autoSplit: 28, overview: 15000 };
  let terrain, grid;
  // Centre of the grid window in world metres.
  let centre = null;

  const km = (m) => (m / 1000).toLocaleString('nb-NO', { maximumFractionDigits: 1 });
  const rowsFor = (cols) => Math.round((cols * 44) / 64);
  const splitSide = () => (state.autoSplit >= 8 ? state.autoSplit : 0);

  // Picks a start point with both water and varied land inside the window.
  function findStart(t) {
    const span = state.cols * C;
    let best = [0, 0], bestScore = -Infinity;
    for (let gy = -12; gy <= 12; gy++) {
      for (let gx = -12; gx <= 12; gx++) {
        const x = gx * 4000, y = gy * 4000;
        let water = 0, lo = Infinity, hi = -Infinity;
        for (let k = 0; k < 25; k++) {
          const h = t.elevation(x + ((k % 5) / 4 - 0.5) * span, y + (Math.floor(k / 5) / 4 - 0.5) * span * 0.7, 50);
          if (h < 0) water++;
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        const score = (water > 3 && water < 12 ? 400 : 0) + Math.min(hi - lo, 300) - Math.abs(hi - 200) * 0.2;
        if (score > bestScore) {
          bestScore = score;
          best = [x, y];
        }
      }
    }
    return best;
  }

  function rebuild() {
    const t0 = performance.now();
    if (!terrain || terrain.seed !== state.seed) {
      terrain = new M.Terrain(state.seed);
      centre = findStart(terrain);
    }
    const rows = rowsFor(state.cols);
    const i0 = Math.round(centre[0] / C - state.cols / 2);
    const j0 = Math.round(centre[1] / C - rows / 2);
    grid = new M.Grid(terrain, { cols: state.cols, rows, i0, j0, strength: state.strength, warp: state.warp });
    grid.autoSplit(splitSide());
    renderer.hover = null;
    const leaves = [...grid.leaves()].length;
    $('status').textContent =
      `${grid.cols} × ${grid.rows} grunnruter (${leaves} med underruter), ` +
      `${km(grid.cols * C)} × ${km(grid.rows * C)} km ved x ${km(centre[0])} km, y ${km(centre[1])} km. ` +
      `Bygget på ${Math.round(performance.now() - t0)} ms.`;
    drawOverview();
    draw();
  }

  // --- overview -------------------------------------------------------------
  const overview = $('overview');
  let overviewInfo = null;
  function drawOverview() {
    const rect = [grid.i0 * C, grid.j0 * C, (grid.i0 + grid.cols) * C, (grid.j0 + grid.rows) * C];
    overviewInfo = M.drawOverview(overview, terrain, centre[0], centre[1], state.overview, 'terrain', rect);
  }
  overview.addEventListener('click', (e) => {
    const r = overview.getBoundingClientRect();
    const { W, H, mpp } = overviewInfo;
    centre = [centre[0] + (e.clientX - r.left - W / 2) * mpp, centre[1] + (e.clientY - r.top - H / 2) * mpp];
    rebuild();
    renderer.fit(grid);
    draw();
  });
  const extentSel = $('extent');
  extentSel.value = state.overview;
  extentSel.addEventListener('change', () => {
    state.overview = parseFloat(extentSel.value);
    drawOverview();
  });
  const move = (fx, fy) => {
    centre = [centre[0] + fx * grid.cols * C, centre[1] + fy * grid.rows * C];
    rebuild();
    renderer.fit(grid);
    draw();
  };
  $('go-n').addEventListener('click', () => move(0, -0.5));
  $('go-s').addEventListener('click', () => move(0, 0.5));
  $('go-w').addEventListener('click', () => move(-0.5, 0));
  $('go-e').addEventListener('click', () => move(0.5, 0));

  let pending = false;
  function draw() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      renderer.draw(grid);
    });
  }

  // --- controls -----------------------------------------------------------
  const modeSel = $('mode');
  for (const [key, m] of Object.entries(M.MODES)) {
    const o = document.createElement('option');
    o.value = key;
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

  function bindRange(id, key, fmt, onInput) {
    const input = $(id);
    const out = $(id + '-out');
    input.value = state[key];
    out.textContent = fmt(state[key]);
    input.addEventListener('input', () => {
      state[key] = parseFloat(input.value);
      out.textContent = fmt(state[key]);
      onInput();
    });
  }

  let rebuildTimer = null;
  const rebuildSoon = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuild();
      renderer.fit(grid);
      draw();
    }, 120);
  };

  bindRange('cols', 'cols', (v) => `${v}`, rebuildSoon);
  bindRange('strength', 'strength', (v) => v.toFixed(1), rebuildSoon);
  bindRange('warp', 'warp', (v) => v.toFixed(2), rebuildSoon);
  bindRange('autosplit', 'autoSplit', (v) => (v >= 8 ? `side > ${v} m` : 'av'), () => {
    grid.autoSplit(splitSide());
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
  seedInput.addEventListener('change', () => {
    state.seed = parseInt(seedInput.value, 10) || 0;
    rebuild();
    renderer.fit(grid);
  });
  $('reseed').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 100000);
    seedInput.value = state.seed;
    rebuild();
    renderer.fit(grid);
    draw();
  });

  $('lines').addEventListener('change', (e) => {
    renderer.showLines = e.target.checked;
    draw();
  });
  $('labels').addEventListener('change', (e) => {
    renderer.showLabels = e.target.checked;
    draw();
  });
  $('fit').addEventListener('click', () => {
    renderer.fit(grid);
    draw();
  });
  const zoomBy = (f, sx = renderer.cssW / 2, sy = renderer.cssH / 2) => {
    const v = renderer.view;
    const ns = Math.max(3, Math.min(400, v.scale * f));
    v.ox = sx - ((sx - v.ox) * ns) / v.scale;
    v.oy = sy - ((sy - v.oy) * ns) / v.scale;
    v.scale = ns;
    draw();
  };
  $('zoom-in').addEventListener('click', () => zoomBy(1.4));
  $('zoom-out').addEventListener('click', () => zoomBy(1 / 1.4));

  // --- hover info -----------------------------------------------------------
  const pct = (v) => `${Math.round(v * 100)} %`;
  function showInfo(c) {
    const el = $('info');
    if (!c) {
      el.innerHTML = '<p class="muted">Hold over en rute for å se verdiene.</p>';
      return;
    }
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
      ['Jordbruk', pct(v.farmland)],
      ['Byggegrunn', pct(v.building)],
      ['Ressurser', pct(v.resource)],
    ];
    el.innerHTML = '<dl>' + rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('') + '</dl>';
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
    const c = grid.leafAt(x, y, renderer.morph);
    if (c !== renderer.hover) {
      renderer.hover = c;
      showInfo(c);
      draw();
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) {
      const r = canvas.getBoundingClientRect();
      const [x, y] = renderer.toWorld(e.clientX - r.left, e.clientY - r.top);
      const c = grid.leafAt(x, y, renderer.morph);
      const merge = drag.button === 2 || document.querySelector('input[name=click]:checked').value === 'merge';
      if (c) {
        if (merge) {
          if (c.parent) c.parent.merge();
          renderer.hover = c.parent || c;
        } else {
          const kids = c.split();
          if (kids) renderer.hover = kids[0];
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
    draw();
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
    drawOverview();
    draw();
  });

  renderer.resize();
  rebuild();
  renderer.fit(grid);
  updateLegend();
  showInfo(null);
  draw();

  M.app = { get grid() { return grid; }, renderer, state, rebuild };
})(window.Markr = window.Markr || {});
