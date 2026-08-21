/* Extrait SYSTEM_PROMPT et le prompt utilisateur photo depuis js/estimator.js,
   sans transcription manuelle : le littéral de tableau est évalué tel quel, et
   buildUserPrompt est appelé pour de vrai. Une retranscription à la main dérive
   silencieusement — c'est exactement ce qui est arrivé au USER_PROMPT figé dans
   run.py, resté sur la formulation « objet-repère » que l'application a
   abandonnée, et qui contredit désormais la consigne A du prompt système.

   Usage : node bench/extract-prompts.mjs <chemin estimator.js> <sortie système> */
import fs from 'node:fs';
import vm from 'node:vm';

const [, , source, sortieSysteme, sortieUser] = process.argv;
if (!source || !sortieSysteme) {
  console.error('usage: extract-prompts.mjs <estimator.js> <system.txt> [user.txt]');
  process.exit(2);
}

const code = fs.readFileSync(source, 'utf8');

function litteral(nom) {
  const debut = code.indexOf('var ' + nom + ' = [');
  if (debut < 0) throw new Error(nom + ' introuvable dans ' + source);
  const ouvrante = code.indexOf('[', debut);
  const fermante = code.indexOf("].join('\\n')", ouvrante);
  if (fermante < 0) throw new Error(nom + " : fin de littéral introuvable");
  return vm.runInNewContext(code.slice(ouvrante, fermante + 1)).join('\n');
}

fs.writeFileSync(sortieSysteme, litteral('SYSTEM_PROMPT'));
console.error(sortieSysteme + ' : ' + litteral('SYSTEM_PROMPT').length + ' caractères');

/* Le prompt utilisateur n'est pas un littéral : il se construit. On charge donc
   le module dans un bac à sable minimal et on appelle la vraie fonction, dans
   la configuration du banc — photo, une vue, sans carte, sans notes. */
if (sortieUser) {
  const sandbox = {
    window: {}, document: undefined,
    Storage: { DEFAULT_MODELS: {}, getBiasByCategory: () => [], getBias: () => null }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox);
  /* mealAt volontairement invalide : mealMoment() renvoie alors '' et le bloc
     « CONTEXTE DU REPAS » disparaît. Sans ça le prompt dépendrait de l'HEURE à
     laquelle le banc tourne — « déjeuner » le midi, « collation » la nuit — et
     deux manches ne seraient plus comparables. Les plats de Nutrition5k n'ont
     de toute façon ni heure ni lieu : le banc mesure la vision seule, comme le
     protocole publié (« sans notes ni extras ni bloc de calibration »). */
  const prompt = sandbox.Estimator.buildPhotoPrompt({
    imageCount: 1, referenceMode: 'none', viewMeasurements: [],
    mealAt: NaN, venue: ''
  });
  fs.writeFileSync(sortieUser, prompt);
  console.error(sortieUser + ' : ' + prompt.length + ' caractères');
}
