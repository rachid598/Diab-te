# Clé de signature de l'APK

Android refuse d'installer une mise à jour dont la signature diffère de celle de
l'application déjà présente — c'est l'erreur *« le package est en conflit avec un
package déjà présent »*. Or GitHub Actions fabrique un `debug.keystore` neuf à
chaque exécution : **chaque build était donc signé d'une clé différente**, et
aucune mise à jour d'APK n'a jamais pu s'installer par-dessus la précédente. Il
fallait désinstaller à chaque fois, donc tout perdre.

`glucovision-signing.jks` fixe ce problème : le workflow signe désormais tous les
builds avec cette clé, et les APK suivants s'installeront par-dessus en gardant
historique, calibration et clés API.

## Le compromis, en clair

Cette clé est **committée dans le dépôt**, mot de passe compris. C'est délibéré :
sans elle dans le dépôt, la compilation en intégration continue ne peut pas
signer de façon stable. La conséquence à connaître : quiconque a accès au dépôt
peut fabriquer un APK que ton téléphone acceptera comme une mise à jour de
GlucoVision. Le risque reste théorique tant que tu n'installes que des APK
téléchargés depuis tes propres releases, mais il existe.

Pour l'éliminer : mets le contenu de ce fichier en base64 dans un secret de dépôt
(`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASS`), supprime le `.jks` d'ici, et
fais reconstruire le fichier par le workflow. Le workflow lit déjà les secrets en
priorité et ne retombe sur le fichier committé que s'ils sont absents.

```bash
base64 -w0 signing/glucovision-signing.jks
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
