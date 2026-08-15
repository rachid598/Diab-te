'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const workflow = read('.github/workflows/android.yml');
const smoke = read('.github/scripts/smoke-apk.sh');
const crashDetector = path.join(ROOT, '.github/scripts/logcat-app-crash.sh');
const APP_ID = 'io.github.rachid598.glucovision';

function detect(log) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glucovision-logcat-'));
  const file = path.join(directory, 'logcat.txt');
  fs.writeFileSync(file, log);
  const result = spawnSync('bash', [crashDetector, file, APP_ID], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  fs.rmSync(directory, { recursive: true, force: true });
  return result;
}

test('la CI exécute le binaire arcoreimg officiel, épinglé et avec un seuil explicite', () => {
  assert.match(workflow, /ARCOREIMG_VERSION: 1\.54\.0/);
  assert.match(workflow,
    /ARCOREIMG_LINUX_SHA256: 2585423461c77c02d034ed5333c5054384a5d19ad212f581ad0274198ace60c0/);
  assert.match(workflow,
    /google-ar\/arcore-android-sdk\/\$\{ARCOREIMG_VERSION\}\/tools\/arcoreimg\/linux\/arcoreimg/);
  assert.match(workflow, /sha256sum --check --strict/);
  assert.match(workflow,
    /"\$ARCOREIMG" eval-img[\s\S]*?--input_image_path=android-card\/glucovision-card\.png/);
  assert.match(workflow, /CARD_MIN_ARCOREIMG_SCORE: 75/);
  assert.match(workflow, /test "\$SCORE" -ge "\$CARD_MIN_ARCOREIMG_SCORE"/);
  assert.match(workflow, /npm run card:check/,
    'la CI doit comparer le rendu déterministe au PNG embarqué');
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(workflow, /arcoreimg[^\n]*100\/100/i,
    'le workflow ne doit pas annoncer à l’avance un score parfait');
});

test('le smoke test ignore un FATAL du système Android', () => {
  const result = detect([
    '08-15 10:00:00.000 E AndroidRuntime: FATAL EXCEPTION: main',
    '08-15 10:00:00.001 E AndroidRuntime: Process: android.process.acore, PID: 921',
    '08-15 10:00:00.002 E AndroidRuntime: java.lang.IllegalStateException: système',
    '',
  ].join('\n'));
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
});

test('le smoke test bloque un FATAL de GlucoVision', () => {
  const result = detect([
    '08-15 10:00:00.000 E AndroidRuntime: FATAL EXCEPTION: main',
    `08-15 10:00:00.001 E AndroidRuntime: Process: ${APP_ID}, PID: 598`,
    '08-15 10:00:00.002 E AndroidRuntime: java.lang.IllegalStateException: app',
    '',
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FATAL EXCEPTION: main/);
  assert.match(result.stdout, new RegExp(`Process: ${APP_ID.replaceAll('.', '\\.')},`));
});

test('le smoke test bloque un ANR exact de GlucoVision, pas celui d’un voisin', () => {
  assert.equal(detect(`08-15 E ActivityManager: ANR in ${APP_ID}\n`).status, 0);
  assert.equal(detect(`08-15 E ActivityManager: ANR in ${APP_ID}.helper\n`).status, 1);
});

test('smoke-apk utilise le détecteur ciblé et plus le FATAL global', () => {
  assert.match(smoke,
    /bash \.github\/scripts\/logcat-app-crash\.sh "\$LOG" "\$APP_ID"/);
  assert.doesNotMatch(smoke, /grep -qE "FATAL EXCEPTION\|ANR in \$APP_ID"/);
});
