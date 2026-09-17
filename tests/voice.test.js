'use strict';

/* Ce module ne cherche jamais de produit lui-même : il extrait une quantité
   et une requête depuis une phrase dictée, en pur texte. Le vrai test — la
   recherche, l'ouverture de la carte de portion, la confirmation obligatoire
   — est côté app.js (tests-browser/comparaison.js). Ici on vérifie seulement
   que la compréhension de la phrase est correcte et honnête sur ses limites. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, plain } = require('./test-env');

function env() {
  return loadScript('js/portion.js', {}); // charge Portion dans window, réutilisé ensuite
}

function withVoice() {
  const sandbox = env();
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'voice.js'), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'js/voice.js' });
  return sandbox;
}

test('les deux exemples demandés sont compris correctement', () => {
  const { Voice } = withVoice();

  const barquettes = Voice.parse('je mange 2 barquettes de LU');
  assert.deepEqual(plain(barquettes), {
    quantite: 2, unite: 'barquette', requete: 'LU', brut: 'je mange 2 barquettes de LU'
  });

  const petitBeurre = Voice.parse('je mange 4 petit beurre de LU');
  assert.deepEqual(plain(petitBeurre), {
    quantite: 4, unite: null, requete: 'petit beurre de LU',
    brut: 'je mange 4 petit beurre de LU'
  });
});

test('la quantité se comprend aussi en toutes lettres', () => {
  const { Voice } = withVoice();
  assert.deepEqual(plain(Voice.parse('je mange trois yaourts nature')),
    { quantite: 3, unite: 'yaourt', requete: 'nature',
      brut: 'je mange trois yaourts nature' });
  assert.deepEqual(plain(Voice.parse('un yaourt')),
    { quantite: 1, unite: 'yaourt', requete: 'yaourt', brut: 'un yaourt' });
});

test('sans quantité en tête de phrase, on renvoie null plutôt que deviner', () => {
  const { Voice } = withVoice();
  assert.equal(Voice.parse('riz'), null);
  assert.equal(Voice.parse('un bon repas avec des amis'), null,
    '« un » est aussi l\'article indéfini : sans nom d\'unité reconnu juste après, ce n\'est pas une quantité');
  assert.equal(Voice.parse('une belle assiette'), null);
  assert.equal(Voice.parse(''), null);
  assert.equal(Voice.parse(null), null);
  assert.equal(Voice.parse('   '), null);
});

test('une quantité déraisonnable est refusée plutôt qu\'acceptée telle quelle', () => {
  const { Voice } = withVoice();
  assert.equal(Voice.parse('je mange 50 barquettes de LU'), null,
    'au-delà de MAX_QUANTITE, la dictée s\'est probablement trompée');
  assert.equal(Voice.parse('je mange 0 yaourt'), null);
  assert.equal(Voice.parse('je mange -2 yaourts'), null);
});

test('plusieurs formulations d\'intention sont reconnues, mais seulement en tête', () => {
  const { Voice } = withVoice();
  assert.equal(Voice.parse('2 barquettes de LU').requete, 'LU');
  assert.equal(Voice.parse("j'ai mangé 2 barquettes de LU").requete, 'LU');
  assert.equal(Voice.parse("j'ai pris 2 barquettes de LU").requete, 'LU');
  assert.equal(Voice.parse('ajoute 2 barquettes de LU').requete, 'LU');
  // « ajoute » au milieu de la phrase ne doit pas être traité comme un préfixe.
  assert.equal(Voice.parse('2 barquettes ajoute de LU').requete, 'ajoute de LU');
});

test('sans le connecteur « de », la requête reste ce qui suit l\'unité', () => {
  const { Voice } = withVoice();
  assert.deepEqual(plain(Voice.parse('6 yaourts nature')),
    { quantite: 6, unite: 'yaourt', requete: 'nature', brut: '6 yaourts nature' });
});

test('supported() ne dépend que de la présence de l\'API du navigateur', () => {
  const sansAPI = withVoice();
  assert.equal(sansAPI.Voice.supported(), false);

  const avecWebkit = env();
  avecWebkit.webkitSpeechRecognition = function () {};
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'voice.js'), 'utf8'),
    avecWebkit, { filename: 'js/voice.js' });
  assert.equal(avecWebkit.Voice.supported(), true);
});
