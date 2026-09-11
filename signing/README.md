# Clé de signature de l'APK

Android refuse d'installer une mise à jour dont la signature diffère de celle de
l'application déjà présente — c'est l'erreur *« le package est en conflit avec un
package déjà présent »*. La stabilité de cette clé, d'une version à l'autre, est
donc ce qui permet à une mise à jour de s'installer par-dessus la précédente en
gardant historique, calibration et clés API. La branche `codex` conserve aussi
l'`applicationId` historique (`io.github.rachid598.glucovision`) et un
`versionCode` supérieur à celui de la stable : la même clé ne suffirait pas si
l'un de ces deux champs changeait.

## Rotation du 11 septembre 2026

La clé précédente (empreinte `6fbba12e…`) a été **committée dans le dépôt, mot de
passe compris**, du 31 juillet au 11 septembre 2026. N'importe qui ayant accès au
dépôt — donc au lien GitHub, sur n'importe laquelle de ses branches — pouvait
fabriquer un APK que les téléphones ayant déjà installé GlucoVision auraient
accepté comme une mise à jour légitime : Android vérifie le certificat, pas la
provenance de l'APK.

Cette clé a été révoquée et remplacée (empreinte `48bb88d1…`), et purgée de
l'historique Git sur toutes les branches et tags du dépôt. **Elle ne doit plus
jamais être utilisée.** Une app déjà installée avec l'ancienne clé doit être
désinstallée une fois avant d'accepter une mise à jour signée avec la nouvelle —
c'est le prix d'une rotation, inévitable une fois la clé exposée : une clé publiée
ne redevient pas secrète en la remplaçant en silence.

## Où vit la clé maintenant

**Nulle part dans le dépôt.** Elle existe uniquement dans deux secrets GitHub
Actions du dépôt : `ANDROID_KEYSTORE_B64` (le fichier `.jks`, encodé en base64)
et `ANDROID_KEYSTORE_PASS` (le mot de passe, magasin et clé identiques). Le
workflow refuse de compiler si l'un des deux est absent — aucun repli sur un
fichier committé n'existe plus.

Pour encoder un fichier `.jks` en vue de le coller dans un secret :

```bash
base64 -w0 glucovision-signing.jks       # Linux
base64 -i glucovision-signing.jks | tr -d '\n'   # macOS
```

Le fichier `.jks` et son mot de passe ne doivent circuler que par ce canal —
jamais par un commit, un message, ou un fichier partagé.

## Caractéristiques de la clé actuelle

| | |
|---|---|
| Alias | `glucovision` |
| Type | PKCS12 |
| Validité | 30 ans |
| Empreinte SHA-256 | `48:BB:88:D1:D9:0A:AA:61:57:8A:5D:65:D3:FF:EB:25:08:5F:2D:F0:35:C1:00:AF:64:63:23:36:B1:60:F5:3E` |

**Ne remplace jamais cette clé** une fois un APK installé, sauf rotation
délibérée et documentée comme celle-ci : le remplacement silencieux ramènerait
exactement le conflit d'installation que la clé stable existe pour éviter.

## Vérifications automatiques

Le workflow relit le certificat contenu dans l'APK produit avec `apksigner` et
le compare à l'empreinte ci-dessus (`EXPECTED_CERT_SHA256` dans
`.github/workflows/android.yml`). Il vérifie aussi l'identifiant d'application,
le `versionCode`, le `versionName`, et publie les sommes SHA-256 de l'APK et du
bundle OTA.

Pour contrôler manuellement un APK téléchargé avec les outils du SDK Android :

```bash
apksigner verify --verbose --print-certs glucovision.apk
```

La ligne `Signer #1 certificate SHA-256 digest` doit être :

```text
48bb88d1d90aaa61578a5d65d3ffeb25085f2df035c100af64632336b160f53e
```

Le workflow produit un APK `release` non débogable, toujours signé par cette
même clé. Les releases versionnées (`apk-codex-vN` et `ota-vN`) sont
immuables ; les canaux permanents `apk-codex` et `ota-codex` sont mis à jour sans
supprimer leur release. Le lien versionné reste disponible pendant toute mise à
jour du raccourci permanent.
