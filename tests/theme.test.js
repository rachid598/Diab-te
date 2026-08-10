'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
const capacitor = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/android.yml'), 'utf8');

function variable(name) {
  const m = css.match(new RegExp('--' + name + ':\\s*(#[0-9a-f]{6})', 'i'));
  assert.ok(m, 'variable CSS --' + name + ' absente');
  return m[1];
}

function luminance(hex) {
  const values = hex.slice(1).match(/../g).map(function (part) {
    const n = parseInt(part, 16) / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

test('le thème sombre est forcé et cohérent entre Web, PWA et Android', function () {
  const bg = variable('bg').toLowerCase();
  assert.match(css, /:root\s*{[\s\S]*?color-scheme:\s*dark;/);
  assert.match(html, new RegExp('<meta name="theme-color" content="' + bg + '"', 'i'));
  assert.match(html, /<meta name="color-scheme" content="dark"/i);
  assert.equal(manifest.background_color.toLowerCase(), bg);
  assert.equal(manifest.theme_color.toLowerCase(), bg);
  assert.equal(capacitor.android.backgroundColor.toLowerCase(), bg);
  assert.deepEqual(capacitor.plugins.SystemBars, {
    insetsHandling: 'css', style: 'DARK', hidden: false
  });
});

test('les contrastes essentiels du thème restent lisibles', function () {
  assert.ok(contrast(variable('text'), variable('bg')) >= 7,
    'texte principal sous le niveau AAA');
  assert.ok(contrast(variable('muted'), variable('surface')) >= 4.5,
    'texte secondaire sous 4,5:1');
  assert.ok(contrast(variable('faint'), variable('surface-2')) >= 4.5,
    'texte discret sous 4,5:1');
  assert.ok(contrast(variable('brand-ink'), variable('brand')) >= 4.5,
    'texte des boutons principaux sous 4,5:1');
  assert.ok(contrast(variable('border-strong'), variable('surface-2')) >= 3,
    'contour des champs sous 3:1');
});

test('le paquet Android remplace le splash et le launcher Capacitor', function () {
  const required = [
    'android-res/drawable/glucovision_mark.xml',
    'android-res/drawable/glucovision_splash.xml',
    'android-res/values/glucovision_colors.xml',
    'android-res/mipmap-anydpi-v21/ic_launcher.xml',
    'android-res/mipmap-anydpi-v26/ic_launcher.xml'
  ];
  required.forEach(function (file) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file + ' absent');
  });
  assert.match(workflow, /@drawable\/glucovision_splash/);
  assert.match(workflow, /mipmap-anydpi-v26\/ic_launcher\.xml/);
});

test('chaque libellé visible nomme réellement son champ', function () {
  const labels = Array.from(html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi));
  assert.ok(labels.length >= 30, 'trop peu de labels analysés');
  labels.forEach(function (match) {
    const attrs = match[1];
    const body = match[2];
    const linked = attrs.match(/\bfor="([^"]+)"/i);
    if (linked) {
      assert.match(html, new RegExp('\\bid="' + linked[1] + '"'),
        'cible absente pour label[for=' + linked[1] + ']');
      return;
    }
    assert.match(body, /<(?:input|select|textarea)\b/i,
      'label sans for et sans contrôle imbriqué : ' + body.replace(/<[^>]+>/g, '').trim());
  });
});
