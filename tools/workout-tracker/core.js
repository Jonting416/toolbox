/*
 * Workout Tracker — pure logic (no DOM, no Toolbox). Loaded by the page as
 * window.WTCore and by the node tests via require().
 *
 * Data shape (also the export-file format, see workout-tracker-requirements.md §5):
 *   { schemaVersion, exportedAt?, exercises[], templates[], sessions[], bodyweight[],
 *     settings{}, settingsUpdatedAt{}, lastBackupAt, deviceId }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WTCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var LB_TO_KG = 0.45359237;          // exact, by definition
  var BACKUP_REMINDER_AFTER = 2;      // FR-19a

  var DEFAULT_SETTINGS = {
    weightUnit: 'lb',
    weekStart: 'mon',
    restSeconds: 90,
    theme: 'system',
    incrementKg: 2.5,
    incrementLb: 5,
    useLastValues: true
  };

  /* ---------- time / ids ---------- */

  function nowIso() { return new Date().toISOString(); }

  function hex(n, len) { var s = n.toString(16); while (s.length < len) s = '0' + s; return s; }

  /** UUIDv7 with a type prefix, e.g. ses_0192…  (time-sortable, collision-safe). */
  function newId(prefix) {
    var ms = Date.now();
    var rnd = new Uint8Array(10);
    (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : require('node:crypto').webcrypto).getRandomValues(rnd);
    var r = Array.prototype.map.call(rnd, function (b) { return hex(b, 2); }).join('');
    var tsHi = hex(Math.floor(ms / 0x10000), 8), tsLo = hex(ms % 0x10000, 4);
    var variant = hex((parseInt(r.slice(4, 6), 16) & 0x3f) | 0x80, 2);
    var id = tsHi + '-' + tsLo + '-7' + r.slice(0, 3) + '-' + variant + r.slice(6, 8) + '-' + r.slice(8, 20);
    return (prefix ? prefix + '_' : '') + id;
  }

  /* ---------- units (FR-12) ---------- */

  function toKg(value, unit) { return unit === 'lb' ? value * LB_TO_KG : value; }
  function fromKg(kg, unit) { return unit === 'lb' ? kg / LB_TO_KG : kg; }

  /** Round to a display step so 135 lb never shows as 134.99999. */
  function roundTo(x, step) { return Math.round(x / step) * step; }

  function trim(n) { return String(parseFloat(n.toFixed(2))); }

  /** Canonical kg -> display string number in `unit` (no unit suffix). */
  function displayWeight(kg, unit) {
    if (kg == null || isNaN(kg)) return '';
    return trim(roundTo(fromKg(kg, unit), 0.25));
  }

  /** What the user typed -> { weightKg, enteredUnit }. */
  function parseWeight(text, unit) {
    var v = parseFloat(String(text).replace(',', '.'));
    if (!isFinite(v) || v < 0) return null;
    return { weightKg: toKg(v, unit), enteredUnit: unit };
  }

  /* ---------- data helpers ---------- */

  function emptyData(deviceId) {
    return {
      schemaVersion: SCHEMA_VERSION,
      exercises: [], templates: [], sessions: [], bodyweight: [],
      settings: {}, settingsUpdatedAt: {},
      lastBackupAt: null,
      deviceId: deviceId || newId('dev')
    };
  }

  /** Fill in anything missing and migrate older versions (pure chain vN -> vN+1). */
  function migrate(data) {
    if (!data || typeof data !== 'object') throw new Error('Not a workout tracker file.');
    var v = typeof data.schemaVersion === 'number' ? data.schemaVersion : 1;
    if (v > SCHEMA_VERSION) throw new Error('This file was made by a newer version of the workout tracker.');
    // (future) while (v < SCHEMA_VERSION) { data = MIGRATIONS[v](data); v++; }
    var out = Object.assign({}, data);
    out.schemaVersion = SCHEMA_VERSION;
    ['exercises', 'templates', 'sessions', 'bodyweight'].forEach(function (k) {
      if (!Array.isArray(out[k])) out[k] = [];
    });
    if (!out.settings || typeof out.settings !== 'object') out.settings = {};
    if (!out.settingsUpdatedAt || typeof out.settingsUpdatedAt !== 'object') out.settingsUpdatedAt = {};
    if (!out.deviceId) out.deviceId = newId('dev');
    if (out.lastBackupAt === undefined) out.lastBackupAt = null;
    return out;
  }

  /** Light structural validation for imports. Returns an array of problems (empty = ok). */
  function validate(data) {
    var errs = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) return ['The file is not a JSON object.'];
    if (typeof data.schemaVersion !== 'number') errs.push('Missing schemaVersion.');
    var idRe = /^[A-Za-z0-9_\-]+$/;
    ['exercises', 'templates', 'sessions', 'bodyweight'].forEach(function (k) {
      if (data[k] === undefined) return;
      if (!Array.isArray(data[k])) { errs.push('“' + k + '” must be a list.'); return; }
      data[k].forEach(function (r, i) {
        if (!r || typeof r !== 'object') errs.push(k + '[' + i + '] is not an object.');
        else if (typeof r.id !== 'string' || !idRe.test(r.id)) errs.push(k + '[' + i + '] has no valid id.');
        else if (typeof r.updatedAt !== 'string') errs.push(k + '[' + i + '] has no updatedAt.');
      });
    });
    if (Array.isArray(data.sessions)) {
      data.sessions.forEach(function (s, i) {
        (s && s.entries || []).forEach(function (e, j) {
          (e.sets || []).forEach(function (st, k) {
            if (st.weightKg != null && (typeof st.weightKg !== 'number' || st.weightKg < 0)) {
              errs.push('sessions[' + i + '].entries[' + j + '].sets[' + k + '] has a bad weightKg.');
            }
            if (st.reps != null && (typeof st.reps !== 'number' || st.reps < 0)) {
              errs.push('sessions[' + i + '].entries[' + j + '].sets[' + k + '] has bad reps.');
            }
          });
        });
      });
    }
    return errs.slice(0, 10);
  }

  /* ---------- merge (FR-18) ---------- */

  /** Is record `a` the winner over `b`? Higher updatedAt; tie-break on deviceId; tombstone wins a tie. */
  function wins(a, b) {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
    if (!!a.deleted !== !!b.deleted) return !!a.deleted;
    return (a.deviceId || '') > (b.deviceId || '');
  }

  function mergeCollection(local, incoming) {
    var map = {}, order = [];
    (local || []).forEach(function (r) { map[r.id] = r; order.push(r.id); });
    (incoming || []).forEach(function (r) {
      var cur = map[r.id];
      if (!cur) { map[r.id] = r; order.push(r.id); }
      else if (wins(r, cur)) map[r.id] = r;
    });
    return order.map(function (id) { return map[id]; });
  }

  /** Merge two data docs; deterministic and commutative. */
  function mergeData(local, incoming) {
    local = migrate(local); incoming = migrate(incoming);
    var out = Object.assign({}, incoming, local);
    ['exercises', 'templates', 'sessions', 'bodyweight'].forEach(function (k) {
      out[k] = mergeCollection(local[k], incoming[k]);
    });
    // settings: last-writer-wins per key
    var keys = {};
    Object.keys(local.settings).concat(Object.keys(incoming.settings)).forEach(function (k) { keys[k] = 1; });
    out.settings = {}; out.settingsUpdatedAt = {};
    Object.keys(keys).forEach(function (k) {
      var lt = local.settingsUpdatedAt[k] || '', it = incoming.settingsUpdatedAt[k] || '';
      var useIncoming = k in incoming.settings && (!(k in local.settings) || it > lt);
      out.settings[k] = useIncoming ? incoming.settings[k] : local.settings[k];
      out.settingsUpdatedAt[k] = useIncoming ? it : lt;
    });
    out.deviceId = local.deviceId;
    out.lastBackupAt = local.lastBackupAt;
    return out;
  }

  /* ---------- queries ---------- */

  function live(list) { return (list || []).filter(function (r) { return !r.deleted; }); }

  function getSettings(data) { return Object.assign({}, DEFAULT_SETTINGS, data.settings); }

  /** Completed, non-deleted sessions saved since the last backup (FR-19a). */
  function unbackedUpCount(data) {
    var last = data.lastBackupAt || '';
    return live(data.sessions).filter(function (s) { return s.endedAt && s.updatedAt > last; }).length;
  }

  function shouldShowBackupBanner(data) { return unbackedUpCount(data) >= BACKUP_REMINDER_AFTER; }

  /** Exercise lookup: custom (incl. tombstoned, so history resolves) over standard library. */
  function exerciseIndex(data, library) {
    var idx = {};
    ((library && library.exercises) || []).forEach(function (e) { idx[e.id] = e; });
    (data.exercises || []).forEach(function (e) { idx[e.id] = e; });
    return idx;
  }

  function exerciseName(idx, entry) {
    var e = idx[entry.exerciseId];
    return e ? e.name : (entry.exerciseName || entry.exerciseId);
  }

  /** The most recent completed session's sets for an exercise (FR-13). */
  function lastPerformance(data, exerciseId, exceptSessionId) {
    var best = null;
    live(data.sessions).forEach(function (s) {
      if (!s.endedAt || s.id === exceptSessionId) return;
      s.entries.forEach(function (e) {
        if (e.exerciseId !== exerciseId) return;
        var sets = (e.sets || []).filter(function (x) { return x.completed; });
        if (sets.length && (!best || s.startedAt > best.startedAt)) best = { startedAt: s.startedAt, sets: sets };
      });
    });
    return best;
  }

  function formatSet(set, unit) {
    var w = set.weightKg == null ? '' : displayWeight(set.weightKg, unit) + ' ' + unit;
    var r = set.reps == null ? '' : '× ' + set.reps;
    return (w + ' ' + r).trim();
  }

  /** Total volume (kg·reps) of completed sets — always on canonical kg. */
  function volumeKg(session) {
    var t = 0;
    session.entries.forEach(function (e) {
      (e.sets || []).forEach(function (s) { if (s.completed && s.weightKg && s.reps) t += s.weightKg * s.reps; });
    });
    return t;
  }

  /* ---------- CSV (FR-16) ---------- */

  function csvCell(v, isText) {
    if (v == null) return '';
    var s = String(v);
    if (isText && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  var CSV_COLUMNS = ['session_id', 'date', 'workout', 'exercise', 'exercise_id', 'set', 'type',
    'reps', 'weight_kg', 'entered_weight', 'entered_unit', 'completed', 'rpe', 'rir', 'notes'];

  function toCSV(data, library) {
    var idx = exerciseIndex(data, library);
    var tpl = {}; (data.templates || []).forEach(function (t) { tpl[t.id] = t; });
    var rows = [CSV_COLUMNS.join(',')];
    live(data.sessions).slice().sort(function (a, b) { return a.startedAt < b.startedAt ? -1 : 1; })
      .forEach(function (s) {
        var workout = s.name || (s.templateId && tpl[s.templateId] ? tpl[s.templateId].name : '');
        s.entries.forEach(function (e) {
          (e.sets || []).forEach(function (st, i) {
            var entered = st.weightKg == null ? '' : displayWeight(st.weightKg, st.enteredUnit || 'kg');
            rows.push([
              csvCell(s.id), csvCell(s.startedAt), csvCell(workout, true), csvCell(exerciseName(idx, e), true),
              csvCell(e.exerciseId), i + 1, csvCell(st.type || 'working'), csvCell(st.reps),
              csvCell(st.weightKg == null ? '' : String(parseFloat(st.weightKg.toFixed(5)))), csvCell(entered),
              csvCell(st.enteredUnit), st.completed ? 'true' : 'false', csvCell(st.rpe), csvCell(st.rir),
              csvCell(st.note, true)
            ].join(','));
          });
        });
      });
    return rows.join('\r\n') + '\r\n';
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION, LB_TO_KG: LB_TO_KG, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    BACKUP_REMINDER_AFTER: BACKUP_REMINDER_AFTER, CSV_COLUMNS: CSV_COLUMNS,
    nowIso: nowIso, newId: newId, toKg: toKg, fromKg: fromKg, displayWeight: displayWeight,
    parseWeight: parseWeight, emptyData: emptyData, migrate: migrate, validate: validate,
    mergeCollection: mergeCollection, mergeData: mergeData, live: live, getSettings: getSettings,
    unbackedUpCount: unbackedUpCount, shouldShowBackupBanner: shouldShowBackupBanner,
    exerciseIndex: exerciseIndex, exerciseName: exerciseName, lastPerformance: lastPerformance,
    formatSet: formatSet, volumeKg: volumeKg, toCSV: toCSV
  };
});
