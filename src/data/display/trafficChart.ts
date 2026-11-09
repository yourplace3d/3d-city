/**
 * Display: the numbers behind the traffic layer's bar chart (24 hours, one bar each), kept
 * apart from the page so tests can check them. The chart itself is built in src/ui/traffic.ts.
 */

/** Round steps for the chart's value axis: 0 and up to two lines above it, like 0 / 20K / 40K. */
export function chartTicks(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0] };
  const raw = max / 2;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks = [0];
  for (let v = step; v <= max + 1e-9; v += step) ticks.push(v);
  // the top of the chart: the highest bar, or the next line if a bar would touch it
  const top = Math.max(max, ticks[ticks.length - 1]) * 1.08;
  return { top, ticks };
}

/** Each bar's height as a share of the chart (0 … 1); hours without counts are 0. */
export function barShares(values: ArrayLike<number>, top: number): number[] {
  return Array.from(values, (v) => (Number.isNaN(v) || top <= 0 ? 0 : Math.max(0, v) / top));
}
