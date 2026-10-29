/*
 * Google Drive storage provider for the Toolbox data file. Loaded after lib/toolbox.js.
 *
 * Browser-only: sign-in uses Google Identity Services' token flow (no client
 * secret, no server), and files go straight from the browser to the Drive REST
 * API. The only scope requested is drive.file, so Toolbox can see just the files
 * it created or that the user picked in the Google Picker — nothing else in their
 * Drive.
 *
 * Access tokens last about an hour and the token flow has no refresh token, so an
 * expired token shows the usual Reconnect button; one click gets a new one
 * (usually without asking again). The token is kept in localStorage so moving
 * between tool pages doesn't need a click each time.
 *
 * Needs window.TOOLBOX_CONFIG.google = { clientId, apiKey, appId } (lib/toolbox.config.js).
 */
(function (global) {
  'use strict';

  var Toolbox = global.Toolbox;
  if (!Toolbox || !Toolbox.registerProvider) return;

  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var FILES = 'https://www.googleapis.com/drive/v3/files';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  var ABOUT = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)';
  var GSI_SRC = 'https://accounts.google.com/gsi/client';
  var GAPI_SRC = 'https://apis.google.com/js/api.js';
  var META = 'id,name,headRevisionId,modifiedTime,trashed';
  var TOKEN_KEY = 'toolbox:gdrive-token';
  var ACCOUNT_KEY = 'toolbox:gdrive-account';
  var EXPIRED = 'Your Google Drive sign-in has expired. Click Reconnect to keep saving.';

  function err(name, message) { return Toolbox.storageError(name, message); }
  function cfg() { return (global.TOOLBOX_CONFIG && global.TOOLBOX_CONFIG.google) || {}; }

  function lsGet(k) { try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function lsSet(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* blocked storage: lasts this page only */ }
  }

  var scripts = {};
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function () { delete scripts[src]; s.remove(); reject(new Error('Couldn’t load Google’s sign-in. Check your connection and try again.')); };
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }

  /* ---------- sign-in ---------- */

  function currentToken() {
    var t = lsGet(TOKEN_KEY);
    return t && t.accessToken && t.expiresAt - 60000 > Date.now() ? t.accessToken : null;
  }

  // Opens Google's sign-in popup, so it must run from a click.
  function requestToken() {
    return loadScript(GSI_SRC).then(function () {
      return new Promise(function (resolve, reject) {
        var oauth2 = global.google.accounts.oauth2;
        oauth2.initTokenClient({
          client_id: cfg().clientId,
          scope: SCOPE,
          login_hint: lsGet(ACCOUNT_KEY) || undefined,
          callback: function (r) {
            if (r.error) {
              reject(new Error(r.error === 'access_denied' ? 'Google Drive access wasn’t granted.' : 'Google sign-in failed: ' + (r.error_description || r.error)));
              return;
            }
            if (!oauth2.hasGrantedAllScopes(r, SCOPE)) {
              reject(new Error('Toolbox needs permission to see and save its own files in your Google Drive. Tick that box when Google asks.'));
              return;
            }
            lsSet(TOKEN_KEY, { accessToken: r.access_token, expiresAt: Date.now() + Number(r.expires_in) * 1000 });
            resolve(r.access_token);
          },
          error_callback: function (e) {
            var x;
            if (e && e.type === 'popup_failed_to_open') x = new Error('Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.');
            else { x = new Error('Google sign-in was cancelled.'); x.name = 'AbortError'; }
            reject(x);
          }
        }).requestAccessToken({ prompt: '' });
      });
    });
  }

  async function ensureToken(interactive) {
    var t = currentToken();
    if (t) return t;
    if (!interactive) throw err('NeedsReconnect', EXPIRED);
    t = await requestToken();
    if (!lsGet(ACCOUNT_KEY)) {
      try { lsSet(ACCOUNT_KEY, (await api(ABOUT)).user.emailAddress); } catch (e) { /* only used as a sign-in hint and label */ }
    }
    return t;
  }

  /* ---------- Drive REST ---------- */

  async function api(url, opts) {
    opts = opts || {};
    var t = currentToken();
    if (!t) throw err('NeedsReconnect', EXPIRED);
    var res;
    try {
      res = await fetch(url, {
        method: opts.method || 'GET',
        headers: Object.assign({ Authorization: 'Bearer ' + t }, opts.headers),
        body: opts.body
      });
    } catch (e) {
      throw err('NeedsReconnect', 'Couldn’t reach Google Drive. Check your connection, then click Reconnect.');
    }
    if (res.status === 401) { lsSet(TOKEN_KEY, null); throw err('NeedsReconnect', EXPIRED); }
    if (res.status === 404) {
      throw err('NotFound', 'Couldn’t find that file in Google Drive. It may have been deleted, or Toolbox no longer has access to it — open it again.');
    }
    if (!res.ok) {
      var detail = '';
      try { detail = (await res.json()).error.message; } catch (e) { /* not JSON */ }
      throw new Error('Google Drive said: ' + (detail || res.status + ' ' + res.statusText));
    }
    return opts.raw ? res.text() : res.json();
  }

  function fileUrl(base, ref) { return base + '/' + encodeURIComponent(ref.id); }
  function toRef(f) { return { provider: 'gdrive', id: f.id, name: f.name }; }

  function loadPicker() {
    return loadScript(GAPI_SRC).then(function () {
      return new Promise(function (resolve, reject) {
        global.gapi.load('picker', { callback: resolve, onerror: function () { reject(new Error('Couldn’t load the Google Drive file picker.')); } });
      });
    });
  }

  /* ---------- provider ---------- */

  Toolbox.registerProvider({
    id: 'gdrive',
    kind: 'cloud',
    label: 'Google Drive',
    autosave: true,
    saveDelay: 2000,     // batch typing into fewer uploads
    checksVersion: true, // write() refuses to overwrite a file that changed since it was read

    available: function () {
      var c = cfg();
      return /^https?:$/.test(global.location.protocol) && !!(c.clientId && c.apiKey && c.appId);
    },

    // Loads Google's sign-in script ahead of a click, so the popup opens straight away.
    prepare: function () { loadScript(GSI_SRC).catch(function () { /* retried on click */ }); },

    account: function () { return lsGet(ACCOUNT_KEY); },

    authorize: function (o) { return ensureToken(!!(o && o.interactive)); },

    pick: async function () {
      var token = await ensureToken(true);
      await loadPicker();
      var picker = global.google.picker, c = cfg();
      return new Promise(function (resolve) {
        var view = new picker.DocsView(picker.ViewId.DOCS)
          .setMimeTypes('application/json,text/plain')
          .setMode(picker.DocsViewMode.LIST);
        new picker.PickerBuilder()
          .addView(view)
          .setTitle('Open your Toolbox data file')
          .setOAuthToken(token)
          .setDeveloperKey(c.apiKey)
          .setAppId(c.appId) // grants drive.file access to the picked file
          .setCallback(function (data) {
            var act = data[picker.Response.ACTION];
            if (act === picker.Action.PICKED) {
              var d = data[picker.Response.DOCUMENTS][0];
              resolve({ ref: { provider: 'gdrive', id: d[picker.Document.ID], name: d[picker.Document.NAME] } });
            } else if (act === picker.Action.CANCEL) {
              resolve(null);
            }
          })
          .build()
          .setVisible(true);
      });
    },

    create: async function (name, text) {
      await ensureToken(true);
      var b = 'toolbox-' + Math.random().toString(36).slice(2);
      var body =
        '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify({ name: name, mimeType: 'application/json' }) + '\r\n' +
        '--' + b + '\r\nContent-Type: application/json\r\n\r\n' +
        text + '\r\n' +
        '--' + b + '--';
      var f = await api(UPLOAD + '?uploadType=multipart&fields=' + META, {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/related; boundary=' + b },
        body: body
      });
      return { ref: toRef(f), version: f.headRevisionId, modifiedTime: new Date(f.modifiedTime) };
    },

    read: async function (ref) {
      var f = await api(fileUrl(FILES, ref) + '?fields=' + META);
      if (f.trashed) throw err('NotFound', '“' + f.name + '” is in your Google Drive trash. Restore it there, or open a different file.');
      var text = await api(fileUrl(FILES, ref) + '?alt=media', { raw: true });
      return { text: text, name: f.name, version: f.headRevisionId, modifiedTime: new Date(f.modifiedTime) };
    },

    // Drive has no reliable If-Match on uploads, so check the revision first. That
    // leaves a tiny window between the check and the upload, fine for one person.
    write: async function (ref, text, o) {
      if (o && o.ifVersion) {
        var cur = await api(fileUrl(FILES, ref) + '?fields=headRevisionId');
        if (cur.headRevisionId !== o.ifVersion) throw err('Conflict', '“' + ref.name + '” was changed in Google Drive since it was opened here.');
      }
      var f = await api(fileUrl(UPLOAD, ref) + '?uploadType=media&fields=' + META, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: text
      });
      return { version: f.headRevisionId, modifiedTime: new Date(f.modifiedTime) };
    },

    signOut: async function () {
      var t = lsGet(TOKEN_KEY);
      lsSet(TOKEN_KEY, null);
      lsSet(ACCOUNT_KEY, null);
      if (t && t.accessToken) {
        try { await loadScript(GSI_SRC); global.google.accounts.oauth2.revoke(t.accessToken, function () {}); }
        catch (e) { /* the token expires within the hour anyway */ }
      }
    }
  });
})(window);
