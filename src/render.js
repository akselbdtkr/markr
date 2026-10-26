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
  const STREAM = [62, 122, 170];
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
      this.showStreams = true;
      this.hover = null;
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

    draw(world) {
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

      // Fill cells; stroke with the same colour to hide anti-aliasing seams.
      ctx.lineWidth = 1;
      for (const c of leaves) {
        const col = rgb(color(c.values));
        this.path(c.corners(t));
        ctx.fillStyle = col;
        ctx.strokeStyle = col;
        ctx.fill();
        ctx.stroke();
      }

      if (this.showStreams) this.drawStreams(sections, t);

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

      if (this.hover && world.loaded(this.hover.section.sx, this.hover.section.sy)) {
        this.path(this.hover.corners(t));
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (this.showLabels && this.view.scale > 42) this.drawLabels(sections, t);
    }

    // Streams are a texture on the cells that own them: each piece is drawn from
    // where it enters the cell to where it leaves, clipped to the cell, in the
    // cell's own (u, v) space, so it follows the cell through the morph.
    drawStreams(sections, t) {
      const ctx = this.ctx;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = rgb(STREAM);
      for (const s of sections) {
        for (const c of s.baseCells()) {
          if (!c.pieces) continue;
          const q = c.corners(t);
          ctx.save();
          this.path(q);
          ctx.clip();
          for (const p of c.pieces) {
            const [ax, ay] = this.toScreen(...M.bilinear(q, p.a[0], p.a[1]));
            const [bx, by] = this.toScreen(...M.bilinear(q, p.b[0], p.b[1]));
            const w = Math.max(1, (M.channelWidth(p.size) / M.CELL_SIZE) * this.view.scale);
            // Reach a little past both ends so pieces in neighbouring cells join.
            let dx = bx - ax, dy = by - ay;
            const len = Math.hypot(dx, dy);
            if (len > 0.01) {
              dx /= len;
              dy /= len;
            } else {
              const [ux, uy] = p.dir, l = Math.hypot(ux, uy) || 1;
              dx = ux / l;
              dy = uy / l;
            }
            const ext = this.view.scale * 0.25;
            ctx.lineWidth = w;
            ctx.beginPath();
            ctx.moveTo(ax - dx * ext, ay - dy * ext);
            ctx.lineTo(bx + dx * ext, by + dy * ext);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
      ctx.restore();
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

  M.Renderer = Renderer;
  M.MODES = MODES;
  M.drawOverview = drawOverview;
  M.colors = { rgb, ramp };
})(window.Markr = window.Markr || {});
