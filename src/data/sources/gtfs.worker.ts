/**
 * Reads timetable files in the background, so the page stays smooth while a city's file (a few
 * hundred MB unpacked) goes by: the cut to the square (sources/gtfs) and the runs through it
 * (match/transit), one file after the other, then all of them as one. The files come from the
 * page and go nowhere else.
 */

import { cutGtfs, GtfsProblem } from './gtfs';
import { ZipProblem } from './zipFile';
import { makeRuns, mergeRuns, type TransitRuns } from '../match/transit';
import type { Timetable, TimetablePart, TimetableRequest, TimetableReply } from './timetable';

const post = (msg: TimetableReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<TimetableRequest>) => {
  const { files, center, sizeM } = e.data;
  const total = files.reduce((s, f) => s + f.size, 0) || 1;
  let before = 0;
  const parts: TimetablePart[] = [];
  const runs: TransitRuns[] = [];
  let timeZone = '';
  let firstDay = Infinity;
  let lastDay = -Infinity;
  let busiest: Timetable['busiest'] = null;
  for (let k = 0; k < files.length; k++) {
    const file = files[k];
    try {
      const cut = await cutGtfs(file, { center, sizeM }, (share) => post({ type: 'progress', share: (before + share * file.size) / total }));
      runs.push(makeRuns(cut, sizeM));
      parts.push({ agencies: cut.agencies, hasShapes: cut.hasShapes, tripsInFile: cut.tripsInFile });
      timeZone ||= cut.timeZone;
      if (Number.isFinite(cut.firstDay)) firstDay = Math.min(firstDay, cut.firstDay);
      if (Number.isFinite(cut.lastDay)) lastDay = Math.max(lastDay, cut.lastDay);
      busiest ??= cut.busiest;
    } catch (err) {
      const kind = err instanceof GtfsProblem || err instanceof ZipProblem ? err.kind : 'unreadable';
      if (kind === 'unreadable') console.warn('Timetable could not be read', err);
      post({ type: 'error', kind, file: k });
      return;
    }
    before += file.size;
  }
  const merged = mergeRuns(runs);
  const transfer: Transferable[] = [merged.runPath, merged.runRoute, merged.runService, merged.runFirst, merged.at, merged.arr, merged.dep, merged.tIn, merged.tOut].map((a) => a.buffer);
  const buffers = new Set<ArrayBufferLike>(transfer as ArrayBufferLike[]);
  for (const p of merged.paths) for (const b of [p.pts.buffer, p.cum.buffer]) if (!buffers.has(b)) buffers.add(b), transfer.push(b);
  post(
    {
      type: 'done',
      timetable: {
        parts,
        timeZone,
        firstDay: Number.isFinite(firstDay) ? firstDay : NaN,
        lastDay: Number.isFinite(lastDay) ? lastDay : NaN,
        busiest,
        runs: merged,
      },
    },
    transfer,
  );
};
