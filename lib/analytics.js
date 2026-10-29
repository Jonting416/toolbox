/*
 * Page-view counting (GoatCounter). Loaded by every page, after lib/toolbox.js.
 *
 * Counting is set up once here instead of in each page's HTML. GoatCounter
 * records anonymous page views (path, referrer, browser, screen size, country)
 * with no cookies. Tool data is never sent to it: it only ever lives in the
 * user's own data file. A one-time notice explains this; visitors can opt out,
 * and the choice is kept in this browser's localStorage.
 */
(function (global) {
  'use strict';

  var Toolbox = global.Toolbox;

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
        'Your tool data is only stored where you choose (a file on this device, or your own Google Drive), and this site never sees it.' +
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
    Toolbox.refresh();
  };

  function onBodyReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  onBodyReady(function () { startCounting(); showNotice(); });
})(window);
