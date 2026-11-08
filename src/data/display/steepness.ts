/**
 * Display: roads and paths coloured by how steep they are, painted into the ground texture.
 * Flat ones stay as they are. The colours run golden yellow → orange → red → dark red: the
 * traffic-light feel without its green (green is parks and woods on this map, and red–green is
 * what colour-blind people can't tell apart). Each step is clearly darker than the one before,
 * so the order reads without colour vision and in black-and-white prints; even the lightest
 * stands out from the beige ground and the white roads.
 */

import type { ClassPiece, SteepClass } from '../match/slope';
import type { ModelOverlay } from '../types';

/** gentle, moderate, steep, very steep */
export const STEEP_COLOURS = ['#cd9a0a', '#cc6700', '#b52d1b', '#701e25'] as const;

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
