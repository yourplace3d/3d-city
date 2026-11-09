/**
 * Reads a timetable file in the background, so the page stays smooth while a city's file (a few
 * hundred MB unpacked) goes by: the cut to the square (sources/gtfs) and the runs through it
 * (match/transit). The file comes from the page and goes nowhere else.
 */

import { cutGtfs, GtfsProblem } from './gtfs';
import { ZipProblem } from './zipFile';
import { makeRuns } from '../match/transit';
import type { TimetableRequest, TimetableReply } from './timetable';

const post = (msg: TimetableReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<TimetableRequest>) => {
  const { file, center, sizeM } = e.data;
  try {
    const cut = await cutGtfs(file, { center, sizeM }, (share) => post({ type: 'progress', share }));
    const runs = makeRuns(cut, sizeM);
    const transfer: Transferable[] = [runs.runPath, runs.runRoute, runs.runService, runs.runFirst, runs.at, runs.arr, runs.dep, runs.tIn, runs.tOut].map((a) => a.buffer);
    for (const p of runs.paths) transfer.push(p.pts.buffer, p.cum.buffer);
    post(
      {
        type: 'done',
        timetable: {
          agencies: cut.agencies,
          timeZone: cut.timeZone,
          firstDay: cut.firstDay,
          lastDay: cut.lastDay,
          hasShapes: cut.hasShapes,
          busiest: cut.busiest,
          tripsInFile: cut.tripsInFile,
          runs,
        },
      },
      transfer,
    );
  } catch (err) {
    const kind = err instanceof GtfsProblem || err instanceof ZipProblem ? err.kind : 'unreadable';
    if (kind === 'unreadable') console.warn('Timetable could not be read', err);
    post({ type: 'error', kind });
  }
};
