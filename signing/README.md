# Clé de signature de l'APK

Android refuse d'installer une mise à jour dont la signature diffère de celle de
l'application déjà présente — c'est l'erreur *« le package est en conflit avec un
package déjà présent »*. Or GitHub Actions fabrique un `debug.keystore` neuf à
chaque exécution : **chaque build était donc signé d'une clé différente**, et
aucune mise à jour d'APK n'a jamais pu s'installer par-dessus la précédente. Il
fallait désinstaller à chaque fois, donc tout perdre.

`glucovision-signing.jks` fixe ce problème : le workflow signe désormais tous les
builds avec cette clé, et les APK suivants s'installeront par-dessus en gardant
historique, calibration et clés API. La branche `codex` conserve aussi
l'`applicationId` historique (`io.github.rachid598.glucovision`) et un
`versionCode` supérieur à celui de la stable : la même clé ne suffirait pas si
l'un de ces deux champs changeait.

## Le compromis, en clair

Cette clé est **committée dans le dépôt**, mot de passe compris. C'est délibéré :
sans elle dans le dépôt, la compilation en intégration continue ne peut pas
signer de façon stable. La conséquence à connaître : quiconque a accès au dépôt
peut fabriquer un APK que ton téléphone acceptera comme une mise à jour de
GlucoVision. Le risque est concret : Android reconnaît le certificat, pas la
personne ni le site qui a distribué l'APK. Ne télécharge donc les mises à jour
que depuis les releases de ce dépôt et vérifie leur empreinte publiée.

Déplacer plus tard le fichier dans les secrets du dépôt évitera de continuer à
l'exposer, mais **n'annulera pas sa divulgation passée** : une clé déjà publiée ne
redevient pas secrète. Une vraie correction demandera une rotation planifiée de
la clé et une migration compatible avec les appareils déjà installés. Pour la
phase de test actuelle, le fichier reste volontairement présent. Si les secrets
sont définis, le workflow les lit en priorité mais refuse immédiatement toute clé
dont l'empreinte diffère.

Sous macOS, l'encodage à placer dans le secret se produit ainsi :

```bash
base64 -i signing/glucovision-signing.jks | tr -d '\n'
```

## Caractéristiques

| | |
|---|---|
| Fichier | `signing/glucovision-signing.jks` (PKCS12) |
| Alias | `glucovision` |
| Mot de passe | `glucovision` (magasin et clé) |
| Validité | 30 ans |
| Empreinte SHA-256 | `6F:BB:A1:2E:31:03:B5:91:99:40:AB:0D:E5:29:F9:00:B3:CE:08:5C:90:19:5F:89:8C:9B:4E:E5:26:5A:4A:8B` |

**Ne remplace jamais cette clé** une fois un APK installé : le remplacement
ramènerait exactement le conflit que ce fichier existe pour supprimer.

## Vérifications automatiques

Le build calcule l'empreinte SHA-256 du certificat de la clé avant de lancer
Gradle, puis relit le certificat contenu dans l'APK avec `apksigner`. Les deux
doivent être exactement égaux à l'empreinte ci-dessus. Il vérifie aussi
l'identifiant d'application, le `versionCode`, le `versionName` et publie les
sommes SHA-256 de l'APK et du bundle OTA.

Pour contrôler manuellement un APK téléchargé avec les outils du SDK Android :

```bash
apksigner verify --verbose --print-certs glucovision.apk
```

La ligne `Signer #1 certificate SHA-256 digest` doit être :

```text
6fbba12e3103b5919940ab0de529f900b3ce085c90195f898c9b4ee5265a4a8b
```

Le workflow produit un APK `release` non débogable, toujours signé par cette
même clé. Les releases versionnées (`apk-codex-vN` et `ota-vN`) sont
immuables ; les canaux permanents `apk-codex` et `ota-codex` sont mis à jour sans
supprimer leur release. Le lien versionné reste disponible pendant toute mise à
jour du raccourci permanent.
