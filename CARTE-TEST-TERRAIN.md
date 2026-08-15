# Validation terrain — carte GlucoVision v2

La carte reste une fonction **bêta** tant que ce protocole n'a pas été exécuté sur le
téléphone cible. Le score `arcoreimg` vérifie seulement que le fichier numérique contient
assez de détails visuels ; il ne mesure ni le taux de détection réel, ni la précision des
portions, ni celle des glucides.

## 1. Préparer la carte

1. Imprimer `glucovision-card.svg` sur papier mat, à **100 %**, sans « ajuster à la page ».
2. Mesurer la ligne témoin : elle doit faire **50,0 mm ± 0,5 mm**.
3. Vérifier que la carte est plane, non brillante, entière et non masquée.
4. Utiliser un APK dont le `versionCode` est au moins **2088**. Une ancienne carte v1 ne
   doit pas être utilisée avec le mode v2.

## 2. Vérifier la détection

Pour chaque essai, approcher d'abord le téléphone jusqu'à ce que la carte occupe environ un
quart de l'image, puis reculer à **50–75 cm** sans perdre la carte. Prendre une vue du dessus
et une vue oblique d'environ 15°.

Faire dix essais dans chacune de ces conditions :

- lumière du jour diffuse ;
- éclairage intérieur normal ;
- éclairage faible mais permettant encore une photo nette.

Noter pour chaque essai : détectée ou refusée, temps avant suivi complet, distance annoncée,
vue acceptée ou rejetée et raison du rejet. Faire aussi dix essais sans carte : aucun ne doit
être accepté comme mesure par carte.

## 3. Vérifier l'échelle

Poser sur le même plan un objet mat dont une dimension est mesurée au réglet, idéalement une
boîte rectangulaire de 100 à 200 mm. Répéter dix captures sans déplacer la carte ni l'objet.
Comparer la dimension connue à la dimension obtenue par la géométrie de la scène — jamais au
nombre de glucides produit par l'IA.

Conserver au minimum : erreur médiane, erreur au 90e percentile, pire erreur, nombre de refus
et captures où la profondeur contredit la carte. Un refus explicite est préférable à une
mesure métrique périmée ou incohérente.

## 4. Critères avant de retirer la mention bêta

- carte imprimée conforme sur au moins deux imprimantes ou deux impressions séparées ;
- au moins 27 détections complètes sur 30 essais avec carte ;
- zéro fausse validation sur les dix essais sans carte ;
- erreur d'échelle médiane ≤ 5 % et 90e percentile ≤ 10 % sur l'objet connu ;
- aucune mesure conservée après perte de suivi, carte masquée ou carte déplacée ;
- résultats reproductibles après redémarrage de l'app et dans les trois éclairages.

Ces seuils sont des critères internes prudents, pas une certification médicale. Même après
validation, la carte ne doit jamais servir seule à calculer une dose d'insuline.
