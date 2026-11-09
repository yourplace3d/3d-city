/**
 * Labels on the model: a rounded tag with a small tail whose tip stands on the ground (or on top
 * of a column). They keep their size on screen and are drawn over everything, like map labels.
 */

import { CanvasTexture, LinearFilter, Sprite, SpriteMaterial, SRGBColorSpace, type PerspectiveCamera } from 'three';

/** Label height as a share of the view's height (the sprites keep their size on screen). */
const LABEL_SCREEN = 0.026;
/** the light rim around lines and labels */
export const CASING = '#fffdf8';
export const INK = '#1e1c19';

/** A rounded label with a small tail; its tip is the sprite's anchor, on the ground. */
export function makeLabel(text: string, colours: { bg: string; fg: string; border: string }): Sprite {
  const font = "600 30px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  const padX = 16;
  const boxH = 46;
  const tail = 12;
  const line = 4;
  const w = Math.ceil(ctx.measureText(text).width) + padX * 2 + line;
  c.width = w;
  c.height = boxH + tail + line;
  ctx.font = font;
  const x0 = line / 2;
  const y0 = line / 2;
  const bw = w - line;
  const r = 12;
  ctx.beginPath();
  ctx.moveTo(x0 + r, y0);
  ctx.arcTo(x0 + bw, y0, x0 + bw, y0 + boxH, r);
  ctx.arcTo(x0 + bw, y0 + boxH, x0, y0 + boxH, r);
  ctx.lineTo(w / 2 + tail * 0.8, y0 + boxH);
  ctx.lineTo(w / 2, y0 + boxH + tail);
  ctx.lineTo(w / 2 - tail * 0.8, y0 + boxH);
  ctx.arcTo(x0, y0 + boxH, x0, y0, r);
  ctx.arcTo(x0, y0, x0 + bw, y0, r);
  ctx.closePath();
  ctx.fillStyle = colours.bg;
  ctx.fill();
  ctx.lineWidth = line;
  ctx.strokeStyle = colours.border;
  ctx.stroke();
  ctx.fillStyle = colours.fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, y0 + boxH / 2 + 1);

  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  // drawn over everything, like map labels: a marker behind a tower is still readable
  const mat = new SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
  const sprite = new Sprite(mat);
  sprite.center.set(0.5, 0);
  const aspect = c.width / c.height;
  let fitted = 0;
  // the size is a share of the view's height: on a tall phone screen the model only fills the
  // width, so the labels shrink with it (not all the way, so they stay readable)
  sprite.onBeforeRender = (_renderer, _scene, camera) => {
    const k = LABEL_SCREEN * Math.min(1, (camera as PerspectiveCamera).aspect || 1) ** 0.6;
    if (k === fitted) return;
    fitted = k;
    sprite.scale.set(k * aspect, k, 1);
    sprite.updateMatrixWorld();
  };
  sprite.scale.set(LABEL_SCREEN * aspect, LABEL_SCREEN, 1);
  return sprite;
}
