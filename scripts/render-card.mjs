#!/usr/bin/env node

/**
 * Génère l'image native depuis l'unique source canonique imprimable.
 *
 *   node scripts/render-card.mjs           # régénère le PNG suivi par Git
 *   node scripts/render-card.mjs --check   # vérifie sans modifier le dépôt
 *
 * Le moteur de rendu est @resvg/resvg-js, verrouillé dans package-lock.json.
 * La source ne contient ni police ni élément <text> : le résultat ne dépend
 * donc d'aucune fonte installée sur la machine qui exécute la commande.
 */

import { createHash } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'glucovision-card.svg');
const TARGET = join(ROOT, 'android-card', 'glucovision-card.png');
const WIDTH = 4280;
const HEIGHT = 2699;
const PHYSICAL_WIDTH = '85.60mm';
const PHYSICAL_HEIGHT = '53.98mm';

const usage = 'Usage: node scripts/render-card.mjs [--check]';
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check') || args.filter((arg) => arg === '--check').length > 1) {
  throw new Error(usage);
}
const checkOnly = args.includes('--check');

const svg = await readFile(SOURCE, 'utf8');

function requireMatch(pattern, message) {
  if (!pattern.test(svg)) throw new Error(message);
}

requireMatch(/<svg\b[^>]*\bwidth="85\.60mm"/i,
  `La largeur physique doit rester ${PHYSICAL_WIDTH}.`);
requireMatch(/<svg\b[^>]*\bheight="53\.98mm"/i,
  `La hauteur physique doit rester ${PHYSICAL_HEIGHT}.`);
requireMatch(/<svg\b[^>]*\bviewBox="0 0 4280 2699"/i,
  `Le viewBox doit rester 0 0 ${WIDTH} ${HEIGHT}.`);
if (/<text\b/i.test(svg)) {
  throw new Error('La carte contient encore un élément <text> : vectoriser tous les libellés.');
}
for (const label of [
  'GLUCOVISION',
  'CARTE REPÈRE • BÊTA TERRAIN',
  'GV2',
  'LIGNE TÉMOIN 50 mm',
  'IMPRIMER À 100 % • SANS AJUSTEMENT',
  'Vérifier que la ligne mesure 50 mm avant utilisation.'
]) {
  if (!svg.includes(`aria-label="${label}"`)) {
    throw new Error(`Libellé vectoriel ou description accessible absent : ${label}`);
  }
}

function render() {
  const renderer = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: { loadSystemFonts: false }
  });
  const image = renderer.render();
  if (image.width !== WIDTH || image.height !== HEIGHT) {
    throw new Error(`Rendu invalide : ${image.width}×${image.height}, attendu ${WIDTH}×${HEIGHT}.`);
  }
  return Buffer.from(image.asPng());
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function dimensions(png) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(signature) || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Le moteur de rendu n’a pas produit un PNG valide.');
  }
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

const first = render();
const second = render();
if (!first.equals(second)) {
  throw new Error('Deux rendus successifs ne sont pas byte-identiques.');
}
const [pngWidth, pngHeight] = dimensions(first);
if (pngWidth !== WIDTH || pngHeight !== HEIGHT) {
  throw new Error(`PNG invalide : ${pngWidth}×${pngHeight}, attendu ${WIDTH}×${HEIGHT}.`);
}

const digest = sha256(first);
if (checkOnly) {
  let committed;
  try {
    committed = await readFile(TARGET);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`PNG absent : ${TARGET}`);
    }
    throw error;
  }
  if (!first.equals(committed)) {
    throw new Error(
      `Le PNG suivi par Git ne vient pas du SVG canonique.\n` +
      `attendu ${digest}\n` +
      `trouvé  ${sha256(committed)}\n` +
      'Exécuter : node scripts/render-card.mjs'
    );
  }
  console.log(`Carte v2 conforme : ${WIDTH}×${HEIGHT}, SHA-256 ${digest}`);
} else {
  const temporary = `${TARGET}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, first, { flag: 'wx' });
    await rename(temporary, TARGET);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  console.log(`Carte v2 générée : ${TARGET}`);
  console.log(`${WIDTH}×${HEIGHT}, SHA-256 ${digest}`);
}
