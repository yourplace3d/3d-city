/**
 * Reads a file of values per area in the background, so the page stays smooth while a country's
 * grid (a few hundred MB unpacked) goes by: the cut to the square (sources/areaFile). The file
 * comes from the page and goes nowhere else.
 */

import { AreaProblem, cutAreas } from './areaFile';
import type { AreaReply, AreaRequest } from './areaValues';

const post = (msg: AreaReply) => (self as unknown as Worker).postMessage(msg);

self.onmessage = async (e: MessageEvent<AreaRequest>) => {
  const { file, name, center, sizeM } = e.data;
  try {
    const cut = await cutAreas(file, name, { center, sizeM }, (share) => post({ type: 'progress', share }));
    post({ type: 'done', cut });
  } catch (err) {
    const kind = err instanceof AreaProblem ? err.kind : 'unreadable';
    if (kind === 'unreadable') console.warn('Values could not be read', err);
    post({ type: 'error', kind, detail: err instanceof AreaProblem ? err.detail : '' });
  }
};
