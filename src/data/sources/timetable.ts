/**
 * A timetable (GTFS) the user picked, read for a square in a worker: what the page gets back.
 * One worker per read; a new place or a new file stops the read before it.
 */

import type { LngLat } from '../../geo/projection';
import type { TransitRuns } from '../match/transit';

export interface Timetable {
  agencies: string[];
  timeZone: string;
  /** days since 1 Jan 1970; NaN when the file has no days */
  firstDay: number;
  lastDay: number;
  hasShapes: boolean;
  busiest: { lon: number; lat: number; name: string } | null;
  tripsInFile: number;
  runs: TransitRuns;
}

export interface TimetableRequest {
  file: Blob;
  center: LngLat;
  sizeM: number;
}

export type TimetableReply =
  | { type: 'progress'; share: number }
  | { type: 'done'; timetable: Timetable }
  | { type: 'error'; kind: string };

/** Why a file couldn't be read, for the panel. */
export class TimetableProblem extends Error {
  constructor(readonly kind: string) {
    super(kind);
    this.name = 'TimetableProblem';
  }
}

/** Reads the timetable for a square; rejects with a `TimetableProblem`, or an AbortError when stopped. */
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
      else reject(new TimetableProblem(msg.kind));
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
