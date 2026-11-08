/**
 * A short vertical flyover video, made in the browser: the camera flies low along one diagonal of
 * the square, looking ahead, and the title fades in near the end. Each frame is rendered off-screen
 * and encoded with the browser's own video encoder (WebCodecs), so the video is smooth however slow
 * the device is. Nothing is uploaded.
 */

import type { CityModel } from '../scene/cityModel';
import type { CapturePose, Viewer } from '../scene/viewer';
import { ATTRIBUTION_TEXT, exportFileName } from './poster';

/** ↗ flies from the south-west corner towards the north-east one, ↖ from south-east to north-west. */
export type FlyDirection = 'ne' | 'nw';

export const FLYOVER = {
  width: 1080,
  height: 1920,
  fps: 30,
  /** the flight; the title fades in during its last seconds */
  flightS: 10.5,
  /** a short still at the end, so the title can be read */
  endS: 1.0,
  /** vertical field of view (degrees) */
  vfov: 50,
};

/** The background behind the model, and the haze far away fades into its middle colour. */
const SKY_TOP = '#f6f3ee';
const SKY_HAZE = '#e7e2d9';
const SKY_BOTTOM = '#d9d3c8';

/** What the flight needs to know about the model: its size and heights (scene y). */
export interface FlightSpace {
  sizeM: number;
  /** ground at the centre */
  groundY: number;
  /** the highest point: the tallest building or hill top */
  topY: number;
}

const PITCH_DEG = 32; // how far below the horizon the camera looks

function ease(k: number): number {
  // moving from the first frame, slowing down gently at the end
  const smooth = 0.5 - Math.cos(Math.PI * k) / 2;
  return 0.3 * k + 0.7 * smooth;
}

const TURN_DEG = 15; // the heading turns gently by twice this over the flight, like a banking plane

/**
 * The camera at point k (0…1) of the flight: it starts inside one corner and flies along the
 * diagonal past the centre on a gentle curve, turning right (↗) or left (↖) by 30°, sinking a little
 * and staying clear of the highest building. Height, distance and speed are shares of the square, so
 * the picture moves at the same pace for a 500 m square as for a 4 km one.
 */
export function flyoverPose(k: number, dir: FlyDirection, space: FlightSpace): CapturePose {
  const s = space.sizeM;
  const e = ease(Math.min(1, Math.max(0, k)));
  // forward along the diagonal, and to its left (mirrored for ↖, so both turn away from the centre line the same way)
  const fwd = dir === 'ne' ? [Math.SQRT1_2, Math.SQRT1_2] : [-Math.SQRT1_2, Math.SQRT1_2];
  const left = dir === 'ne' ? [-fwd[1], fwd[0]] : [fwd[1], -fwd[0]];
  const at = (x: number, y: number): [number, number] => [fwd[0] * x + left[0] * y, fwd[1] * x + left[1] * y];

  // an arc over the chord from -0.5 s to +0.1 s along the diagonal; it bulges to the left by 2% of the side
  const turn = (TURN_DEG * Math.PI) / 180;
  const half = 0.3 * s;
  const radius = half / Math.sin(turn);
  const phi = -turn + 2 * turn * e;
  const x = -0.2 * s + radius * Math.sin(phi);
  const y = radius * (Math.cos(phi) - Math.cos(turn));
  const heading = [Math.cos(phi), -Math.sin(phi)]; // in (forward, left)

  const clear = Math.max(space.topY + 0.04 * s, space.groundY + 0.11 * s);
  const camY = clear + 0.03 * s * (1 - e);
  const height = camY - space.groundY;
  // look a little below the horizon, but never at a point beyond the square
  const ahead = Math.min(height / Math.tan((PITCH_DEG * Math.PI) / 180), 0.35 * s);
  const [pe, pn] = at(x, y);
  const [le, ln] = at(x + heading[0] * ahead, y + heading[1] * ahead);
  return { pos: [pe, pn, camY], look: [le, ln, space.groundY] };
}

/** "your-place-kleinfelde-2km-flyover.mp4" */
export function flyoverFileName(title: string, sizeM: number): string {
  return exportFileName(title, sizeM, 'flyover.mp4');
}

/** Whether this browser has a video encoder at all (the exact codec is checked when recording). */
export function flyoverMaybeSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.VideoEncoder === 'function' && window.isSecureContext;
}

export class FlyoverUnsupportedError extends Error {}

export interface FlyoverInfo {
  title: string;
  subtitle?: string;
  dir: FlyDirection;
}

export interface FlyoverOptions {
  /** 0…1 as the frames are made */
  onProgress?: (done: number) => void;
  signal?: AbortSignal;
  /** shorter or smaller videos, for tests */
  seconds?: number;
  width?: number;
  height?: number;
}

