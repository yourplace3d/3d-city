/**
 * What a clip of a layer that moves in time plays (src/ui/clip.ts makes it): the timetable for two
 * hours, the traffic for its day, a route's replay. Each layer hands one out; nothing changes until
 * the clip calls at(), and done() puts the layer back as it was.
 */

/** A clip lasts this long (s)… */
export const CLIP_SECONDS = 12;
/** …and the timetable's one plays this much of the day (s): two hours, ten minutes a second. */
export const CLIP_TRANSIT_S = 2 * 3600;

export interface ClipFrame {
  /** the big clock on the frame: "08:40", "14:00", "12.4 km" */
  clock: string;
  /** under it: "Wed 11 Nov", "Tue", "1:02:10" */
  note: string;
}

export interface ClipSource {
  /** what the clip plays, for the dialog */
  span: string;
  /** the layer at `k` (0 → 1) of the clip, and the clock for that frame */
  at(k: number): ClipFrame;
  /** the layer back as it was before the clip */
  done(): void;
}
