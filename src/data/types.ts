/**
 * The data-layer engine: what every overlay on the model is made of.
 *
 *   source  → reads data into lon/lat (+ time): a file the user picks, a share link, later live APIs
 *   match   → places it in the model's local metres (E, N from the centre of the square)
 *   time    → positions or values per moment, and playback
 *   display → draws it: painted into the ground texture and/or 3D objects on the model
 *
 * `.claude/skills/add-data-layer/SKILL.md` walks through adding a data set.
 */

import type { Object3D } from 'three';

/** Who to credit for a data set. Shown in the app and on posters; null for the user's own data. */
export interface Attribution {
  text: string;
  licence?: string;
  url?: string;
}

/** One point of a track: where, and optionally the height and when (ms since 1970). */
export interface TrackPoint {
  lon: number;
  lat: number;
  ele?: number;
  time?: number;
}

/** A line of points in order: a run, a ride, a race course. */
export interface Track {
  name: string;
  points: TrackPoint[];
}

/** Metres east and north of the model's centre. */
export type Pt = [number, number];

/**
 * Paints into the ground texture after the map layers. The context is set up in local metres
 * (E, N; north up), so draw with model coordinates; `sizeM` is the side of the square.
 */
export type GroundPainter = (ctx: CanvasRenderingContext2D, sizeM: number) => void;

/** What a display needs to stand things on the model's terrain. */
export interface ModelSurface {
  readonly sizeM: number;
  /** scene y of the ground at a point (metres E, N from the centre), at the current exaggeration */
  groundY(e: number, n: number): number;
}

/** A display on the model: ground paint and/or 3D objects. The model owns it once added. */
export interface ModelOverlay {
  /** drawn into the ground texture, on top of roads, water and green */
  paint?: GroundPainter;
  /** painting order among data layers: higher is drawn on top (default 0) */
  order?: number;
  /** 3D objects, added to the model */
  object?: Object3D;
  /** stand the 3D objects on the terrain again; called when added and whenever the terrain's height changes */
  place?(surface: ModelSurface): void;
  dispose?(): void;
}
