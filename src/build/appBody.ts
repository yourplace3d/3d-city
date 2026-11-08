/**
 * Build time only (vite.config.ts): the body both apps share, for one of them. The other app's
 * parts (between only:place / only:data markers) are left out, the markers and the template's
 * leading comment go, and %ROOT% becomes the way back to the site's root from that page.
 */
export type AppName = 'place' | 'data';

export function appBody(app: AppName, template: string): string {
  const other = app === 'place' ? 'data' : 'place';
  return template
    .replace(/^<!--[\s\S]*?-->\n/, '')
    .replace(new RegExp(`[ \\t]*<!-- only:${other} -->[\\s\\S]*?<!-- /only:${other} -->\\n?`, 'g'), '')
    .replace(new RegExp(`[ \\t]*<!-- /?only:${app} -->\\n?`, 'g'), '')
    .replaceAll('%ROOT%', app === 'data' ? '../' : './');
}
