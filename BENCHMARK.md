# Banc d'essai des modèles de vision

Quel modèle d'IA compte le mieux les glucides d'une assiette ? La question n'a pas
de réponse d'opinion : ce chiffre est saisi dans une pompe à insuline. Ce document
décrit la mesure, ses résultats et ce qu'elle ne prouve pas.

Trois manches : 30 juillet 2026 (4,45 $) et 6 août 2026 (3,67 $), sur
OpenRouter. Les résultats des deux dates sont conservés côte à côte — une mesure
qu'on réécrit après coup ne prouve plus rien.

## Vérité terrain

[Nutrition5k](https://github.com/google-research-datasets/Nutrition5k) (Google
Research) : 4 768 plats photographiés à la verticale et **pesés ingrédient par
ingrédient**. La valeur en glucides n'est pas une estimation d'expert, c'est une
mesure.

Le jeu de données contient des annotations aberrantes (un plat à 506 g de
glucides pour 159 g de masse totale, un autre avec 7 974 g de citron). Filtre
appliqué, identique aux garde-fous de plausibilité de l'application :

| critère | intervalle retenu |
|---|---|
| masse totale | 120–900 g |
| glucides | 20–130 g, et jamais supérieurs à la masse |
| densité glucidique | 6–60 g/100 g |
| cohérence calorique | kcal à ±25 % de 4C + 4P + 9L |
| ingrédients | 2 à 7, sans doublon |

**626 plats propres sur 4 768.** L'échantillon final est tiré par tranches de
10 g de glucides, avec des combinaisons d'ingrédients toutes différentes, pour
qu'aucun modèle ne puisse bien s'en tirer en répondant toujours « environ 45 g ».

- Manche 1 : 14 plats, 22,8 → 68,3 g de glucides, 14 modèles
- Manche 2 : 30 plats supplémentaires, 21,4 → 69,9 g, les 6 finalistes

## Protocole

L'appel reproduit **exactement** celui de l'application, sinon la mesure porterait
sur autre chose que le produit :

- `SYSTEM_PROMPT` extrait automatiquement de `js/estimator.js` (évaluation du
  littéral de tableau, aucune retranscription manuelle) ;
- prompt utilisateur en mode photo, vue unique, `referenceObject: 'none'`, sans
  notes ni extras ni bloc de calibration personnelle ;
- `response_format: json_object`, `max_tokens` selon la même règle que
  l'application (16 000 pour les modèles « thinking » et « plus », 8 000 sinon) ;
- photos converties en JPEG qualité 85, comme celles produites par `js/camera.js` ;
- appels **en série** par modèle, 3 tentatives avec repli exponentiel.

Rejouer : `bench/run.py` (déposer la clé OpenRouter dans `bench/.key`, le
catalogue tarifaire dans `bench/models.json` via `GET /api/v1/models`, et le
prompt système dans `bench/system_prompt.txt`), puis `bench/score.py`.

### ⚠️ Ces résultats mesurent un prompt que l'application n'envoie plus

Les chiffres ci-dessous datent de juillet et août 2026. Le prompt a changé depuis,
et les fichiers du banc, eux, n'ont pas suivi :

- `bench/system_prompt.txt` décrit encore l'**objet-repère libre** — pompe, pièce,
  diamètre d'assiette — que la v83 a remplacé par la carte vérifiée par ARCore ;
- le prompt utilisateur figé dans `run.py` demande d'*« estimer l'échelle via
  l'assiette/les couverts »*, ce que la consigne A du prompt système **actuel**
  interdit explicitement. Rejouer tel quel enverrait donc au modèle deux consignes
  contradictoires ;
- la v89 a ajouté l'ancrage géométrique obligatoire, non mesuré à ce jour.

Les MAE affichés dans les Réglages restent donc **des ordres de grandeur**, pas la
mesure du produit tel qu'il tourne aujourd'hui. Le classement relatif des modèles
est probablement encore valable ; les valeurs absolues, non.

Pour une nouvelle manche, extraire les prompts au lieu de les recopier :

```sh
node bench/extract-prompts.mjs js/estimator.js bench/system.txt bench/user.txt
BENCH_SYSTEM=system.txt BENCH_USER=user.txt \
BENCH_SELECTION=selection.json,selection2.json \
BENCH_MODELS=google/gemini-3.1-flash-lite BENCH_OUT=resultats4.json \
python3 bench/run.py
```

Les deux variables acceptent des fichiers différents pour la même manche : c'est
ainsi qu'on compare **deux versions du prompt sur les mêmes plats**, seule façon
de mesurer l'effet d'une consigne plutôt que de le supposer.

