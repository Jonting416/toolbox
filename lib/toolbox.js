/*
 * Toolbox data layer — shared by the landing page and every tool.
 *
 * All data lives in ONE JSON file the user keeps, on their own computer or in
 * their own cloud storage:
 *
 *   {
 *     "format": "toolbox-data",
 *     "version": 1,
 *     "createdAt": "...", "updatedAt": "...",
 *     "tools": {
 *       "workout-tracker": { "schemaVersion": 1, ...whatever that tool stores... },
 *       "workout-timer":   { "schemaVersion": 1, ... }
 *     }
 *   }
 *
 * "version" versions the file envelope; each tool versions its own section with
 * "schemaVersion" and migrates it on load.
 *
 * Each tool owns exactly one key under "tools" (its id) and reads/writes it with
 * Toolbox.get(id) / Toolbox.set(id, value) / Toolbox.update(id, fn).
 *
 * Where the file lives is up to a storage provider (see "storage providers"
 * below), each in its own file under lib/providers/:
 *  - local.js: "local" (a file on this computer, saved automatically, in Chromium
 *    browsers) and "download" (Firefox, Safari: changes are kept in this browser
 *    until the user downloads an updated copy).
 *  - gdrive.js: "gdrive", a file in the user's Google Drive, saved automatically.
 *
 * The pieces, loaded by every page with plain <script> tags in this order (no ES
 * modules, so the site also works when opened from disk):
 *
 *   lib/toolbox.config.js     site settings (Google Drive client ID, …)
 *   lib/toolbox.js            this file: the data, saving, the public API
 *   lib/providers/local.js    storage on this device
 *   lib/providers/gdrive.js   storage in Google Drive
 *   lib/toolbox-ui.js         data bar, header chip, dialogs, icons
 *   lib/analytics.js          anonymous page-view counting and its notice
 *
 * Startup (finding the remembered file) waits until the page has been parsed, so
 * every provider has registered by then. Tools wait for Toolbox.ready.
 */
