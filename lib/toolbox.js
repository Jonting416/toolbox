/*
 * Toolbox data layer — shared by the landing page and every tool.
 *
 * All data lives in ONE JSON file the user keeps on their own computer:
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
 * Two ways the file is kept:
 *  - "file" mode (Chrome, Edge, Opera, other Chromium browsers): the File System
 *    Access API gives us a handle to the real file. Changes save to it
 *    automatically, and the handle is remembered across visits (the browser may
 *    ask the user to re-grant permission with one click).
 *  - "download" mode (Firefox, Safari): the file is read with a normal file
 *    picker. Changes are kept as a working copy in this browser until the user
 *    downloads the updated file.
 *
 * Plain script (not an ES module) so the site also works when opened from disk.
 *
 * This file also loads GoatCounter (anonymous, cookieless page-view counting) and
 * shows a one-time notice about it on every page; see "page-view counting" below.
 */
(function (global) {
  'use strict';

  var FORMAT = 'toolbox-data';
  var VERSION = 1;
  var DEFAULT_NAME = 'toolbox-data.json';
  var CACHE_KEY = 'toolbox:working-copy';
  var IDB_NAME = 'toolbox';
  var IDB_STORE = 'handles';
  var HANDLE_KEY = 'datafile';
  var PICKER_TYPES = [{ description: 'Toolbox data file', accept: { 'application/json': ['.json'] } }];

  var canUseFileHandles =
    typeof global.showOpenFilePicker === 'function' &&
    typeof global.showSaveFilePicker === 'function';

  // Firefox can't show a save dialog from a page, but its own setting can make
  // every download ask where to save.
  var isFirefox = /firefox\//i.test((global.navigator && global.navigator.userAgent) || '');

  var state = {
    ready: false,
    doc: null,          // the parsed data file
    mode: null,         // 'file' | 'download' | null
    handle: null,       // FileSystemFileHandle in file mode
    fileName: null,
    dirty: false,       // changes not yet written / downloaded
    lastSaved: null,    // Date
    needsReconnect: false,
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

  /* ---------- working copy (localStorage) ---------- */

  function cacheRead() {
    try { var s = localStorage.getItem(CACHE_KEY); return s ? JSON.parse(s) : null; }
    catch (e) { return null; }
  }

  function persistCache() {
    try {
      if (!state.doc) { localStorage.removeItem(CACHE_KEY); return; }
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        doc: state.doc,
        mode: state.mode,
        fileName: state.fileName,
        dirty: state.dirty,
        lastSaved: state.lastSaved ? state.lastSaved.toISOString() : null
      }));
    } catch (e) { /* storage full or blocked: the file is still the source of truth */ }
  }

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

  /* ---------- reading & writing ---------- */

  async function loadFromHandle(handle) {
    var file;
    try { file = await handle.getFile(); }
    catch (e) {
      await forgetHandle();
      resetState();
      throw new Error('Couldn’t find “' + handle.name + '”. It may have been moved or deleted — open it again.');
    }
    var doc = parseDoc(await file.text());

    // If the last page closed before an autosave finished, the working copy is newer.
    var cached = cacheRead();
    var recovered = !!(cached && cached.mode === 'file' && cached.dirty && cached.doc &&
      cached.fileName === handle.name && cached.doc.updatedAt > doc.updatedAt);
    if (recovered) doc = cached.doc;

    state.doc = doc;
    state.mode = 'file';
    state.handle = handle;
    state.fileName = handle.name;
    state.needsReconnect = false;
    state.lastSaved = new Date(file.lastModified);
    state.dirty = recovered;
    state.error = null;
    state.generation++;
    persistCache();
    if (recovered) scheduleSave(0);
  }

  function scheduleSave(delay) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delay == null ? 300 : delay);
  }

  function flush() {
    if (state.mode !== 'file' || !state.handle || !state.doc) return Promise.resolve();
    if (writing) { writeAgain = true; return writing; }
    var startedAt = rev;
    writing = (async function () {
      try {
        var w = await state.handle.createWritable();
        await w.write(serialize());
        await w.close();
        if (rev === startedAt) state.dirty = false;
        state.lastSaved = new Date();
        state.error = null;
        persistCache();
      } catch (e) {
        if (e && e.name === 'NotAllowedError') {
          state.needsReconnect = true;
          state.error = 'The browser needs your permission again to save. Click Reconnect.';
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

  function resetState() {
    clearTimeout(saveTimer);
    state.doc = null;
    state.mode = null;
    state.handle = null;
    state.fileName = null;
    state.dirty = false;
    state.lastSaved = null;
    state.needsReconnect = false;
    state.generation++;
    persistCache();
  }

  function guardUnsavedDownload() {
    if (state.mode === 'download' && state.dirty) {
      throw new Error('Download your changes (or discard them) before switching files.');
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

  /* ---------- startup ---------- */

  async function init() {
    if (canUseFileHandles) {
      var handle = await recallHandle();
      if (handle) {
        state.handle = handle;
        state.fileName = handle.name;
        state.mode = 'file';
        var perm = 'prompt';
        try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { /* ignore */ }
        if (perm === 'granted') {
          try { await loadFromHandle(handle); } catch (e) { state.error = e.message; }
        } else {
          state.needsReconnect = true;
        }
      }
    }
    if (!state.mode) {
      var cached = cacheRead();
      if (cached && cached.doc && cached.mode === 'download') {
        state.doc = cached.doc;
        state.mode = 'download';
        state.fileName = cached.fileName || DEFAULT_NAME;
        state.dirty = !!cached.dirty;
        state.lastSaved = cached.lastSaved ? new Date(cached.lastSaved) : null;
      }
    }
    state.ready = true;
    emit();
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
    return {
      ready: state.ready,
      connected: !!state.doc,
      mode: state.mode,
      fileName: state.fileName,
      dirty: state.dirty,
      saving: !!writing,
      lastSaved: state.lastSaved,
      needsReconnect: state.needsReconnect,
      error: state.error,
      generation: state.generation,
      canUseFileHandles: canUseFileHandles,
      size: state.doc ? serialize().length : 0,
      toolIds: state.doc ? Object.keys(state.doc.tools) : []
    };
  }

  var Toolbox = {
    FORMAT: FORMAT,
    VERSION: VERSION,
    canUseFileHandles: canUseFileHandles,

    /** Resolves once the remembered file (if any) has been checked. */
    ready: null,

    status: status,

    /** Subscribe to status/data changes. Returns an unsubscribe function. */
    on: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    },

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
      state.doc.updatedAt = nowIso();
      state.dirty = true;
      rev++;
      persistCache();
      if (state.mode === 'file') scheduleSave();
      emit();
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
      state.doc.updatedAt = nowIso();
      state.dirty = true;
      rev++;
      persistCache();
      if (state.mode === 'file') scheduleSave();
      emit();
      return true;
    },

    /** Start a brand-new, empty data file. */
    createFile: action(async function () {
      guardUnsavedDownload();
      if (canUseFileHandles) {
        var handle = await global.showSaveFilePicker({ suggestedName: DEFAULT_NAME, types: PICKER_TYPES });
        state.doc = emptyDoc();
        state.mode = 'file';
        state.handle = handle;
        state.fileName = handle.name;
        state.needsReconnect = false;
        state.dirty = true;
        state.generation++;
        rev++;
        await rememberHandle(handle);
        await flush();
      } else {
        state.doc = emptyDoc();
        state.mode = 'download';
        state.fileName = DEFAULT_NAME;
        state.dirty = false;
        state.generation++;
        state.lastSaved = new Date();
        downloadText(serialize(), state.fileName);
        persistCache();
      }
    }),

    /** Point the toolbox at an existing data file. */
    openFile: action(async function () {
      guardUnsavedDownload();
      if (canUseFileHandles) {
        var picked = await global.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
        var handle = picked[0];
        var perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') throw new Error('Permission to save to that file was not granted.');
        await loadFromHandle(handle);
        await rememberHandle(handle);
      } else {
        var file = await pickFileFallback();
        if (!file) return;
        var doc = parseDoc(await file.text());
        state.doc = doc;
        state.mode = 'download';
        state.fileName = file.name;
        state.dirty = false;
        state.lastSaved = new Date(file.lastModified);
        state.generation++;
        persistCache();
      }
    }),

    /** Re-grant permission for the remembered file (needs a click). */
    reconnect: action(async function () {
      if (!state.handle) throw new Error('No file to reconnect to. Open your data file instead.');
      var perm = await state.handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('Permission was not granted.');
      await loadFromHandle(state.handle);
    }),

    /** Save now: writes the file (file mode) or downloads it (download mode). */
    save: action(async function () {
      if (!state.doc) return;
      if (state.mode === 'file') {
        clearTimeout(saveTimer);
        await flush();
      } else {
        downloadText(serialize(), state.fileName);
        state.dirty = false;
        state.lastSaved = new Date();
        persistCache();
      }
    }),

    /** Download a copy of the current data (a backup), in any mode. */
    downloadCopy: action(async function () {
      if (!state.doc) return;
      var stamp = new Date().toISOString().slice(0, 10);
      var base = (state.fileName || DEFAULT_NAME).replace(/\.json$/i, '');
      downloadText(serialize(), state.mode === 'download' ? state.fileName : base + '-backup-' + stamp + '.json');
      if (state.mode === 'download') { state.dirty = false; state.lastSaved = new Date(); persistCache(); }
    }),

    /** Stop using the current file in this browser. The file itself is untouched. */
    closeFile: action(async function (opts) {
      if (state.mode === 'download' && state.dirty && !(opts && opts.discard)) {
        if (!global.confirm('You have changes that haven’t been downloaded yet. Discard them?')) return;
      }
      if (state.mode === 'file' && state.dirty && !state.needsReconnect) await flush();
      await forgetHandle();
      resetState();
    })
  };

  /* ---------- small UI helpers shared by pages ---------- */

  Toolbox.timeAgo = function (date) {
    if (!date) return '';
    var s = Math.round((Date.now() - date.getTime()) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + ' sec ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' hr ago';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  Toolbox.formatBytes = function (n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  Toolbox.escape = esc;

  /**
   * Render the data-file status bar into `el` and keep it updated.
   * options.variant: 'compact' (tool pages, default) or 'panel' (landing page).
   */
  function runAction(a) {
    if (a === 'create') Toolbox.createFile();
    else if (a === 'open') Toolbox.openFile();
    else if (a === 'reconnect') Toolbox.reconnect();
    else if (a === 'save') Toolbox.save();
    else if (a === 'copy') Toolbox.downloadCopy();
    else if (a === 'close') Toolbox.closeFile();
  }

  function downloadModeNote() {
    var note = '<p class="databar-note">This browser can’t save to files directly, so changes are kept here until you download the updated file. Chrome or Edge can save automatically.</p>';
    if (isFirefox) {
      note += '<p class="databar-note">To choose where the file is saved, open Firefox <strong>Settings → General → Files and Applications</strong> and turn on <strong>Always ask you where to save files</strong>.</p>';
    }
    return note;
  }

  // Once a file is open, the header "account" chip stands in for the data bar,
  // like a signed-in user. Only applies on pages that mount the chip.
  var accountMounted = false;
  function fileInUse(s) {
    return accountMounted && s.ready && s.connected && !s.needsReconnect;
  }

  Toolbox.mountDataBar = function (el, options) {
    var variant = (options && options.variant) || 'compact';
    el.classList.add('databar', 'databar--' + variant);

    function btn(act, label, kind) {
      return '<button type="button" class="btn ' + (kind ? 'btn--' + kind : '') + '" data-act="' + act + '">' + label + '</button>';
    }

    function render(s) {
      el.hidden = fileInUse(s);
      if (el.hidden) return;
      var tone, title, detail, actions = [];
      if (!s.ready) {
        tone = 'idle'; title = 'Checking for your data file…'; detail = '';
      } else if (s.needsReconnect) {
        tone = 'warn';
        title = s.fileName;
        detail = 'Your browser needs permission again to read and save this file.';
        actions.push(btn('reconnect', 'Reconnect', 'primary'), btn('open', 'Open a different file'));
      } else if (!s.connected) {
        tone = 'idle';
        title = 'No data file open';
        detail = variant === 'panel'
          ? 'Everything you do in these tools is saved to one file that you keep. Create one, or open the file you used last time.'
          : 'Open or create your data file to save your work.';
        actions.push(btn('create', 'Create new file', 'primary'), btn('open', 'Open existing file'));
      } else if (s.mode === 'file') {
        tone = s.saving ? 'busy' : 'ok';
        title = s.fileName;
        detail = s.saving ? 'Saving…' : (s.dirty ? 'Changes pending…' : 'Saved automatically · ' + Toolbox.timeAgo(s.lastSaved));
        if (variant === 'panel') {
          detail += ' · ' + Toolbox.formatBytes(s.size) + ' · ' + s.toolIds.length + (s.toolIds.length === 1 ? ' tool' : ' tools') + ' with data';
          actions.push(btn('copy', 'Download backup'), btn('open', 'Switch file'), btn('close', 'Close', 'ghost'));
        } else {
          actions.push(btn('copy', 'Backup'));
        }
      } else {
        tone = s.dirty ? 'warn' : 'ok';
        title = s.fileName;
        detail = s.dirty
          ? 'Unsaved changes — download the file to keep them.'
          : 'Up to date · downloaded ' + Toolbox.timeAgo(s.lastSaved);
        if (s.dirty) {
          actions.push(btn('save', 'Download file', 'primary'));
          if (variant === 'panel') actions.push(btn('close', 'Discard changes', 'ghost'));
        } else if (variant === 'panel') {
          actions.push(btn('open', 'Open file'), btn('create', 'New file'), btn('close', 'Close', 'ghost'));
        }
      }

      var note = '';
      if (variant === 'panel' && s.ready && s.mode === 'download') note = downloadModeNote();

      el.dataset.tone = tone;
      el.innerHTML =
        '<div class="databar-main">' +
          '<span class="databar-icon" aria-hidden="true">' + ICONS.file + '</span>' +
          '<div class="databar-text">' +
            (variant === 'panel' ? '<span class="eyebrow">Data file</span>' : '') +
            '<strong class="databar-title">' + esc(title) + '</strong>' +
            (detail ? '<span class="databar-detail"><span class="dot"></span>' + esc(detail) + '</span>' : '') +
          '</div>' +
          (actions.length ? '<div class="databar-actions">' + actions.join('') + '</div>' : '') +
        '</div>' +
        (s.error ? '<p class="databar-error" role="alert">' + esc(s.error) + '</p>' : '') +
        note;
    }

    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (b) runAction(b.dataset.act);
    });

    render(status());
    Toolbox.on(render);
    setInterval(function () { render(status()); }, 30000); // keep "x min ago" fresh
  };

  /**
   * Render the open data file into a page header, like a signed-in account:
   * a chip with the file name that opens a menu of file actions. While a file is
   * in use, any data bar on the page hides itself; when no file is open (or it
   * needs reconnecting) the chip hides and the data bar acts as the "sign-in".
   */
  Toolbox.mountAccount = function (el) {
    accountMounted = true;
    el.classList.add('account');
    el.innerHTML =
      '<button type="button" class="account-chip" aria-haspopup="true" aria-expanded="false">' +
        '<span class="account-icon" aria-hidden="true">' + ICONS.file + '</span>' +
        '<span class="account-name"></span>' +
        '<span class="dot" aria-hidden="true"></span>' +
      '</button>' +
      '<span class="account-quick"></span>' +
      '<div class="account-menu" role="menu" hidden></div>';
    var chip = el.querySelector('.account-chip');
    var nameEl = el.querySelector('.account-name');
    var quick = el.querySelector('.account-quick');
    var menu = el.querySelector('.account-menu');
    var lastError = null;

    function item(act, label, kind) {
      return '<button type="button" role="menuitem" class="account-item' + (kind ? ' account-item--' + kind : '') + '" data-act="' + act + '">' + label + '</button>';
    }

    function setOpen(open) {
      menu.hidden = !open;
      chip.setAttribute('aria-expanded', String(open));
    }

    function render(s) {
      el.hidden = !fileInUse(s);
      if (el.hidden) { setOpen(false); return; }

      var tone, detail, items = [], quickHtml = '';
      if (s.mode === 'file') {
        tone = s.saving ? 'busy' : 'ok';
        detail = s.saving ? 'Saving…' : (s.dirty ? 'Changes pending…' : 'Saved automatically · ' + Toolbox.timeAgo(s.lastSaved));
        items.push(item('copy', 'Download backup'), item('open', 'Switch file'), item('close', 'Close file'));
      } else {
        tone = s.dirty ? 'warn' : 'ok';
        detail = s.dirty ? 'Unsaved changes — download the file to keep them.' : 'Up to date · downloaded ' + Toolbox.timeAgo(s.lastSaved);
        if (s.dirty) {
          quickHtml = '<button type="button" class="btn btn--primary" data-act="save">Download file</button>';
          items.push(item('save', 'Download file'), item('close', 'Discard changes', 'danger'));
        } else {
          items.push(item('open', 'Open file'), item('create', 'New file'), item('close', 'Close file'));
        }
      }
      if (s.error) tone = 'warn';

      el.dataset.tone = tone;
      nameEl.textContent = s.fileName;
      chip.title = s.fileName + ' — ' + detail;
      if (quick.innerHTML !== quickHtml) quick.innerHTML = quickHtml;

      var html =
        '<div class="account-head">' +
          '<span class="eyebrow">Data file</span>' +
          '<strong class="account-title">' + esc(s.fileName) + '</strong>' +
          '<span class="account-detail">' + esc(detail) + '</span>' +
          '<span class="account-detail">' + Toolbox.formatBytes(s.size) + ' · ' + s.toolIds.length + (s.toolIds.length === 1 ? ' tool' : ' tools') + ' with data</span>' +
        '</div>' +
        (s.error ? '<p class="databar-error" role="alert">' + esc(s.error) + '</p>' : '') +
        '<div class="account-items">' + items.join('') + '</div>' +
        (s.mode === 'download' ? '<div class="account-notes">' + downloadModeNote() + '</div>' : '');
      // Only touch the DOM when something changed, so focus inside the menu survives.
      if (menu.innerHTML !== html) menu.innerHTML = html;

      // Surface a new error by opening the menu it's shown in.
      if (s.error && s.error !== lastError) setOpen(true);
      lastError = s.error;
    }

    chip.addEventListener('click', function () { setOpen(menu.hidden); });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      setOpen(false);
      runAction(b.dataset.act);
    });
    document.addEventListener('click', function (e) { if (!el.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) { setOpen(false); chip.focus(); }
    });

    Toolbox.on(render);
    emit(); // re-render every mounted bar now that the chip exists
    setInterval(function () { render(status()); }, 30000);
  };

  /* ---------- icons (stroke icons, inherit currentColor) ---------- */

  var svg = function (body) {
    return '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  };
  var ICONS = {
    file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>'),
    dumbbell: svg('<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/>'),
    timer: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M10 2h4M12 2v3"/>'),
    note: svg('<path d="M5 4h14v12l-4 4H5z"/><path d="M15 20v-4h4M8 9h8M8 13h5"/>'),
    chart: svg('<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>'),
    calendar: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>'),
    list: svg('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>'),
    wrench: svg('<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8-1.3-1.3a4 4 0 0 1-5-5L13 2z"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>')
  };
  Toolbox.icons = ICONS;

  /* ---------- page-view counting (GoatCounter) ---------- */
  //
  // Every page loads this file, so counting is set up once here instead of in each
  // page's HTML. GoatCounter records anonymous page views (path, referrer, browser,
  // screen size, country) with no cookies. Tool data is never sent: it only ever
  // lives in the user's own data file. Visitors can opt out; the choice is kept in
  // this browser's localStorage.

  var GOATCOUNTER_ENDPOINT = 'https://aremi.goatcounter.com/count';
  var GOATCOUNTER_SCRIPT = 'https://gc.zgo.at/count.js';
  var ANALYTICS_KEY = 'toolbox:analytics';            // 'off' when the visitor opted out
  var NOTICE_KEY = 'toolbox:analytics-notice-seen';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* blocked storage: choice lasts this page only */ }
  }

  function countingEnabled() { return lsGet(ANALYTICS_KEY) !== 'off'; }

  function startCounting() {
    if (!countingEnabled() || document.querySelector('script[data-goatcounter]')) return;
    global.goatcounter = global.goatcounter || {};
    global.goatcounter.endpoint = GOATCOUNTER_ENDPOINT;
    var s = document.createElement('script');
    s.async = true;
    s.src = GOATCOUNTER_SCRIPT;
    s.setAttribute('data-goatcounter', GOATCOUNTER_ENDPOINT);
    document.body.appendChild(s);
  }

  var noticeEl = null;
  function renderNotice() {
    var on = countingEnabled();
    noticeEl.innerHTML =
      '<p class="notice-text"><strong>About this site:</strong> it counts anonymous page views with ' +
        '<a href="https://www.goatcounter.com" target="_blank" rel="noopener">GoatCounter</a>: no cookies, nothing that identifies you. ' +
        'Your tool data stays in your own file and is never sent anywhere.' +
        (on ? '' : ' <em>Your visits are not being counted.</em>') + '</p>' +
      '<div class="notice-actions">' +
        '<button type="button" class="btn btn--primary" data-notice="ok">Got it</button>' +
        '<button type="button" class="btn btn--ghost" data-notice="toggle">' + (on ? 'Don’t count my visits' : 'Count my visits') + '</button>' +
      '</div>';
  }

  function showNotice() {
    if (noticeEl || lsGet(NOTICE_KEY)) return;
    noticeEl = document.createElement('div');
    noticeEl.className = 'notice-bar';
    noticeEl.setAttribute('role', 'region');
    noticeEl.setAttribute('aria-label', 'Privacy notice');
    renderNotice();
    noticeEl.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-notice]');
      if (!b) return;
      if (b.dataset.notice === 'toggle') { Toolbox.setAnalytics(!countingEnabled()); renderNotice(); return; }
      lsSet(NOTICE_KEY, '1');
      noticeEl.remove();
      noticeEl = null;
    });
    document.body.appendChild(noticeEl);
  }

  /** Whether this browser's page views are counted. */
  Toolbox.analyticsEnabled = countingEnabled;
  /** Opt in or out of page-view counting in this browser (takes effect from the next page load). */
  Toolbox.setAnalytics = function (on) {
    lsSet(ANALYTICS_KEY, on ? null : 'off');
    if (on) startCounting();
    emit();
  };

  function onBodyReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  onBodyReady(function () { startCounting(); showNotice(); });

  Toolbox.ready = init().catch(function (e) {
    state.ready = true;
    fail(e && e.message ? e.message : String(e));
  });

  global.Toolbox = Toolbox;
})(window);
