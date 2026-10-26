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
    elevation: [[38, 70, 83], [110, 150, 90], [205, 190, 130], [150, 120, 100], [245, 245, 240]],
    moisture: [[214, 190, 140], [150, 180, 110], [60, 140, 120], [30, 80, 140]],
    heat: [[250, 245, 225], [240, 190, 90], [200, 80, 50], [90, 30, 60]],
    green: [[245, 240, 225], [180, 205, 130], [70, 130, 60], [25, 70, 35]],
    amber: [[245, 240, 225], [235, 200, 140], [200, 110, 60], [120, 50, 40]],
    stone: [[245, 240, 225], [190, 190, 200], [110, 110, 140], [50, 50, 80]],
  };

  // Natural-looking colour: moisture/elevation biome with hill shading.
  function terrainColor(v) {
    const dry = [206, 190, 140], lush = [98, 140, 72], marsh = [92, 128, 110];
    const rock = [138, 128, 118], snow = [240, 240, 236];
    let c = mix(dry, lush, clamp01((v.moisture - 0.15) / 0.6));
    if (v.moisture > 0.8 && v.elevation < 0.5) c = mix(c, marsh, (v.moisture - 0.8) / 0.2);
    c = mix(c, rock, clamp01((v.elevation - 0.62) / 0.14));
    c = mix(c, snow, clamp01((v.elevation - 0.8) / 0.06));
    // Lambert shading, light from the north-west.
    const z = 7;
    const nx = -v.gx * z, ny = -v.gy * z, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    const shade = (nx * -0.6 + ny * -0.6 + nz * 0.53) / len;
    const f = 0.62 + 0.45 * shade;
    return [c[0] * f, c[1] * f, c[2] * f];
  }

  const MODES = {
    terrain: { label: 'Terreng', color: terrainColor },
    elevation: { label: 'Høyde', color: (v) => ramp(RAMPS.elevation, v.elevation), ramp: RAMPS.elevation },
    moisture: { label: 'Fuktighet', color: (v) => ramp(RAMPS.moisture, v.moisture), ramp: RAMPS.moisture },
    ruggedness: { label: 'Ulendthet', color: (v) => ramp(RAMPS.heat, v.ruggedness), ramp: RAMPS.heat },
    slope: { label: 'Helning', color: (v) => ramp(RAMPS.heat, v.steepness), ramp: RAMPS.heat },
    size: {
      label: 'Rutestørrelse',
      // log scale: 1/8 .. 8 times the nominal cell area
      color: (v) => ramp(RAMPS.stone, 1 - (Math.log2(v.area) + 3) / 6),
      ramp: RAMPS.stone,
      legend: ['stor', 'liten'],
    },
    farmland: { label: 'Jordbruksverdi', color: (v) => ramp(RAMPS.green, v.farmland), ramp: RAMPS.green },
    building: { label: 'Byggegrunn', color: (v) => ramp(RAMPS.amber, v.building), ramp: RAMPS.amber },
    resource: { label: 'Ressurser', color: (v) => ramp(RAMPS.stone, v.resource), ramp: RAMPS.stone },
  };

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.view = { scale: 16, ox: 0, oy: 0 };
      this.mode = 'terrain';
      this.morph = 1;
      this.showLines = true;
      this.showLabels = true;
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

    fit(grid) {
      const pad = 24;
      const s = Math.min((this.cssW - 2 * pad) / grid.cols, (this.cssH - 2 * pad) / grid.rows);
      this.view.scale = s;
      this.view.ox = (this.cssW - grid.cols * s) / 2 - grid.i0 * s;
      this.view.oy = (this.cssH - grid.rows * s) / 2 - grid.j0 * s;
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

    draw(grid) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--canvas-bg') || '#1d2024';
      ctx.fillRect(0, 0, this.cssW, this.cssH);

      const color = MODES[this.mode].color;
      const t = this.morph;
      const leaves = [...grid.leaves()];

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

      if (this.showLines) {
        const s = this.view.scale;
        for (const c of leaves) {
          this.path(c.corners(t));
          const a = c.level === 0 ? 0.42 : 0.24;
          ctx.strokeStyle = `rgba(20,24,28,${a})`;
          ctx.lineWidth = Math.max(0.4, Math.min(1.2, s / 30)) * (c.level === 0 ? 1 : 0.7);
          ctx.stroke();
        }
      }

      if (this.hover) {
        this.path(this.hover.corners(t));
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (this.showLabels && this.view.scale > 42) {
        ctx.fillStyle = 'rgba(15,18,22,0.75)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const c of grid.baseCells()) {
          const p = c.corners(t);
          const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
          const cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
          const [sx, sy] = this.toScreen(cx, cy);
          if (sx < -20 || sy < -20 || sx > this.cssW + 20 || sy > this.cssH + 20) continue;
          ctx.font = `${Math.min(13, this.view.scale / 5)}px ui-monospace, monospace`;
          ctx.fillText(`${c.i},${c.j}`, sx, sy);
        }
      }
    }
  }

  M.Renderer = Renderer;
  M.MODES = MODES;
  M.colors = { rgb, ramp };
})(window.Markr = window.Markr || {});