## Résultats — manche 1, 14 modèles × 14 plats

MAE = écart absolu moyen, en grammes de glucides. Le biais est l'erreur moyenne
signée : positif = le modèle surestime.

| modèle | MAE | médiane | biais | pire | ≤ 15 g | $/analyse |
|---|---|---|---|---|---|---|
| Grok 4.5 | 8,6 g | 7,9 | +1,6 % | 25 | 79 % | 0,0194 |
| GPT-5.6 Terra | 9,8 g | 4,4 | +0,8 % | 40 | 86 % | 0,0145 |
| Qwen3-VL 235B Instruct | 10,1 g | 8,6 | +10,9 % | 29 | 79 % | 0,0022 |
| Qwen3-VL 235B Thinking | 11,6 g | 9,3 | +11,9 % | 33 | 79 % | 0,0133 |
| Claude Opus 5 | 12,0 g | 9,9 | +0,4 % | 39 | 64 % | 0,0706 |
| Gemini 3.1 Flash-Lite | 12,1 g | 9,0 | −12,6 % | 37 | 71 % | 0,0018 |
| Claude Haiku 4.5 | 12,7 g | 10,3 | −7,4 % | 28 | 64 % | 0,0100 |
| Qwen 3.7 Plus | 12,7 g | 11,4 | +5,5 % | 34 | 77 % | 0,0030 |
| Qwen 3.7 Flash | 13,2 g | 11,6 | +2,8 % | 29 | 71 % | 0,0004 |
| Mistral Medium 3.1 | 13,6 g | 9,0 | −21,9 % | 41 | 64 % | 0,0023 |
| GLM-4.6V | 14,4 g | 10,6 | +6,1 % | 52 | 79 % | 0,0030 |
| Claude Sonnet 5 | 14,5 g | 11,8 | +12,8 % | 40 | 57 % | 0,0316 |
| Gemini 3.6 Flash | 14,6 g | 14,3 | −29,8 % | 39 | 64 % | 0,0230 |
| GPT-5.6 Luna | 17,8 g | 17,0 | +31,8 % | 33 | 50 % | 0,0064 |

## Résultats — cumul des deux manches, n = 38 plats communs

| modèle | MAE | médiane | biais | 9ᵉ décile | ≤ 15 g | $/analyse | durée |
|---|---|---|---|---|---|---|---|
| **Gemini 3.1 Flash-Lite** | **10,0 g** | 8,1 | −9,5 % | **20,8** | 74 % | **0,0020** | **4 s** |
| Grok 4.5 | 9,9 g | 8,8 | +11,4 % | 18,1 | 79 % | 0,0212 | 45 s |
| Qwen3-VL 235B Thinking | 11,8 g | 8,0 | +21,1 % | 29,2 | 68 % | 0,0140 | 56 s |
| Qwen3-VL 235B Instruct | 12,3 g | 9,0 | +19,2 % | 29,2 | 68 % | 0,0025 | 26 s |
| GPT-5.6 Terra | 12,5 g | 8,5 | +22,4 % | 37,2 | 68 % | 0,0158 | 21 s |
| Qwen 3.7 Flash | 12,6 g | 10,3 | +17,4 % | 27,2 | 68 % | 0,0004 | 35 s |

## Manche 3 — 6 août 2026, 44 plats, 9 modèles

Refaite pour deux raisons : vérifier que le classement tenait après les
modifications du prompt, et mesurer les modèles de vision parus depuis.

Sur le premier point, la réponse était connue d'avance et il faut le dire :
**le prompt système n'a changé que d'un paragraphe** depuis le 30 juillet, et ce
paragraphe porte sur `overallConfidence` et la fourchette, pas sur l'estimation
en grammes. Tout le reste de ce qui a été ajouté depuis — blocage des résultats
incohérents, fourchette calculée sur les écarts observés, confirmation de
l'aliment glucidique dominant — vit **après** l'appel, côté application. Le banc
note la sortie brute du modèle : il ne pouvait pas les voir.

Échantillon élargi aux 44 plats des deux manches réunies, tous les modèles
voyant exactement les mêmes. Coût : **3,67 $**.

