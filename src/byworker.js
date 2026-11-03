// A worker for the city window: works out chunks of heights from the grunn
// chain, so several run side by side.
self.window = self;
self.Markr = { VERSION: 1, CELL_SIZE: 16 };
importScripts('noise.js', 'baselayer.js', 'regionlayer.js', 'depressionlayer.js', 'riverline.js', 'riversections.js', 'locallayer.js', 'grunnchain.js', 'bychunk.js');
let chain = null, state = null, gen = -1;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    state = m.state;
    gen = m.gen;
    chain = self.Markr.byChain(state);
    return;
  }
  if (m.type === 'chunk' && m.gen === gen) {
    const ch = self.Markr.byChunk(chain, state, m.ci, m.cj);
    self.postMessage({ type: 'chunk', gen, ci: m.ci, cj: m.cj, ch }, [ch.h.buffer, ch.cls.buffer, ch.firm.buffer, ch.rgb.buffer, ch.type.buffer]);
  }
};
