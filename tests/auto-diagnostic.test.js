'use strict';

/* L'auto-diagnostic est ce sur quoi la CI décide qu'un APK est bon.

   S'il annonçait « manques=aucun » alors qu'un plugin requis n'est pas
   enregistré, le test émulateur passerait au vert sur une application amputée —
   et on se retrouverait exactement dans la situation qu'il est censé empêcher :
   un contrôle vert qui ne contrôle rien. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, plain } = require('./test-env');

const TOUS = ['Camera', 'Filesystem', 'CapacitorHttp', 'CapacitorUpdater',
              'SecureStorage', 'LocalNotifications', 'Share', 'App', 'DepthScan'];

/* Un faux Capacitor : isNativePlatform() décide si on se croit dans l'APK, et
   la présence d'une clé décide si le plugin s'est enregistré. */
function natif(presents, plateforme) {
  const Cap = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => plateforme || 'android'
    }
  };
  presents.forEach((p) => { Cap[p] = {}; });
  return loadScript('js/native.js', { Cap: Cap }).Native;
}

test('toutes les capacités présentes : rien ne manque', () => {
  const d = natif(TOUS).selfCheck();
  assert.deepEqual(plain(d.manques), []);
  assert.equal(d.camera, 'ok');
  assert.equal(d.profondeur, 'ok');
  assert.equal(d.platform, 'android');
});

test('un plugin requis absent est signalé, et nommé', () => {
  const d = natif(TOUS.filter((p) => p !== 'Camera')).selfCheck();
  assert.deepEqual(plain(d.manques), ['Camera']);
  assert.equal(d.camera, 'ABSENT');
});

test('la profondeur absente n\'est pas une panne', () => {
  // Un téléphone sans ARCore est le cas NORMAL, et l'émulateur de CI n'en a pas.
  // La compter comme un manque rendrait le diagnostic inutilisable là où il sert.
  const d = natif(TOUS.filter((p) => p !== 'DepthScan')).selfCheck();
  assert.deepEqual(plain(d.manques), []);
  assert.equal(d.profondeur, 'absent');
});

test('plusieurs manques sont tous listés', () => {
  const d = natif(['Camera', 'Filesystem']).selfCheck();
  assert.deepEqual(plain(d.manques).sort(),
    ['App', 'CapacitorHttp', 'CapacitorUpdater', 'LocalNotifications',
     'SecureStorage', 'Share'].sort());
});

test('la ligne des journaux porte la version et l\'état de chaque capacité', () => {
  const ligne = natif(TOUS).selfCheckLine('76');
  assert.match(ligne, /^GLUCOVISION_READY /, 'le marqueur est en tête, greppable');
  assert.match(ligne, /platform=android/);
  assert.match(ligne, /version=76/);
  assert.match(ligne, /camera=ok/);
  assert.match(ligne, /manques=aucun/);
});

test('la ligne nomme les manques au lieu de dire « aucun »', () => {
  const ligne = natif(TOUS.filter((p) => p !== 'SecureStorage')).selfCheckLine('76');
  assert.match(ligne, /coffre=ABSENT/);
  assert.match(ligne, /manques=SecureStorage/);
  assert.doesNotMatch(ligne, /manques=aucun/);
});

test('l\'expression de la CI extrait bien les manques de la ligne', () => {
  // La CI fait : sed -n 's/.*manques=\([^ ]*\).*/\1/p'. Si un champ était ajouté
  // APRÈS manques= et que le séparateur changeait, le test émulateur lirait une
  // valeur tronquée et validerait n'importe quoi.
  const ligne = natif(['Camera']).selfCheckLine('76');
  const m = /manques=([^ ]*)/.exec(ligne);
  assert.ok(m, 'le champ manques est présent et délimité par une espace');
  assert.deepEqual(m[1].split(',').sort(),
    ['App', 'CapacitorHttp', 'CapacitorUpdater', 'Filesystem',
     'LocalNotifications', 'SecureStorage', 'Share'].sort());
});

test('le rapport est écrit dans le cache privé, là où la CI le lit', () => {
  // Le chemin et le nom sont un contrat avec .github/scripts/smoke-apk.sh :
  // s'ils changent ici sans changer là-bas, le test émulateur expire à chaque
  // build sur une application pourtant saine.
  const ecrits = [];
  const Cap = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    Directory: { Cache: 'CACHE', Data: 'DATA' },
    Filesystem: { writeFile: (o) => { ecrits.push(o); return Promise.resolve({}); } }
  };
  TOUS.forEach((p) => { if (!Cap[p]) Cap[p] = {}; });
  const Native = loadScript('js/native.js', { Cap: Cap }).Native;

  return Native.writeStartupReport('76').then((ligne) => {
    assert.equal(ecrits.length, 1);
    assert.equal(ecrits[0].path, 'demarrage.txt');
    assert.equal(ecrits[0].directory, 'CACHE', 'jamais dans les Documents de l\'utilisateur');
    assert.equal(ecrits[0].encoding, 'utf8');
    assert.equal(ecrits[0].data, ligne + '\n');
    assert.match(ligne, /^GLUCOVISION_READY /);
  });
});

test('une écriture impossible ne fait pas échouer le démarrage', () => {
  // Le disque plein ne doit pas empêcher l'app de s'ouvrir. La CI verra
  // l'absence du fichier — c'est justement le signal qu'elle attend.
  const Cap = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    Directory: { Cache: 'CACHE' },
    Filesystem: { writeFile: () => Promise.reject(new Error('disque plein')) }
  };
  TOUS.forEach((p) => { if (!Cap[p]) Cap[p] = {}; });
  const Native = loadScript('js/native.js', { Cap: Cap }).Native;
  return Native.writeStartupReport('76').then((ligne) => {
    assert.match(ligne, /^GLUCOVISION_READY /);
  });
});

test('hors APK, aucune capacité n\'est réclamée', () => {
  // La PWA n'a pas de plugins natifs : elle ne doit pas se déclarer en panne.
  const Native = loadScript('js/native.js', {}).Native;
  const d = Native.selfCheck();
  assert.equal(d.isApp, false);
  assert.equal(d.camera, 'web');
  assert.deepEqual(plain(d.manques), []);
});
