/* Point d'entrée bundlé vers les plugins Capacitor.
   L'appli est en scripts classiques (pas de bundler à l'exécution) : on regroupe
   donc ici les modules ESM des plugins, et esbuild en fait un IIFE unique
   (vendor/capacitor-plugins.js) chargé par index.html.

   Ce fichier se charge aussi dans la PWA, sans danger : hors de l'APK,
   Capacitor.isNativePlatform() renvoie false et js/native.js n'appelle
   simplement aucun plugin. */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { LocalNotifications } from '@capacitor/local-notifications';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { CapacitorUpdater } from '@capgo/capacitor-updater';

window.Cap = {
  Capacitor: Capacitor,
  CapacitorHttp: CapacitorHttp,
  Camera: Camera,
  CameraResultType: CameraResultType,
  CameraSource: CameraSource,
  Filesystem: Filesystem,
  Directory: Directory,
  Preferences: Preferences,
  LocalNotifications: LocalNotifications,
  SecureStorage: SecureStorage,
  CapacitorUpdater: CapacitorUpdater
};
