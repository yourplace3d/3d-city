import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appBody } from '../src/build/appBody';

const template = readFileSync('src/app-body.html', 'utf8');

describe('the two apps’ pages', () => {
  const place = appBody('place', template);
  const data = appBody('data', template);

  it('give Your Place its own parts only: no data layers', () => {
    expect(place).toContain('id="stl-btn"');
    expect(place).toContain('id="presets"');
    expect(place).not.toMatch(/data-layer-group|route-control|route-file|steep-legend|layer-cards|print-route/);
    expect(place).toContain('href="./data/"');
    expect(place).toContain('href="./about/"');
  });

  it('give Your Place · Data its own parts only: the layers, and the route in the 3D print', () => {
    expect(data).toMatch(/data-layer-group[\s\S]*route-control/);
    expect(data).toContain('id="route-file"');
    expect(data).toMatch(/id="stl-btn"[\s\S]*|print-route/);
    expect(data).toContain('id="print-route"');
    expect(data).not.toMatch(/id="presets"/);
    expect(data).toContain('href="../about/"');
    expect(data).toContain('id="other-app" href="../"');
  });

  it('leave no markers, placeholders or duplicate ids behind', () => {
    for (const html of [place, data]) {
      expect(html).not.toMatch(/only:|%ROOT%|app-body marker/);
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    }
  });

  it('have both pages ask for the shared body', () => {
    for (const [file, app] of [
      ['index.html', 'place'],
      ['data/index.html', 'data'],
    ]) {
      const page = readFileSync(file, 'utf8');
      expect(page).toContain(`<body data-app="${app}">`);
      expect(page).toContain('<!-- app-body -->');
    }
  });
});
