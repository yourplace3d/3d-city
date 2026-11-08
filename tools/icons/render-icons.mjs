/**
 * Renders an app's PNG icons from its SVG, the way the main app's are made: 192 and 512 px with
 * the rounded square on transparent, a full-bleed 512 px maskable icon (the art at 78 %, inside the
 * safe zone) and a full-bleed 180 px Apple touch icon.
 *
 *   node tools/icons/render-icons.mjs public/data   (reads icon.svg there, writes the PNGs next to it)
 *
 * Needs Playwright with Chromium.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/icons/render-icons.mjs <folder with icon.svg>');
  process.exit(2);
}
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');
const BG = '#ebe6dc';
const jobs = [
  { file: 'icon-192.png', size: 192, scale: 1, bg: 'transparent' },
  { file: 'icon-512.png', size: 512, scale: 1, bg: 'transparent' },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.78, bg: BG },
  { file: 'apple-touch-icon.png', size: 180, scale: 1, bg: BG },
];
const browser = await chromium.launch();
try {
  for (const j of jobs) {
    const page = await browser.newPage({ viewport: { width: j.size, height: j.size }, deviceScaleFactor: 1 });
    const art = Math.round(j.size * j.scale);
    await page.setContent(
      `<html><body style="margin:0;background:${j.bg};display:grid;place-items:center;width:${j.size}px;height:${j.size}px">` +
        `<div style="width:${art}px;height:${art}px">${svg.replace('<svg ', `<svg width="${art}" height="${art}" `)}</div></body></html>`,
    );
    await page.screenshot({ path: join(dir, j.file), omitBackground: j.bg === 'transparent' });
    await page.close();
    console.log(`${join(dir, j.file)} (${j.size} px)`);
  }
} finally {
  await browser.close();
}
