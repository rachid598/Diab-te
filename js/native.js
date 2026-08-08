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

  /* « android », « ios » ou « web ». Les deux plateformes natives n'ont pas le
     même cycle de vie : sur Android le contenu web se met à jour tout seul par
     OTA pendant que le code natif reste celui de l'APK installé, alors que sur
     iOS tout est reconstruit ensemble à chaque compilation. Des garde-fous
     écrits pour le premier cas n'ont aucun sens dans le second. */
  var platform = (C && typeof C.getPlatform === 'function') ? C.getPlatform() : 'web';

  var PHOTO_DIR = 'photos';
  var NOTIF_CHANNEL = 'glucovision-controle';
  var photoBase = null;      // URL affichable du dossier photos (calculée une fois)
  var readyPromise = null;
  var markedReadyPromise = null;

  function noop() {}
  function resolved(v) { return Promise.resolve(v); }

  // ---------- Démarrage ----------

  /* Prépare tout ce qui doit l'être avant le premier rendu :
     - l'URL de base des photos, pour pouvoir construire les <img> en synchrone ;
     - le canal de notifications.

     notifyAppReady() est volontairement absent d'ici. Le signaler avant que
     Storage.hydrate() et l'interface aient réellement fini d'initialiser ferait
     accepter comme sain un bundle OTA qui plante juste après. init() appelle
     markReady() seulement une fois l'application utilisable.
     Un plugin qui ne répondrait pas ne doit jamais empêcher l'app de démarrer :
     d'où le garde-fou de 3 s. */
  function ready() {
    if (readyPromise) return readyPromise;
    if (!isApp) { readyPromise = resolved(false); return readyPromise; }

    var work = Promise.all([
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

  function markReady() {
    if (markedReadyPromise) return markedReadyPromise;
    if (!isApp || !Cap.CapacitorUpdater ||
        typeof Cap.CapacitorUpdater.notifyAppReady !== 'function') {
      markedReadyPromise = resolved(false);
      return markedReadyPromise;
    }
    markedReadyPromise = Cap.CapacitorUpdater.notifyAppReady()
      .then(function () { return true; });
    return markedReadyPromise;
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
      /* Le plugin résout déjà `null` quand une clé n'existe pas. Une exception
         signifie donc que le Keystore est réellement illisible : la masquer
         ferait croire à Storage qu'il est sûr d'enregistrer quatre clés vides. */
      return Cap.SecureStorage.get(SECURE_PREFIX + p);
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
      );
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

  // ---------- Photo mesurée (ARCore Depth, Android uniquement) ----------

  /* Le plugin est optionnel : l'APK reste utilisable sur un téléphone sans
     ARCore ou sans Depth API. La disponibilité est déterminée côté natif de
     manière asynchrone, car Google Play Services peut répondre provisoirement
     « en cours de vérification » au démarrage. */
  var depthAvailabilityPromise = null;

  function depthAvailable() {
    if (!isApp || platform !== 'android' || !Cap.DepthScan ||
        typeof Cap.DepthScan.available !== 'function') {
      return resolved({ supported: false, installed: false, reason: 'INDISPONIBLE' });
    }
    if (depthAvailabilityPromise) return depthAvailabilityPromise;
    depthAvailabilityPromise = Cap.DepthScan.available().then(function (r) {
      return {
        supported: !!(r && r.supported),
        installed: !!(r && r.installed),
        reason: (r && r.reason) || 'INCONNU'
      };
    }).catch(function (e) {
      depthAvailabilityPromise = null; // une réponse transitoire pourra être retentée
      return { supported: false, installed: false, transient: true,
               reason: (e && e.message) || 'ERREUR' };
    });
    return depthAvailabilityPromise;
  }

  function depthCapture() {
    if (!isApp || platform !== 'android' || !Cap.DepthScan ||
        typeof Cap.DepthScan.capture !== 'function') return resolved(null);
    return Cap.DepthScan.capture().then(function (r) {
      if (!r || r.cancelled) return r || { cancelled: true };
      if (r.error) return { error: String(r.error) };
      var jpeg = (r.jpegBase64 || '').toString();
      if (!jpeg) return { error: 'La photo ARCore est vide.' };
      return {
        urls: ['data:image/jpeg;base64,' + jpeg],
        depth: {
          ok: !!r.depthOk,
          scaleOk: !!r.scaleOk,
          volumeOk: !!r.volumeOk,
          fieldWidthCm: Number(r.fieldWidthCm) || 0,
          fieldHeightCm: Number(r.fieldHeightCm) || 0,
          distanceCm: Number(r.distanceCm) || 0,
          cmPerPixel: Number(r.cmPerPixel) || 0,
          volumeCm3: Number(r.volumeCm3) || 0,
          areaCm2: Number(r.areaCm2) || 0,
          heightMaxCm: Number(r.heightMaxCm) || 0,
          heightMeanCm: Number(r.heightMeanCm) || 0,
          samples: Number(r.samples) || 0,
          confidentPixels: Number(r.confidentPixels) || 0,
          coverage: Number(r.coverage) || 0,
          observations: Number(r.observations) || 0,
          parallaxCm: Number(r.parallaxCm) || 0,
          fresh: r.fresh !== false,
          note: (r.note || '').toString(),
          diag: (r.diag || '').toString()
        }
      };
    }).catch(function (e) {
      return { error: (e && e.message) || 'Mesure ARCore impossible.' };
    });
  }

  // ---------- Identité de la couche native ----------

  /* Le bundle web se met à jour tout seul, le code natif non. Rien n'empêchait
     donc un APK ancien de charger un bundle plus récent, d'afficher sa version,
     et d'exécuter malgré tout l'ancien Java — y compris pour un plugin que ce
     bundle croit disponible. On lit donc le numéro de build réel de l'APK, seul
     moyen pour le web de savoir sur quoi il tourne. */
  var nativeBuild = null;

  function appBuild() {
    if (!isApp || !Cap.App || typeof Cap.App.getInfo !== 'function') return resolved(null);
    if (nativeBuild != null) return resolved(nativeBuild);
    return Cap.App.getInfo()
      .then(function (info) {
        var n = parseInt((info && info.build) || '', 10);
        nativeBuild = isFinite(n) ? n : 0;
        return nativeBuild;
      })
      .catch(function () { nativeBuild = 0; return 0; });
  }

  // ---------- Partage d'un fichier ----------

  /* Écrit le contenu dans le cache de l'app puis ouvre le sélecteur de partage
     d'Android (mail, messagerie, Drive…). Le cache convient : le fichier n'a
     pas à survivre au partage, et il est nettoyé par le système.
     Renvoie false sur le web, où l'appelant retombe sur un téléchargement. */
  /* Renvoie { ok, error, step } plutôt qu'un booléen : un échec silencieux ici
     se traduisait à l'écran par un bouton qui ne fait rien, sans le moindre
     indice sur l'étape fautive — écriture du fichier ou ouverture de la feuille
     de partage. Impossible à diagnostiquer autrement qu'en devinant. */
  function shareFile(name, content, title) {
    if (!isApp) return resolved({ ok: false, error: 'web' });
    var step = 'ecriture';
    return Cap.Filesystem.writeFile({
      path: name,
      data: content,
      directory: Cap.Directory.Cache,
      encoding: 'utf8'
    }).then(function (res) {
      step = 'partage';
      return Cap.Share.share({
        title: title || name,
        // Certains destinataires n'acceptent qu'un texte : le titre sert de secours.
        files: [res.uri]
      });
    }).then(function () { return { ok: true }; })
      .catch(function (err) {
        // Annulation par l'utilisateur : ce n'est pas une erreur.
        var m = (err && (err.message || err.errorMessage)) || String(err || '');
        if (/cancel|abort|dismiss/i.test(m)) return { ok: true, cancelled: true };
        return { ok: false, error: m || 'échec inconnu', step: step };
      });
  }

  /* Repli quand la feuille de partage échoue : on écrit dans le dossier de
     documents de l'appareil, qui est visible depuis le gestionnaire de fichiers.
     Moins pratique que de choisir la destination, mais au moins le fichier
     existe quelque part de retrouvable — et l'URI renvoyée le dit. */
  function saveToDocuments(name, content) {
    if (!isApp) return resolved(null);
    var dirs = [Cap.Directory.Documents, Cap.Directory.External, Cap.Directory.Data];
    var i = 0;
    function attempt() {
      if (i >= dirs.length) return resolved(null);
      var dir = dirs[i++];
      return Cap.Filesystem.writeFile({
        path: name, data: content, directory: dir, encoding: 'utf8', recursive: true
      }).then(function (r) {
        return { uri: (r && r.uri) || name, directory: String(dir) };
      }).catch(function () { return attempt(); });
    }
    return attempt();
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
  function positiveInt(v, field) {
    var s = (typeof v === 'number') ? String(v) : (v || '').toString();
    if (!/^[1-9][0-9]*$/.test(s)) throw new Error('Manifeste OTA invalide (' + field + ').');
    var n = Number(s);
    if (!Number.isSafeInteger(n)) throw new Error('Manifeste OTA invalide (' + field + ').');
    return n;
  }

  /* Le manifeste est une entrée réseau hostile jusqu'à preuve du contraire.
     On refuse les URL arbitraires, les versions ambiguës et les archives sans
     SHA-256. Le zip doit vivre sur un tag de release IMMUABLE qui porte son
     numéro : une réécriture du canal « latest » ne peut donc pas remplacer le
     contenu d'une version déjà validée. */
  function validateManifest(raw, currentVersion) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Manifeste OTA absent ou illisible.');
    }
    var appVersion = positiveInt(raw.appVersion, 'appVersion');
    var minNativeBuild = positiveInt(raw.minNativeBuild, 'minNativeBuild');
    var version = (raw.version || '').toString();
    if (version !== '1.' + appVersion + '.0') {
      throw new Error('Manifeste OTA invalide (version).');
    }
    var checksum = (raw.checksum || '').toString().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(checksum)) {
      throw new Error('Manifeste OTA sans empreinte SHA-256 valide.');
    }
    var u;
    try { u = new URL((raw.url || '').toString()); }
    catch (e) { throw new Error('URL OTA invalide.'); }
    var expected = '/rachid598/Diab-te/releases/download/ota-v' + appVersion + '/www.zip';
    if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port ||
        u.username || u.password || u.search || u.hash || u.pathname !== expected) {
      throw new Error('URL OTA refusée : la release n’est pas immuable ou n’appartient pas au projet.');
    }
    var current = (currentVersion == null || Number(currentVersion) === 0)
      ? 0 : positiveInt(currentVersion, 'version locale');
    return {
      appVersion: String(appVersion),
      appVersionNumber: appVersion,
      version: version,
      minNativeBuild: minNativeBuild,
      checksum: checksum,
      url: u.toString(),
      newer: appVersion > current
    };
  }

  function checkUpdate(manifestUrl, currentVersion) {
    if (!isApp) return resolved(null);
    // Anti-cache : le petit manifeste du canal est volontairement mutable.
    var url = manifestUrl + (manifestUrl.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now();
    return Promise.all([httpJson(url, 10000), appBuild()]).then(function (all) {
      var res = all[0], build = all[1];
      if (!res || res.status < 200 || res.status >= 300) {
        throw new Error('Manifeste OTA indisponible (HTTP ' + ((res && res.status) || 0) + ').');
      }
      var info = validateManifest(res.data, currentVersion);
      if (!info.newer) return null;
      if (!(build >= info.minNativeBuild)) {
        return { kind: 'apk-required', info: info, nativeBuild: build || 0 };
      }
      return { kind: 'available', info: info, nativeBuild: build };
    });
  }

  function downloadUpdate(input) {
    if (!isApp || !input) return resolved(null);
    var raw = input.info || input;
    var info = validateManifest(raw, 0);
    return appBuild().then(function (build) {
      if (!(build >= info.minNativeBuild)) {
        throw new Error('Cet OTA exige l’APK ' + info.minNativeBuild + ' (installé : ' + (build || 0) + ').');
      }
      return Cap.CapacitorUpdater.download({
        url: info.url,
        version: info.version,
        checksum: info.checksum
      });
    });
  }

  function applyUpdate(bundle) {
    if (!isApp || !bundle || !bundle.id) return Promise.reject(new Error('Bundle OTA absent.'));
    // set() recharge la WebView sur le nouveau bundle : rien ne s'exécute après.
    return Cap.CapacitorUpdater.set({ id: bundle.id }).then(function () { return true; });
  }

  window.Native = {
    isApp: isApp,
    platform: platform,
    ready: ready,
    markReady: markReady,
    httpJson: httpJson,

    camera: { capture: capture, pickMany: pickMany },
    depth: { available: depthAvailable, capture: depthCapture },
    shareFile: shareFile,
    saveToDocuments: saveToDocuments,
    appBuild: appBuild,
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
