// Generates sections in the background. The page sends the settings once, then
// asks for sections one at a time; each comes back as Section.serialize() data.
self.window = self;
importScripts('noise.js', 'terrain.js', 'world.js');

let world = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    const terrain = new self.Markr.Terrain(m.seed, m.terrain);
    world = new self.Markr.World(terrain, Object.assign({}, m.world, { autoSplit: 0, maxSections: 30 }));
  } else if (m.type === 'build') {
    const s = world.section(m.sx, m.sy);
    self.postMessage({ type: 'section', gen: m.gen, data: s.serialize() });
  }
};
