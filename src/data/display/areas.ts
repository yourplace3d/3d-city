/**
 * Display: values per area as building colours. Each building takes its area's class colour, in
 * one hue from light (lowest fifth) to dark (highest); buildings with no value turn a quiet grey,
 * so "no data" never reads as "cheap". Areas with their own outline (neighbourhoods, block
 * groups) have it drawn on the ground; the area the pin is in is outlined in the accent colour,
 * grid squares included. The ground itself stays as it is: blue on the ground would look like water.
 *
 * The five blues pass the dataviz checks as an ordered ramp: lightness steps clearly from one to
 * the next, and the lightest still stands out from white buildings and the beige ground.
 */

import { Color } from 'three';
import { classOf, type AreaIndex, type Areas } from '../match/areas';
import type { ModelOverlay } from '../types';

/** lowest fifth → highest */
export const AREA_COLOURS = ['#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'] as const;
/** buildings without a value */
export const AREA_NONE = '#d4d0c8';
/** the outlines of areas on the ground */
const OUTLINE = 'rgba(40, 46, 60, 0.55)';

export class AreaDisplay implements ModelOverlay {
  /** over steepness and traffic paint, under a route */
  readonly order = 1;
  private readonly colours = AREA_COLOURS.map((c) => new Color(c));
  private readonly none = new Color(AREA_NONE);
  /** the area the pin is in, or -1 */
  picked = -1;

  constructor(
    readonly areas: Areas,
    readonly index: AreaIndex,
    readonly breaks: readonly number[],
    private readonly accent: string,
  ) {}

  /** The colour of the building whose middle is at (e, n). */
  colourAt = (e: number, n: number): Color => {
    const i = this.index.at(e, n);
    if (i < 0) return this.none;
    const k = classOf(this.areas.shapes[i].value, this.breaks);
    // fewer breaks than five classes: spread them over the ramp's ends
    const classes = this.breaks.length + 1;
    const step = classes === 1 ? 2 : Math.round((k * (this.colours.length - 1)) / (classes - 1));
    return this.colours[step];
  };

  /** The class colour of a value, as CSS. */
  cssColour(value: number): string {
    const k = classOf(value, this.breaks);
    const classes = this.breaks.length + 1;
    return AREA_COLOURS[classes === 1 ? 2 : Math.round((k * (AREA_COLOURS.length - 1)) / (classes - 1))];
  }

  paint = (ctx: CanvasRenderingContext2D, sizeM: number): void => {
    const line = sizeM * 0.0012;
    ctx.save();
    ctx.lineJoin = 'round';
    const trace = (rings: Float32Array[]) => {
      ctx.beginPath();
      for (const r of rings) {
        ctx.moveTo(r[0], r[1]);
        for (let k = 2; k < r.length; k += 2) ctx.lineTo(r[k], r[k + 1]);
        ctx.closePath();
      }
    };
    if (this.areas.geometry === 'shapes') {
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = line;
      for (const s of this.areas.shapes) {
        trace(s.rings);
        ctx.stroke();
      }
    }
    const p = this.areas.shapes[this.picked];
    if (p) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = line * 4.5;
      trace(p.rings);
      ctx.stroke();
      ctx.strokeStyle = this.accent;
      ctx.lineWidth = line * 2.5;
      ctx.stroke();
    }
    ctx.restore();
  };
}
