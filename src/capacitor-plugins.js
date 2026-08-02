/* Point d'entrée bundlé vers les plugins Capacitor.
   L'appli est en scripts classiques (pas de bundler à l'exécution) : on regroupe
   donc ici les modules ESM des plugins, et esbuild en fait un IIFE unique
   (vendor/capacitor-plugins.js) chargé par index.html.

   Ce fichier se charge aussi dans la PWA, sans danger : hors de l'APK,
   Capacitor.isNativePlatform() renvoie false et js/native.js n'appelle
   simplement aucun plugin. */
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { LocalNotifications } from '@capacitor/local-notifications';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';

/* DepthScan est écrit dans les projets natifs eux-mêmes — android-src/ pour
   ARCore, ios-src/ pour ARKit — et non distribué en paquet npm : il n'y a donc
   rien à importer, seulement un proxy à déclarer. Les deux implémentations
   exposent le même nom et les mêmes champs, ce qui permet au web d'ignorer sur
   quelle plateforme il tourne. registerPlugin fonctionne aussi sur le web —
   l'appel échouerait à l'exécution, mais js/native.js ne s'en sert que si
   isNativePlatform(). */
const DepthScan = registerPlugin('DepthScan');

window.Cap = {
  Capacitor: Capacitor,
  DepthScan: DepthScan,
  CapacitorHttp: CapacitorHttp,
  Camera: Camera,
  CameraResultType: CameraResultType,
  CameraSource: CameraSource,
  Filesystem: Filesystem,
  Directory: Directory,
  Preferences: Preferences,
  LocalNotifications: LocalNotifications,
  SecureStorage: SecureStorage,
  CapacitorUpdater: CapacitorUpdater,
  Share: Share,
  App: App
};
