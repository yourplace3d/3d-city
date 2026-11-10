/**
 * Timetables (GTFS) the user picked or downloaded, read for a square in a worker: what the page
 * gets back. Several at once are read one after the other and shown together (a city's buses
 * and its trains often come in separate files). One worker per read; a new place or a new file
 * stops the read before it.
 */

import type { LngLat } from '../../geo/projection';
import type { TransitRuns } from '../match/transit';

/** What one file had. */
export interface TimetablePart {
  agencies: string[];
  hasShapes: boolean;
  tripsInFile: number;
}

export interface Timetable {
  /** one per file, in the order given */
  parts: TimetablePart[];
  timeZone: string;
  /** days since 1 Jan 1970; NaN when the files have no days */
  firstDay: number;
  lastDay: number;
  /** where the first file is busiest */
  busiest: { lon: number; lat: number; name: string } | null;
  runs: TransitRuns;
}

export interface TimetableRequest {
  files: Blob[];
  center: LngLat;
  sizeM: number;
}

export type TimetableReply =
  | { type: 'progress'; share: number }
  | { type: 'done'; timetable: Timetable }
  | { type: 'error'; kind: string; file: number };

/** Why a file couldn't be read, for the panel; `file` is which one. */
export class TimetableProblem extends Error {
  constructor(
    readonly kind: string,
    readonly file = 0,
  ) {
    super(kind);
    this.name = 'TimetableProblem';
  }
}

/** Reads the timetables for a square; rejects with a `TimetableProblem`, or an AbortError when stopped. */
export function readTimetable(req: TimetableRequest, onProgress: (share: number) => void, signal: AbortSignal): Promise<Timetable> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./gtfs.worker.ts', import.meta.url), { type: 'module' });
    const stop = () => {
      worker.terminate();
      reject(new DOMException('Stopped', 'AbortError'));
    };
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    worker.onmessage = (e: MessageEvent<TimetableReply>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress(msg.share);
        return;
      }
      signal.removeEventListener('abort', stop);
      worker.terminate();
      if (msg.type === 'done') resolve(msg.timetable);
      else reject(new TimetableProblem(msg.kind, msg.file));
    };
    worker.onerror = (e) => {
      signal.removeEventListener('abort', stop);
      worker.terminate();
      console.warn('Timetable worker failed', e.message);
      reject(new TimetableProblem('unreadable'));
    };
    worker.postMessage(req);
  });
}
