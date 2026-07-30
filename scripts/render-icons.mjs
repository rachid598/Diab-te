/* Régénère les icônes PNG à partir des SVG sources, via Chromium.
   Les PNG livrés jusqu'à la v43 étaient tronqués : le contenu s'arrêtait entre
   52 % et 83 % de la hauteur selon le fichier, ce qui coupait la goutte et le
   bas de l'assiette — visible dans l'en-tête de l'app comme sur l'icône de
   l'écran d'accueil. Les SVG, eux, étaient intacts : c'est l'export qui était
   fautif. D'où ce script, pour que le rendu soit reproductible et vérifié.

   Usage, depuis la racine du dépôt :
     npm i --no-save playwright && node scripts/render-icons.mjs
   CHROMIUM_PATH permet de pointer un Chromium déjà installé au lieu d'en
   télécharger un. */
import { chromium } from 'playwright';
import fs from 'fs';

const JOBS = [
  { svg: 'icons/icon.svg',          out: 'icons/icon-180.png', size: 180 },
  { svg: 'icons/icon.svg',          out: 'icons/icon-192.png', size: 192 },
  { svg: 'icons/icon.svg',          out: 'icons/icon-512.png', size: 512 },
  { svg: 'icons/icon-maskable.svg', out: 'icons/icon-maskable-512.png', size: 512 },
];

const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
for (const j of JOBS) {
  const svg = fs.readFileSync(j.svg, 'utf8');
  const p = await b.newPage({ viewport: { width: j.size, height: j.size }, deviceScaleFactor: 1 });
  await p.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
     svg{display:block;width:${j.size}px;height:${j.size}px}</style>${svg}`,
    { waitUntil: 'load' });
  await p.waitForTimeout(120);
  await p.screenshot({ path: j.out, omitBackground: true,
                       clip: { x: 0, y: 0, width: j.size, height: j.size } });
  await p.close();
  console.log('rendu', j.out, j.size + 'px');
}
await b.close();
