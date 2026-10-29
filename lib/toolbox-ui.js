/*
 * Shared Toolbox UI: the data-file bar, the header "account" chip, dialogs, small
 * formatting helpers and icons. Loaded after lib/toolbox.js and the providers.
 *
 * Also supplies the data layer's questions (Toolbox.prompts) as proper dialogs:
 * "your browser can't save to the file" and "this file changed somewhere else".
 */
(function (global) {
  'use strict';

  var Toolbox = global.Toolbox;

  // Firefox can't show a save dialog from a page, but its own setting can make
  // every download ask where to save.
  var isFirefox = /firefox\//i.test((global.navigator && global.navigator.userAgent) || '');

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* blocked storage: lasts this page only */ }
  }

  /* ---------- small helpers shared by pages ---------- */

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

  /* ---------- dialogs ---------- */

  /**
   * A small modal. By default it has Cancel / OK and resolves true for OK, false for
   * Cancel, Escape or clicking outside. o.buttons replaces those:
   * [{ label, value, kind, run }] resolves with the clicked button's value, except a
   * button with `run`, which calls it and leaves the box open.
   */
  function showDialog(o) {
    var buttons = o.buttons || [
      { label: 'Cancel', value: false, kind: 'ghost' },
      { label: o.ok, value: true, kind: 'primary' }
    ];
    return new Promise(function (resolve) {
      var prev = document.activeElement;
      var wrap = document.createElement('div');
      wrap.className = 'tb-dialog-backdrop';
      wrap.innerHTML =
        '<div class="tb-dialog" role="dialog" aria-modal="true" aria-labelledby="tb-dialog-title">' +
          '<h2 class="tb-dialog-title" id="tb-dialog-title">' + esc(o.title) + '</h2>' +
          '<div class="tb-dialog-body">' + o.body + '</div>' +
          (o.dontShowKey ? '<label class="tb-dialog-check"><input type="checkbox"> Don’t show this again</label>' : '') +
          '<div class="tb-dialog-actions">' +
            buttons.map(function (b, i) {
              return '<button type="button" class="btn' + (b.kind ? ' btn--' + b.kind : '') + '" data-r="' + i + '">' + esc(b.label) + '</button>';
            }).join('') +
          '</div>' +
        '</div>';
      function done(value) {
        var box = wrap.querySelector('.tb-dialog-check input');
        if (value === true && box && box.checked) lsSet(o.dontShowKey, '1');
        document.removeEventListener('keydown', onKey, true);
        wrap.remove();
        if (prev && prev.focus) prev.focus();
        resolve(value);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Tab') {
          // Keep focus inside the box.
          var f = wrap.querySelectorAll('button, input'), first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      wrap.addEventListener('click', function (e) {
        var el = e.target.closest('button[data-r]');
        if (el) {
          var b = buttons[Number(el.dataset.r)];
          if (b.run) b.run(); else done(b.value);
        } else if (e.target === wrap) done(false);
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(wrap);
      wrap.querySelector('[data-r="' + (buttons.length - 1) + '"]').focus();
    });
  }
  Toolbox.showDialog = showDialog;

  var SAVE_INFO_KEY = 'toolbox:save-info-hidden';

  /** Explain that this browser can't write to the file. Resolves true to go ahead and download. */
  Toolbox.prompts.manualSave = function (o) {
    if (lsGet(SAVE_INFO_KEY)) return Promise.resolve(true);
    var browser = isFirefox ? 'Firefox' : 'This browser';
    return showDialog({
      title: 'Your browser can’t save to the file directly',
      body:
        '<p>' + browser + ' doesn’t let websites write to files on your computer, so Toolbox can’t update ' +
          '<strong>' + esc(o.fileName) + '</strong> itself.</p>' +
        '<p>Instead, your browser will <strong>download an updated copy</strong>. To keep your changes, replace your old ' +
          'data file with the downloaded one (or open the downloaded file next time).</p>' +
        (isFirefox ? '<p>Tip: to choose where it’s saved, turn on <strong>Always ask you where to save files</strong> in ' +
          'Firefox Settings → General → Files and Applications.</p>' : '') +
        '<p class="tb-dialog-muted">Chrome and Edge can save straight to the file.</p>',
      ok: 'Download updated file',
      dontShowKey: SAVE_INFO_KEY
    });
  };

  /** The file changed elsewhere: resolves 'mine', 'theirs', or false to decide later. */
  Toolbox.prompts.conflict = function (o) {
    return showDialog({
      title: 'This file changed somewhere else',
      body:
        '<p><strong>' + esc(o.fileName) + '</strong> was changed in ' + esc(o.where) + ' since you opened it here ' +
          '— maybe on another device or in another tab.</p>' +
        '<p>Choose which version to keep. To keep both, download your copy first.</p>',
      buttons: [
        { label: 'Download my copy', kind: 'ghost', run: function () { Toolbox.downloadCopy(); } },
        { label: 'Reload from ' + o.where, value: 'theirs' },
        { label: 'Keep mine', value: 'mine', kind: 'primary' }
      ]
    });
  };

  /** Switching storage closes the open file: confirm, and warn loudly about unsaved changes. */
  Toolbox.prompts.switchStorage = function (o) {
    var body = o.unsaved
      ? '<p><strong>You have changes that haven’t been saved to ' + esc(o.fileName) + '.</strong> ' +
          'Switching storage closes this file here, and those changes will be lost.</p>' +
        '<p>To keep them, download your copy first, then switch.</p>'
      : '<p>Switching storage closes <strong>' + esc(o.fileName) + '</strong> here. The file itself isn’t changed, ' +
          'and you can open it again later from ' + esc(o.from) + '.</p>' +
        '<p>Then open or create a data file in ' + esc(o.to) + '.</p>';
    var buttons = [{ label: 'Cancel', value: false, kind: 'ghost' }];
    if (o.unsaved) buttons.push({ label: 'Download my copy', run: function () { Toolbox.downloadCopy(); } });
    buttons.push(o.unsaved
      ? { label: 'Switch and lose changes', value: true, kind: 'destructive' }
      : { label: 'Switch to ' + o.to, value: true, kind: 'primary' });
    return showDialog({ title: 'Switch to ' + o.to + '?', body: body, buttons: buttons }).then(Boolean);
  };

  /* ---------- data bar and account chip ---------- */

  // Actions are 'create', 'open', … optionally with a provider: 'open:gdrive'.
  function runAction(a) {
    var parts = a.split(':'), act = parts[0], pid = parts[1];
    if (act === 'create') Toolbox.createFile(pid);
    else if (act === 'open') Toolbox.openFile(pid);
    else if (act === 'reconnect') Toolbox.reconnect();
    else if (act === 'save') Toolbox.save();
    else if (act === 'copy') Toolbox.downloadCopy();
    else if (act === 'close') Toolbox.closeFile();
    else if (act === 'resolve') Toolbox.resolveConflict();
    else if (act === 'signout') Toolbox.signOut();
  }

  // Warm up a cloud provider's sign-in script when the pointer or focus reaches one
  // of its buttons, so the click can open the sign-in popup straight away (browsers
  // block popups that open too long after a click). Not done earlier, so visitors
  // who never use cloud storage don't load anything from it.
  function prepareFor(el) {
    var b = el && el.closest && el.closest('button[data-act]');
    if (!b) return;
    var pid = b.dataset.act.split(':')[1] || (b.dataset.act === 'reconnect' && Toolbox.status().provider);
    var p = pid && Toolbox.getProvider(pid);
    if (p && p.prepare) p.prepare();
  }

  function watchForPrepare(el) {
    el.addEventListener('pointerover', function (e) { prepareFor(e.target); });
    el.addEventListener('focusin', function (e) { prepareFor(e.target); });
  }

  function downloadModeNote() {
    var note = '<p class="databar-note">This browser can’t write to files directly, so changes are kept here until you click Save file, which downloads an updated copy. Chrome or Edge can save straight to the file.</p>';
    if (isFirefox) {
      note += '<p class="databar-note">To choose where the file is saved, open Firefox <strong>Settings → General → Files and Applications</strong> and turn on <strong>Always ask you where to save files</strong>.</p>';
    }
    return note;
  }

  // "Saved automatically · 2 min ago" etc. for files that save themselves.
  function autosaveDetail(s) {
    if (s.conflict) return 'Changed somewhere else — choose which version to keep.';
    if (s.saving) return 'Saving…';
    if (s.dirty) return 'Changes pending…';
    return (s.mode === 'cloud' ? 'Saved to ' + s.providerLabel : 'Saved automatically') + ' · ' + Toolbox.timeAgo(s.lastSaved);
  }

  function autosaveTone(s) { return s.conflict ? 'warn' : s.saving ? 'busy' : 'ok'; }

  // "Switch file" stays with the same kind of storage.
  function openAct(s) { return s.mode === 'cloud' ? 'open:' + s.provider : 'open'; }

  function fileIcon(s) { return s.mode === 'cloud' ? ICONS.cloud : ICONS.file; }

  function storageLabelOf(s) {
    var o = s.storageOptions.filter(function (x) { return x.id === s.storage; })[0];
    return o ? o.label : s.storage;
  }

  /**
   * The Storage selector shown beside the header chip: where the data file is
   * kept. Changing it is a real action — it closes the open file (after asking).
   */
  function mountStoragePicker(beside) {
    var wrap = document.createElement('label');
    wrap.className = 'storage-picker';
    wrap.innerHTML =
      '<span class="storage-picker-label">Storage</span>' +
      '<span class="storage-picker-field"><select class="storage-select"></select></span>';
    beside.parentNode.insertBefore(wrap, beside);
    var select = wrap.querySelector('select');

    function render(s) {
      var html = s.storageOptions.map(function (o) {
        return '<option value="' + esc(o.id) + '">' + esc(o.label) + '</option>';
      }).join('');
      if (select.innerHTML !== html) select.innerHTML = html;
      select.value = s.storage; // also puts it back after a cancelled switch
      var only = s.storageOptions.length < 2;
      select.disabled = !s.ready || only;
      wrap.title = only
        ? 'Your data file is kept on this device. Other storage isn’t available on this site.'
        : 'Where your data file is kept. Changing it closes the file that’s open now.';
    }

    select.addEventListener('change', function () {
      var id = select.value;
      var p = Toolbox.getProvider(id);
      if (p && p.prepare) p.prepare(); // its next step is a sign-in click
      Toolbox.switchStorage(id);
    });

    render(Toolbox.status());
    Toolbox.on(render);
  }

  // Once a file is open, the header "account" chip stands in for the data bar,
  // like a signed-in user. Only applies on pages that mount the chip.
  var accountMounted = false;
  function fileInUse(s) {
    return accountMounted && s.ready && s.connected && !s.needsReconnect;
  }

  /**
   * Render the data-file status bar into `el` and keep it updated.
   * options.variant: 'compact' (tool pages, default) or 'panel' (landing page).
   */
  Toolbox.mountDataBar = function (el, options) {
    var variant = (options && options.variant) || 'compact';
    el.classList.add('databar', 'databar--' + variant);

    function btn(act, label, kind) {
      return '<button type="button" class="btn ' + (kind ? 'btn--' + kind : '') + '" data-act="' + act + '">' + esc(label) + '</button>';
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
        detail = s.mode === 'cloud'
          ? 'Sign in to ' + s.providerLabel + ' again to read and save this file.'
          : 'Your browser needs permission again to read and save this file.';
        actions.push(btn('reconnect', 'Reconnect', 'primary'), btn(openAct(s), 'Open a different file'));
      } else if (!s.connected) {
        // Create / Open go to the storage chosen in the header's Storage selector.
        var cloud = s.storage !== 'device';
        var label = storageLabelOf(s);
        tone = 'idle';
        title = 'No data file open';
        detail = variant === 'panel'
          ? 'Everything you do in these tools is saved to one file that you keep ' + (cloud ? 'in your ' + label : 'on this device') + '. ' +
            'Create one, or open the file you used last time.' +
            (s.storageOptions.length > 1 ? ' To keep it somewhere else, change Storage at the top of the page.' : '')
          : 'Open or create your data file' + (cloud ? ' in ' + label : '') + ' to save your work.';
        if (cloud) actions.push(btn('create:' + s.storage, 'New in ' + label, 'primary'), btn('open:' + s.storage, 'Open from ' + label));
        else actions.push(btn('create', 'Create new file', 'primary'), btn('open', 'Open existing file'));
      } else if (s.mode === 'file' || s.mode === 'cloud') {
        tone = autosaveTone(s);
        title = s.fileName;
        detail = autosaveDetail(s);
        if (s.conflict) actions.push(btn('resolve', 'Choose version', 'primary'));
        if (variant === 'panel') {
          detail += ' · ' + Toolbox.formatBytes(s.size) + ' · ' + s.toolIds.length + (s.toolIds.length === 1 ? ' tool' : ' tools') + ' with data';
          if (s.account) detail += ' · ' + s.account;
          actions.push(btn('copy', 'Download backup'), btn(openAct(s), 'Switch file'), btn('close', 'Close', 'ghost'));
        } else {
          actions.push(btn('copy', 'Backup'));
        }
      } else {
        tone = s.dirty ? 'warn' : 'ok';
        title = s.fileName;
        detail = s.dirty
          ? 'Unsaved changes — save the file to keep them.'
          : 'Up to date · saved ' + Toolbox.timeAgo(s.lastSaved);
        if (s.dirty) {
          actions.push(btn('save', 'Save file', 'primary'));
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
          '<span class="databar-icon" aria-hidden="true">' + fileIcon(s) + '</span>' +
          '<div class="databar-text">' +
            (variant === 'panel' ? '<span class="eyebrow">Data file' + (s.mode === 'cloud' ? ' · ' + esc(s.providerLabel) : '') + '</span>' : '') +
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
    watchForPrepare(el);

    render(Toolbox.status());
    Toolbox.on(render);
    setInterval(function () { render(Toolbox.status()); }, 30000); // keep "x min ago" fresh
  };

  /**
   * Render the open data file into a page header, like a signed-in account:
   * a chip with the file name that opens a menu of file actions. While a file is
   * in use, any data bar on the page hides itself; when no file is open (or it
   * needs reconnecting) the chip hides and the data bar acts as the "sign-in".
   * A Storage selector is added just before `el` unless options.storagePicker is false.
   */
  Toolbox.mountAccount = function (el, options) {
    accountMounted = true;
    if (!(options && options.storagePicker === false)) mountStoragePicker(el);
    el.classList.add('account');
    el.innerHTML =
      '<button type="button" class="account-chip" aria-haspopup="true" aria-expanded="false">' +
        '<span class="account-icon" aria-hidden="true"></span>' +
        '<span class="account-name"></span>' +
        '<span class="dot" aria-hidden="true"></span>' +
      '</button>' +
      '<span class="account-quick"></span>' +
      '<div class="account-menu" role="menu" hidden></div>';
    var chip = el.querySelector('.account-chip');
    var iconEl = el.querySelector('.account-icon');
    var nameEl = el.querySelector('.account-name');
    var quick = el.querySelector('.account-quick');
    var menu = el.querySelector('.account-menu');
    var lastError = null;

    function item(act, label, kind) {
      return '<button type="button" role="menuitem" class="account-item' + (kind ? ' account-item--' + kind : '') + '" data-act="' + act + '">' + esc(label) + '</button>';
    }

    function setOpen(open) {
      menu.hidden = !open;
      chip.setAttribute('aria-expanded', String(open));
    }

    function render(s) {
      el.hidden = !fileInUse(s);
      if (el.hidden) { setOpen(false); return; }

      var tone, detail, items = [], quickHtml = '';
      if (s.mode === 'file' || s.mode === 'cloud') {
        tone = autosaveTone(s);
        detail = autosaveDetail(s);
        if (s.conflict) {
          quickHtml = '<button type="button" class="btn btn--primary" data-act="resolve">Choose version</button>';
          items.push(item('resolve', 'Choose which version to keep'));
        }
        items.push(item('copy', 'Download backup'), item(openAct(s), 'Switch file'), item('close', 'Close file'));
        if (s.canSignOut) items.push(item('signout', 'Sign out of ' + s.providerLabel));
      } else {
        tone = s.dirty ? 'warn' : 'ok';
        detail = s.dirty ? 'Unsaved changes — save the file to keep them.' : 'Up to date · saved ' + Toolbox.timeAgo(s.lastSaved);
        if (s.dirty) {
          quickHtml = '<button type="button" class="btn btn--primary" data-act="save">Save file</button>';
          items.push(item('save', 'Save file'), item('close', 'Discard changes', 'danger'));
        } else {
          items.push(item('open', 'Open file'), item('create', 'New file'), item('close', 'Close file'));
        }
      }
      if (s.error) tone = 'warn';

      el.dataset.tone = tone;
      nameEl.textContent = s.fileName;
      chip.title = s.fileName + (s.mode === 'cloud' ? ' (' + s.providerLabel + ')' : '') + ' — ' + detail;
      var icon = fileIcon(s);
      if (iconEl.innerHTML !== icon) iconEl.innerHTML = icon;
      if (quick.innerHTML !== quickHtml) quick.innerHTML = quickHtml;

      var html =
        '<div class="account-head">' +
          '<span class="eyebrow">Data file' + (s.mode === 'cloud' ? ' · ' + esc(s.providerLabel) : '') + '</span>' +
          '<strong class="account-title">' + esc(s.fileName) + '</strong>' +
          '<span class="account-detail">' + esc(detail) + '</span>' +
          '<span class="account-detail">' + Toolbox.formatBytes(s.size) + ' · ' + s.toolIds.length + (s.toolIds.length === 1 ? ' tool' : ' tools') + ' with data</span>' +
          (s.account ? '<span class="account-detail">Signed in as ' + esc(s.account) + '</span>' : '') +
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
    watchForPrepare(el);
    document.addEventListener('click', function (e) { if (!el.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) { setOpen(false); chip.focus(); }
    });

    Toolbox.on(render);
    Toolbox.refresh(); // re-render every mounted bar now that the chip exists
    setInterval(function () { render(Toolbox.status()); }, 30000);
  };

  /* ---------- icons (stroke icons, inherit currentColor) ---------- */

  var svg = function (body) {
    return '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  };
  var ICONS = {
    file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>'),
    cloud: svg('<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z"/>'),
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
})(window);
