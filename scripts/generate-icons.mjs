// Renders the PWA icons in public/icons from SVG. Run with `npm run icons` after changing the artwork.
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, writeFileSync } from 'node:fs';

const mark = (stroke) => `
  <path d="M22 18a10 10 0 1 0 0 20c5.6 0 7.8-4.4 7.8-10S32.4 18 38 18a10 10 0 1 1 0 20" fill="none" stroke="${stroke}" stroke-width="5" stroke-linecap="round"/>
  <path d="M22 38c5.6 0 7.8 4.4 7.8 4.4" fill="none" stroke="${stroke}" stroke-width="5" stroke-linecap="round"/>
  <circle cx="44" cy="46" r="4" fill="#f1c164"/>`;

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#b8492f"/>${mark('#fff6ec')}</svg>`;
// Maskable: full-bleed background, artwork inside the 80% safe zone.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#b8492f"/><g transform="translate(9.6 9.6) scale(0.7)">${mark('#fff6ec')}</g></svg>`;
// Apple touch icons get no transparency and their own rounding.
const apple = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#b8492f"/><g transform="translate(4.8 4.8) scale(0.85)">${mark('#fff6ec')}</g></svg>`;
// Android status-bar badge: white silhouette on transparent.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${mark('#ffffff').replace('#f1c164', '#ffffff')}</svg>`;

mkdirSync('public/icons', { recursive: true });
const out = [
  ['icon-192.png', icon, 192],
  ['icon-512.png', icon, 512],
  ['maskable-512.png', maskable, 512],
  ['apple-touch-icon.png', apple, 180],
  ['badge-96.png', badge, 96],
];
for (const [name, svg, size] of out) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(`public/icons/${name}`, png);
  console.log(`public/icons/${name}`);
}