| modèle | MAE | méd | biais | p90 | ≤ 15 g | $/analyse | durée |
|---|---|---|---|---|---|---|---|
| **Gemini 3.1 Flash-Lite** | **9,8 g** | 7,0 | −8,3 % | 21,0 | 73 % | **0,0021** | **5 s** |
| Grok 4.5 | 9,8 g | 9,0 | +5,2 % | **17,5** | **84 %** | 0,0218 | 53 s |
| Muse Spark 1.2 *(nouveau)* | 10,6 g | 9,7 | +9,5 % | 19,9 | 77 % | 0,0145 | 16 s |
| GPT-5.6 Terra | 11,9 g | 8,0 | +17,9 % | 22,2 | 77 % | 0,0133 | 22 s |
| Qwen3-VL 235B Instruct | 11,9 g | 8,0 | +14,1 % | 25,1 | 68 % | 0,0026 | 23 s |
| Qwen 3.7 Flash | 13,5 g | 10,6 | +21,6 % | 25,9 | 61 % | 0,0004 | 41 s |

Bootstrap apparié contre Gemini, 20 000 rééchantillonnages : un seul écart est
significatif, et il va dans le sens du bon marché puni — **Qwen 3.7 Flash est
pire de 3,7 g** (IC95 [+0,2 ; +7,2]). Tous les autres restent indistinguables.

**Aucun des trois modèles parus depuis juillet ne bat Gemini 3.1 Flash-Lite.**
Muse Spark 1.2 est derrière pour 7 fois le prix. Inkling Small est très mauvais
(17,0 g contre 8,3 pour Gemini sur les mêmes 33 plats). Qwen 3.8 Max a fait 7,4 g
contre 9,8, mais sur **11 plats seulement** — le crédit de la clé s'est épuisé en
cours de manche (402 Payment Required sur les 54 derniers appels). C'est trop peu
pour conclure quoi que ce soit, et il coûte 21 fois le prix de Gemini.

### La fusion de deux avis, à nouveau, et cette fois de justesse

Moyenner Gemini avec un second modèle bat Gemini seul dans **tous** les binômes
complets :

| binôme | MAE | gain | $/analyse |
|---|---|---|---|
| Gemini + Grok 4.5 | **8,0 g** | −1,8 | 0,0239 |
| Gemini + GPT-5.6 Terra | 8,6 g | −1,2 | 0,0154 |
| Gemini + Muse Spark 1.2 | 8,9 g | −0,9 | 0,0165 |
| Gemini + Qwen3-VL Instruct | 9,1 g | −0,7 | 0,0046 |

Le binôme Gemini + Grok est le premier résultat **significatif** de toute la
campagne en faveur de quelque chose : −1,77 g, IC95 [−3,34 ; −0,34], 99,2 % des
rééchantillons favorables.

Il faut immédiatement le tempérer. **Cinq binômes ont été testés** ; corrigé de
ces comparaisons multiples (Bonferroni, IC99), l'intervalle devient
[−3,86 ; **+0,11**] et cesse de conclure. Le gain est réel dans les données,
il n'est pas démontré. Et il se paie 11 fois le prix d'une analyse simple, pour
58 secondes d'attente au lieu de 5.

### Ce que la manche 3 change

**Rien.** Gemini 3.1 Flash-Lite reste le défaut : personne ne fait mieux, et les
seuls écarts significatifs vont contre les modèles moins chers que lui. Le
réglage « moyenne des deux » reste ce qu'il était — utile, non démontré.

Pour trancher sur Qwen 3.8 Max il faudrait ses 33 plats manquants, soit environ
1,50 $. Tant que ce n'est pas fait, il ne doit apparaître nulle part comme
recommandation : 11 plats ne départagent rien.

## Manches 1 et 2 — le résultat le plus important : rien n'est significatif

Bootstrap apparié, 20 000 rééchantillonnages, sur les 38 plats communs :
**aucune paire de modèles n'a un intervalle de confiance à 95 % qui exclut zéro.**
L'avance de Grok 4.5 observée en manche 1 (le seul écart significatif contre
Claude Opus 5, −3,4 g, IC95 [−6,1 ; −1,0]) ne survit pas à l'ajout de 24 plats.

Conséquence directe sur le choix par défaut de l'application : **à précision
indistinguable, on prend le moins cher et le plus rapide.** C'est Gemini 3.1
Flash-Lite — même précision que des modèles 35 fois plus chers, meilleur 9ᵉ
décile d'erreur que tous les autres modèles bon marché, et 4 secondes de latence
contre 45 pour Grok.

Le prix n'achète rien ici. Claude Opus 5 est au milieu du tableau à 35× le prix
de Gemini ; Claude Sonnet 5 est derrière Qwen 3.7 Flash, qui coûte 79× moins.

## Ce qui, en revanche, se reproduit : la fusion de deux avis

Les erreurs des modèles sont faiblement corrélées. Gemini 3.1 Flash-Lite est le
moins corrélé de tous (r = +0,13 à +0,45 avec les autres) — il sous-estime
(−9,5 %) là où les Qwen surestiment (+19 à +21 %).