export async function makeFlyover(viewer: Viewer, model: CityModel, info: FlyoverInfo, opts: FlyoverOptions = {}): Promise<Blob> {
  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, getFirstEncodableVideoCodec, QUALITY_HIGH } = await import('mediabunny');
  const fps = FLYOVER.fps;
  const scale = (opts.seconds ?? FLYOVER.flightS + FLYOVER.endS) / (FLYOVER.flightS + FLYOVER.endS);
  const flightS = FLYOVER.flightS * scale;
  const endS = FLYOVER.endS * scale;

  // the full size where the encoder takes it, else 720p
  let size: [number, number] | null = null;
  let codec = null;
  const sizes: Array<[number, number]> = opts.width && opts.height ? [[opts.width, opts.height]] : [[FLYOVER.width, FLYOVER.height], [720, 1280]];
  for (const [w, h] of sizes) {
    codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: w, height: h });
    if (codec) {
      size = [w, h];
      break;
    }
  }
  if (!codec || !size) throw new FlyoverUnsupportedError('no video encoder');
  const [W, H] = size;

  const bounds = viewer.modelBounds();
  const space: FlightSpace = { sizeM: model.sizeM, groundY: model.centerY(), topY: bounds ? bounds.max.y : model.centerY() };
  const s = model.sizeM;

  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d')!;

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(out, { codec, quality: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  model.setPinVisible(false);
  const capture = viewer.startCapture(W, H, FLYOVER.vfov, SKY_HAZE, 0.45 * s, 1.25 * s);
  try {
    const flightFrames = Math.round(flightS * fps);
    const total = flightFrames + Math.round(endS * fps);
    const titleIn = flightS - Math.min(3.2, flightS * 0.35);
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const time = i / fps;
      // the last frames hold the end of the flight
      capture.frame(flyoverPose(Math.min(1, i / (flightFrames - 1)), info.dir, space));
      const titleAlpha = Math.max(0, Math.min(1, (time - titleIn) / 0.8));
      drawFrame(ctx, capture.canvas, W, H, info, titleAlpha);
      await source.add(time, 1 / fps);
      opts.onProgress?.((i + 1) / total);
      // let the page show the progress now and then
      if (i % 6 === 5) await new Promise((r) => setTimeout(r, 0));
    }
    capture.end();
    model.setPinVisible(true);
    await output.finalize();
  } catch (err) {
    capture.end();
    model.setPinVisible(true);
    await output.cancel().catch(() => {});
    throw err;
  }
  return new Blob([output.target.buffer!], { type: 'video/mp4' });
}

/** One frame: background, the rendered model, the credit, and the title as it fades in. */
function drawFrame(ctx: CanvasRenderingContext2D, render: HTMLCanvasElement, W: number, H: number, info: FlyoverInfo, titleAlpha: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, SKY_TOP);
  sky.addColorStop(0.45, SKY_HAZE);
  sky.addColorStop(1, SKY_BOTTOM);
  ctx.globalAlpha = 1;
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(render, 0, 0, W, H);

  // a dark veil at the bottom, for the credit and (stronger) the title
  const veil = ctx.createLinearGradient(0, H * 0.55, 0, H);
  veil.addColorStop(0, 'rgba(20, 18, 15, 0)');
  veil.addColorStop(1, `rgba(20, 18, 15, ${0.3 + 0.35 * titleAlpha})`);
  ctx.fillStyle = veil;
  ctx.fillRect(0, H * 0.55, W, H * 0.45);

  const serif = "ui-serif, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";
  const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  const pad = Math.round(W * 0.08);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = Math.round(W * 0.012);

  const title = info.title.trim();
  const subtitle = info.subtitle?.trim() ?? '';
  if (titleAlpha > 0 && (title || subtitle)) {
    ctx.globalAlpha = titleAlpha;
    let size = Math.round(W * 0.092);
    ctx.font = `500 ${size}px ${serif}`;
    while (ctx.measureText(title).width > W - 2 * pad && size > 24) {
      size -= 3;
      ctx.font = `500 ${size}px ${serif}`;
    }
    const y = H * 0.8;
    ctx.fillStyle = '#c8431a';
    ctx.shadowBlur = 0;
    const bar = Math.round(W * 0.07);
    ctx.fillRect(W / 2 - bar / 2, y - size * 1.25, bar, Math.max(3, Math.round(W * 0.005)));
    ctx.shadowBlur = Math.round(W * 0.012);
    ctx.fillStyle = '#ffffff';
    if (title) ctx.fillText(title, W / 2, y);
    if (subtitle) {
      let sub = Math.round(size * 0.48);
      ctx.font = `italic 400 ${sub}px ${serif}`;
      while (ctx.measureText(subtitle).width > W - 2 * pad && sub > 16) {
        sub -= 2;
        ctx.font = `italic 400 ${sub}px ${serif}`;
      }
      ctx.fillText(subtitle, W / 2, y + sub * 1.6);
    }
  }

  // the data credit the licences ask for, on every frame
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#ffffff';
  ctx.shadowBlur = Math.round(W * 0.006);
  const parts = ATTRIBUTION_TEXT.split(' · ');
  const half = Math.ceil(parts.length / 2);
  const small = Math.round(W * 0.02);
  ctx.font = `400 ${small}px ${sans}`;
  ctx.fillText(parts.slice(0, half).join(' · '), W / 2, H - small * 2.9);
  ctx.fillText(parts.slice(half).join(' · '), W / 2, H - small * 1.5);
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.textAlign = 'start';
}