(function (global) {
  'use strict';

  var FORMAT = 'toolbox-data';
  var VERSION = 1;
  var DEFAULT_NAME = 'toolbox-data.json';
  var CACHE_KEY = 'toolbox:working-copy';
  var SOURCE_KEY = 'toolbox:datasource';
  var STORAGE_KEY = 'toolbox:storage';  // where new files go when none is open: 'device' or a cloud provider id

  var canUseFileHandles =
    typeof global.showOpenFilePicker === 'function' &&
    typeof global.showSaveFilePicker === 'function';

  var state = {
    ready: false,
    doc: null,          // the parsed data file
    provider: null,     // where the file lives (see "storage providers")
    ref: null,          // the provider's pointer to the file, e.g. { provider, id, name }
    version: null,      // the provider's revision of the file as last read or written
    fileName: null,
    dirty: false,       // changes not yet written / downloaded
    lastSaved: null,    // Date
    needsReconnect: false,
    conflict: false,    // the file changed elsewhere; saving waits for the user to choose
    error: null,
    generation: 0       // bumps whenever a different file (or no file) is loaded
  };

  var listeners = [];
  var rev = 0;          // bumps on every change; used to know when a save caught up
  var saveTimer = null;
  var writing = null;   // in-flight write promise
  var writeAgain = false;

  /* ---------- helpers ---------- */

  function nowIso() { return new Date().toISOString(); }

  function emptyDoc() {
    var t = nowIso();
    return { format: FORMAT, version: VERSION, createdAt: t, updatedAt: t, tools: {} };
  }

  function clone(v) {
    if (v === undefined) return undefined;
    return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
  }

  function parseDoc(text) {
    if (!text || !text.trim()) return emptyDoc(); // a blank file is fine: start fresh
    var obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('That file isn’t valid JSON.'); }
    if (!obj || typeof obj !== 'object' || obj.format !== FORMAT) {
      throw new Error('That doesn’t look like a Toolbox data file.');
    }
    if (typeof obj.version !== 'number' || obj.version > VERSION) {
      throw new Error('That file was made by a newer version of Toolbox.');
    }
    if (!obj.tools || typeof obj.tools !== 'object') obj.tools = {};
    return obj;
  }

  function serialize() { return JSON.stringify(state.doc, null, 2); }

  function emit() {
    var s = status();
    listeners.slice().forEach(function (fn) {
      try { fn(s); } catch (e) { console.error(e); }
    });
  }

  function fail(message) { state.error = message; emit(); }

  function downloadText(text, name) {
    var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name || DEFAULT_NAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function backupName() {
    var stamp = new Date().toISOString().slice(0, 10);
    return (state.fileName || DEFAULT_NAME).replace(/\.json$/i, '') + '-backup-' + stamp + '.json';
  }

  /* ---------- working copy (localStorage) ---------- */

  function lsJson(k) {
    try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; }
    catch (e) { return null; }
  }

  function cacheRead() { return lsJson(CACHE_KEY); }

  // Working copies saved before storage providers only had a mode and file name.
  function cacheProviderId(c) { return c.provider || (c.mode === 'file' ? 'local' : c.mode); }
  function cacheRef(c) { return c.ref || { provider: cacheProviderId(c), name: c.fileName }; }

  function persistCache() {
    try {
      if (!state.doc) { localStorage.removeItem(CACHE_KEY); return; }
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        doc: state.doc,
        provider: state.provider ? state.provider.id : null,
        ref: state.ref,
        version: state.version,
        fileName: state.fileName,
        dirty: state.dirty,
        lastSaved: state.lastSaved ? state.lastSaved.toISOString() : null
      }));
    } catch (e) { /* storage full or blocked: the file is still the source of truth */ }
  }

  /* ---------- remembered file (which provider, which file) ---------- */

  function sourceRead() { return lsJson(SOURCE_KEY); }
  function rememberSource() {
    try { localStorage.setItem(SOURCE_KEY, JSON.stringify({ provider: state.provider.id, ref: state.ref })); }
    catch (e) { /* blocked storage: the file is forgotten after this page */ }
  }
  function forgetSource() { try { localStorage.removeItem(SOURCE_KEY); } catch (e) { /* ignore */ } }

  function refKey(r) { return r ? r.provider + ':' + (r.id || r.name) : ''; }

  /* ---------- storage providers ---------- */
  //
  // A provider moves the file's text to and from one place. This file owns
  // everything else (the doc, autosave, the working copy, conflicts).
  //
  //   id, label        'gdrive', 'Google Drive'
  //   kind             'file' | 'download' | 'cloud' (becomes status().mode)
  //   autosave         true: changes are written automatically with write().
  //                    false: changes stay in the working copy until Save file
  //                    downloads them (only the download provider).
  //   saveDelay        ms to wait after a change before writing (default 300)
  //   checksVersion    true: write() throws Conflict if the file changed since ifVersion
  //   available()      whether it can be used on this page
  //   prepare()        optional: warm up (e.g. load a sign-in script) before a click
  //   account()        optional: who is signed in, for display
  //   restore()        optional: a ref remembered by the provider itself (local file handles)
  //   authorize({interactive})  check access; interactive ones run from a click.
  //                    Throws NeedsReconnect when non-interactive access isn't possible.
  //   pick()           ask the user for an existing file → { ref, text? } or null
  //   create(name, text)        → { ref, version, modifiedTime }
  //   read(ref)        → { text, version, modifiedTime, name? }
  //   write(ref, text, { ifVersion })  → { version, modifiedTime }
  //   forget()         optional: drop anything remembered about the current file
  //   signOut()        optional: end the provider's sign-in
  //
  // A ref is a small JSON object the provider understands, always with
  // `provider` and `name`. Errors with these names mean something here:
  // NeedsReconnect (show Reconnect), NotFound (forget the file), Conflict.

  function storageError(name, message) {
    var e = new Error(message);
    e.name = name;
    return e;
  }

  var providers = {};

  function usable(id) { var p = providers[id]; return p && p.available() ? p : null; }

  // This device: a real file where the browser allows it, otherwise downloads.
  function deviceProvider() { return usable('local') || providers.download; }

  function providerFor(id) {
    if (!id) return deviceProvider();
    var p = providers[id];
    if (!p || !p.available()) throw new Error((p ? p.label : 'That storage') + ' isn’t available here.');
    return p;
  }

  function cloudProviders() {
    return Object.keys(providers).map(function (k) { return providers[k]; })
      .filter(function (p) { return p.kind === 'cloud' && p.available(); });
  }

  /* ---------- storage choice ---------- */
  //
  // What the header's Storage selector shows: 'device' (the local and download
  // providers together) or a cloud provider id. It follows the open file; with no
  // file open it's the user's last choice, which decides where Create / Open go.

  function storageOf(p) { return p.kind === 'cloud' ? p.id : 'device'; }

  function storageLabel(id) { return id === 'device' ? 'This device' : providers[id].label; }

  function currentStorage() {
    if (state.provider) return storageOf(state.provider);
    var id = null;
    try { id = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    return id && id !== 'device' && usable(id) ? id : 'device';
  }

  function rememberStorage(id) {
    try { localStorage.setItem(STORAGE_KEY, id); } catch (e) { /* lasts this page only */ }
  }

  // Changes that would be lost by closing the file now. While a file waits for
  // Reconnect it isn't loaded, but its working copy may still hold changes.
  function hasUnsaved() {
    if (state.doc) return state.dirty;
    var c = state.ref && cacheRead();
    return !!(c && c.dirty && c.doc && refKey(cacheRef(c)) === refKey(state.ref));
  }

  /* ---------- reading & writing ---------- */

  // Make `doc` (from `ref` at provider `p`) the open file.
  function adopt(p, ref, doc, o) {
    clearTimeout(saveTimer);
    var sameFile = o.sameDoc && doc === state.doc;
    state.doc = doc;
    state.provider = p;
    state.ref = ref;
    state.fileName = ref.name;
    state.version = o.version == null ? null : o.version;
    state.lastSaved = o.lastSaved || new Date();
    state.dirty = !!o.dirty;
    state.needsReconnect = false;
    state.conflict = false;
    state.error = null;
    if (!sameFile) state.generation++;
    rememberSource();
    rememberStorage(storageOf(p));
    persistCache();
  }

  async function loadFrom(p, ref, opts) {
    var data;
    try { data = await p.read(ref); }
    catch (e) {
      if (e && e.name === 'NotFound' && refKey(ref) === refKey(state.ref)) {
        if (p.forget) await p.forget();
        forgetSource();
        resetState();
      }
      throw e;
    }
    var doc = parseDoc(data.text);
    if (data.name) ref = Object.assign({}, ref, { name: data.name });

    // If the last page closed before a save finished, the working copy has newer
    // changes. Providers that check versions keep the version those changes were
    // based on, so if the file also changed elsewhere the save reports a conflict.
    var cached = !(opts && opts.discardLocal) && cacheRead();
    var recovered = !!(cached && cached.dirty && cached.doc &&
      cacheProviderId(cached) === p.id && refKey(cacheRef(cached)) === refKey(ref) &&
      (p.checksVersion || cached.doc.updatedAt > doc.updatedAt));

    adopt(p, ref, recovered ? cached.doc : doc, {
      version: recovered && p.checksVersion ? cached.version : data.version,
      lastSaved: data.modifiedTime,
      dirty: recovered
    });
    if (recovered) scheduleSave(0);
  }

  function scheduleSave(delay) {
    clearTimeout(saveTimer);
    var d = delay != null ? delay : (state.provider && state.provider.saveDelay) || 300;
    saveTimer = setTimeout(flush, d);
  }

  function flush() {
    var p = state.provider;
    if (!p || !p.autosave || !state.doc || state.needsReconnect || state.conflict) return Promise.resolve();
    if (writing) { writeAgain = true; return writing; }
    var startedAt = rev;
    writing = (async function () {
      try {
        var r = await p.write(state.ref, serialize(), { ifVersion: state.version });
        if (rev === startedAt) state.dirty = false;
        if (r && r.version != null) state.version = r.version;
        state.lastSaved = (r && r.modifiedTime) || new Date();
        state.error = null;
        persistCache();
      } catch (e) {
        if (e && e.name === 'NeedsReconnect') {
          state.needsReconnect = true;
          state.error = e.message || 'The browser needs your permission again to save. Click Reconnect.';
        } else if (e && e.name === 'Conflict') {
          state.conflict = true;
          state.error = e.message + ' Choose which version to keep.';
          setTimeout(promptConflict, 0);
        } else {
          state.error = 'Couldn’t save: ' + (e && e.message ? e.message : e);
        }
      } finally {
        writing = null;
        emit();
        if (writeAgain) { writeAgain = false; flush(); }
      }
    })();
    emit();
    return writing;
  }

  // Before switching files, write anything still waiting to be saved to the current one.
  async function settle() {
    clearTimeout(saveTimer);
    if (state.provider && state.provider.autosave && state.dirty) await flush();
    if (writing) await writing;
  }

  function resetState() {
    clearTimeout(saveTimer);
    state.doc = null;
    state.provider = null;
    state.ref = null;
    state.version = null;
    state.fileName = null;
    state.dirty = false;
    state.lastSaved = null;
    state.needsReconnect = false;
    state.conflict = false;
    state.generation++;
    persistCache();
  }

  function isDownload() { return !!state.provider && !state.provider.autosave; }

  function guardUnsavedDownload() {
    if (isDownload() && state.dirty) {
      throw new Error('Save your changes (or discard them) before switching files.');
    }
  }

  // Wraps a user action: picker cancellations are silent, other errors are shown.
  function action(fn) {
    return async function () {
      try {
        state.error = null;
        var result = await fn.apply(null, arguments);
        emit();
        return result;
      } catch (e) {
        if (e && e.name === 'AbortError') { emit(); return; }
        fail(e && e.message ? e.message : String(e));
      }
    };
  }

  /* ---------- conflicts ---------- */

  var conflictOpen = false;

  /** The file changed elsewhere: ask which version to keep (Toolbox.prompts.conflict). */
  async function promptConflict() {
    if (!state.conflict || conflictOpen) return;
    conflictOpen = true;
    var choice;
    try {
      choice = await Toolbox.prompts.conflict({
        fileName: state.fileName,
        where: state.provider ? state.provider.label : 'its storage'
      });
    } finally { conflictOpen = false; }
    if (choice === 'theirs') await Toolbox.reloadFile();
    else if (choice === 'mine') await Toolbox.overwriteFile();
  }

  /* ---------- startup ---------- */

  async function init() {
    var src = sourceRead();
    var cached = cacheRead();
    if (!src) {
      // Remembered before storage providers: a file handle, or a download-mode working copy.
      var local = usable('local');
      var r = local && local.restore ? await local.restore() : null;
      if (r) src = { provider: 'local', ref: r };
      else if (cached && cached.doc && cacheProviderId(cached) === 'download') src = { provider: 'download', ref: cacheRef(cached) };
    }

    var p = src && usable(src.provider);
    if (p && p.autosave) {
      state.provider = p;
      state.ref = src.ref;
      state.fileName = src.ref.name;
      try {
        await p.authorize({ interactive: false });
        await loadFrom(p, src.ref);
      } catch (e) {
        if (e && e.name === 'NeedsReconnect') {
          state.needsReconnect = true; // the bar explains; Reconnect shows any error
        } else {
          if (e && e.name === 'NotFound' && state.provider) { forgetSource(); resetState(); }
          state.error = e && e.message ? e.message : String(e);
        }
      }
    } else if (p && cached && cached.doc && cacheProviderId(cached) === p.id) {
      // Download mode: the working copy is all there is until the next Save file.
      state.doc = cached.doc;
      state.provider = p;
      state.ref = cacheRef(cached);
      state.fileName = cached.fileName || DEFAULT_NAME;
      state.dirty = !!cached.dirty;
      state.lastSaved = cached.lastSaved ? new Date(cached.lastSaved) : null;
      rememberSource();
    }
    state.ready = true;
    emit();
  }

  // Wait for the rest of the page's scripts (providers, UI) before looking for the file.
  function whenParsed() {
    return new Promise(function (resolve) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { resolve(); });
      else resolve();
    });
  }

  // Every tool section should carry a numeric schemaVersion so its shape can be
  // migrated later. Not enforced (old data must keep loading), but flagged once.
  var warnedUnversioned = {};
  function warnIfUnversioned(toolId, value) {
    if (warnedUnversioned[toolId]) return;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.schemaVersion !== 'number') {
      warnedUnversioned[toolId] = true;
      console.warn('Toolbox: data for "' + toolId + '" should be an object with a numeric schemaVersion.');
    }
  }

  /* ---------- public API ---------- */

  function status() {
    var p = state.provider;
    return {
      ready: state.ready,
      connected: !!state.doc,
      mode: p ? p.kind : null,            // 'file' | 'download' | 'cloud' | null
      provider: p ? p.id : null,
      providerLabel: p ? p.label : null,
      account: p && p.account ? p.account() : null,
      canSignOut: !!(p && p.signOut),
      fileName: state.fileName,
      dirty: state.dirty,
      saving: !!writing,
      lastSaved: state.lastSaved,
      needsReconnect: state.needsReconnect,
      conflict: state.conflict,
      error: state.error,
      generation: state.generation,
      canUseFileHandles: canUseFileHandles,
      cloudProviders: cloudProviders().map(function (c) { return { id: c.id, label: c.label }; }),
      storage: currentStorage(),          // 'device' | a cloud provider id
      storageOptions: [{ id: 'device', label: storageLabel('device') }].concat(
        cloudProviders().map(function (c) { return { id: c.id, label: c.label }; })),
      size: state.doc ? serialize().length : 0,
      toolIds: state.doc ? Object.keys(state.doc.tools) : []
    };
  }

  function changed() {
    state.doc.updatedAt = nowIso();
    state.dirty = true;
    rev++;
    persistCache();
    if (state.provider && state.provider.autosave) scheduleSave();
    emit();
  }

  async function closeFile(opts) {
    if (state.provider && state.provider.autosave && state.dirty && !state.needsReconnect && !state.conflict) await settle();
    if (hasUnsaved() && !(opts && opts.discard) &&
      !global.confirm('You have changes that haven’t been saved to your file yet. Discard them?')) return false;
    if (state.provider && state.provider.forget) await state.provider.forget();
    forgetSource();
    resetState();
    return true;
  }

  var Toolbox = {
    FORMAT: FORMAT,
    VERSION: VERSION,
    DEFAULT_NAME: DEFAULT_NAME,
    canUseFileHandles: canUseFileHandles,

    /** Resolves once the remembered file (if any) has been checked. */
    ready: null,

    status: status,

    /** Subscribe to status/data changes. Returns an unsubscribe function. */
    on: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    },

    /** Call every subscriber again with the current status (e.g. after mounting more UI). */
    refresh: emit,

    /** A copy of a tool's stored data, or `fallback` if none / no file is open. */
    get: function (toolId, fallback) {
      if (!state.doc || !(toolId in state.doc.tools)) return fallback;
      return clone(state.doc.tools[toolId]);
    },

    /** Replace a tool's stored data. Returns false if no data file is open. */
    set: function (toolId, value) {
      if (!state.doc || state.needsReconnect) return false;
      warnIfUnversioned(toolId, value);
      state.doc.tools[toolId] = clone(value);
      changed();
      return true;
    },

    /** Read-modify-write: fn(current) returns the new value (or mutates and returns nothing). */
    update: function (toolId, fn, fallback) {
      var cur = Toolbox.get(toolId, fallback);
      var next = fn(cur);
      return Toolbox.set(toolId, next === undefined ? cur : next);
    },

    /** Delete a tool's data from the file. */
    remove: function (toolId) {
      if (!state.doc || state.needsReconnect || !(toolId in state.doc.tools)) return false;
      delete state.doc.tools[toolId];
      changed();
      return true;
    },

    /** Start a brand-new, empty data file. providerId: e.g. 'gdrive'; omit for this device. */
    createFile: action(async function (providerId) {
      guardUnsavedDownload();
      var p = providerFor(providerId);
      await settle();
      var doc = emptyDoc();
      var r = await p.create(DEFAULT_NAME, JSON.stringify(doc, null, 2));
      adopt(p, r.ref, doc, { version: r.version, lastSaved: r.modifiedTime });
    }),

    /** Point the toolbox at an existing data file. providerId: e.g. 'gdrive'; omit for this device. */
    openFile: action(async function (providerId) {
      guardUnsavedDownload();
      var p = providerFor(providerId);
      await settle();
      var picked = await p.pick();
      if (!picked) return;
      if (picked.text != null) {
        adopt(p, picked.ref, parseDoc(picked.text), { version: picked.version, lastSaved: picked.modifiedTime });
      } else {
        await loadFrom(p, picked.ref);
      }
    }),

    /** Get access to the remembered file again (needs a click). */
    reconnect: action(async function () {
      var p = state.provider;
      if (!p || !state.ref) throw new Error('No file to reconnect to. Open your data file instead.');
      await p.authorize({ interactive: true });
      if (state.doc) {
        // Lost access while working (e.g. a sign-in expired): keep going, then save.
        state.needsReconnect = false;
        if (state.dirty) await flush();
      } else {
        await loadFrom(p, state.ref);
      }
    }),

    /** After a conflict: drop changes made here and load the file as it is now. */
    reloadFile: action(async function () {
      if (!state.provider || !state.ref) return;
      await loadFrom(state.provider, state.ref, { discardLocal: true });
    }),

    /** After a conflict: replace the file with the changes made here. */
    overwriteFile: action(async function () {
      if (!state.doc) return;
      state.conflict = false;
      state.version = null; // write without checking the file's revision
      state.dirty = true;
      await flush();
    }),

    /** Ask again which version to keep after a conflict. */
    resolveConflict: action(promptConflict),

    /**
     * Save now. Writes straight to the file wherever the browser allows it; otherwise
     * explains why it can't (Toolbox.prompts.manualSave) and downloads an updated copy.
     */
    save: action(async function () {
      if (!state.doc) return;
      if (state.provider && state.provider.autosave) {
        if (state.conflict) return promptConflict();
        clearTimeout(saveTimer);
        await flush();
        return;
      }
      var local = usable('local');
      if (local) {
        // This browser can write files, but has no link to this one yet (e.g. the
        // changes came from the working copy). Ask where to save: picking the original
        // file overwrites it, and from then on changes save to it automatically.
        var r = await local.create(state.fileName || DEFAULT_NAME, serialize());
        adopt(local, r.ref, state.doc, { version: r.version, lastSaved: r.modifiedTime, sameDoc: true });
        return;
      }
      if (!(await Toolbox.prompts.manualSave({ fileName: state.fileName || DEFAULT_NAME }))) return;
      downloadText(serialize(), state.fileName);
      state.dirty = false;
      state.lastSaved = new Date();
      persistCache();
    }),

    /** Download a copy of the current data (a backup), in any mode. */
    downloadCopy: action(async function () {
      if (!state.doc) return;
      var dl = isDownload();
      downloadText(serialize(), dl ? state.fileName : backupName());
      if (dl) { state.dirty = false; state.lastSaved = new Date(); persistCache(); }
    }),

    /** Stop using the current file in this browser. The file itself is untouched. */
    closeFile: action(closeFile),

    /**
     * Change where the data file is kept: 'device' or a cloud provider id. If a file
     * is open this closes it (after saving what can be saved, and asking first with
     * Toolbox.prompts.switchStorage, which warns about changes that would be lost).
     * Create / Open then use the new storage.
     */
    switchStorage: action(async function (id) {
      if (id !== 'device') providerFor(id); // throws if it isn't available
      if (id === currentStorage()) return;
      if (state.provider) {
        if (state.provider.autosave && state.dirty && !state.needsReconnect && !state.conflict) await settle();
        var ok = await Toolbox.prompts.switchStorage({
          fileName: state.fileName,
          from: storageLabel(currentStorage()),
          to: storageLabel(id),
          unsaved: hasUnsaved()
        });
        if (!ok || !(await closeFile({ discard: true }))) return;
      }
      rememberStorage(id);
    }),

    /** Close the file and sign out of its provider (e.g. Google Drive). */
    signOut: action(async function () {
      var p = state.provider;
      if (!p || !p.signOut) return;
      if (await closeFile()) await p.signOut();
    }),

    /** Add a storage provider (see "storage providers" in this file). */
    registerProvider: function (p) { providers[p.id] = p; },

    /** A registered provider by id, or null. */
    getProvider: function (id) { return providers[id] || null; },

    /** An Error with a name the data layer understands: NeedsReconnect, NotFound or Conflict. */
    storageError: storageError,

    /** Save `text` as a download named `name`. */
    downloadText: downloadText,

    /**
     * Questions the data layer asks the user. lib/toolbox-ui.js replaces these
     * plain fallbacks with proper dialogs.
     *   manualSave({ fileName }) → Promise<boolean>: go ahead and download?
     *   conflict({ fileName, where }) → Promise<'mine' | 'theirs' | null>
     *   switchStorage({ fileName, from, to, unsaved }) → Promise<boolean>: close the file and switch?
     */
    prompts: {
      manualSave: function () { return Promise.resolve(true); },
      switchStorage: function (o) {
        return Promise.resolve(global.confirm(
          'Switch to ' + o.to + '? This closes ' + o.fileName + ' here.' +
          (o.unsaved ? '\n\nYou have changes that haven’t been saved to it. They will be lost.' : '')
        ));
      },
      conflict: function (o) {
        return Promise.resolve(global.confirm(
          o.fileName + ' was changed in ' + o.where + ' since you opened it here.\n\n' +
          'OK: keep your version (overwrite). Cancel: reload the file and lose your changes.'
        ) ? 'mine' : 'theirs');
      }
    }
  };

  global.Toolbox = Toolbox;

  Toolbox.ready = whenParsed().then(init).catch(function (e) {
    state.ready = true;
    fail(e && e.message ? e.message : String(e));
  });
})(window);
