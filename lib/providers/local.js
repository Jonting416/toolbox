/*
 * Storage on this device: the built-in providers. Loaded after lib/toolbox.js.
 *
 *  - "local" (Chrome, Edge, Opera, other Chromium browsers): the File System
 *    Access API gives us a handle to the real file. Changes save to it
 *    automatically, and the handle is remembered across visits in IndexedDB (the
 *    browser may ask the user to re-grant permission with one click).
 *  - "download" (Firefox, Safari): the file is read with a normal file picker.
 *    Changes are kept as a working copy in this browser until the user clicks
 *    Save file; an info box explains the browser can't write to the file, then
 *    an updated copy is downloaded. (In Chromium, Save file in this mode asks
 *    where to save and switches to "local".)
 */
(function (global) {
  'use strict';

  var Toolbox = global.Toolbox;
  var err = Toolbox.storageError;

  var IDB_NAME = 'toolbox';
  var IDB_STORE = 'handles';
  var HANDLE_KEY = 'datafile';
  var PICKER_TYPES = [{ description: 'Toolbox data file', accept: { 'application/json': ['.json'] } }];

  /* ---------- remembered file handle (IndexedDB) ---------- */

  function idb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbOp(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var store = db.transaction(IDB_STORE, mode).objectStore(IDB_STORE);
        var req = fn(store);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function () { return undefined; });
  }

  function rememberHandle(h) { return idbOp('readwrite', function (s) { return s.put(h, HANDLE_KEY); }); }
  function recallHandle() { return idbOp('readonly', function (s) { return s.get(HANDLE_KEY); }); }
  function forgetHandle() { return idbOp('readwrite', function (s) { return s.delete(HANDLE_KEY); }); }

  /* ---------- "local": a real file, saved automatically ---------- */

  var handle = null;

  var local = {
    id: 'local',
    kind: 'file',
    label: 'This device',
    autosave: true,
    saveDelay: 300,
    available: function () { return Toolbox.canUseFileHandles; },

    /** The remembered file from an earlier visit, if any. */
    restore: async function () {
      var h = await recallHandle();
      if (!h) return null;
      handle = h;
      return { provider: 'local', name: h.name };
    },

    authorize: async function (o) {
      if (!handle) handle = await recallHandle();
      if (!handle) throw err('NotFound', 'No file to reconnect to. Open your data file instead.');
      var perm = 'prompt';
      try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { /* ignore */ }
      if (perm === 'granted') return;
      if (!(o && o.interactive)) throw err('NeedsReconnect', '');
      perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('Permission was not granted.');
    },

    pick: async function () {
      var picked = await global.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
      var h = picked[0];
      var perm = await h.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('Permission to save to that file was not granted.');
      handle = h;
      await rememberHandle(h);
      return { ref: { provider: 'local', name: h.name } };
    },

    create: async function (name, text) {
      var h = await global.showSaveFilePicker({ suggestedName: name, types: PICKER_TYPES });
      handle = h;
      await rememberHandle(h);
      var r = await local.write(null, text);
      return { ref: { provider: 'local', name: h.name }, version: r.version, modifiedTime: r.modifiedTime };
    },

    read: async function () {
      var file;
      try { file = await handle.getFile(); }
      catch (e) {
        throw err('NotFound', 'Couldn’t find “' + handle.name + '”. It may have been moved or deleted — open it again.');
      }
      return { text: await file.text(), version: null, modifiedTime: new Date(file.lastModified) };
    },

    write: async function (ref, text) {
      try {
        var w = await handle.createWritable();
        await w.write(text);
        await w.close();
      } catch (e) {
        if (e && e.name === 'NotAllowedError') {
          throw err('NeedsReconnect', 'The browser needs your permission again to save. Click Reconnect.');
        }
        throw e;
      }
      return { version: null, modifiedTime: new Date() };
    },

    forget: function () { handle = null; return forgetHandle(); }
  };

  /* ---------- "download": read with a file picker, save by downloading ---------- */

  function pickFileFallback() {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', function () { resolve((input.files && input.files[0]) || null); });
      input.addEventListener('cancel', function () { resolve(null); });
      input.click();
    });
  }

  var download = {
    id: 'download',
    kind: 'download',
    label: 'This device',
    autosave: false,
    available: function () { return true; },

    pick: async function () {
      var file = await pickFileFallback();
      if (!file) return null;
      return { ref: { provider: 'download', name: file.name }, text: await file.text(), modifiedTime: new Date(file.lastModified) };
    },

    create: async function (name, text) {
      Toolbox.downloadText(text, name);
      return { ref: { provider: 'download', name: name }, version: null, modifiedTime: new Date() };
    }
  };

  Toolbox.registerProvider(local);
  Toolbox.registerProvider(download);
})(window);