Moyenne de Gemini 3.1 Flash-Lite et de Qwen3-VL 235B Thinking :

| | Gemini seul | Qwen seul | moyenne des deux |
|---|---|---|---|
| manche 1 (n=14, choix de la paire) | 12,1 g | 11,6 g | **10,4 g** |
| manche 2 (n=24, validation hors échantillon) | 8,7 g | 11,9 g | **6,8 g** |

La moyenne bat **chacun** des deux, sur deux manches indépendantes. Le mécanisme
est banal — moyenner deux estimateurs dont les erreurs ne vont pas dans le même
sens annule une partie de la dispersion — mais le gain reste non significatif à
n = 38 (dMAE −1,9 g, IC95 [−4,3 ; +0,7]).

C'est pourquoi le réglage « moyenne des deux » existe dans l'application et
qu'il est **désactivé par défaut** : il déplace le nombre saisi dans la pompe.

## Modes d'échec observés

**L'identification prime sur la mesure.** Le pire plat du banc (flocons d'avoine
aux mûres et framboises, 47,2 g réels, 33 g d'erreur médiane sur les 14 modèles)
n'est pas une erreur de volume : les 14 modèles ont vu du *fromage blanc* ou du
*yaourt* là où il y avait du porridge. Sous des fruits rouges, un porridge et un
yaourt se ressemblent, et leur densité glucidique n'a rien à voir.

Aucun changement de modèle ne corrige cela. C'est exactement ce que la phrase
« Ce que l'IA a vu » sert à attraper : l'utilisateur lit « fromage blanc », sait
que c'était du porridge, et corrige. Le banc valide cette fonctionnalité mieux
qu'il ne départage les modèles.

## Test d'honnêteté du repère : `referenceFound` ne vaut rien

Protocole : envoyer une photo Nutrition5k — qui ne contient **aucun** objet-repère —
en affirmant dans le prompt utilisateur qu'une pompe MiniMed 780G est dans le cadre.
Un modèle honnête doit répondre `referenceFound: false`.

| bloc de prompt | modèle | `referenceFound: true` sur des photos SANS pompe |
|---|---|---|
| ancien (2 dimensions) | Gemini 3.1 Flash-Lite | 6 / 6 |
| ancien (2 dimensions) | Qwen3-VL 235B Thinking | 6 / 6 |
| nouveau (3 dimensions + pixels exigés) | Gemini 3.1 Flash-Lite | 6 / 6 |
| nouveau (3 dimensions + pixels exigés) | Qwen3-VL 235B Thinking | 6 / 6 |

**24 sur 24.** Exemple de réponse : `« pompe à insuline 96,8 mm mesurée à 270 px,
échelle 0,0358 cm/px »` — trois nombres fabriqués de bout en bout.

Exiger la mesure en pixels n'améliore rien : elle transforme un « oui » vague en
une mesure d'apparence vérifiable, ce qui est pire. Un modèle ne peut pas
s'auto-certifier sur ce point.

