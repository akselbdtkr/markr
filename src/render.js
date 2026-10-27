// Draws the grid on a canvas.
(function (M) {
  'use strict';

  const { clamp01 } = M.util;

  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

  function ramp(stops, t) {
    t = clamp01(t);
    const n = stops.length - 1;
    const k = Math.min(n - 1, Math.floor(t * n));
    return mix(stops[k], stops[k + 1], t * n - k);
  }

  const RAMPS = {
    moisture: [[214, 190, 140], [150, 180, 110], [60, 140, 120], [30, 80, 140]],
    heat: [[250, 245, 225], [240, 190, 90], [200, 80, 50], [90, 30, 60]],
    green: [[245, 240, 225], [180, 205, 130], [70, 130, 60], [25, 70, 35]],
    amber: [[245, 240, 225], [235, 200, 140], [200, 110, 60], [120, 50, 40]],
    stone: [[245, 240, 225], [190, 190, 200], [110, 110, 140], [50, 50, 80]],
    sea: [[132, 186, 214], [62, 122, 170], [22, 58, 108], [10, 26, 60]],
    land: [[70, 130, 70], [150, 170, 100], [175, 150, 110], [130, 112, 100], [245, 245, 240]],
  };

  const WATER_SHALLOW = [132, 186, 214];
  // Streams and fully wet land take the colour of shallow water, so a river or
  // delta meets the sea without a seam.
  const STREAM = ramp(RAMPS.sea, Math.log1p(2) / Math.log1p(5000));
  // Light crest of the waves that pulse in along the coast.
  const FOAM = [214, 232, 240];
  // White water where a stream falls steeply.
  const WHITEWATER = [236, 244, 248];
  // Drawing switches the colour functions read.
  const SHOW = { streams: true };
  const LANDSCAPE = [[70, 120, 170], [170, 200, 120], [110, 150, 80], [190, 165, 110], [150, 145, 150]];

  // Depth below 0 m mapped to [0, 1] on a log scale, so shallow water still varies.
  const depthT = (h) => clamp01(Math.log1p(-h) / Math.log1p(5000));
  // Height above 0 m mapped to [0, 1] with a square root, so lowland still varies.
  const heightT = (h) => clamp01(Math.sqrt(h / 5000));

  function shade(c, v, exaggeration = 1.5) {
    const nx = -v.gx * exaggeration, ny = -v.gy * exaggeration, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    // Lambert shading, light from the north-west.
    const l = (nx * -0.6 + ny * -0.6 + nz * 0.53) / len;
    const f = 0.62 + 0.45 * l;
    return [c[0] * f, c[1] * f, c[2] * f];
  }

  // Natural-looking colour. Water is blue by depth. Land is green by moisture up to
  // the tree line at 1000 m, bare heath and rock above it, snow on the high peaks.
  function terrainColor(v) {
    const h = v.elevation;
    if (v.water || h < 0) return ramp(RAMPS.sea, depthT(Math.min(h, -0.5)));
    const dry = [184, 182, 112], lush = [86, 132, 66], marsh = [80, 128, 120];
    const heath = [150, 138, 106], rock = [138, 130, 120], snow = [240, 240, 236];
    // Moisture: dry, then green, then bluer; at 100 % the cell is fully blue.
    let c = mix(dry, lush, clamp01((v.moisture - 0.15) / 0.55));
    c = mix(c, marsh, M.util.smoothstep(0.7, 0.92, v.moisture));
    c = mix(c, heath, M.util.smoothstep(850, 1000, h));
    c = mix(c, rock, M.util.smoothstep(1100, 1700, h));
    c = mix(c, snow, M.util.smoothstep(1900, 2300, h));
    if (h < 1.5) c = mix(c, WATER_SHALLOW, 0.35); // wet shoreline
    c = shade(c, v);
    if (v.moisture > 0.92) c = mix(c, STREAM, (v.moisture - 0.92) / 0.08);
    return c;
  }

  function elevationColor(v) {
    return v.elevation < 0 ? ramp(RAMPS.sea, depthT(v.elevation)) : ramp(RAMPS.land, heightT(v.elevation));
  }

  const MODES = {
    terrain: { label: 'Terreng', color: terrainColor },
    region: {
      label: 'Landskapsområde',
      color: (v) => {
        const w = v.regions || [1, 0, 0, 0, 0];
        const c = [0, 0, 0];
        M.REGIONS.forEach((r, k) => {
          for (let q = 0; q < 3; q++) c[q] += w[k] * r.colour[q];
        });
        return v.water ? mix(c, [40, 70, 120], 0.55) : c;
      },
    },
    landscape: {
      label: 'Landskap',
      color: (v) => ramp(LANDSCAPE, v.landscape),
      ramp: LANDSCAPE,
      legend: ['marin · slette · åser · platå · alpin', ''],
    },
    streams: {
      label: 'Vassdrag',
      color: (v) => (v.water ? ramp(RAMPS.sea, 0.3) : ramp(RAMPS.stone, Math.min(1, Math.log2(1 + v.streams) / 6))),
      ramp: RAMPS.stone,
      legend: ['ingen', 'store'],
    },
    elevation: {
      label: 'Høyde',
      color: elevationColor,
      ramp: [...RAMPS.sea].reverse().concat(RAMPS.land),
      legend: ['−5000 m', '5000 m'],
    },
    moisture: { label: 'Fuktighet', color: (v) => ramp(RAMPS.moisture, v.moisture), ramp: RAMPS.moisture },
    ruggedness: { label: 'Ulendthet', color: (v) => ramp(RAMPS.heat, v.ruggedness), ramp: RAMPS.heat },
    slope: { label: 'Helning', color: (v) => ramp(RAMPS.heat, v.steepness), ramp: RAMPS.heat, legend: ['flatt', '≥ 27°'] },
    size: {
      label: 'Rutestørrelse',
      // log scale over the side length: 64 m down to 1 m
      color: (v) => ramp(RAMPS.stone, 1 - Math.log2(v.side) / 6),
      ramp: RAMPS.stone,
      legend: ['64 m', '1 m'],
    },
    farmland: { label: 'Jordbruksverdi', color: (v) => ramp(RAMPS.green, v.farmland), ramp: RAMPS.green },
    building: { label: 'Byggegrunn', color: (v) => ramp(RAMPS.amber, v.building), ramp: RAMPS.amber },
    resource: { label: 'Ressurser', color: (v) => ramp(RAMPS.stone, v.resource), ramp: RAMPS.stone },
  };

  // Overview of the terrain around the grid window, drawn straight from the
  // continuous fields (no cells). extent is the width shown, in metres.
  function drawOverview(canvas, terrain, cx, cy, extent, mode, viewRect) {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
    const res = 2; // CSS pixels per sample
    const nx = Math.ceil(W / res), ny = Math.ceil(H / res);
    const mpp = extent / W; // metres per CSS pixel
    const off = document.createElement('canvas');
    off.width = nx;
    off.height = ny;
    const octx = off.getContext('2d');
    const img = octx.createImageData(nx, ny);
    const color = MODES[mode] && mode !== 'size' ? MODES[mode].color : terrainColor;
    const step = mpp * res;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const wx = cx + (x * res - W / 2) * mpp, wy = cy + (y * res - H / 2) * mpp;
        const s = terrain.sample(wx, wy, step / 2, step * 2);
        s.steepness = clamp01(s.slope / 0.5);
        s.area = 256; s.side = 16; s.farmland = 0; s.building = 0; s.resource = 0; s.streams = 0;
        s.regions = terrain.regionParams(wx, wy).weights;
        s.moisture = Math.min(s.moisture, 0.9);
        const c = color(s);
        const k = (y * nx + x) * 4;
        img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, nx * res, ny * res);
    // The part shown in the main view
    const [x0, y0, x1, y1] = viewRect.map((v, k) => (k % 2 === 0 ? (v - cx) / mpp + W / 2 : (v - cy) / mpp + H / 2));
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    if (x1 - x0 > 6) {
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    } else {
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      ctx.beginPath();
      ctx.moveTo(mx - 8, my); ctx.lineTo(mx - 3, my); ctx.moveTo(mx + 3, my); ctx.lineTo(mx + 8, my);
      ctx.moveTo(mx, my - 8); ctx.lineTo(mx, my - 3); ctx.moveTo(mx, my + 3); ctx.lineTo(mx, my + 8);
      ctx.stroke();
    }
    return { W, H, mpp };
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.view = { scale: 16, ox: 0, oy: 0 }; // pixels per index unit, offset
      this.mode = 'terrain';
      this.morph = 1;
      this.showLines = true;
      this.showLabels = true;
      this.showSections = false;
      this.blend = true;
      this.waves = !window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.hasShore = false;
      this.hover = null;
    }

    get showStreams() {
      return SHOW.streams;
    }

    set showStreams(v) {
      SHOW.streams = v;
    }

    toScreen(x, y) {
      return [x * this.view.scale + this.view.ox, y * this.view.scale + this.view.oy];
    }

    toWorld(sx, sy) {
      return [(sx - this.view.ox) / this.view.scale, (sy - this.view.oy) / this.view.scale];
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
      this.dpr = dpr;
      this.cssW = r.width;
      this.cssH = r.height;
    }

    // Centre of the view, in index units.
    get centre() {
      return this.toWorld(this.cssW / 2, this.cssH / 2);
    }

    centreOn(x, y) {
      this.view.ox = this.cssW / 2 - x * this.view.scale;
      this.view.oy = this.cssH / 2 - y * this.view.scale;
    }

    // Sections that touch the view, nearest to the centre first.
    visibleSections() {
      const S = M.SECTION;
      const [x0, y0] = this.toWorld(0, 0), [x1, y1] = this.toWorld(this.cssW, this.cssH);
      const [cx, cy] = this.centre;
      const out = [];
      for (let sy = Math.floor((y0 - 1) / S); sy <= Math.floor((y1 + 1) / S); sy++) {
        for (let sx = Math.floor((x0 - 1) / S); sx <= Math.floor((x1 + 1) / S); sx++) {
          out.push([sx, sy, Math.hypot((sx + 0.5) * S - cx, (sy + 0.5) * S - cy)]);
        }
      }
      return out.sort((p, q) => p[2] - q[2]);
    }

    path(corners) {
      const ctx = this.ctx;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const [sx, sy] = this.toScreen(corners[k][0], corners[k][1]);
        if (k === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
    }

    centroid(c, t) {
      const p = c.corners(t);
      return this.toScreen((p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4);
    }

    // Full redraw: the cells, lines and labels go to an offscreen layer, then the
    // light top layer (waves, hover) is composed over it.
    draw(world) {
      if (!this.layer || this.layer.width !== this.canvas.width || this.layer.height !== this.canvas.height) {
        this.layer = document.createElement('canvas');
        this.layer.width = this.canvas.width;
        this.layer.height = this.canvas.height;
      }
      const screen = this.ctx;
      this.ctx = this.layer.getContext('2d');
      try {
        this.drawStatic(world);
      } finally {
        this.ctx = screen;
      }
      this.compose(world);
    }

    // Top layer only: the cached cells, the wave pulse on water near the coast
    // (crests run in toward the shore) and the hover outline. Cheap enough to
    // run many times a second.
    compose(world) {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (this.layer) ctx.drawImage(this.layer, 0, 0);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const t = this.morph;
      if (this.shoreCells && this.shoreCells.length) {
        const time = performance.now() / 1000;
        ctx.fillStyle = rgb(FOAM);
        for (const [c, d] of this.shoreCells) {
          const k = Math.max(0, Math.sin(time * 0.6 + d * 1.1 + (c.base.i + c.base.j) * 0.05));
          const a = 0.2 * k * k * (1 - (d - 1) / SHORE_REACH);
          if (a < 0.01) continue;
          ctx.globalAlpha = a;
          this.path(c.corners(t));
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      if (this.hover && world.loaded(this.hover.section.sx, this.hover.section.sy)) {
        this.path(this.hover.corners(t));
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    drawStatic(world) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--canvas-bg') || '#1d2024';
      ctx.fillRect(0, 0, this.cssW, this.cssH);

      const sections = [];
      for (const [sx, sy] of this.visibleSections()) {
        const s = world.loaded(sx, sy);
        if (s) sections.push(s);
      }
      const color = MODES[this.mode].color;
      const t = this.morph;
      const leaves = [];
      for (const s of sections) for (const c of s.leaves()) leaves.push(c);

      // Colour of every cell, and the water cells near the coast for the waves.
      const waves = this.waves && this.mode === 'terrain' && this.view.scale > 2;
      this.shoreCells = [];
      for (const s of sections) {
        const shore = waves ? shoreDistance(world, s) : null;
        for (const c of s.leaves()) {
          c.drawColor = color(c.values);
          if (shore && c.water) {
            const d = shore[(c.base.j - s.b0) * M.SECTION + (c.base.i - s.a0)];
            if (d) this.shoreCells.push([c, d]);
          }
        }
      }
      this.hasShore = this.shoreCells.length > 0;

      // Where neighbouring cells differ a lot (coast, river, a change of zone),
      // blend: each corner takes the mean colour of the cells around it, and the
      // cell is drawn in small pieces fading from its own colour to its corners'.
      // The blend is drawn in more pieces the closer you zoom, so it stays smooth.
      const scale = this.view.scale;
      const blend = this.blend && scale > 6;
      const vertex = blend ? vertexColours(sections) : null;
      const N = Math.max(2, Math.min(10, Math.ceil(scale / 6)));

      // Streams are drawn into the cells they cross, as a band along their course.
      const streams = SHOW.streams && this.mode === 'terrain';
      const segs = streams ? this.streamSegments(sections, t) : null;
      const textured = streams && scale > 6;

      ctx.lineWidth = 1;
      for (const c of leaves) {
        const q = c.corners(t);
        let own = c.drawColor;
        const near = streams && !c.water ? nearSegments(world, c, segs) : null;
        if (near && !textured) own = mix(own, STREAM, c.values.streamFill);
        let corner = null;
        if (blend && c.level === 0) {
          corner = [vkey(c.i, c.j), vkey(c.i + 1, c.j), vkey(c.i + 1, c.j + 1), vkey(c.i, c.j + 1)].map((k) => {
            const a = vertex.get(k);
            return a ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : own;
          });
          if (!corner.some((k) => Math.abs(k[0] - own[0]) + Math.abs(k[1] - own[1]) + Math.abs(k[2] - own[2]) > BLEND_CONTRAST)) corner = null;
        }
        if (corner || (near && textured)) {
          // Stream cells get pieces of about 3 px, so a thin creek stays continuous.
          const n = near && textured ? Math.max(N, Math.min(12, Math.ceil(scale / 3))) : N;
          this.drawPieces(q, own, corner, textured ? near : null, n);
          continue;
        }
        const col = rgb(own);
        this.path(q);
        ctx.fillStyle = col;
        ctx.strokeStyle = col;
        ctx.fill();
        ctx.stroke();
      }

      if (this.showLines && this.view.scale > 3) {
        const s = this.view.scale;
        for (const c of leaves) {
          this.path(c.corners(t));
          const a = c.level === 0 ? 0.42 : 0.24;
          ctx.strokeStyle = `rgba(20,24,28,${a})`;
          ctx.lineWidth = Math.max(0.4, Math.min(1.2, s / 30)) * (c.level === 0 ? 1 : 0.7);
          ctx.stroke();
        }
      }

      if (this.showSections) this.drawSectionEdges(sections, t);

      if (this.showLabels && this.view.scale > 42) this.drawLabels(sections, t);
    }

    // Screen segments of every stream piece in view, per base cell:
    // [ax, ay, bx, by, halfWidth, vis, foam].
    streamSegments(sections, t) {
      const out = new Map();
      const cellPx = this.view.scale;
      for (const s of sections) {
        for (const c of s.baseCells()) {
          if (!c.pieces) continue;
          const q = c.corners(t), list = [];
          for (const p of c.pieces) {
            let [ax, ay] = this.toScreen(...M.bilinear(q, p.a[0], p.a[1]));
            let [bx, by] = this.toScreen(...M.bilinear(q, p.b[0], p.b[1]));
            // Reach a little past both ends so the band runs on into the next cell.
            let dx = bx - ax, dy = by - ay;
            const len = Math.hypot(dx, dy);
            if (len > 0.01) {
              dx /= len;
              dy /= len;
            } else {
              const l = Math.hypot(p.dir[0], p.dir[1]) || 1;
              dx = p.dir[0] / l;
              dy = p.dir[1] / l;
            }
            const ext = cellPx * 0.2;
            ax -= dx * ext;
            ay -= dy * ext;
            bx += dx * ext;
            by += dy * ext;
            // A creek is drawn at least about a fifth of a cell wide; a river as wide
            // as its channel.
            const hw = Math.max((M.channelWidth(p.size) / M.CELL_SIZE) * cellPx * 0.5, cellPx * 0.2, 2.5);
            // White water where it falls steeply: metres of drop per metre run.
            const run = Math.max(6, Math.hypot(bx - ax, by - ay) / cellPx * M.CELL_SIZE);
            const foam = M.util.smoothstep(0.15, 0.6, p.drop / run);
            list.push([ax, ay, bx, by, hw, p.vis, foam]);
          }
          out.set(c, list);
        }
      }
      return out;
    }

    // A cell in N x N pieces. Each piece takes its colour from the cell's own
    // colour (at the centre) blended toward its corners' colours (if `corner`),
    // and then the stream bands that pass near it: full water in the channel,
    // falling off quickly to the sides along an S-curve.
    drawPieces(q, own, corner, near, N) {
      const ctx = this.ctx;
      for (let b = 0; b < N; b++) {
        for (let a = 0; a < N; a++) {
          const u0 = a / N, v0 = b / N, u1 = (a + 1) / N, v1 = (b + 1) / N;
          const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
          let col = own;
          if (corner) {
            const top = mix(corner[0], corner[1], um), bot = mix(corner[3], corner[2], um);
            const w = (1 - Math.abs(2 * um - 1)) * (1 - Math.abs(2 * vm - 1));
            col = mix(mix(top, bot, vm), own, w);
          }
          if (near) {
            const [px, py] = this.toScreen(...M.bilinear(q, um, vm));
            let best = 0, foam = 0;
            for (const [ax, ay, bx, by, hw, vis, fm] of near) {
              const d = segmentDistance(px, py, ax, ay, bx, by);
              const f = vis * (1 - M.util.smoothstep(hw * 0.6, hw * 1.5, d));
              if (f > best) {
                best = f;
                foam = fm;
              }
            }
            if (best > 0.01) col = mix(col, mix(STREAM, WHITEWATER, foam), best);
          }
          const css = rgb(col);
          this.path([M.bilinear(q, u0, v0), M.bilinear(q, u1, v0), M.bilinear(q, u1, v1), M.bilinear(q, u0, v1)]);
          ctx.fillStyle = css;
          ctx.strokeStyle = css;
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    drawSectionEdges(sections, t) {
      const ctx = this.ctx, S = M.SECTION;
      ctx.strokeStyle = 'rgba(230,60,60,0.9)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 4]);
      for (const s of sections) {
        ctx.beginPath();
        for (let k = 0; k <= S; k++) {
          const [x, y] = this.toScreen(...s.vertex(s.a0, s.b0 + S - k, t));
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        for (let k = 1; k <= S; k++) ctx.lineTo(...this.toScreen(...s.vertex(s.a0 + k, s.b0, t)));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    drawLabels(sections, t) {
      const ctx = this.ctx;
      ctx.fillStyle = 'rgba(15,18,22,0.75)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '11px ui-monospace, monospace';
      // Skip labels that would overlap one already drawn.
      const drawn = [];
      for (const s of sections) {
        for (const c of s.baseCells()) {
          if ((c.values.side / M.CELL_SIZE) * this.view.scale < 38) continue;
          const [sx, sy] = this.centroid(c, t);
          if (sx < -20 || sy < -20 || sx > this.cssW + 20 || sy > this.cssH + 20) continue;
          const label = `${c.i},${c.j}`;
          const hw = ctx.measureText(label).width / 2 + 3;
          if (drawn.some(([x, y, w]) => Math.abs(x - sx) < w + hw && Math.abs(y - sy) < 13)) continue;
          drawn.push([sx, sy, hw]);
          ctx.fillText(label, sx, sy);
        }
      }
    }
  }

  // Blend a cell when a corner differs from it by more than this (sum of RGB).
  const BLEND_CONTRAST = 54;
  // How far out from the coast the waves reach, in cells.
  const SHORE_REACH = 4;

  // Distance from point p to segment a-b.
  function segmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const f = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - ax - f * dx, py - ay - f * dy);
  }

  // Stream segments of a cell's base cell and its eight neighbours, or null.
  function nearSegments(world, c, segs) {
    const S = M.SECTION, b = c.base;
    let out = null;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = b.i + di, j = b.j + dj;
        const sec = di || dj ? world.loaded(Math.floor(i / S), Math.floor(j / S)) : b.section;
        const n = sec && sec.cell(i, j);
        const list = n && segs.get(n);
        if (list) out = out ? out.concat(list) : list;
      }
    }
    return out;
  }

  // Numeric key of vertex (i, j).
  const vkey = (i, j) => (i + 524288) * 1048576 + (j + 524288);

  // Mean colour around every vertex of the base cells in view: [r, g, b, count].
  function vertexColours(sections) {
    const map = new Map();
    const add = (k, col) => {
      let a = map.get(k);
      if (!a) map.set(k, (a = [0, 0, 0, 0]));
      a[0] += col[0];
      a[1] += col[1];
      a[2] += col[2];
      a[3]++;
    };
    for (const s of sections) {
      for (const c of s.baseCells()) {
        const col = c.isLeaf ? c.drawColor : c.children[0].drawColor;
        if (!col) continue;
        add(vkey(c.i, c.j), col);
        add(vkey(c.i + 1, c.j), col);
        add(vkey(c.i + 1, c.j + 1), col);
        add(vkey(c.i, c.j + 1), col);
      }
    }
    return map;
  }

  // For the water cells of a section: steps to the nearest land (1 = next to it),
  // up to SHORE_REACH; 0 for land and open water. Computed once per section.
  function shoreDistance(world, s) {
    if (s.shore) return s.shore;
    const S = M.SECTION, d = new Uint8Array(S * S);
    // Lakes have no waves; only the sea (and fjords) do.
    const waterAt = (i, j) => {
      const sec = world.loaded(Math.floor(i / S), Math.floor(j / S));
      const c = sec && sec.cell(i, j);
      return c ? c.water : world.cellElevation(i, j) < 0;
    };
    let front = [];
    for (const c of s.baseCells()) {
      if (!c.water || !c.values.sea) continue;
      if (!waterAt(c.i + 1, c.j) || !waterAt(c.i - 1, c.j) || !waterAt(c.i, c.j + 1) || !waterAt(c.i, c.j - 1)) {
        d[(c.j - s.b0) * S + (c.i - s.a0)] = 1;
        front.push(c);
      }
    }
    for (let step = 2; step <= SHORE_REACH && front.length; step++) {
      const next = [];
      for (const c of front) {
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = s.cell(c.i + di, c.j + dj);
          if (!n || !n.water || !n.values.sea) continue;
          const k = (n.j - s.b0) * S + (n.i - s.a0);
          if (d[k]) continue;
          d[k] = step;
          next.push(n);
        }
      }
      front = next;
    }
    s.shore = d;
    return d;
  }

  M.Renderer = Renderer;
  M.MODES = MODES;
  M.drawOverview = drawOverview;
  M.colors = { rgb, ramp };
})(window.Markr = window.Markr || {});
