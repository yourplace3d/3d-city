/**
 * Display: roads and paths coloured by how steep they are, painted into the ground texture.
 * Flat ones stay as they are. The colours are one light-to-dark ramp (orange to deep red),
 * checked to read in order and to stand out from the beige ground and the white roads;
 * no green or blue, which would look like parks or water.
 */

import type { ClassPiece, SteepClass } from '../match/slope';
import type { ModelOverlay } from '../types';

/** gentle, moderate, steep, very steep */
export const STEEP_COLOURS = ['#e4864e', '#cc5727', '#a82f1f', '#6b1d26'] as const;

export function steepColour(cls: SteepClass): string | null {
  return cls > 0 ? STEEP_COLOURS[cls - 1] : null;
}

export interface SteepPiece extends ClassPiece {
  /** the road's width on the map (m) */
  widthM: number;
}

export class SteepnessDisplay implements ModelOverlay {
  /** under a route */
  readonly order = 0;

  constructor(readonly pieces: SteepPiece[]) {}

  paint = (ctx: CanvasRenderingContext2D, sizeM: number): void => {
    // at least a few pixels wide on the texture, so steep paths show from afar
    const min = sizeM * 0.0015;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // gentle first, so the steeper colour wins where pieces meet
    for (let cls = 1; cls <= 4; cls++) {
      ctx.strokeStyle = STEEP_COLOURS[cls - 1];
      for (const p of this.pieces) {
        if (p.cls !== cls || p.pts.length < 2) continue;
        ctx.lineWidth = Math.max(p.widthM, min);
        ctx.beginPath();
        ctx.moveTo(p.pts[0][0], p.pts[0][1]);
        for (let k = 1; k < p.pts.length; k++) ctx.lineTo(p.pts[k][0], p.pts[k][1]);
        ctx.stroke();
      }
    }
    ctx.restore();
  };
}
