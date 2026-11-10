/**
 * A small play button in the panel's bar, so a layer that moves in time (the timetable, the
 * traffic counts, a route) plays with the panel closed too. It stands in for the panel's own
 * Replay button, of the layer shown or else of the route, and shows its state and the time it is
 * at (the button's data-clock, which each layer keeps up to date).
 */

import { t } from '../i18n';

/** the panel's Replay buttons, the data layers' before the route's */
const REPLAYS = ['transit-play', 'traffic-play', 'route-play'];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The Replay button the quick one stands in for: one that is shown in the panel, if any. */
function current(): HTMLElement | undefined {
  return REPLAYS.map((id) => $(id)).find((b) => b && !b.closest('[hidden]'));
}

export function bindQuickPlay(): void {
  const quick = $<HTMLButtonElement>('quick-play');
  const clock = $('quick-clock');
  const update = () => {
    const b = current();
    if (quick.hidden !== !b) quick.hidden = !b;
    if (!b) return;
    const playing = b.getAttribute('aria-pressed') === 'true';
    const label = playing ? t.routePause : t.routePlay;
    if (quick.getAttribute('aria-pressed') !== String(playing)) quick.setAttribute('aria-pressed', String(playing));
    if (quick.getAttribute('aria-label') !== label) {
      quick.setAttribute('aria-label', label);
      quick.title = label;
    }
    const text = b.dataset.clock ?? '';
    if (clock.textContent !== text) clock.textContent = text;
  };
  new MutationObserver(update).observe($('sheet-body'), { subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-pressed', 'data-clock'] });
  quick.addEventListener('click', () => current()?.click());
  update();
}
