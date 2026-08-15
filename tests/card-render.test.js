'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const SVG_PATH = resolve(ROOT, 'glucovision-card.svg');
const PNG_PATH = resolve(ROOT, 'android-card', 'glucovision-card.png');

test('la carte v2 est un SVG imprimable sans texte ni dépendance de police', () => {
  const svg = readFileSync(SVG_PATH, 'utf8');

  assert.match(svg, /<svg\b[^>]*\bwidth="85\.60mm"/i);
  assert.match(svg, /<svg\b[^>]*\bheight="53\.98mm"/i);
  assert.match(svg, /<svg\b[^>]*\bviewBox="0 0 4280 2699"/i);
  assert.doesNotMatch(svg, /<text\b/i);
  assert.doesNotMatch(svg, /\bfont(?:-family|-size|-weight)?\s*=/i);

  for (const label of [
    'GLUCOVISION',
    'CARTE REPÈRE • BÊTA TERRAIN',
    'GV2',
    'LIGNE TÉMOIN 50 mm',
    'IMPRIMER À 100 % • SANS AJUSTEMENT',
    'Vérifier que la ligne mesure 50 mm avant utilisation.'
  ]) {
    assert.ok(svg.includes(`aria-label="${label}"`), `libellé vectoriel absent : ${label}`);
  }

  // 50 px/mm : 2 500 unités entre les deux repères donnent exactement 50 mm.
  assert.match(svg, /<line x1="1380" y1="2250" x2="3880" y2="2250"/);
});

test('le PNG natif est le rendu byte-identique du SVG canonique', () => {
  const output = execFileSync(process.execPath, ['scripts/render-card.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.match(output, /Carte v2 conforme : 4280×2699, SHA-256 [a-f0-9]{64}/);

  const png = readFileSync(PNG_PATH);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 4280);
  assert.equal(png.readUInt32BE(20), 2699);
});
