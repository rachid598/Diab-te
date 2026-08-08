'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function memoryStorage(seed, options) {
  const values = new Map(Object.entries(seed || {}));
  const state = Object.assign({ failKey: null, failCount: Infinity }, options || {});
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (state.failKey === key && state.failCount > 0) {
        state.failCount--;
        throw new Error('quota');
      }
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
    _values: values,
    _state: state
  };
}

function loadScript(relative, overrides) {
  const sandbox = Object.assign({
    console,
    Promise,
    Date,
    Math,
    JSON,
    Uint32Array,
    setTimeout,
    clearTimeout,
    navigator: { onLine: true },
    localStorage: memoryStorage(),
    fetch() { return Promise.reject(new Error('fetch non simulé')); }
  }, overrides || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  vm.runInContext(source, sandbox, { filename: relative });
  return sandbox;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { loadScript, memoryStorage, plain };
