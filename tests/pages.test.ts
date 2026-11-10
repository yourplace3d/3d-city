import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('index.html', 'utf8');

describe('the page', () => {
  it('is Your Place · Data, with the data layers and the route', () => {
    expect(page).toMatch(/data-layer-group[\s\S]*route-control/);
    expect(page).toContain('id="route-file"');
    expect(page).toContain('id="transit-file"');
    expect(page).toContain('id="poster-btn"');
  });

  it('stands on its own: no 3D print, no way to another app', () => {
    expect(page).not.toMatch(/stl-btn|print-block|print-details|print-size|tiles-range|3D print/);
    expect(page).not.toMatch(/href="\.\.\/|other-app|part-of/);
  });

  it('leaves no placeholders but the site address, and no duplicate ids', () => {
    expect(page).not.toMatch(/only:|%ROOT%|app-body/);
    expect(page).toContain('href="%SITE_URL%"');
    const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});
