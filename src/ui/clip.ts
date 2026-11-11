/**
 * A clip of a layer that moves in time, as an MP4 to share: 12 seconds, square (1080 × 1080),
 * the camera turning slowly, the title on top and the clock and the data's credits at the
 * bottom, like the image. Made frame by frame on the device (WebCodecs), so a slow phone makes
 * the same smooth clip, only more slowly. Nothing is uploaded.
 *
 * Loaded only when a clip is asked for (it brings the MP4 writer with it).
 */

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Viewer } from '../scene/viewer';
import { ATTRIBUTION_TEXT } from './poster';
import { CLIP_SECONDS, type ClipFrame, type ClipSource } from './clipSource';

export const CLIP_SIZE = 1080;
const FPS = 30;
const BITRATE = 6_000_000;
/** a key frame every two seconds */
const KEY_EVERY = FPS * 2;
/** the camera turns this far over the clip (degrees) */
const TURN_DEG = 24;
/** encoded frames waiting at most */
const QUEUE = 4;

/** H.264 first (what every phone and app plays), High, Main, then Baseline; VP9 where there's none. */
const CODECS: Array<{ codec: string; kind: 'avc' | 'vp9' }> = [
  { codec: 'avc1.640028', kind: 'avc' },
  { codec: 'avc1.4D0028', kind: 'avc' },
  { codec: 'avc1.42E028', kind: 'avc' },
  { codec: 'vp09.00.40.08', kind: 'vp9' },
];

export interface ClipInfo {
  title: string;
  subtitle?: string;
  /** the data layer's credit, above the map's */
  credit?: string;
}

/** Whether this browser can make clips at all (the button shows only then). */
export function clipsPossible(): boolean {
  return 'VideoEncoder' in window && 'VideoFrame' in window;
}

async function pickCodec(size: number): Promise<(typeof CODECS)[number] | null> {
  for (const c of CODECS) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported(encoderConfig(c, size));
      if (supported) return c;
    } catch {
      /* try the next */
    }
  }
  return null;
}

function encoderConfig(c: (typeof CODECS)[number], size: number): VideoEncoderConfig {
  return {
    codec: c.codec,
    width: size,
    height: size,
    bitrate: BITRATE,
    framerate: FPS,
    ...(c.kind === 'avc' ? { avc: { format: 'avc' as const } } : {}),
  };
}

const ease = (k: number) => 0.5 - 0.5 * Math.cos(Math.PI * k);
const serif = "ui-serif, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";
const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Shrink a font until the text fits. */
function fit(ctx: CanvasRenderingContext2D, text: string, font: (px: number) => string, px: number, maxW: number, minPx: number): number {
  ctx.font = font(px);
  while (px > minPx && ctx.measureText(text).width > maxW) {
    px -= 1;
    ctx.font = font(px);
  }
  return px;
}

/** What stays the same on every frame: the background under the model, and the text over it. */
function makeChrome(size: number, info: ClipInfo): { under: HTMLCanvasElement; over: HTMLCanvasElement } {
  const under = document.createElement('canvas');
  under.width = under.height = size;
  const u = under.getContext('2d')!;
  const bg = u.createRadialGradient(size / 2, size * 0.4, size * 0.1, size / 2, size * 0.5, size * 0.9);
  bg.addColorStop(0, '#f6f3ee');
  bg.addColorStop(1, '#dfd9ce');
  u.fillStyle = bg;
  u.fillRect(0, 0, size, size);

  const over = document.createElement('canvas');
  over.width = over.height = size;
  const o = over.getContext('2d')!;
  const pad = Math.round(size * 0.045);
  // soft bands, so the text reads over the model
  const top = o.createLinearGradient(0, 0, 0, size * 0.2);
  top.addColorStop(0, 'rgba(246, 243, 238, 0.92)');
  top.addColorStop(1, 'rgba(246, 243, 238, 0)');
  o.fillStyle = top;
  o.fillRect(0, 0, size, size * 0.2);
  const bottom = o.createLinearGradient(0, size * 0.74, 0, size);
  bottom.addColorStop(0, 'rgba(246, 243, 238, 0)');
  bottom.addColorStop(1, 'rgba(246, 243, 238, 0.94)');
  o.fillStyle = bottom;
  o.fillRect(0, size * 0.74, size, size * 0.26);

  o.textBaseline = 'alphabetic';
  o.fillStyle = '#c8431a';
  o.fillRect(pad, pad, Math.round(size * 0.05), Math.max(3, Math.round(size * 0.004)));
  o.fillStyle = '#1e1c19';
  const titlePx = fit(o, info.title, (px) => `500 ${px}px ${serif}`, Math.round(size * 0.052), size - 2 * pad, 20);
  o.fillText(info.title, pad, pad + size * 0.018 + titlePx);
  const sub = info.subtitle?.trim();
  if (sub) {
    o.fillStyle = '#3a352f';
    const subPx = fit(o, sub, (px) => `italic 400 ${px}px ${serif}`, Math.round(titlePx * 0.5), size - 2 * pad, 12);
    o.fillText(sub, pad, pad + size * 0.018 + titlePx * 1.2 + subPx);
  }

  // credits: the data's, then the map's
  o.fillStyle = '#7a7368';
  const line = Math.round(size * 0.0135);
  const mapPx = fit(o, ATTRIBUTION_TEXT, (px) => `400 ${px}px ${sans}`, line, size - 2 * pad, 8);
  o.fillText(ATTRIBUTION_TEXT, pad, size - pad * 0.75);
  if (info.credit) {
    fit(o, info.credit, (px) => `400 ${px}px ${sans}`, line, size - 2 * pad, 8);
    o.fillText(info.credit, pad, size - pad * 0.75 - mapPx * 1.5);
  }
  return { under, over };
}

