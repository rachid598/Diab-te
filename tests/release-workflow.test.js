'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const bytes = (file) => fs.readFileSync(path.join(ROOT, file));
const digest = (file) => crypto.createHash('sha256').update(bytes(file)).digest('hex');

const workflow = read('.github/workflows/android.yml');
const app = read('js/app.js');
const index = read('index.html');
const worker = read('service-worker.js');
const buildWww = read('scripts/build-www.sh');
const readme = read('README.md');
const manifest = JSON.parse(read('manifest.webmanifest'));
const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));

const CARD_SVG_SHA256 = '2dac92147701d7c9f1f81a6a9f18128a416730859d1b0912da9048d10976096b';
const CARD_PNG_SHA256 = '5636449101e45da4725fcfc16d7037db51d07055f830fb9aa65c6c3bd8d1dd60';

test('la version v84 ou suivante reste synchronisée dans toute la chaîne de publication', () => {
  const appVersion = /APP_VERSION = '(\d+)'/.exec(app);
  const workerVersion = /var VERSION = '(\d+)'/.exec(worker);
  assert.ok(appVersion, 'APP_VERSION absent de js/app.js');
  assert.ok(workerVersion, 'VERSION absente du service worker');
  const expected = appVersion[1];
  assert.ok(Number(expected) >= 84, 'la carte repère exige au minimum la v84');
  assert.equal(workerVersion[1], expected);
  assert.equal(packageJson.version, `1.${expected}.0`);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);

  const assetVersions = new Set(Array.from(index.matchAll(/\?v=(\d+)/g), (m) => m[1]));
  assert.deepEqual(Array.from(assetVersions), [expected],
    `tous les scripts et styles de index.html doivent porter ?v=${expected}`);
  assert.match(manifest.description, /carte repère optionnelle/i);
  assert.match(manifest.description, /ne calcule aucune dose/i);
});

test('le workflow refuse toute branche autre que codex et garde une seule identité', () => {
  const triggerBlock = workflow.slice(0, workflow.indexOf('# Le build'));
  assert.equal((triggerBlock.match(/^\s+- codex$/gm) || []).length, 2,
    'pull_request et push doivent cibler uniquement codex');
  [
    'codex-2', 'sans-relief', 'avec-relief',
    'apk-latest', 'ota-latest', 'apk-stable', 'ota-stable',
    'apk-relief', 'ota-relief', 'io.github.rachid598.glucovision.relief'
  ].forEach((forbidden) => {
    assert.equal(workflow.includes(forbidden), false,
      `ancienne variante encore présente dans le workflow : ${forbidden}`);
  });

  assert.match(workflow, /BRANCH="\$\{GITHUB_BASE_REF:-\$GITHUB_REF_NAME\}"/);
  assert.match(workflow, /if \[\[ "\$BRANCH" != "codex" \]\]; then[\s\S]*?exit 1/);
  assert.doesNotMatch(workflow, /case "\$BRANCH"/,
    'aucune branche ne doit tomber dans une variante par défaut');
  assert.match(workflow, /apk_tag=apk-codex/);
  assert.match(workflow, /ota_tag=ota-codex/);
  assert.match(workflow, /app_id=io\.github\.rachid598\.glucovision/);
  assert.match(workflow, /code_offset=2000/);
  assert.match(workflow, /has_depth=true/);
  assert.match(workflow, /minimum_native_floor=2084/);
  assert.match(workflow,
    /EXPECTED_CERT_SHA256: 6fbba12e3103b5919940ab0de529f900b3ce085c90195f898c9b4ee5265a4a8b/);
  assert.match(workflow,
    /github\.event_name == 'push' &&\s*github\.ref == 'refs\/heads\/codex'/);
});

test('la carte repère imprimable et le PNG natif sont verrouillés octet par octet', () => {
  assert.equal(digest('glucovision-card.svg'), CARD_SVG_SHA256);
  assert.equal(digest('android-card/glucovision-card.png'), CARD_PNG_SHA256);
  assert.match(workflow, new RegExp(`CARD_SVG_SHA256: ${CARD_SVG_SHA256}`));
  assert.match(workflow, new RegExp(`CARD_PNG_SHA256: ${CARD_PNG_SHA256}`));
  assert.match(readme, new RegExp(CARD_SVG_SHA256));
  assert.match(readme, new RegExp(CARD_PNG_SHA256));
  assert.match(readme, /arcoreimg[^\n]*100\/100/i);

  const svg = read('glucovision-card.svg');
  assert.match(svg, /width="85\.60mm" height="53\.98mm" viewBox="0 0 4280 2699"/);
  assert.match(svg, /LIGNE TÉMOIN 50 mm/i);
  assert.match(svg, /IMPRIMER À 100 %/i);
  assert.match(svg, /x1="1380"[^>]*x2="3880"/,
    'la ligne témoin doit mesurer 2500 unités, soit exactement 50 mm');
  assert.doesNotMatch(svg, /<(?:script|foreignObject)\b/i);
  assert.doesNotMatch(svg, /(?:href|src)\s*=\s*["'](?:https?:|data:)/i,
    'le SVG doit rester autonome et sans ressource distante');

  const png = bytes('android-card/glucovision-card.png');
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 4280);
  assert.equal(png.readUInt32BE(20), 2699);
  assert.equal(png[24], 8, 'profondeur PNG attendue : 8 bits');
  assert.ok(png[25] === 2 || png[25] === 6, 'PNG attendu en RGB ou RGBA');
  assert.ok(Math.abs((4280 / 2699) - (85.60 / 53.98)) < 1e-12,
    'le PNG et le format physique doivent avoir exactement le même ratio');
});

test('les deux formes de la carte sont livrées aux bons consommateurs', () => {
  assert.match(buildWww, /cp index\.html manifest\.webmanifest glucovision-card\.svg www\//);
  assert.match(worker, /'\.\/glucovision-card\.svg'/);
  assert.match(workflow,
    /cp android-card\/glucovision-card\.png android\/app\/src\/main\/assets\/glucovision-card\.png/);
  assert.match(workflow,
    /cmp android-card\/glucovision-card\.png android\/app\/src\/main\/assets\/glucovision-card\.png/);
  assert.match(workflow,
    /unzip -p dist\/glucovision\.apk assets\/glucovision-card\.png/);
  assert.match(workflow,
    /cmp glucovision-card\.svg www\/glucovision-card\.svg/);
});
