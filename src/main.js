// UI wiring: controls, pan/zoom, hover info, split/merge on click.
(function (M) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('map');
  const renderer = new M.Renderer(canvas);

  const state = { seed: 1848, cols: 64, strength: 2.5, warp: 0.35, autoSplit: 0 };
  let terrain, grid;

  function rebuild() {
    const t0 = performance.now();
    terrain = new M.Terrain(state.seed);
    const rows = Math.round((state.cols * 44) / 64);
    grid = new M.Grid(terrain, { cols: state.cols, rows, strength: state.strength, warp: state.warp });
    grid.autoSplit(state.autoSplit);
    renderer.hover = null;
    $('status').textContent = `${grid.cols} × ${grid.rows} ruter · bygget på ${Math.round(performance.now() - t0)} ms`;
    draw();
  }

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
  bindRange('autosplit', 'autoSplit', (v) => (v ? `> ${v.toFixed(1)}` : 'av'), () => {
    grid.autoSplit(state.autoSplit);
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
  });
  $('reseed').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 100000);
    seedInput.value = state.seed;
    rebuild();
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
    const rows = [
      ['Indeks', path.join(' → ')],
      ['Nivå', c.level === 0 ? '0 (grunnrute)' : `${c.level} (underrute)`],
      ['Areal', `${v.area.toFixed(2)} × nominell`],
      ['Høyde', v.elevation.toFixed(3)],
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
          renderer.hover = c.split()[0];
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