/** The clock of a frame, above the credits. */
function drawClock(ctx: CanvasRenderingContext2D, size: number, f: ClipFrame, credit: boolean): void {
  const pad = Math.round(size * 0.045);
  const line = Math.round(size * 0.0135);
  const base = size - pad * 0.75 - line * (credit ? 3 : 1.5) - size * 0.02;
  ctx.textBaseline = 'alphabetic';
  let y = base;
  if (f.note) {
    ctx.fillStyle = '#5c564d';
    ctx.font = `500 ${Math.round(size * 0.022)}px ${sans}`;
    ctx.fillText(f.note, pad, y);
    y -= size * 0.034;
  }
  ctx.fillStyle = '#1e1c19';
  ctx.font = `600 ${Math.round(size * 0.06)}px ${sans}`;
  ctx.fillText(f.clock, pad, y);
}

/** Thrown when the clip was cancelled (the dialog closed). */
export class ClipCancelled extends Error {}

/**
 * Make the clip: the source's layer at each frame, the camera turning from where it is. The
 * layer, the camera and the screen are put back as they were, whatever happens.
 */
export async function makeClip(viewer: Viewer, source: ClipSource, info: ClipInfo, onProgress: (k: number) => void, signal: AbortSignal, seconds = CLIP_SECONDS): Promise<Blob> {
  const choice = await pickCodec(CLIP_SIZE);
  if (!choice) throw new Error('no video encoder for the clip');
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: choice.kind, width: CLIP_SIZE, height: CLIP_SIZE, frameRate: FPS }, fastStart: 'in-memory' });
  let failure: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (failure = e),
  });
  encoder.configure(encoderConfig(choice, CLIP_SIZE));

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CLIP_SIZE;
  const ctx = canvas.getContext('2d')!;
  const chrome = makeChrome(CLIP_SIZE, info);
  const cam = viewer.getCameraState();
  const frames = viewer.beginFrames(CLIP_SIZE, CLIP_SIZE, { hideScreen: true });
  const total = Math.max(2, Math.round(seconds * FPS));
  try {
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new ClipCancelled();
      if (failure) throw failure;
      const k = i / (total - 1);
      viewer.setCameraState({ ...cam, azimuth: cam.azimuth + TURN_DEG * ease(k) });
      const label = source.at(k);
      const gl = frames.frame();
      ctx.drawImage(chrome.under, 0, 0);
      ctx.drawImage(gl, 0, 0, CLIP_SIZE, CLIP_SIZE);
      ctx.drawImage(chrome.over, 0, 0);
      drawClock(ctx, CLIP_SIZE, label, !!info.credit);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      encoder.encode(frame, { keyFrame: i % KEY_EVERY === 0 });
      frame.close();
      onProgress((i + 1) / total);
      // let the page breathe, and the encoder catch up
      await new Promise((r) => setTimeout(r, 0));
      while (encoder.encodeQueueSize > QUEUE && !failure) await new Promise((r) => setTimeout(r, 10));
    }
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    frames.end();
    viewer.setCameraState(cam);
    source.done();
  }
  return new Blob([target.buffer], { type: 'video/mp4' });
}
