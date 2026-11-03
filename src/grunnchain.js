// The chain of grunn layers, shared by the grunn window and the city
// window: base, middle layer, regions, depression, rivers (point-wise and
// per section), local layer and springs. ctx holds what the view sets:
// lod (which layers are drawn) and pix (the size of a drawn point, sim units).
(function (M) {
  'use strict';

  // The settings the layers start from.
  M.GRUNN_DEFAULTS = {
    seed: 51597,
    contSize: 3010, contW: 2.6, basinSize: 940, basinW: 1.75, baseSize: 240, baseW: 1.2, s1Size: 710, s1W: 2.8, s1Width: 0.26,
    tSea: -0.33, tHigh: 1.15, tDivide: 1.98, divSteep: 2.5,
    lowTop: 260, highTop: 1600, shelf: 320, deep: 3500,
    midSize: 185, midW: 0.9, midStretch: 10, tInland: 0,
    firmSize: 75, firmW: 0.8, firmInherit: 1, typeSize: 110, typeW: 1.05, typeFirm: 0.4, typeHeight: 0.3, regStretch: 3,
    tT1: -0.34, tT2: 1.01, tT3: 1.85, typeSoft: 0.6,
    depMode: 'median', depSize: 200, depDepth: 0.3, depWidth: 0.61, depSoft: 0.6, depStretch: 3, depAlign: 0.7, depLow: 0.8, depPlain: 0.5, depSlope: 30, depMtn: 0.6,
    vA1: 0.27, vA2: 1.17, vA3: 1.8, vB1: 0.15, vB2: 0.55, vB3: 0.74, vH: 0.4,
    riverAlign: 0.15, riverWidth: 50000, riverDeep: 10, riverZone: 4, riverSlope: 15, riverReach: 30000, springDepth: 6, springCarve: 30, springZone: 6000,
    rvH: [1, 0.6, 0.41, 0.4, 0.35, 0.35], rvF: [1, 0.6, 0.4, 0.37, 0.41, 0.44], riverMin: 900, riverBraid: 0.7, riverDrop: 0.03, riverRise: 0.5,
    secZoom: 1200, lodRiver: 16, lodDep: 150, lodRegion: 300, lodLocal: 25,
    lcH: [0.05, 0.54, 0.2, 0.72], lcS: [0.2, 0.54, 0.48, 0.25], lcR: [0, 0.15, 0.44, 1], lcT: [0.2, 0.62, 0.4, 0.3], lcU: [0.2, 0.15, 0.35, 0.8],
    locFlat: 0.8, locSide: 0.25, bank: 1800, locBank: 10000, mtH: 1500, mtS: 810, mtDiv: 1, mtFirm: 0.8, locFirm: 0.8, cutH: 1200, cutS: 510, mtT: 4, locK: 1, locW: 3, locSlope: 25, mtSlope: 75, snowFrom: 3200, snowTo: 4300, riverGap: 30000, riverWalk: 50000, riverOutlet: 100000, riverSill: 15, riverDetour: 3, riverBend: 0.6, riverMeander: 2, showNodes: false,
    // Scale: the simulation keeps its own units; on screen one unit is
    // 1/scaleH m across and 1/scaleV m in height (1:50 and 1:10).
    scaleH: 50, scaleV: 2,
  };


  M.grunnChain = function (state, on, ctx) {
    let layer, region, dep, river, local, sections;
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
    const pl = { ...state };
    if (!on.local) pl.locW = 0;
    if (!on.mount) pl.mtH = 0;
    if (!on.cut) pl.cutH = 0;
    local = on.local || on.mount ? new M.LocalLayer(layer, state.seed, pl) : null;
    // The per-section step: its own store of rivers, built when zoomed in.
    sections = river && on.sections
      ? new M.RiverSections(river, (x, y) => {
          // At a fixed point size (two cells, as the lattices), so the
          // rivers per section do not depend on what is being drawn.
          const f = fullCore(x, y, false, 32 * state.scaleH);
          // sea: the open sea itself (base, middle layer and depression
          // under the threshold), not water of a river marked as sea.
          return { h: f.h, cls: f.cls, sea: f.vLand < state.tSea };
        }, { cell: 16 * state.scaleH, gap: state.riverGap, walk: state.riverWalk, bend: state.riverBend, meander: state.riverMeander, tSea: state.tSea, minW: state.riverMin, springDepth: state.springDepth, springCarve: state.springCarve, springZone: state.springZone, springOn: on.spring, rise: 5 * state.scaleV, outlet: state.riverOutlet, sill: state.riverSill * state.scaleV, detour: state.riverDetour, slopeK: state.scaleH / state.scaleV })
      : null;
    const lod = ctx.lod;
    // Region at a point (land only), or null.
    const regionAt = (x, y, v) => (v >= state.tSea ? region.at(x, y, v) : null);
    // pix: the size of a drawn point (sim units), by default the view's.
    function fullCore(x, y, withSections, pix = ctx.pix) {
      const [vb, v0, inland, large] = layer.valueParts(x, y);
      const r = lod.region ? regionAt(x, y, v0) : null;
      let v = v0, band = 0;
      if (dep && lod.dep) {
        const d = dep.at(x, y, v0, vb, inland, r ? r.firm : 0.5, large, r ? r.w[0] : 0, r ? r.pos : null);
        v = d.v;
        band = d.band;
      }
      // Rivers: class 4 (elv), on land only.
      const vLand = v;
      let water = false, sea = false, tint = 0, edge = Infinity, ew = 0, carveH = 0;
      // Large views draw only large rivers: skip the river sum where even the
      // widest river here would be under two drawn points (no section step).
      const small = !withSections && r && river && river.maxWidth(layer.height(v0), r.firm) < 2 * pix;
      if (river && lod.river && r && v >= state.tSea && !small) {
        const mask = withSections && sections ? sections.waterAt(x, y) : undefined;
        const rv = river.at(x, y, v, mask);
        if (mask && !mask.water && !rv.water) tint = mask.cover;
        carveH = mask && !mask.water ? mask.carve || 0 : 0;
        v = rv.v;
        water = rv.water;
        sea = !!rv.sea;
        edge = rv.edge;
        ew = rv.ew ?? 0;
      }
      const cls = sea ? 0 : water ? 4 : layer.cls(v);
      let h = layer.height(v);
      // The local layer, on land: shaped by the landscape type, the valley
      // profile and the river.
      if (local && lod.local && r && cls >= 1 && cls <= 3) {
        const low = 1 - Math.max(0, Math.min(1, (large - state.tSea) / (state.tHigh - state.tSea)));
        const sw = band > 0 ? M.DepressionLayer.shapes(r.pos, 1 - low, state) : null;
        // A mountain: fjellsk, and more the higher above the divide threshold.
        // Firm ground gives mountain forms too, whatever the type.
        const firmM = state.mtFirm * Math.max(0, Math.min(1, (r.firm - 0.45) / 0.4));
        const mount = Math.min(1, Math.max(r.w[3], firmM) + state.mtDiv * Math.max(0, Math.min(1, (v - state.tDivide + 0.3) / 0.8)));
        // Toward the sea the local layer fades out, so the coast has no cliff.
        const coast = Math.max(0, Math.min(1, (v - state.tSea) / 0.3));
        const k = coast * coast * (3 - 2 * coast);
        h = Math.max(0.5 * state.scaleV, h + k * local.at(x, y, r.pos, band, sw, edge, mount, r.firm, h / Math.max(1, layer.height(state.tDivide)), ew));
      }
      // Brooks from the springs carve their channel last.
      if (carveH > 0 && cls >= 1 && cls <= 3) h = Math.max(0.5 * state.scaleV, h - carveH);
      return { v, h, cls, region: r, band, tint, vLand };
    }
    return { layer, region, dep, river, local, sections, fullCore, regionAt };
  };
})(window.Markr = window.Markr || {});
