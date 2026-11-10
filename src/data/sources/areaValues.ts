/**
 * Values per area (what homes cost, what people earn) from a file the user picked or a provider's
 * download, read for a square in a worker: what the page gets back. One worker per read; a new
 * place or a new file stops the read before it.
 */

import type { LngLat } from '../../geo/projection';
import type { AreaCut } from './areaFile';

export interface AreaRequest {
  file: Blob;
  name: string;
  center: LngLat;
  sizeM: number;
}

export type AreaReply = { type: 'progress'; share: number } | { type: 'done'; cut: AreaCut } | { type: 'error'; kind: string; detail: string };

/** Why a file couldn't be read, for the panel. */
export class AreaReadProblem extends Error {
  constructor(
    readonly kind: string,
    readonly detail = '',
  ) {
    super(kind);
    this.name = 'AreaReadProblem';
  }
}

/** Reads a file of values for a square; rejects with an `AreaReadProblem`, or an AbortError when stopped. */
export function readAreaValues(req: AreaRequest, onProgress: (share: number) => void, signal: AbortSignal): Promise<AreaCut> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./area.worker.ts', import.meta.url), { type: 'module' });
    const stop = () => {
      worker.terminate();
      reject(new DOMException('Stopped', 'AbortError'));
    };
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    worker.onmessage = (e: MessageEvent<AreaReply>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress(msg.share);
        return;
      }
      signal.removeEventListener('abort', stop);
      worker.terminate();
      if (msg.type === 'done') resolve(msg.cut);
      else reject(new AreaReadProblem(msg.kind, msg.detail));
    };
    worker.onerror = (e) => {
      signal.removeEventListener('abort', stop);
      worker.terminate();
      console.warn('Values worker failed', e.message);
      reject(new AreaReadProblem('unreadable'));
    };
    worker.postMessage(req);
  });
}
