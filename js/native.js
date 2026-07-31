/* native.js — pont vers les capacités Android (APK Capacitor).

   Règle de conception : ce module est le SEUL endroit qui connaît Capacitor.
   Le reste de l'app appelle Native.<capacité> et obtient soit la version
   native, soit un repli web, sans jamais tester la plateforme lui-même.
   Conséquence : la PWA et l'APK font tourner exactement le même code, et une
   mise à jour OTA (qui ne remplace que le web) ne peut pas casser l'APK.

   Hors de l'APK, Native.isApp vaut false et chaque capacité renvoie une valeur
   neutre (null / Promise résolue) : les chemins de code éprouvés de la PWA
   restent inchangés. */
(function () {
  'use strict';

  var Cap = window.Cap || null;
  var C = Cap && Cap.Capacitor;
  /* On se base sur isNativePlatform() et NON sur isPluginAvailable() : plusieurs
     plugins (Camera, Filesystem, Preferences) ont une implémentation web qui
     répondrait « disponible » dans le navigateur, alors qu'on veut y garder le
     comportement actuel de la PWA. */
  var isApp = !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());

  var PHOTO_DIR = 'photos';
  var NOTIF_CHANNEL = 'glucovision-controle';
  var photoBase = null;      // URL affichable du dossier photos (calculée une fois)
  var readyPromise = null;

  function noop() {}
  function resolved(v) { return Promise.resolve(v); }

  // ---------- Démarrage ----------

  /* Prépare tout ce qui doit l'être avant le premier rendu :
     - notifyAppReady() : obligatoire, sinon le plugin de mise à jour considère
       que le bundle a planté et revient à la version précédente ;
     - l'URL de base des photos, pour pouvoir construire les <img> en synchrone.
     Un plugin qui ne répondrait pas ne doit jamais empêcher l'app de démarrer :
     d'où le garde-fou de 3 s. */
  function ready() {
    if (readyPromise) return readyPromise;
    if (!isApp) { readyPromise = resolved(false); return readyPromise; }

    var work = Promise.all([
      Cap.CapacitorUpdater.notifyAppReady().catch(noop),
      Cap.Filesystem.getUri({ directory: Cap.Directory.Data, path: PHOTO_DIR })
        .then(function (r) { photoBase = C.convertFileSrc(r.uri); })
        .catch(noop),
      /* Depuis Android 8, une notification sans canal DÉCLARÉ n'est jamais
         affichée. On crée donc le nôtre au démarrage — ça le fait aussi
         apparaître nommément dans les réglages Android, où il peut être coupé
         indépendamment du reste de l'app. */
      Cap.LocalNotifications.createChannel({
        id: NOTIF_CHANNEL,
        name: 'Contrôle glycémie',
        description: 'Rappel de contrôle après un repas analysé',
        importance: 4,
        visibility: 1
      }).catch(noop)
    ]).then(function () { return true; });

    var guard = new Promise(function (res) { setTimeout(function () { res(true); }, 3000); });
    readyPromise = Promise.race([work, guard]);
    return readyPromise;
  }

  // ---------- HTTP natif (sans CORS) ----------

  /* Dans l'APK la requête part du code Java, pas du navigateur : la politique
     d'origine croisée ne s'applique pas. C'est ce qui rend à nouveau utilisables
     les serveurs qui n'envoient aucun en-tête CORS — le cas de
     search.openfoodfacts.org, à l'origine du « erreur réseau » de la PWA.

     Renvoie une Promise de { status, data } où data est déjà l'objet JSON.
     Sur le web : null, l'appelant garde son fetch() habituel. */
  function httpJson(url, ms) {
    if (!isApp) return resolved(null);
    return Cap.CapacitorHttp.request({
      url: url,
      method: 'GET',
      headers: { Accept: 'application/json' },
      connectTimeout: ms || 15000,
      readTimeout: ms || 15000
    }).then(function (res) {
      var data = res.data;
      // Selon le type MIME renvoyé, le pont donne l'objet ou la chaîne brute.
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { data = null; }
      }
      return { status: res.status, data: data };
    });
  }

  // ---------- Appareil photo natif ----------

  /* getUserMedia ne donne qu'une image du flux vidéo de prévisualisation :
     compressée, sans autofocus dédié ni HDR. Ici on passe par l'appareil photo
     du système, donc par le vrai pipeline du capteur. Meilleure photo =
     meilleure lecture des textures (grain du riz, mie du pain) = meilleure
     estimation, ce qui est le seul levier gratuit sur la précision.

     Le redimensionnement à 2048 px est fait côté natif : on évite ainsi de faire
     transiter une image de 12 Mpx à travers le pont JavaScript. */
  var SHOT = {
    quality: 88,
    targetWidth: 2048,
    targetHeight: 2048,
    correctOrientation: true,
    editable: 'no'
  };

  /* Les nouvelles méthodes du plugin (takePhoto / chooseFromGallery) ne rendent
     qu'une URI de fichier, jamais l'image elle-même : on la relit ici. C'est
     voulu côté Capacitor — faire transiter plusieurs mégaoctets de base64 par le
     pont JavaScript est exactement ce qui fait ramer, voire planter, la WebView. */
  function readAsDataUrl(result) {
    var uri = result && (result.uri || result.webPath);
    if (!uri) return resolved(null);
    return Cap.Filesystem.readFile({ path: uri })
      .then(function (r) { return 'data:image/jpeg;base64,' + r.data; })
      .catch(function () { return null; });
  }

  function capture() {
    if (!isApp) return resolved(null);
    // getPhoto est déprécié en Capacitor 8 mais reste le seul disponible sur des
    // versions plus anciennes du plugin : on garde le repli.
    if (typeof Cap.Camera.takePhoto !== 'function') {
      return Cap.Camera.getPhoto({
        quality: 88, width: 2048, height: 2048, correctOrientation: true,
        allowEditing: false, saveToGallery: false,
        resultType: 'dataUrl', source: 'CAMERA'
      }).then(function (photo) {
        return photo && photo.dataUrl ? [photo.dataUrl] : [];
      });
    }
    return Cap.Camera.takePhoto(Object.assign({ saveToGallery: false }, SHOT))
      .then(readAsDataUrl)
      .then(function (url) { return url ? [url] : []; });
  }

  // Sélection multiple depuis la galerie (le sélecteur système d'Android 13+,
  // qui ne demande aucune permission d'accès aux photos).
  function pickMany(limit) {
    if (!isApp) return resolved(null);
    limit = limit || 6;
    if (typeof Cap.Camera.chooseFromGallery !== 'function') {
      return Cap.Camera.pickImages(Object.assign({ limit: limit }, SHOT))
        .then(function (res) {
          return Promise.all(((res && res.photos) || []).slice(0, limit).map(readAsDataUrl));
        })
        .then(function (list) { return list.filter(Boolean); });
    }
    return Cap.Camera.chooseFromGallery(Object.assign({
      mediaType: 0,               // MediaTypeSelection.Photo — photos uniquement
      allowMultipleSelection: true,
      limit: limit
    }, SHOT)).then(function (res) {
      return Promise.all(((res && res.results) || []).slice(0, limit).map(readAsDataUrl));
    }).then(function (list) { return list.filter(Boolean); });
  }

  // ---------- Photos sur le système de fichiers ----------

  /* Les vignettes en base64 dans localStorage sont ce qui saturait le stockage :
     storage.js devait supprimer des images puis tronquer l'historique pour
     réussir à écrire. Dans l'APK on écrit les images comme de vrais fichiers
     dans le dossier privé de l'app — plus de quota à ~5 Mo, et on peut garder
     la photo en pleine définition plutôt qu'une vignette de 320 px. */
  function savePhoto(name, dataUrl) {
    if (!isApp || !dataUrl) return resolved(null);
    var base64 = dataUrl.split(',')[1];
    if (!base64) return resolved(null);
    return Cap.Filesystem.writeFile({
      path: PHOTO_DIR + '/' + name,
      data: base64,
      directory: Cap.Directory.Data,
      recursive: true
    }).then(function () { return name; })
      .catch(function () { return null; });
  }

  /* URL affichable, en synchrone : le rendu de l'historique construit du HTML
     d'un bloc et ne peut pas attendre une Promise par image. D'où photoBase,
     résolu une seule fois au démarrage. */
  function photoSrc(name) {
    if (!isApp || !name || !photoBase) return null;
    return photoBase + '/' + name;
  }

  function deletePhoto(name) {
    if (!isApp || !name) return resolved(false);
    return Cap.Filesystem.deleteFile({
      path: PHOTO_DIR + '/' + name,
      directory: Cap.Directory.Data
    }).then(function () { return true; }).catch(function () { return false; });
  }

  // Supprime les images qu'aucune entrée d'historique ne référence plus.
  function prunePhotos(keepNames) {
    if (!isApp) return resolved(0);
    var keep = {};
    (keepNames || []).forEach(function (n) { if (n) keep[n] = true; });
    return Cap.Filesystem.readdir({ directory: Cap.Directory.Data, path: PHOTO_DIR })
      .then(function (res) {
        var files = (res.files || []).map(function (f) {
          return typeof f === 'string' ? f : f.name;
        }).filter(function (n) { return n && !keep[n]; });
        return Promise.all(files.map(function (n) { return deletePhoto(n); }))
          .then(function () { return files.length; });
      })
      .catch(function () { return 0; });
  }

  // Place occupée par les photos, en octets.
  function photosSize() {
    if (!isApp) return resolved(0);
    return Cap.Filesystem.readdir({ directory: Cap.Directory.Data, path: PHOTO_DIR })
      .then(function (res) {
        return (res.files || []).reduce(function (s, f) {
          return s + ((f && f.size) || 0);
        }, 0);
      })
      .catch(function () { return 0; });
  }

  // ---------- Clés API chiffrées (Keystore Android) ----------

  /* localStorage est déjà privé à l'app sur Android, mais il reste en clair sur
     le disque : une sauvegarde ADB ou un téléphone rooté l'expose. Ici les clés
     sont chiffrées par une clé matérielle qui ne quitte jamais le Keystore. */
  var SECURE_PREFIX = 'apikey.';

  function loadKeys(providers) {
    if (!isApp) return resolved(null);
    return Promise.all(providers.map(function (p) {
      return Cap.SecureStorage.get(SECURE_PREFIX + p)
        .catch(function () { return null; });
    })).then(function (values) {
      var out = {};
      providers.forEach(function (p, i) {
        out[p] = (typeof values[i] === 'string') ? values[i] : '';
      });
      return out;
    });
  }

  function saveKeys(keys) {
    if (!isApp || !keys) return resolved(false);
    return Promise.all(Object.keys(keys).map(function (p) {
      var v = keys[p] || '';
      return (v
        ? Cap.SecureStorage.set(SECURE_PREFIX + p, v)
        : Cap.SecureStorage.remove(SECURE_PREFIX + p)
      ).catch(noop);
    })).then(function () { return true; });
  }

  // ---------- Notifications de contrôle ----------

  function notifPermission() {
    if (!isApp) return resolved(false);
    return Cap.LocalNotifications.checkPermissions().then(function (p) {
      if (p.display === 'granted') return true;
      if (p.display === 'denied') return false;
      return Cap.LocalNotifications.requestPermissions().then(function (r) {
        return r.display === 'granted';
      });
    }).catch(function () { return false; });
  }

  function scheduleNotif(opts) {
    if (!isApp) return resolved(false);
    return notifPermission().then(function (ok) {
      if (!ok) return false;
      return Cap.LocalNotifications.schedule({
        notifications: [{
          // Un identifiant 32 bits stable : les secondes de l'horodatage du repas.
          id: opts.id,
          title: opts.title,
          body: opts.body,
          schedule: { at: opts.at },
          channelId: NOTIF_CHANNEL
          // Pas de smallIcon : « ic_stat_icon_config_sample » n'est qu'un exemple
          // de la doc, pas une ressource livrée. La référencer donnerait une
          // icône manquante ; sans elle, le plugin prend celle de l'app.
        }]
      }).then(function () { return true; })
        .catch(function () { return false; });
    });
  }

  function cancelNotif(id) {
    if (!isApp) return resolved(false);
    return Cap.LocalNotifications.cancel({ notifications: [{ id: id }] })
      .then(function () { return true; }).catch(function () { return false; });
  }

  // ---------- Mesure de profondeur (ARCore) ----------

  /* Sur une vue de dessus, la hauteur des aliments n'est pas visible : c'est la
     principale inconnue géométrique, donc la principale source d'erreur sur une
     portion. L'API Depth d'ARCore la mesure, et fournit au passage l'échelle
     absolue — ce qui rend l'objet-repère inutile quand elle fonctionne.

     Tout est facultatif et silencieux en cas d'échec : la valeur renvoyée dit
     seulement si la mesure a abouti, et l'appelant garde le chemin photo normal.
     Le résultat n'est mis en cache que pour « disponible », parce que ça ne
     change pas pendant l'exécution ; la mesure, elle, est refaite à chaque fois. */
  var depthAvailability = null;

  function depthAvailable() {
    if (!isApp || !Cap.DepthScan) return resolved({ supported: false, reason: 'WEB' });
    if (depthAvailability) return resolved(depthAvailability);
    return Cap.DepthScan.available()
      .then(function (r) {
        depthAvailability = r || { supported: false, reason: 'VIDE' };
        return depthAvailability;
      })
      .catch(function (e) {
        depthAvailability = { supported: false, reason: (e && e.message) || 'ERREUR' };
        return depthAvailability;
      });
  }

  function depthCapture() {
    if (!isApp || !Cap.DepthScan) return resolved(null);
    return Cap.DepthScan.capture()
      .then(function (r) {
        if (!r || r.cancelled) return null;
        if (r.error) return { error: r.error };
        if (!r.jpegBase64) return null;
        return {
          dataUrl: 'data:image/jpeg;base64,' + r.jpegBase64,
          depth: {
            ok: !!r.depthOk,
            volumeCm3: r.volumeCm3 || 0,
            areaCm2: r.areaCm2 || 0,
            heightMaxCm: r.heightMaxCm || 0,
            heightMeanCm: r.heightMeanCm || 0,
            distanceCm: r.distanceCm || 0,
            cmPerPixel: r.cmPerPixel || 0,
            samples: r.samples || 0,
            note: r.note || ''
          }
        };
      })
      .catch(function (e) { return { error: (e && e.message) || 'Mesure impossible.' }; });
  }

  // ---------- Partage d'un fichier ----------

  /* Écrit le contenu dans le cache de l'app puis ouvre le sélecteur de partage
     d'Android (mail, messagerie, Drive…). Le cache convient : le fichier n'a
     pas à survivre au partage, et il est nettoyé par le système.
     Renvoie false sur le web, où l'appelant retombe sur un téléchargement. */
  function shareFile(name, content, title) {
    if (!isApp) return resolved(false);
    return Cap.Filesystem.writeFile({
      path: name,
      data: content,
      directory: Cap.Directory.Cache,
      encoding: 'utf8'
    }).then(function (res) {
      return Cap.Share.share({
        title: title || name,
        // Certains destinataires n'acceptent qu'un texte : le titre sert de secours.
        files: [res.uri]
      });
    }).then(function () { return true; })
      .catch(function (err) {
        // Annulation par l'utilisateur : ce n'est pas une erreur.
        var m = (err && err.message) || '';
        if (/cancel|abort|dismiss/i.test(m)) return true;
        return false;
      });
  }

  // ---------- Raccourcis de l'écran d'accueil ----------

  /* Android lance l'app avec une URL quand on utilise un raccourci (appui long
     sur l'icône). On la lit au démarrage ET on écoute les suivantes : si l'app
     tournait déjà en arrière-plan, aucun démarrage n'a lieu. */
  function onLaunchAction(handler) {
    if (!isApp || !Cap.App) return;
    var fire = function (url) {
      if (!url) return;
      var m = /glucovision:\/\/([a-z-]+)/.exec(url);
      if (m) handler(m[1]);
    };
    Cap.App.getLaunchUrl().then(function (r) { fire(r && r.url); }).catch(noop);
    Cap.App.addListener('appUrlOpen', function (e) { fire(e && e.url); });
  }

  // Réagit au retour au premier plan (reprise de la file d'attente hors-ligne).
  function onResume(handler) {
    if (!isApp || !Cap.App) return;
    Cap.App.addListener('appStateChange', function (s) {
      if (s && s.isActive) handler();
    });
  }

  // ---------- Mise à jour du contenu web (OTA) ----------

  /* Sans ça, chaque version imposerait de retélécharger et réinstaller l'APK à
     la main. Le plugin remplace les fichiers web embarqués par ceux d'une
     archive téléchargée : l'APK n'a plus besoin d'être réinstallé que si on
     ajoute un plugin NATIF (ce qui est rare). Même comportement que la PWA.

     Mode manuel volontaire (autoUpdate désactivé) : on veut décider quand la
     bascule a lieu et l'annoncer avec le même bandeau « Actualiser » que sur le
     web, pas voir l'app se recharger sous les doigts pendant un repas. */
  function checkUpdate(manifestUrl, currentVersion) {
    if (!isApp) return resolved(null);
    // Anti-cache : les assets de release passent par un CDN.
    var url = manifestUrl + (manifestUrl.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now();
    return httpJson(url, 10000).then(function (res) {
      var info = res && res.data;
      if (!info || !info.appVersion || !info.url) return null;
      if (String(info.appVersion) === String(currentVersion)) return null;
      // On ne redescend jamais vers une version plus ancienne.
      if (parseInt(info.appVersion, 10) <= parseInt(currentVersion, 10)) return null;
      return info;
    }).catch(function () { return null; });
  }

  function downloadUpdate(info) {
    if (!isApp || !info) return resolved(null);
    return Cap.CapacitorUpdater.download({
      url: info.url,
      version: info.version || ('1.' + info.appVersion + '.0')
    }).then(function (bundle) {
      // Prête pour le prochain démarrage ; applyUpdate() bascule tout de suite.
      return Cap.CapacitorUpdater.next({ id: bundle.id }).then(function () { return bundle; });
    }).catch(function () { return null; });
  }

  function applyUpdate(bundle) {
    if (!isApp || !bundle) return resolved(false);
    // set() recharge la WebView sur le nouveau bundle : rien ne s'exécute après.
    return Cap.CapacitorUpdater.set({ id: bundle.id })
      .then(function () { return true; }).catch(function () { return false; });
  }

  window.Native = {
    isApp: isApp,
    ready: ready,
    httpJson: httpJson,

    camera: { capture: capture, pickMany: pickMany },
    depth: { available: depthAvailable, capture: depthCapture },
    shareFile: shareFile,
    onLaunchAction: onLaunchAction,
    onResume: onResume,
    photos: {
      save: savePhoto, src: photoSrc, remove: deletePhoto,
      prune: prunePhotos, size: photosSize
    },
    secure: { load: loadKeys, save: saveKeys },
    notify: {
      permission: notifPermission, schedule: scheduleNotif, cancel: cancelNotif
    },
    update: {
      check: checkUpdate, download: downloadUpdate, apply: applyUpdate
    }
  };
})();
