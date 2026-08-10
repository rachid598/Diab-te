'use strict';

/* La question de clarification est la seule façon d'obtenir une information que
   AUCUN modèle ne peut deviner : sous des fruits rouges, un yaourt (≈5 g/100 g)
   et un porridge (≈12 g/100 g) donnent la même photo, et plus de 20 g d'écart
   sur le total.

   Le champ est déclaré PAR LE MODÈLE, y compris l'enjeu en grammes qui décide
   si on dérange l'utilisateur. Il a donc tout intérêt à le gonfler pour
   justifier sa question. Tout est revalidé ici. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript, plain } = require('./test-env');

const { Estimator } = loadScript('js/estimator.js');
const c = Estimator.sanitizeClarification;

const bonne = {
  question: 'Sous les fruits rouges, c\'est du yaourt ou du porridge ?',
  options: ['Yaourt', 'Porridge', 'Autre'],
  impactCarbsG: 22
};

test('une question utile passe telle quelle', () => {
  const r = c(bonne);
  assert.equal(r.question, bonne.question);
  assert.deepEqual(plain(r.options), ['Yaourt', 'Porridge', 'Autre']);
  assert.equal(r.impactCarbsG, 22);
});

test('sous le seuil, on ne dérange pas', () => {
  /* Une question posée pour rien fait fermer l'application, et la suivante —
     celle qui aurait servi — ne sera plus lue. Le seuil protège les questions
     qui comptent, pas l'utilisateur. */
  assert.equal(c(Object.assign({}, bonne, { impactCarbsG: 9 })), null);
  assert.equal(c(Object.assign({}, bonne, { impactCarbsG: 0 })), null);
  assert.equal(Estimator.CLARIF_SEUIL_G, 10, 'le seuil est explicite, pas magique');
  assert.ok(c(Object.assign({}, bonne, { impactCarbsG: 10 })), 'la borne elle-même passe');
});

test('un enjeu annoncé absurde est ramené à un plafond', () => {
  // 900 g de glucides d'écart n'existe pas dans une assiette.
  assert.equal(c(Object.assign({}, bonne, { impactCarbsG: 900 })).impactCarbsG, 300);
});

test('un enjeu non chiffré ne vaut pas question', () => {
  // Sans nombre, rien ne permet de dire si ça mérite d'interrompre le repas.
  assert.equal(c(Object.assign({}, bonne, { impactCarbsG: null })), null);
  assert.equal(c(Object.assign({}, bonne, { impactCarbsG: 'beaucoup' })), null);
  assert.equal(c(Object.assign({}, bonne, { impactCarbsG: undefined })), null);
});

test('une question sans vrai choix n\'est pas une question', () => {
  // Une seule option, c'est une affirmation déguisée en question.
  assert.equal(c(Object.assign({}, bonne, { options: ['Yaourt'] })), null);
  assert.equal(c(Object.assign({}, bonne, { options: [] })), null);
  assert.equal(c(Object.assign({}, bonne, { options: 'Yaourt ou porridge' })), null);
});

test('les options vides ou démesurées sont écartées', () => {
  const r = c(Object.assign({}, bonne, {
    options: ['Yaourt', '', '   ', 'Porridge', 'x'.repeat(80)]
  }));
  assert.deepEqual(plain(r.options), ['Yaourt', 'Porridge']);
});

test('jamais plus de quatre options', () => {
  // Au-delà, ce n'est plus un choix rapide devant une assiette qui refroidit.
  const r = c(Object.assign({}, bonne, { options: ['a', 'b', 'c', 'd', 'e', 'f'] }));
  assert.equal(r.options.length, 4);
});

test('une question absente, vide ou interminable ne s\'affiche pas', () => {
  assert.equal(c(null), null);
  assert.equal(c(undefined), null);
  assert.equal(c({}), null);
  assert.equal(c(Object.assign({}, bonne, { question: '   ' })), null);
  assert.equal(c(Object.assign({}, bonne, { question: 'x'.repeat(250) })), null);
  assert.equal(c('yaourt ou porridge ?'), null, 'une chaîne n\'est pas une question valide');
});

/* Les deux tests suivants passent par le VRAI chemin d'estimation, avec un
   fetch simulé. Une première version testait recompute() sur un objet qui
   portait déjà le champ : il survivait par simple recopie, et débrancher
   sanitize() ne faisait rien échouer. Le test passait pour une mauvaise
   raison — exactement le genre de vert creux qu'on traque ici. */
function estimeAvec(reponseModele) {
  const sandbox = loadScript('js/estimator.js', {
    setTimeout: (fn) => { fn(); return 0; },
    fetch: () => Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(reponseModele) }] } }]
      }))
    })
  });
  return sandbox.Estimator.estimateWith('gemini',
    [{ base64: 'AAAA', mediaType: 'image/jpeg' }], { imageCount: 1 },
    { apiKeys: { gemini: 'k' }, models: { gemini: 'gemini-3.1-flash-lite' } });
}

const REPAS = {
  seen: 'Un bol de préparation blanche avec des fruits rouges.',
  items: [{ name: 'porridge', estimatedMassG: 200, carbDensityPer100g: 12,
            carbsG: 24, confidence: 'medium' }],
  totalCarbsG: 24, rangeLowG: 18, rangeHighG: 30, overallConfidence: 'medium'
};

test('la question arrive jusqu\'au résultat, en passant par la normalisation', () => {
  return estimeAvec(Object.assign({}, REPAS, { clarification: bonne }))
    .then(function (r) {
      assert.ok(r.clarification, 'le champ doit être branché sur sanitize()');
      assert.equal(r.clarification.impactCarbsG, 22);
      assert.equal(r.clarification.options.length, 3);
    });
});

test('une question sous le seuil n\'atteint jamais l\'écran', () => {
  return estimeAvec(Object.assign({}, REPAS, {
    clarification: Object.assign({}, bonne, { impactCarbsG: 4 })
  })).then(function (r) {
    assert.equal(r.clarification, null);
  });
});

test('un repas sans question ne fabrique rien', () => {
  return estimeAvec(REPAS).then(function (r) {
    assert.equal(r.clarification, null);
  });
});
