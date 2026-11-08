/**
 * Time: a playback clock from 0 to 1 over a fixed duration (a replay, later 24 hours of traffic).
 * Driven by the viewer's frames (`advance`), so it costs nothing while paused and stops with the
 * page when the tab is hidden. Never starts by itself: the caller decides (reduced motion).
 */

/** The longest step a frame may take: after a hidden tab or a stall, carry on rather than jump. */
const MAX_STEP_MS = 100;

export class Playback {
  position = 0;
  playing = false;

  constructor(
    public durationMs: number,
    private readonly onChange: (position: number, playing: boolean) => void = () => undefined,
  ) {}

  /** Play from where it is; from the start again once it has finished. */
  play(): void {
    if (this.position >= 1) this.position = 0;
    this.playing = true;
    this.onChange(this.position, true);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.onChange(this.position, false);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(position: number): void {
    this.position = Math.min(1, Math.max(0, position));
    this.onChange(this.position, this.playing);
  }

  /** Back to the start, stopped. */
  reset(): void {
    this.playing = false;
    this.position = 0;
    this.onChange(0, false);
  }

  /** Move on by a frame's time; true if the position changed. Stops at the end. */
  advance(dtMs: number): boolean {
    if (!this.playing || dtMs <= 0) return false;
    this.position = Math.min(1, this.position + Math.min(dtMs, MAX_STEP_MS) / this.durationMs);
    if (this.position >= 1) this.playing = false;
    this.onChange(this.position, this.playing);
    return true;
  }
}
