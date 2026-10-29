/*
 * Workout Tracker UI. All data lives in the Toolbox data file under the key
 * "workout-tracker", in the export format described in
 * workout-tracker-requirements.md §5 (see core.js).
 *
 * Rendering model: structural changes call render(); typing in a field only
 * saves (so focus is never lost mid-entry).
 */
(function () {
  'use strict';

  var TOOL_ID = 'workout-tracker';
  var C = window.WTCore;
  var esc = Toolbox.escape;
  var LIB = window.WT_LIBRARY || { exercises: [], provenance: {} };

  var SET_TYPES = [['working', 'Working'], ['warmup', 'Warm-up'], ['dropset', 'Drop set'], ['failure', 'To failure']];
  var TRACKING = [['weight_reps', 'Weight × reps'], ['bodyweight_reps', 'Bodyweight reps'], ['assisted_reps', 'Assisted reps'],
    ['reps_only', 'Reps only'], ['duration', 'Duration'], ['distance_duration', 'Distance + duration']];
  var TABS = [['log', 'Log'], ['history', 'History'], ['templates', 'Templates'], ['exercises', 'Exercises'],
    ['body', 'Body'], ['settings', 'Settings']];

  var DEVICE = (function () {
    try {
      var d = localStorage.getItem('wt:deviceId');
      if (!d) { d = C.newId('dev'); localStorage.setItem('wt:deviceId', d); }
      return d;
    } catch (e) { return C.newId('dev'); }
  })();

  var ui = {
    tab: 'log',
    sessionId: null,       // open session editor
    tplDraft: null,        // template being edited
    exFilter: { q: '', muscle: '', equipment: '', source: '' },
    exLimit: 60,
    openSet: null,         // "entryIdx:setIdx" with detail row open
    backupDismissed: false, // FR-19a: in memory only, so it returns on next visit
    wakeLock: null
  };

  var $ = function (id) { return document.getElementById(id); };
  var app = $('app'), tabsEl = $('tabs'), bannersEl = $('banners'), footEl = $('foot'), modalEl = $('modal');

  /* ---------- data access ---------- */

  function usable() { var s = Toolbox.status(); return s.connected && !s.needsReconnect; }

  function load() {
    if (!usable()) return null;
    return C.migrate(Toolbox.get(TOOL_ID, null) || C.emptyData(DEVICE));
  }

  function commit(fn) {
    var d = load();
    if (!d) return false;
    fn(d);
    d.deviceId = DEVICE;
    return Toolbox.set(TOOL_ID, d);
  }

  function touch(rec) { rec.updatedAt = C.nowIso(); rec.deviceId = DEVICE; return rec; }
  function byId(list, id) { return list.filter(function (r) { return r.id === id; })[0]; }
  function unitOf(d) { return C.getSettings(d).weightUnit; }
  function wfmt(kg, unit) { return C.displayWeight(kg, unit) + ' ' + unit; }
  function fmtDate(iso) { return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function fmtDuration(a, b) {
    var m = Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  function libIndex(d) { return C.exerciseIndex(d, LIB); }
  function activeSession(d) {
    return C.live(d.sessions).filter(function (s) { return !s.endedAt; })
      .sort(function (a, b) { return a.startedAt < b.startedAt ? 1 : -1; })[0] || null;
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* ---------- render ---------- */

  function render() {
    var d = load();
    applyTheme(d);
    renderTabs();
    renderBanners(d);
    if (!d) {
      var s = Toolbox.status();
      app.innerHTML = '<div class="wt-empty">' + (s.ready
        ? 'Open or create your data file above to start tracking workouts. Everything is saved to that file, on your own device.'
        : 'Checking for your data file…') + '</div>';
      footEl.textContent = '';
      return;
    }
    var sess = ui.sessionId && byId(d.sessions, ui.sessionId);
    if (ui.sessionId && (!sess || sess.deleted)) { ui.sessionId = null; sess = null; }
    if (sess) app.innerHTML = sessionView(d, sess);
    else if (ui.tab === 'history') app.innerHTML = historyView(d);
    else if (ui.tab === 'templates') app.innerHTML = ui.tplDraft ? templateEditor(d) : templatesView(d);
    else if (ui.tab === 'exercises') app.innerHTML = exercisesView(d);
    else if (ui.tab === 'body') app.innerHTML = bodyView(d);
    else if (ui.tab === 'settings') app.innerHTML = settingsView(d);
    else app.innerHTML = logView(d);
    footEl.textContent = 'Last backup (JSON export): ' + (d.lastBackupAt ? new Date(d.lastBackupAt).toLocaleString() : 'never');
    syncWakeLock(!!sess);
  }

  function applyTheme(d) {
    var t = d ? C.getSettings(d).theme : 'system';
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-wt-theme', t);
    else document.documentElement.removeAttribute('data-wt-theme');
  }

  function renderTabs() {
    tabsEl.innerHTML = TABS.map(function (t) {
      var cur = !ui.sessionId && ui.tab === t[0];
      return '<button type="button" data-act="tab" data-tab="' + t[0] + '"' + (cur ? ' aria-current="page"' : '') + '>' + t[1] + '</button>';
    }).join('');
  }

  function renderBanners(d) {
    var html = '';
    if (d && C.shouldShowBackupBanner(d) && !ui.backupDismissed) {
      html += '<div class="wt-banner" role="status"><div class="wt-grow"><strong>Back up your workouts.</strong> ' +
        C.unbackedUpCount(d) + ' sessions haven’t been exported yet. They’re saved in your Toolbox data file — an exported ' +
        'backup protects you if that file is lost.</div>' +
        '<button type="button" class="btn btn--primary" data-act="goto-export">Export</button>' +
        '<button type="button" class="btn btn--ghost" data-act="dismiss-backup">Dismiss</button></div>';
    }
    var seen = false;
    try { seen = localStorage.getItem('wt:noticeSeen') === '1'; } catch (e) { /* ignore */ }
    if (d && !seen) {
      html += '<div class="wt-banner info" role="note"><div class="wt-grow"><strong>Where your data lives.</strong> ' +
        'Workouts are saved to the Toolbox data file you opened above — on your device or in your own Google Drive, never on this site’s server. ' +
        'Clearing that file means starting empty, so export a JSON backup now and then.</div>' +
        '<button type="button" class="btn" data-act="dismiss-notice">Got it</button></div>';
    }
    bannersEl.innerHTML = html;
  }

  /* ---------- Log tab ---------- */

  function logView(d) {
    var s = C.getSettings(d), unit = s.weightUnit;
    var active = activeSession(d), tpls = C.live(d.templates).filter(function (t) { return !t.archived; });
    var h = '';
    if (active) {
      h += '<div class="wt-card"><div class="wt-row between"><div><strong>Workout in progress</strong><div class="wt-small wt-muted">' +
        esc(active.name || 'Workout') + ' · started ' + fmtTime(active.startedAt) + ' · ' + countSets(active) + ' sets</div></div>' +
        '<button type="button" class="btn btn--primary" data-act="open-session" data-id="' + esc(active.id) + '">Resume</button></div></div>';
    } else {
      h += '<div class="wt-row"><button type="button" class="btn btn--primary btn--big" data-act="start-empty">Start empty workout</button></div>';
      h += '<h2 class="wt-h">From a template</h2>';
      h += tpls.length ? tpls.map(function (t) {
        return '<div class="wt-card"><div class="wt-row between"><div><div class="wt-ex-name">' + esc(t.name) + '</div>' +
          '<div class="wt-small wt-muted">' + (t.entries || []).length + ' exercises</div></div>' +
          '<button type="button" class="btn btn--primary" data-act="start-tpl" data-id="' + esc(t.id) + '">Start</button></div></div>';
      }).join('') : '<div class="wt-empty">No templates yet. Create one in the Templates tab.</div>';
    }

    var done = C.live(d.sessions).filter(function (x) { return x.endedAt; })
      .sort(function (a, b) { return a.startedAt < b.startedAt ? 1 : -1; });
    var wkStart = weekStartDate(s.weekStart);
    var thisWeek = done.filter(function (x) { return new Date(x.startedAt) >= wkStart; }).length;
    h += '<h2 class="wt-h">Recent</h2>';
    h += '<p class="wt-small wt-muted">' + thisWeek + (thisWeek === 1 ? ' session' : ' sessions') + ' this week · ' + done.length + ' total</p>';
    h += done.length ? done.slice(0, 5).map(function (x) { return sessionCard(d, x, unit); }).join('')
      : '<div class="wt-empty">Finished workouts will show up here.</div>';
    return h;
  }

  function weekStartDate(ws) {
    var now = new Date(), day = now.getDay();                // 0 = Sunday
    var diff = ws === 'sun' ? day : (day + 6) % 7;
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
    return d;
  }

  function countSets(s) {
    return s.entries.reduce(function (n, e) { return n + (e.sets || []).filter(function (x) { return x.completed; }).length; }, 0);
  }

  function sessionCard(d, s, unit) {
    var idx = libIndex(d);
    var names = s.entries.map(function (e) { return C.exerciseName(idx, e); });
    var vol = C.volumeKg(s);
    return '<div class="wt-card clickable" data-act="open-session" data-id="' + esc(s.id) + '" tabindex="0" role="button">' +
      '<div class="wt-row between"><strong>' + esc(s.name || 'Workout') + '</strong><span class="wt-small wt-muted">' + fmtDate(s.startedAt) + '</span></div>' +
      '<div class="wt-small wt-muted">' + esc(names.slice(0, 4).join(', ')) + (names.length > 4 ? ' +' + (names.length - 4) + ' more' : '') + '</div>' +
      '<div class="wt-small wt-muted">' + countSets(s) + (countSets(s) === 1 ? ' set' : ' sets') + (vol ? ' · ' + Math.round(C.fromKg(vol, unit)).toLocaleString() + ' ' + unit + ' volume' : '') +
      (s.endedAt ? ' · ' + fmtDuration(s.startedAt, s.endedAt) : '') + '</div></div>';
  }

  /* ---------- sessions ---------- */

  function newSet(src) {
    var st = { type: 'working', reps: null, weightKg: null, enteredUnit: null, completed: false };
    if (src) {
      st.type = src.type || 'working'; st.reps = src.reps == null ? null : src.reps;
      st.weightKg = src.weightKg == null ? null : src.weightKg; st.enteredUnit = src.enteredUnit || null;
    }
    return st;
  }

  function makeEntry(d, exerciseId, tplEntry) {
    var ex = libIndex(d)[exerciseId], settings = C.getSettings(d), unit = settings.weightUnit;
    var last = settings.useLastValues ? C.lastPerformance(d, exerciseId) : null;
    var n = tplEntry && tplEntry.targetSets ? tplEntry.targetSets : (last ? last.sets.length : 3);
    var sets = [];
    for (var i = 0; i < n; i++) {
      var st = newSet(last ? last.sets[Math.min(i, last.sets.length - 1)] : null);
      if (!last && tplEntry) {
        if (tplEntry.targetWeightKg != null) { st.weightKg = tplEntry.targetWeightKg; st.enteredUnit = unit; }
        if (tplEntry.targetReps && tplEntry.targetReps.min != null) st.reps = tplEntry.targetReps.min;
      }
      st.completed = false;
      sets.push(st);
    }
    return {
      exerciseId: exerciseId, exerciseName: ex ? ex.name : exerciseId, sets: sets,
      supersetGroup: tplEntry && tplEntry.supersetGroup != null ? tplEntry.supersetGroup : null,
      restSeconds: tplEntry && tplEntry.restSeconds != null ? tplEntry.restSeconds : null
    };
  }

  function startSession(tplId) {
    var id = C.newId('ses');
    commit(function (d) {
      var s = { id: id, templateId: null, name: '', startedAt: C.nowIso(), endedAt: null, notes: '', entries: [], deleted: false, createdAt: C.nowIso() };
      var t = tplId && byId(d.templates, tplId);
      if (t) {
        s.templateId = t.id; s.name = t.name;
        s.entries = (t.entries || []).map(function (te) { return makeEntry(d, te.exerciseId, te); });
      }
      touch(s); d.sessions.push(s);
    });
    ui.sessionId = id; ui.openSet = null; render();
  }

  function sessionView(d, s) {
    var unit = unitOf(d), idx = libIndex(d), active = !s.endedAt;
    var h = '<div class="wt-row between"><button type="button" class="btn btn--ghost" data-act="close-session">← Back</button>' +
      '<span class="wt-small wt-muted" id="elapsed">' + (active ? 'Started ' + fmtTime(s.startedAt) + ' · ' + fmtDuration(s.startedAt, new Date()) : fmtDate(s.startedAt) + ' · ' + fmtDuration(s.startedAt, s.endedAt)) + '</span></div>';
    h += '<div class="wt-field"><label class="wt-label" for="s-name">Workout name</label>' +
      '<input class="wt-in" id="s-name" data-f="s-name" value="' + esc(s.name || '') + '" placeholder="Workout"></div>';
    h += s.entries.map(function (e, i) { return entryCard(d, s, e, i, unit, idx); }).join('');
    h += '<div class="wt-row" style="margin-top:12px"><button type="button" class="btn" data-act="add-exercise">+ Add exercise</button>' +
      (active && 'wakeLock' in navigator ? '<label class="wt-small wt-muted"><input type="checkbox" data-f="wake"' + (ui.wakeWanted ? ' checked' : '') + '> Keep screen on</label>' : '') + '</div>';
    h += '<div class="wt-field"><label class="wt-label" for="s-notes">Notes</label><textarea class="wt-ta" id="s-notes" data-f="s-notes">' + esc(s.notes || '') + '</textarea></div>';
    if (!active) {
      h += '<div class="wt-row" style="margin-top:12px"><span class="wt-small wt-muted">Finished ' + fmtTime(s.endedAt) + ' · edits are saved automatically.</span></div>';
      h += '<div class="wt-row" style="margin-top:12px"><button type="button" class="btn btn--danger" data-act="delete-session">Delete session</button></div>';
    } else {
      h += '<div class="wt-row" style="margin-top:16px"><button type="button" class="btn btn--primary btn--big" data-act="finish-session">Finish workout</button>' +
        '<button type="button" class="btn btn--danger" data-act="delete-session">Discard</button></div>';
    }
    return h;
  }

  function entryCard(d, s, e, i, unit, idx) {
    var ex = idx[e.exerciseId];
    var bw = ex && (ex.trackingType === 'bodyweight_reps' || ex.trackingType === 'assisted_reps');
    var prev = C.lastPerformance(d, e.exerciseId, s.id);
    var h = '<div class="wt-card wt-entry" data-i="' + i + '"><div class="wt-entry-head"><div>' +
      '<div class="wt-entry-name">' + (e.supersetGroup != null && e.supersetGroup !== '' ? '<span class="wt-ss">SS ' + esc(e.supersetGroup) + '</span>' : '') + esc(C.exerciseName(idx, e)) + '</div>' +
      (prev ? '<div class="wt-prev">Previous (' + new Date(prev.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '): ' +
        esc(prev.sets.map(function (x) { return C.formatSet(x, unit); }).join(', ')) + '</div>' : '') +
      '</div><div class="wt-row" style="flex-wrap:nowrap">' +
      '<button type="button" class="btn btn--ghost btn--sm" data-act="move-entry" data-dir="-1" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button type="button" class="btn btn--ghost btn--sm" data-act="move-entry" data-dir="1" aria-label="Move down"' + (i === s.entries.length - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button type="button" class="btn btn--ghost btn--sm btn--danger" data-act="remove-entry" aria-label="Remove exercise">✕</button></div></div>';
    var shared = C.weightMode(e) === 'shared', wLabel = (bw ? 'Added weight' : 'Weight');
    // Body is centered in the card and capped in width; columns stretch proportionally.
    h += '<div class="wt-entry-body"><div class="wt-sets' + (shared ? ' wt-sets--shared' : '') + '">';
    if (shared) {
      // Same grid as the set rows: the weight box lines up with Reps, ⚖️ with Done.
      h += '<div class="wt-weightrow"><span></span><div class="wt-weightcell"><label class="wt-label" for="w-' + i + '">' + wLabel + ' (' + unit + ') · all sets</label>' +
        '<input class="wt-in wt-weight" data-f="entry-weight" id="w-' + i + '" inputmode="decimal" aria-label="' + esc(wLabel + ' for every set, in ' + unit) + '" value="' + esc(C.displayWeight(C.sharedWeight(e), unit)) + '"></div>' +
        weightButton() + '<span></span></div>';
    }
    h += '<div class="wt-sethead"><span>Set</span>' +
      (shared ? '' : '<span>' + (bw ? '+' : '') + unit + '</span>') + '<span>Reps</span><span>Done</span><span></span></div>';
    (e.sets || []).forEach(function (st, j) {
      var key = i + ':' + j, open = ui.openSet === key;
      var typeTag = st.type && st.type !== 'working' ? '<span class="t">' + esc(st.type === 'warmup' ? 'W' : st.type === 'dropset' ? 'D' : 'F') + '</span>' : '';
      h += '<div class="wt-set' + (st.completed ? ' done' : '') + '" data-j="' + j + '">' +
        '<span class="wt-setno">' + (j + 1) + typeTag + '</span>' +
        (shared ? '' : '<span class="wt-wbox">' + weightField('set-weight', st.weightKg, unit, null, 'Set ' + (j + 1) + ' weight in ' + unit) + '</span>') +
        '<input class="wt-in wt-reps" data-f="set-reps" inputmode="numeric" aria-label="Set ' + (j + 1) + ' reps" value="' + (st.reps == null ? '' : st.reps) + '">' +
        '<button type="button" class="wt-check" data-act="toggle-set" aria-pressed="' + !!st.completed + '" aria-label="Mark set done">✓</button>' +
        '<button type="button" class="wt-more" data-act="set-more" aria-label="Set options" aria-expanded="' + open + '">⋯</button></div>';
      if (open) {
        h += '<div class="wt-detail" data-j="' + j + '"><div><label class="wt-label">Type</label><select class="wt-sel" data-f="set-type">' +
          SET_TYPES.map(function (t) { return '<option value="' + t[0] + '"' + ((st.type || 'working') === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select></div>' +
          '<div><label class="wt-label">RPE</label><input class="wt-in" data-f="set-rpe" inputmode="decimal" value="' + (st.rpe == null ? '' : st.rpe) + '"></div>' +
          '<div><label class="wt-label">RIR</label><input class="wt-in" data-f="set-rir" inputmode="numeric" value="' + (st.rir == null ? '' : st.rir) + '"></div>' +
          '<div class="wide"><label class="wt-label">Note</label><input class="wt-in" data-f="set-note" value="' + esc(st.note || '') + '"></div>' +
          '<div class="wide"><button type="button" class="btn btn--sm btn--danger" data-act="remove-set">Remove set</button></div></div>';
      }
    });
    h += '</div><div class="wt-entry-foot"><button type="button" class="btn btn--sm" data-act="add-set">+ Add set</button>' +
      '<button type="button" class="wt-switch" role="switch" aria-checked="' + !shared + '" data-act="weight-mode">' +
        '<span class="wt-switch-label">Different weight per set</span>' +
        '<span class="wt-switch-track" aria-hidden="true"><span class="wt-switch-thumb"></span></span></button>' +
      '</div></div></div>';
    return h;
  }

  /** The ⚖️ button that opens the adjust-weight sheet. */
  function weightButton() {
    return '<button type="button" class="wt-wbtn" data-act="weight-sheet" aria-label="Adjust weight in steps" title="Adjust weight in steps"><span aria-hidden="true">⚖️</span></button>';
  }

  /** A typed per-set weight box plus its ⚖️ button. */
  function weightField(f, kg, unit, id, label) {
    return '<input class="wt-in wt-weight" data-f="' + f + '"' + (id ? ' id="' + id + '"' : '') + ' inputmode="decimal" aria-label="' + esc(label) + '"' +
      ' value="' + esc(C.displayWeight(kg, unit)) + '">' + weightButton();
  }

  /* ---------- adjust-weight sheet ---------- */

  // Target: one set (j >= 0) or the whole exercise in shared mode (j < 0).
  function weightTarget(d, i, j) {
    var e = byId(d.sessions, ui.sessionId).entries[i];
    return { entry: e, kg: j >= 0 ? e.sets[j].weightKg : C.sharedWeight(e) };
  }

  function openWeightSheet(i, j) {
    var d = load(), unit = unitOf(d), t = weightTarget(d, i, j), steps = C.WEIGHT_STEPS[unit] || C.WEIGHT_STEPS.lb;
    var what = esc(C.exerciseName(libIndex(d), t.entry)) + ' · ' + (j >= 0 ? 'set ' + (j + 1) : 'all sets');
    var btns = function (sign) {
      return steps.map(function (n) {
        return '<button type="button" class="wt-wm-step" data-act="wm-step" data-delta="' + (sign * n) + '">' + (sign < 0 ? '−' : '+') + n + '</button>';
      }).join('');
    };
    openModal('<div class="wt-row between"><h3 class="wt-h" style="margin:0">Adjust weight</h3>' +
      '<button type="button" class="btn btn--primary" data-act="close-modal">Done</button></div>' +
      '<p class="wt-small wt-muted" style="margin:4px 0 0">' + what + '</p>' +
      '<div class="wt-wm-value" aria-live="polite"><span id="wm-value">' + esc(C.displayWeight(t.kg, unit) || '0') + '</span> ' + unit + '</div>' +
      '<div class="wt-wm-grid">' + btns(-1) + btns(1) + '</div>');
    modalRefresh = { weight: { i: i, j: j }, onClose: render };
  }

  function stepWeightSheet(delta) {
    var w = modalRefresh && modalRefresh.weight;
    if (!w) return;
    var d = load(), unit = unitOf(d), next = C.stepWeight(weightTarget(d, w.i, w.j).kg, delta, unit);
    mutSession(function (s) {
      var e = s.entries[w.i];
      if (w.j >= 0) { e.sets[w.j].weightKg = next; e.sets[w.j].enteredUnit = unit; }
      else C.setAllWeights(e, next, unit);
    });
    $('wm-value').textContent = C.displayWeight(next, unit);
  }

  function toggleWeightMode(i) {
    var d = load(), e = byId(d.sessions, ui.sessionId).entries[i], unit = unitOf(d);
    if (C.weightMode(e) === 'perSet') {
      var first = C.sharedWeight(e);
      if (C.hasMixedWeights(e) && !confirm('Use ' + (first == null ? 'no weight' : wfmt(first, unit)) + ' (set 1’s weight) for every set?')) return;
      mutSession(function (s) {
        var en = s.entries[i];
        en.weightMode = 'shared';
        C.setAllWeights(en, C.sharedWeight(en), (en.sets[0] && en.sets[0].enteredUnit) || unit);
      });
    } else {
      mutSession(function (s) { s.entries[i].weightMode = 'perSet'; });
    }
    render();
  }

  function mutSession(fn) {
    return commit(function (d) {
      var s = byId(d.sessions, ui.sessionId);
      if (s) { fn(s, d); touch(s); }
    });
  }

  function finishSession() {
    var d = load(), s = byId(d.sessions, ui.sessionId);
    var open = 0;
    s.entries.forEach(function (e) { open += (e.sets || []).filter(function (x) { return !x.completed; }).length; });
    if (open && !confirm(open + (open === 1 ? ' set isn’t' : ' sets aren’t') + ' checked off. Finish anyway? Unchecked sets will be removed.')) return;
    mutSession(function (s) {
      s.entries.forEach(function (e) { e.sets = (e.sets || []).filter(function (x) { return x.completed; }); });
      s.entries = s.entries.filter(function (e) { return e.sets.length; });
      if (!s.entries.length) { s.deleted = true; } else { s.endedAt = C.nowIso(); }
    });
    ui.sessionId = null; ui.tab = 'history'; render();
  }

  /* ---------- History ---------- */

  function historyView(d) {
    var unit = unitOf(d);
    var done = C.live(d.sessions).filter(function (x) { return x.endedAt; })
      .sort(function (a, b) { return a.startedAt < b.startedAt ? 1 : -1; });
    if (!done.length) return '<div class="wt-empty">No finished workouts yet.</div>';
    return done.map(function (x) { return sessionCard(d, x, unit); }).join('');
  }

  /* ---------- Exercises ---------- */

  function allExercises(d) {
    var seen = {}, out = [];
    C.live(d.exercises).forEach(function (e) { seen[e.id] = 1; out.push(e); });
    LIB.exercises.forEach(function (e) { if (!seen[e.id]) out.push(e); });
    return out;
  }

  function filterExercises(d, f) {
    var q = f.q.trim().toLowerCase();
    return allExercises(d).filter(function (e) {
      if (f.source && e.source !== f.source) return false;
      if (f.muscle && (e.primaryMuscles || []).concat(e.secondaryMuscles || []).indexOf(f.muscle) < 0) return false;
      if (f.equipment && (e.equipment || 'none') !== f.equipment) return false;
      if (!q) return true;
      return e.name.toLowerCase().indexOf(q) >= 0 || (e.aliases || []).some(function (a) { return a.toLowerCase().indexOf(q) >= 0; });
    }).sort(function (a, b) {
      if (a.source !== b.source) return a.source === 'custom' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function facets(d) {
    var m = {}, eq = {};
    allExercises(d).forEach(function (e) {
      (e.primaryMuscles || []).concat(e.secondaryMuscles || []).forEach(function (x) { m[x] = 1; });
      eq[e.equipment || 'none'] = 1;
    });
    return { muscles: Object.keys(m).sort(), equipment: Object.keys(eq).sort() };
  }

  function filterBar(d, f, pick) {
    var fc = facets(d);
    function opts(list, cur, any) {
      return '<option value="">' + any + '</option>' + list.map(function (x) {
        return '<option value="' + esc(x) + '"' + (cur === x ? ' selected' : '') + '>' + esc(cap(x)) + '</option>';
      }).join('');
    }
    return '<div class="wt-fields"><input class="wt-in" type="search" data-live="ex-q" placeholder="Search exercises" aria-label="Search exercises" value="' + esc(f.q) + '">' +
      '<select class="wt-sel" data-f="ex-muscle" aria-label="Muscle">' + opts(fc.muscles, f.muscle, 'Any muscle') + '</select>' +
      '<select class="wt-sel" data-f="ex-equipment" aria-label="Equipment">' + opts(fc.equipment, f.equipment, 'Any equipment') + '</select>' +
      (pick ? '' : '<select class="wt-sel" data-f="ex-source" aria-label="Source"><option value="">All</option><option value="custom"' + (f.source === 'custom' ? ' selected' : '') + '>My exercises</option><option value="standard"' + (f.source === 'standard' ? ' selected' : '') + '>Standard library</option></select>') +
      '</div>';
  }

  function exerciseRows(d, f, limit, act) {
    var list = filterExercises(d, f), shown = list.slice(0, limit);
    if (!list.length) return '<div class="wt-empty">No matching exercises.</div>';
    return shown.map(function (e) {
      return '<div class="wt-card clickable" data-act="' + act + '" data-id="' + esc(e.id) + '" tabindex="0" role="button"><div class="wt-row between"><div>' +
        '<div class="wt-ex-name">' + esc(e.name) + '</div><div class="wt-small wt-muted">' +
        esc((e.primaryMuscles || []).join(', ') || '—') + (e.equipment ? ' · ' + esc(e.equipment) : '') + '</div></div>' +
        (e.source === 'custom' ? '<span class="wt-chip">custom</span>' : '') + '</div></div>';
    }).join('') + (list.length > limit ? '<div class="wt-row" style="margin-top:10px"><button type="button" class="btn" data-act="more-ex">Show more (' + (list.length - limit) + ' left)</button></div>' : '');
  }

  function exercisesView(d) {
    return '<div class="wt-row between" style="margin-bottom:12px"><span class="wt-small wt-muted">' + LIB.exercises.length + ' standard · ' +
      C.live(d.exercises).length + ' custom</span><button type="button" class="btn btn--primary" data-act="new-exercise">+ New exercise</button></div>' +
      filterBar(d, ui.exFilter, false) + '<div id="ex-list" style="margin-top:12px">' + exerciseRows(d, ui.exFilter, ui.exLimit, 'view-exercise') + '</div>';
  }

  function exerciseDetail(d, id) {
    var e = libIndex(d)[id];
    if (!e) return;
    var h = '<div class="wt-row between"><h3 class="wt-h">' + esc(e.name) + '</h3><button type="button" class="btn btn--ghost" data-act="close-modal">Close</button></div>' +
      '<p class="wt-small wt-muted">' + (e.source === 'custom' ? 'Custom exercise' : 'Standard library') + ' · ' + esc(cap(e.category || 'strength')) +
      ' · ' + esc(e.equipment || 'no equipment') + '</p>' +
      '<p class="wt-small"><strong>Primary:</strong> ' + esc((e.primaryMuscles || []).join(', ') || '—') + '<br><strong>Secondary:</strong> ' + esc((e.secondaryMuscles || []).join(', ') || '—') + '</p>' +
      (e.instructions ? '<div class="wt-pre">' + esc(e.instructions) + '</div>' : '') +
      '<div class="wt-row" style="margin-top:16px">' +
      (e.source === 'custom'
        ? '<button type="button" class="btn" data-act="edit-exercise" data-id="' + esc(id) + '">Edit</button><button type="button" class="btn btn--danger" data-act="delete-exercise" data-id="' + esc(id) + '">Delete</button>'
        : '<button type="button" class="btn" data-act="fork-exercise" data-id="' + esc(id) + '">Fork to edit a copy</button>') + '</div>';
    openModal(h);
  }

  function exerciseForm(d, id) {
    var e = id ? libIndex(d)[id] : { name: '', aliases: [], category: 'strength', primaryMuscles: [], secondaryMuscles: [], equipment: '', trackingType: 'weight_reps', instructions: '' };
    var fc = facets(d);
    var h = '<div class="wt-row between"><h3 class="wt-h">' + (id ? 'Edit exercise' : 'New exercise') + '</h3><button type="button" class="btn btn--ghost" data-act="close-modal">Cancel</button></div>' +
      '<form data-form="exercise" data-id="' + esc(id || '') + '">' +
      '<div class="wt-field"><label class="wt-label" for="x-name">Name</label><input class="wt-in" id="x-name" name="name" required value="' + esc(e.name) + '"></div>' +
      '<div class="wt-field"><label class="wt-label" for="x-alias">Aliases (comma separated)</label><input class="wt-in" id="x-alias" name="aliases" value="' + esc((e.aliases || []).join(', ')) + '"></div>' +
      '<div class="wt-fields wt-field"><div><label class="wt-label" for="x-track">Tracking</label><select class="wt-sel" id="x-track" name="trackingType">' +
      TRACKING.map(function (t) { return '<option value="' + t[0] + '"' + (e.trackingType === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select></div>' +
      '<div><label class="wt-label" for="x-eq">Equipment</label><input class="wt-in" id="x-eq" name="equipment" list="eq-list" value="' + esc(e.equipment || '') + '">' +
      '<datalist id="eq-list">' + fc.equipment.map(function (x) { return '<option value="' + esc(x) + '">'; }).join('') + '</datalist></div></div>' +
      '<div class="wt-field"><label class="wt-label" for="x-pm">Primary muscles (comma separated)</label><input class="wt-in" id="x-pm" name="primaryMuscles" list="mu-list" value="' + esc((e.primaryMuscles || []).join(', ')) + '"></div>' +
      '<div class="wt-field"><label class="wt-label" for="x-sm">Secondary muscles (comma separated)</label><input class="wt-in" id="x-sm" name="secondaryMuscles" list="mu-list" value="' + esc((e.secondaryMuscles || []).join(', ')) + '">' +
      '<datalist id="mu-list">' + fc.muscles.map(function (x) { return '<option value="' + esc(x) + '">'; }).join('') + '</datalist></div>' +
      '<div class="wt-field"><label class="wt-label" for="x-ins">Instructions (optional)</label><textarea class="wt-ta" id="x-ins" name="instructions">' + esc(e.instructions || '') + '</textarea></div>' +
      '<div class="wt-row" style="margin-top:16px"><button type="submit" class="btn btn--primary">Save</button></div></form>';
    openModal(h);
  }

  function splitList(s) { return String(s || '').split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean); }

  function saveExerciseForm(form) {
    var f = new FormData(form), id = form.dataset.id;
    var fields = {
      name: String(f.get('name')).trim(),
      aliases: String(f.get('aliases') || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean),
      trackingType: f.get('trackingType'),
      equipment: String(f.get('equipment') || '').trim().toLowerCase() || null,
      primaryMuscles: splitList(f.get('primaryMuscles')), secondaryMuscles: splitList(f.get('secondaryMuscles')),
      instructions: String(f.get('instructions') || '')
    };
    if (!fields.name) return;
    commit(function (d) {
      var e = id && byId(d.exercises, id);
      if (e) { Object.assign(e, fields); touch(e); return; }
      e = Object.assign({ id: C.newId('ex'), category: 'strength', source: 'custom', createdAt: C.nowIso(), deleted: false }, fields);
      d.exercises.push(touch(e));
    });
    closeModal(); render();
  }

  function forkExercise(id) {
    var newIdVal = C.newId('ex');
    commit(function (d) {
      var src = libIndex(d)[id];
      var e = Object.assign({}, JSON.parse(JSON.stringify(src)), {
        id: newIdVal, source: 'custom', standardId: src.source === 'standard' ? src.id : src.standardId || null,
        name: src.name + ' (copy)', createdAt: C.nowIso(), deleted: false
      });
      d.exercises.push(touch(e));
    });
    closeModal(); render(); exerciseForm(load(), newIdVal);
  }

  /* ---------- Templates ---------- */

  function templatesView(d) {
    var list = C.live(d.templates).sort(function (a, b) { return a.name.localeCompare(b.name); });
    var h = '<div class="wt-row between" style="margin-bottom:12px"><span class="wt-small wt-muted">' + list.length + ' templates</span>' +
      '<button type="button" class="btn btn--primary" data-act="new-template">+ New template</button></div>';
    if (!list.length) return h + '<div class="wt-empty">A template is a saved list of exercises with targets you can start a workout from.</div>';
    var idx = libIndex(d);
    return h + list.map(function (t) {
      return '<div class="wt-card"><div class="wt-row between"><div><div class="wt-ex-name">' + esc(t.name) + (t.archived ? ' <span class="wt-chip">archived</span>' : '') + '</div>' +
        '<div class="wt-small wt-muted">' + esc((t.entries || []).map(function (e) { return C.exerciseName(idx, e); }).slice(0, 5).join(', ')) + '</div></div>' +
        '<div class="wt-row"><button type="button" class="btn btn--sm" data-act="edit-template" data-id="' + esc(t.id) + '">Edit</button>' +
        '<button type="button" class="btn btn--sm" data-act="dup-template" data-id="' + esc(t.id) + '">Duplicate</button>' +
        '<button type="button" class="btn btn--sm" data-act="archive-template" data-id="' + esc(t.id) + '">' + (t.archived ? 'Unarchive' : 'Archive') + '</button>' +
        '<button type="button" class="btn btn--sm btn--danger" data-act="delete-template" data-id="' + esc(t.id) + '">Delete</button></div></div></div>';
    }).join('');
  }

  function templateEditor(d) {
    var t = ui.tplDraft, unit = unitOf(d), idx = libIndex(d);
    var h = '<div class="wt-row between"><h3 class="wt-h">' + (t._new ? 'New template' : 'Edit template') + '</h3></div>' +
      '<div class="wt-field"><label class="wt-label" for="t-name">Name</label><input class="wt-in" id="t-name" data-f="t-name" value="' + esc(t.name) + '"></div>' +
      '<div class="wt-field"><label class="wt-label" for="t-notes">Notes</label><textarea class="wt-ta" id="t-notes" data-f="t-notes">' + esc(t.notes || '') + '</textarea></div>' +
      '<h2 class="wt-h">Exercises</h2>';
    h += t.entries.length ? t.entries.map(function (e, i) {
      var tr = e.targetReps || {};
      return '<div class="wt-tpl-entry" data-i="' + i + '"><div class="wt-row between"><strong>' + esc(C.exerciseName(idx, e)) + '</strong><div class="wt-row" style="flex-wrap:nowrap">' +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="t-move" data-dir="-1"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">↑</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="t-move" data-dir="1"' + (i === t.entries.length - 1 ? ' disabled' : '') + ' aria-label="Move down">↓</button>' +
        '<button type="button" class="btn btn--ghost btn--sm btn--danger" data-act="t-remove" aria-label="Remove">✕</button></div></div>' +
        '<div class="wt-tpl-fields">' +
        tplField('Sets', 't-sets', e.targetSets) + tplField('Reps min', 't-rmin', tr.min) + tplField('Reps max', 't-rmax', tr.max) +
        tplField('Weight (' + unit + ')', 't-weight', e.targetWeightKg == null ? '' : C.displayWeight(e.targetWeightKg, unit)) +
        tplField('Rest (s)', 't-rest', e.restSeconds) + tplField('Superset', 't-ss', e.supersetGroup) + '</div></div>';
    }).join('') : '<div class="wt-empty">No exercises yet.</div>';
    h += '<div class="wt-row" style="margin-top:12px"><button type="button" class="btn" data-act="t-add">+ Add exercise</button></div>' +
      '<div class="wt-row" style="margin-top:16px"><button type="button" class="btn btn--primary" data-act="t-save">Save template</button>' +
      '<button type="button" class="btn" data-act="t-cancel">Cancel</button></div>';
    return h;
  }

  function tplField(label, f, v) {
    return '<div><label class="wt-label">' + label + '</label><input class="wt-in" data-f="' + f + '" inputmode="decimal" value="' + esc(v == null ? '' : v) + '"></div>';
  }

  function blankTemplate() {
    return { _new: true, id: C.newId('tpl'), name: '', notes: '', entries: [], archived: false, deleted: false, createdAt: C.nowIso() };
  }

  /* ---------- Body ---------- */

  function bodyView(d) {
    var unit = unitOf(d), today = new Date().toISOString().slice(0, 10);
    var list = C.live(d.bodyweight).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.updatedAt < b.updatedAt ? 1 : -1); });
    var h = '<form class="wt-card" data-form="body"><div class="wt-fields"><div><label class="wt-label" for="b-date">Date</label>' +
      '<input class="wt-in" id="b-date" type="date" name="date" required value="' + today + '"></div>' +
      '<div><label class="wt-label" for="b-w">Bodyweight (' + unit + ')</label><input class="wt-in" id="b-w" name="weight" inputmode="decimal" required></div>' +
      '<div><label class="wt-label" for="b-n">Note</label><input class="wt-in" id="b-n" name="note"></div></div>' +
      '<div class="wt-row" style="margin-top:12px"><button type="submit" class="btn btn--primary">Add entry</button>' +
      '<span class="wt-small wt-muted">Optional. Stored only; nothing else in the app uses it.</span></div></form>';
    h += '<h2 class="wt-h">Entries</h2>';
    h += list.length ? list.map(function (b) {
      return '<div class="wt-card"><div class="wt-list-item"><div><strong>' + esc(wfmt(b.weightKg, unit)) + '</strong> <span class="wt-small wt-muted">' + esc(b.date) + (b.note ? ' · ' + esc(b.note) : '') + '</span></div>' +
        '<button type="button" class="btn btn--sm btn--ghost btn--danger" data-act="delete-body" data-id="' + esc(b.id) + '">Delete</button></div></div>';
    }).join('') : '<div class="wt-empty">No entries.</div>';
    return h;
  }

  /* ---------- Settings, data, sync ---------- */

  function settingsView(d) {
    var s = C.getSettings(d);
    function sel(key, label, opts) {
      return '<div><label class="wt-label" for="st-' + key + '">' + label + '</label><select class="wt-sel" id="st-' + key + '" data-f="setting" data-key="' + key + '">' +
        opts.map(function (o) { return '<option value="' + o[0] + '"' + (String(s[key]) === String(o[0]) ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>';
    }
    function num(key, label) {
      return '<div><label class="wt-label" for="st-' + key + '">' + label + '</label><input class="wt-in" id="st-' + key + '" data-f="setting-num" data-key="' + key + '" inputmode="decimal" value="' + esc(s[key]) + '"></div>';
    }
    var h = '<h2 class="wt-h" style="margin-top:0">Preferences</h2><div class="wt-card"><div class="wt-fields">' +
      sel('weightUnit', 'Weight unit', [['lb', 'Pounds (lb)'], ['kg', 'Kilograms (kg)']]) +
      sel('weekStart', 'Week starts on', [['mon', 'Monday'], ['sun', 'Sunday']]) +
      sel('theme', 'Theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]) +
      num('restSeconds', 'Default rest (seconds)') + '</div>' +
      '<label class="wt-small" style="display:block;margin-top:12px"><input type="checkbox" data-f="setting-bool" data-key="useLastValues"' + (s.useLastValues ? ' checked' : '') +
      '> Start new sets from my last performance of each exercise</label>' +
      '<p class="wt-small wt-muted">Changing the unit never changes stored data; weights are kept in kilograms and converted for display.</p></div>';

    h += '<h2 class="wt-h" id="export">Backup &amp; data</h2><div class="wt-card"><div class="wt-row">' +
      '<button type="button" class="btn btn--primary" data-act="export-json">Export JSON backup</button>' +
      '<button type="button" class="btn" data-act="export-csv">Export CSV (one row per set)</button></div>' +
      '<p class="wt-small wt-muted">Last JSON backup: ' + (d.lastBackupAt ? new Date(d.lastBackupAt).toLocaleString() : 'never') + '. ' + C.unbackedUpCount(d) + ' finished sessions not yet backed up.</p>' +
      '<hr style="border:0;border-top:1px solid var(--line);margin:14px 0"><div class="wt-field"><label class="wt-label" for="imp">Import JSON file</label>' +
      '<input id="imp" type="file" accept=".json,application/json" data-f="import-file"></div>' +
      '<div class="wt-row" style="margin-top:8px"><label class="wt-small"><input type="radio" name="impmode" value="merge" checked> Merge with current data (recommended)</label>' +
      '<label class="wt-small"><input type="radio" name="impmode" value="replace"> Replace current data</label></div>' +
      '<p class="wt-small wt-muted" id="imp-msg" role="status"></p></div>';

    h += '<h2 class="wt-h">Sync</h2><div class="wt-card">' +
      '<div class="wt-list-item"><div><strong>Google Drive</strong><div class="wt-small wt-muted">Keep your data in sync across devices through your own Drive.</div></div><button type="button" class="btn" disabled>Connect</button><span class="wt-chip soon">Coming Soon</span></div>' +
      '<div class="wt-list-item"><div><strong>Dropbox</strong><div class="wt-small wt-muted">Same, through your own Dropbox.</div></div><button type="button" class="btn" disabled>Connect</button><span class="wt-chip soon">Coming Soon</span></div>' +
      '<p class="wt-small wt-muted">Until then, keep your Toolbox data file in a synced folder (iCloud Drive, Dropbox, OneDrive…) or move it between devices with export/import.</p></div>';

    h += '<h2 class="wt-h">About your data</h2><div class="wt-card wt-small wt-muted">No accounts and no server. Workouts are saved only to the Toolbox data file you opened and are never sent anywhere. ' +
      'The site counts anonymous page views with GoatCounter (no cookies); you can opt out from the Toolbox home page. ' +
      'Exercise library: <a href="' + esc(LIB.provenance.url || '#') + '" target="_blank" rel="noopener">free-exercise-db</a> (public domain), ' +
      LIB.exercises.length + ' exercises, commit ' + esc((LIB.provenance.commit || '').slice(0, 7)) + '.</div>';
    return h;
  }

  function download(text, name, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function exportJson() {
    var now = C.nowIso();
    commit(function (d) { d.lastBackupAt = now; });
    var d = load();
    var out = Object.assign({}, d, { exportedAt: now });
    delete out.lastBackupAt; delete out.deviceId;
    download(JSON.stringify(out, null, 2), 'workout-tracker-' + now.slice(0, 10) + '.json', 'application/json');
    ui.backupDismissed = false; render();
  }

  function importFile(file) {
    var msg = $('imp-msg');
    var mode = (document.querySelector('input[name="impmode"]:checked') || {}).value || 'merge';
    var reader = new FileReader();
    reader.onerror = function () { msg.textContent = 'Couldn’t read that file.'; };
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result));
        var errs = C.validate(data);
        if (errs.length) throw new Error('Not a valid workout export: ' + errs.join(' '));
        var incoming = C.migrate(data);
        if (mode === 'replace' && !confirm('Replace ALL current workout data with this file? This can’t be undone.')) return;
        commit(function (d) {
          var merged = mode === 'replace'
            ? Object.assign({}, incoming, { lastBackupAt: new Date().toISOString() })
            : C.mergeData(d, incoming);
          Object.keys(d).forEach(function (k) { delete d[k]; });
          Object.assign(d, merged);
        });
        render();
        var m2 = $('imp-msg');
        if (m2) m2.textContent = (mode === 'replace' ? 'Replaced' : 'Merged') + ' ' + incoming.sessions.length + ' sessions, ' + incoming.templates.length + ' templates, ' + incoming.exercises.length + ' custom exercises.';
      } catch (e) {
        msg.textContent = e.message || String(e);
      }
    };
    reader.readAsText(file);
  }

  /* ---------- modal ---------- */

  var modalRefresh = null;
  function openModal(html) {
    modalEl.innerHTML = '<div class="wt-modal-box" role="dialog" aria-modal="true">' + html + '</div>';
    modalEl.hidden = false;
    var f = modalEl.querySelector('input:not([type=hidden]), textarea');
    if (f) f.focus();
  }
  function closeModal() {
    var r = modalRefresh;
    modalEl.hidden = true; modalEl.innerHTML = ''; modalRefresh = null;
    if (r && r.onClose) r.onClose();
  }

  function openPicker(onPick) {
    var d = load();
    var filter = { q: '', muscle: '', equipment: '', source: '' }, limit = 50;
    function body() {
      modalEl.querySelector('#pick-list').innerHTML = exerciseRows(d, filter, limit, 'pick-exercise');
    }
    openModal('<div class="wt-row between"><h3 class="wt-h">Add exercise</h3><button type="button" class="btn btn--ghost" data-act="close-modal">Cancel</button></div>' +
      '<div style="margin-top:10px">' + filterBar(d, filter, true) + '</div><div id="pick-list" style="margin-top:12px"></div>');
    body();
    modalRefresh = {
      onPick: onPick,
      setFilter: function (k, v) { filter[k] = v; limit = 50; body(); },
      more: function () { limit += 50; body(); }
    };
  }

  /* ---------- wake lock ---------- */

  function syncWakeLock(inSession) {
    if (!('wakeLock' in navigator)) return;
    if (inSession && ui.wakeWanted && !ui.wakeLock) {
      navigator.wakeLock.request('screen').then(function (l) {
        ui.wakeLock = l; l.addEventListener('release', function () { ui.wakeLock = null; });
      }).catch(function () { /* not allowed: ignore */ });
    } else if ((!inSession || !ui.wakeWanted) && ui.wakeLock) {
      ui.wakeLock.release(); ui.wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && ui.sessionId) syncWakeLock(true);
  });

  /* ---------- events ---------- */

  function ctxSet(el) {
    var entry = el.closest('[data-i]'), row = el.closest('[data-j]');
    return { i: entry ? +entry.dataset.i : -1, j: row ? +row.dataset.j : -1 };
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modalEl.hidden) closeModal();
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.clickable[data-act]')) {
      e.preventDefault(); e.target.click();
    }
  });
  modalEl.addEventListener('mousedown', function (e) { if (e.target === modalEl) closeModal(); });

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    var act = el.dataset.act, id = el.dataset.id, cx = ctxSet(el), d;
    switch (act) {
      case 'tab': ui.tab = el.dataset.tab; ui.sessionId = null; ui.tplDraft = null; location.hash = ui.tab; render(); break;
      case 'dismiss-backup': ui.backupDismissed = true; render(); break;
      case 'dismiss-notice': try { localStorage.setItem('wt:noticeSeen', '1'); } catch (e) { /* ignore */ } render(); break;
      case 'goto-export': ui.tab = 'settings'; ui.sessionId = null; render(); var x = $('export'); if (x) x.scrollIntoView(); break;

      case 'start-empty': startSession(null); break;
      case 'start-tpl': startSession(id); break;
      case 'open-session': ui.sessionId = id; ui.openSet = null; render(); window.scrollTo(0, 0); break;
      case 'close-session': ui.sessionId = null; ui.openSet = null; render(); break;
      case 'finish-session': finishSession(); break;
      case 'delete-session':
        if (confirm('Delete this session? This can’t be undone.')) { mutSession(function (s) { s.deleted = true; }); ui.sessionId = null; render(); }
        break;

      case 'add-exercise':
        openPicker(function (exId) {
          mutSession(function (s, dd) { s.entries.push(makeEntry(dd, exId, null)); });
          closeModal(); render();
        });
        break;
      case 'move-entry':
        mutSession(function (s) { moveItem(s.entries, cx.i, +el.dataset.dir); }); render(); break;
      case 'remove-entry':
        if (confirm('Remove this exercise from the workout?')) { mutSession(function (s) { s.entries.splice(cx.i, 1); }); render(); }
        break;
      case 'add-set':
        mutSession(function (s) {
          var sets = s.entries[cx.i].sets, last = sets[sets.length - 1];
          sets.push(newSet(last));
        }); render(); break;
      case 'remove-set': {
        var o = ui.openSet.split(':'); ui.openSet = null;
        mutSession(function (s) { s.entries[+o[0]].sets.splice(+o[1], 1); }); render(); break;
      }
      case 'set-more': {
        var k = cx.i + ':' + cx.j; ui.openSet = ui.openSet === k ? null : k; render(); break;
      }
      case 'toggle-set':
        mutSession(function (s) { var st = s.entries[cx.i].sets[cx.j]; st.completed = !st.completed; }); render(); break;
      case 'weight-sheet': openWeightSheet(cx.i, cx.j); break;
      case 'wm-step': stepWeightSheet(+el.dataset.delta); break;
      case 'weight-mode': toggleWeightMode(cx.i); break;

      case 'view-exercise': exerciseDetail(load(), id); break;
      case 'new-exercise': exerciseForm(load(), null); break;
      case 'edit-exercise': exerciseForm(load(), id); break;
      case 'fork-exercise': forkExercise(id); break;
      case 'delete-exercise':
        if (confirm('Delete this exercise? Past workouts keep its name.')) {
          commit(function (dd) { var e = byId(dd.exercises, id); if (e) { e.deleted = true; touch(e); } });
          closeModal(); render();
        }
        break;
      case 'more-ex': ui.exLimit += 60; render(); break;
      case 'pick-exercise': if (modalRefresh) modalRefresh.onPick(id); break;
      case 'close-modal': closeModal(); break;

      case 'new-template': ui.tplDraft = blankTemplate(); render(); break;
      case 'edit-template': d = load(); ui.tplDraft = JSON.parse(JSON.stringify(byId(d.templates, id))); render(); break;
      case 'dup-template':
        commit(function (dd) {
          var t = JSON.parse(JSON.stringify(byId(dd.templates, id)));
          t.id = C.newId('tpl'); t.name += ' (copy)'; t.createdAt = C.nowIso(); t.archived = false; dd.templates.push(touch(t));
        }); render(); break;
      case 'archive-template':
        commit(function (dd) { var t = byId(dd.templates, id); t.archived = !t.archived; touch(t); }); render(); break;
      case 'delete-template':
        if (confirm('Delete this template? Past workouts are kept.')) {
          commit(function (dd) { var t = byId(dd.templates, id); t.deleted = true; touch(t); }); render();
        }
        break;
      case 't-add':
        openPicker(function (exId) {
          ui.tplDraft.entries.push({ exerciseId: exId, exerciseName: (libIndex(load())[exId] || {}).name, targetSets: 3, targetReps: { min: 8, max: 12 }, targetWeightKg: null, restSeconds: null, supersetGroup: null });
          closeModal(); render();
        });
        break;
      case 't-move': moveItem(ui.tplDraft.entries, cx.i, +el.dataset.dir); render(); break;
      case 't-remove': ui.tplDraft.entries.splice(cx.i, 1); render(); break;
      case 't-cancel': ui.tplDraft = null; render(); break;
      case 't-save': saveTemplate(); break;

      case 'delete-body':
        commit(function (dd) { var b = byId(dd.bodyweight, id); b.deleted = true; touch(b); }); render(); break;
      case 'export-json': exportJson(); break;
      case 'export-csv': download(C.toCSV(load(), LIB), 'workout-tracker-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv'); break;
    }
  });

  function moveItem(list, i, dir) {
    var j = i + dir;
    if (j < 0 || j >= list.length) return;
    var t = list[i]; list[i] = list[j]; list[j] = t;
  }

  function saveTemplate() {
    var t = ui.tplDraft;
    if (!t.name.trim()) { alert('Give the template a name.'); return; }
    commit(function (d) {
      var rec = Object.assign({}, t); delete rec._new;
      rec.name = rec.name.trim();
      var cur = byId(d.templates, rec.id);
      if (cur) d.templates[d.templates.indexOf(cur)] = touch(Object.assign({}, cur, rec));
      else d.templates.push(touch(rec));
    });
    ui.tplDraft = null; render();
  }

  function numOrNull(v, int) {
    var n = parseFloat(String(v).replace(',', '.'));
    return isFinite(n) && n >= 0 ? (int ? Math.round(n) : n) : null;
  }

  document.addEventListener('change', function (ev) {
    var el = ev.target, f = el.dataset && el.dataset.f;
    if (!f) return;
    var cx = ctxSet(el), unit;
    switch (f) {
      case 's-name': mutSession(function (s) { s.name = el.value.trim(); }); break;
      case 's-notes': mutSession(function (s) { s.notes = el.value; }); break;
      case 'wake': ui.wakeWanted = el.checked; syncWakeLock(true); break;
      case 'set-weight':
        unit = unitOf(load());
        var w = el.value.trim() === '' ? { weightKg: null, enteredUnit: null } : C.parseWeight(el.value, unit);
        if (!w) { render(); break; }
        mutSession(function (s) { var t = s.entries[cx.i].sets[cx.j]; t.weightKg = w.weightKg; t.enteredUnit = w.enteredUnit; });
        el.value = C.displayWeight(w.weightKg, unit);
        break;
      case 'entry-weight': {
        unit = unitOf(load());
        var ew = el.value.trim() === '' ? { weightKg: null, enteredUnit: null } : C.parseWeight(el.value, unit);
        if (!ew) { render(); break; }
        mutSession(function (s) { var en = s.entries[cx.i]; en.weightMode = 'shared'; C.setAllWeights(en, ew.weightKg, ew.enteredUnit); });
        el.value = C.displayWeight(ew.weightKg, unit);
        break;
      }
      case 'set-reps': mutSession(function (s) { s.entries[cx.i].sets[cx.j].reps = numOrNull(el.value, true); }); break;
      case 'set-type': mutSession(function (s) { s.entries[cx.i].sets[cx.j].type = el.value; }); render(); break;
      case 'set-rpe': mutSession(function (s) { var v = numOrNull(el.value); if (v == null) delete s.entries[cx.i].sets[cx.j].rpe; else s.entries[cx.i].sets[cx.j].rpe = v; }); break;
      case 'set-rir': mutSession(function (s) { var v = numOrNull(el.value, true); if (v == null) delete s.entries[cx.i].sets[cx.j].rir; else s.entries[cx.i].sets[cx.j].rir = v; }); break;
      case 'set-note': mutSession(function (s) { var st = s.entries[cx.i].sets[cx.j]; if (el.value.trim()) st.note = el.value; else delete st.note; }); break;

      case 'ex-muscle': ui.exFilter.muscle = el.value; pickOrList('muscle', el.value); break;
      case 'ex-equipment': ui.exFilter.equipment = el.value; pickOrList('equipment', el.value); break;
      case 'ex-source': ui.exFilter.source = el.value; ui.exLimit = 60; render(); break;

      case 't-name': ui.tplDraft.name = el.value; break;
      case 't-notes': ui.tplDraft.notes = el.value; break;
      case 't-sets': case 't-rmin': case 't-rmax': case 't-weight': case 't-rest': case 't-ss': {
        var e = ui.tplDraft.entries[cx.i];
        if (f === 't-sets') e.targetSets = numOrNull(el.value, true);
        else if (f === 't-rmin') e.targetReps = Object.assign({}, e.targetReps, { min: numOrNull(el.value, true) });
        else if (f === 't-rmax') e.targetReps = Object.assign({}, e.targetReps, { max: numOrNull(el.value, true) });
        else if (f === 't-weight') { var p = el.value.trim() === '' ? null : C.parseWeight(el.value, unitOf(load())); e.targetWeightKg = p ? p.weightKg : null; }
        else if (f === 't-rest') e.restSeconds = numOrNull(el.value, true);
        else e.supersetGroup = el.value.trim() === '' ? null : el.value.trim();
        break;
      }

      case 'setting': commit(function (d) { setSetting(d, el.dataset.key, el.value); }); render(); break;
      case 'setting-num': {
        var n = numOrNull(el.value);
        if (n != null && n > 0) commit(function (d) { setSetting(d, el.dataset.key, n); });
        render(); break;
      }
      case 'setting-bool': commit(function (d) { setSetting(d, el.dataset.key, el.checked); }); render(); break;
      case 'import-file': if (el.files[0]) importFile(el.files[0]); el.value = ''; break;
    }
  });

  function setSetting(d, key, value) {
    d.settings[key] = value;
    d.settingsUpdatedAt[key] = C.nowIso();
  }

  function pickOrList(key, v) {
    if (modalRefresh) modalRefresh.setFilter(key, v);
    else { ui.exLimit = 60; render(); }
  }

  document.addEventListener('input', function (ev) {
    var el = ev.target;
    if (el.dataset && el.dataset.live === 'ex-q') {
      if (modalRefresh) { modalRefresh.setFilter('q', el.value); return; }
      ui.exFilter.q = el.value; ui.exLimit = 60;
      $('ex-list').innerHTML = exerciseRows(load(), ui.exFilter, ui.exLimit, 'view-exercise');
    }
  });

  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form.dataset || !form.dataset.form) return;
    ev.preventDefault();
    if (form.dataset.form === 'exercise') saveExerciseForm(form);
    else if (form.dataset.form === 'body') {
      var f = new FormData(form), unit = unitOf(load()), w = C.parseWeight(f.get('weight'), unit);
      if (!w) return;
      commit(function (d) {
        d.bodyweight.push(touch({ id: C.newId('bw'), date: String(f.get('date')), weightKg: w.weightKg, enteredUnit: w.enteredUnit,
          note: String(f.get('note') || '').trim() || undefined, createdAt: C.nowIso(), deleted: false }));
      });
      render();
    }
  });

  // "Show more" inside the exercise picker.
  modalEl.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-act="more-ex"]');
    if (b && modalRefresh) { ev.stopPropagation(); modalRefresh.more(); }
  }, true);

  /* ---------- boot ---------- */

  document.getElementById('back-icon').outerHTML = Toolbox.icons.arrow;
  Toolbox.mountDataBar($('databar'));
  Toolbox.mountAccount($('account'));

  var h0 = location.hash.slice(1);
  if (TABS.some(function (t) { return t[0] === h0; })) ui.tab = h0;

  // Which file is open: changes only when a different file is opened / reconnected / closed.
  function fileKey(s) { return s.ready ? (s.connected && !s.needsReconnect ? 'g' + s.generation : 'none') : 'wait'; }
  var lastKey = 'init';
  Toolbox.on(function (s) {
    // Re-render only when a different file is opened / reconnected, not on every save tick.
    var key = fileKey(s);
    if (key !== lastKey) { lastKey = key; ui.sessionId = null; ui.tplDraft = null; render(); }
  });
  // Record the real key here (not a placeholder), or the first save after loading
  // looks like a file change and closes whatever workout is open.
  Toolbox.ready.then(function () { lastKey = fileKey(Toolbox.status()); render(); });
  render();

  setInterval(function () {
    var el = $('elapsed'), d = load();
    if (!el || !d || !ui.sessionId) return;
    var s = byId(d.sessions, ui.sessionId);
    if (s && !s.endedAt) el.textContent = 'Started ' + fmtTime(s.startedAt) + ' · ' + fmtDuration(s.startedAt, new Date());
  }, 30000);
})();