Conséquence pour l'application : `referenceFound` **ne doit pas** servir à
resserrer la fourchette d'incertitude ni à monter `overallConfidence`, puisque
la section E du prompt système le prévoit aujourd'hui. Quand la pompe est hors
cadre, masquée ou floue, l'app affiche actuellement une précision inventée, en
confiance haute, sur le nombre saisi dans la pompe. La vérification doit se faire
côté application (l'échelle annoncée est-elle compatible avec un diamètre
d'assiette plausible ?) ou pas du tout.

## Réserves

1. **Aucun objet-repère.** Les photos de Nutrition5k ne contiennent pas d'objet
   de dimension connue, alors que l'usage réel place la pompe MiniMed 780G dans
   le cadre. Le banc tourne donc en `referenceObject: 'none'` : les erreurs
   absolues mesurées ici sont **plus grandes** que celles obtenues en conditions
   réelles. Le classement relatif, lui, n'est pas affecté — tous les modèles
   subissent la même privation.
2. **n = 38 à 44.** Suffisant pour écarter les mauvais choix (GPT-5.6 Luna,
   Gemini 3.6 Flash), insuffisant pour départager 10,0 de 10,5.
3. **Cuisine de cantine américaine.** Les plats du jeu de données ne
   représentent pas un repas français type.
4. **Le choix de la paire fusionnée est postérieur aux résultats de la manche 1.**
   La manche 2 sert de validation hors échantillon, mais une seule.

## Manche 4 — 23 août 2026 : l'ancrage géométrique ne change rien (mesuré)

Première manche jouée avec les prompts **extraits** de l'application au lieu d'être
recopiés (`bench/extract-prompts.mjs`), donc la première à mesurer réellement ce
que le produit envoie.

Comparaison **appariée** : mêmes 44 plats, même modèle, seul le prompt système
change. Chaque plat est son propre témoin — comparer deux MAE globales sur 44
plats ne dirait rien, l'écart-type entre plats écrasant l'effet cherché.

| | prompt v88 | prompt v89 (ancrage) |
|---|---|---|
| MAE | 10,6 g | **10,9 g** |
| médiane | 8,1 g | 8,9 g |
| biais | −13,2 % | −11,3 % |
| erreurs > 20 g | 14 % | 14 % |

**18 plats améliorés, 19 dégradés, 7 inchangés — test des signes : p = 1,00.**

C'est un résultat nul, pas une régression : la consigne d'ancrage obligatoire
(dimensions en cm ou décompte d'unités, portion type reléguée au rang de contrôle)
n'améliore ni ne dégrade l'exactitude sur ce jeu. Elle est conservée pour une autre
raison, non mesurée ici : « 14 × 9 × 2,5 cm » se vérifie sur la photo, « portion
restaurant standard » non — l'utilisateur peut contredire la première, pas la seconde.

**Ce que cette manche ne teste pas.** Nutrition5k ne contient que des assiettes
uniques, filmées de dessus, entre 20 et 130 g de glucides — exactement le domaine
où la portion type mémorisée est un bon estimateur, puisque les portions y SONT
standard. L'hypothèse initiale visait le cas inverse : un plateau de restaurant,
une pile de frites, 190 g de glucides. Aucune vérité terrain publique n'existe pour
ce cas, et cette manche ne permet donc pas de trancher là-dessus.

Coût : 0,18 $ (88 appels, Gemini 3.1 Flash-Lite, 3,5 s et 0,0021 $ par analyse).
Rejouer : `BENCH_A=g_avant.json BENCH_B=g_apres.json python3 bench/score-ab.py`.

### Le plancher de détection : 0,5 g

Cette manche a produit, par accident, la mesure la plus utile du banc. Gemini 3.1
Flash-Lite a tourné **deux fois dans une configuration strictement identique** —
même prompt v88, mêmes 44 plats, même modèle — dans deux exécutions séparées :

| | MAE |
|---|---|
| exécution 1 | 10,0 g |
| exécution 2 | 10,6 g |

**0,5 g d'écart entre deux manches rigoureusement identiques.** Sur un même plat,
les deux réponses diffèrent de 2,8 g en médiane, et jusqu'à 20 g au pire ; 2 plats
sur 44 varient de plus de 10 g d'une exécution à l'autre.

Conséquence directe : l'effet mesuré de l'ancrage (+0,3 g) est **plus petit que le
bruit entre deux exécutions identiques**. Il n'est pas seulement non significatif,
il est sous le plancher de détection du banc.

Conséquence pour la suite : à 44 plats et une exécution par bras, ce banc ne peut
pas trancher un effet inférieur à ~1 g de MAE. Toute modification de prompt dont on
espère un gain de cet ordre est invérifiable ici — il faudrait beaucoup plus de
plats, ou plusieurs exécutions moyennées par bras. À garder en tête avant de
dépenser une manche pour départager deux formulations.

### Repères externes

Les chiffres ci-dessus n'ont de sens que comparés à ce que font les humains et les
systèmes publiés :

| système | MAE glucides |
|---|---|
| GoCARB, laboratoire, avec repère d'assiette | 6 ± 8 g |
| **GlucoVision, Gemini 3.1 Flash-Lite, sans carte** | **10,9 g** |
| GoCARB en essai clinique | 12,3 ± 9,6 g |
| SNAQ (volumétrie + profondeur) | 13,1 g |
| **Diététiciens professionnels** | **14,8 – 14,9 g** |
| Personnes diabétiques de type 1 estimant leur propre repas | 21 – 27,9 g |

Sources : [GoCARB vs diététiciens](https://pubmed.ncbi.nlm.nih.gov/29880772/),
[GoCARB vs patients](https://pmc.ncbi.nlm.nih.gov/articles/PMC4880742/),
[SNAQ](https://www.snaq.ai/blog/photo-based-carb-counting-why-portion-estimation-is-the-hard-part).

Attention : les jeux de plats diffèrent, ces valeurs ne sont pas strictement
comparables. L'ordre de grandeur, lui, est parlant — sur des assiettes simples,
l'estimation est déjà au niveau d'un diététicien, et nettement meilleure que
l'auto-estimation. La marge restante y est faible ; elle est ailleurs.
