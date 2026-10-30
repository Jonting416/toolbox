// Run: node --test tools/workout-tracker/tests
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');
const lib = require('../library/exercises.v1.json');

function session(over) {
  return Object.assign({ id: C.newId('ses'), startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T11:00:00Z',
    updatedAt: '2026-10-01T11:00:00Z', deleted: false, entries: [] }, over);
}

test('135 lb round-trips through kg and displays as 135', () => {
  const p = C.parseWeight('135', 'lb');
  assert.strictEqual(C.displayWeight(p.weightKg, 'lb'), '135');
  assert.strictEqual(C.displayWeight(p.weightKg, 'kg'), '61.25');
  const d = C.emptyData(); d.sessions.push(session({ entries: [{ exerciseId: 'x', sets: [{ ...p, reps: 5, completed: true }] }] }));
  const back = C.migrate(JSON.parse(JSON.stringify(d)));
  assert.strictEqual(back.sessions[0].entries[0].sets[0].weightKg, p.weightKg);
});

test('volume is identical regardless of display unit', () => {
  const s = session({ entries: [{ exerciseId: 'x', sets: [
    { weightKg: C.toKg(135, 'lb'), reps: 5, completed: true }, { weightKg: 100, reps: 5, completed: true }] }] });
  assert.ok(Math.abs(C.volumeKg(s) - (C.toKg(135, 'lb') * 5 + 500)) < 1e-9);
});

test('weight mode: shared by default, per-set when weights differ, explicit mode wins', () => {
  const kg = (lb) => C.toKg(lb, 'lb');
  const fresh = { sets: [{ weightKg: null }, { weightKg: null }] };
  assert.strictEqual(C.weightMode(fresh), 'shared');
  assert.strictEqual(C.weightMode({ sets: [{ weightKg: kg(135) }, { weightKg: kg(135) }] }), 'shared');
  const mixed = { sets: [{ weightKg: kg(135) }, { weightKg: kg(155) }] };
  assert.strictEqual(C.weightMode(mixed), 'perSet');
  assert.strictEqual(C.hasMixedWeights(mixed), true);
  assert.strictEqual(C.weightMode({ ...mixed, weightMode: 'shared' }), 'shared');
  assert.strictEqual(C.weightMode({ ...fresh, weightMode: 'perSet' }), 'perSet');
  assert.strictEqual(C.weightMode({ sets: [] }), 'shared');
});

test('setAllWeights puts one weight on every set; clearing clears the unit too', () => {
  const e = { sets: [{ weightKg: 10, enteredUnit: 'kg' }, { weightKg: null }, { weightKg: 50, enteredUnit: 'kg' }] };
  C.setAllWeights(e, C.toKg(225, 'lb'), 'lb');
  assert.ok(e.sets.every((s) => s.enteredUnit === 'lb' && C.displayWeight(s.weightKg, 'lb') === '225'));
  assert.strictEqual(C.displayWeight(C.sharedWeight(e), 'lb'), '225');
  C.setAllWeights(e, null, 'lb');
  assert.ok(e.sets.every((s) => s.weightKg === null && s.enteredUnit === null));
  assert.strictEqual(C.sharedWeight(e), null);
});

test('stepWeight adds plate steps in the display unit and never goes below zero', () => {
  assert.deepStrictEqual(C.WEIGHT_STEPS.lb, [5, 10, 25, 45]);
  assert.strictEqual(C.displayWeight(C.stepWeight(C.toKg(135, 'lb'), 45, 'lb'), 'lb'), '180');
  assert.strictEqual(C.displayWeight(C.stepWeight(null, 25, 'lb'), 'lb'), '25');
  assert.strictEqual(C.stepWeight(C.toKg(10, 'lb'), -45, 'lb'), 0);
  assert.strictEqual(C.displayWeight(C.stepWeight(60, 2.5, 'kg'), 'kg'), '62.5');
});

test('uuidv7 ids are unique and time-sortable', () => {
  const a = C.newId('ses'); const b = C.newId('ses');
  assert.notStrictEqual(a, b); assert.match(a, /^ses_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('merge: LWW, tombstone wins, deterministic both ways, nothing lost', () => {
  const a = C.emptyData('A'), b = C.emptyData('B');
  a.sessions.push(session({ id: 's1', notes: 'old', updatedAt: '2026-10-01T11:00:00Z' }), session({ id: 's2' }));
  b.sessions.push(session({ id: 's1', notes: 'new', updatedAt: '2026-10-02T00:00:00Z' }), session({ id: 's3' }));
  a.templates.push({ id: 't1', name: 'A', updatedAt: '2026-10-03T00:00:00Z', deleted: false, deviceId: 'A' });
  b.templates.push({ id: 't1', name: 'B', updatedAt: '2026-10-03T00:00:00Z', deleted: true, deviceId: 'B' });
  const ab = C.mergeData(a, b), ba = C.mergeData(b, a);
  const ids = (d) => d.sessions.map((s) => s.id).sort();
  assert.deepStrictEqual(ids(ab), ['s1', 's2', 's3']); assert.deepStrictEqual(ids(ba), ids(ab));
  assert.strictEqual(ab.sessions.find((s) => s.id === 's1').notes, 'new');
  assert.strictEqual(ab.templates[0].deleted, true); assert.strictEqual(ba.templates[0].deleted, true);
});

test('settings merge last-writer-wins per key', () => {
  const a = C.emptyData(), b = C.emptyData();
  a.settings = { weightUnit: 'lb', theme: 'dark' }; a.settingsUpdatedAt = { weightUnit: '2026-01-02', theme: '2026-01-01' };
  b.settings = { weightUnit: 'kg', theme: 'light' }; b.settingsUpdatedAt = { weightUnit: '2026-01-01', theme: '2026-01-02' };
  const m = C.mergeData(a, b);
  assert.deepStrictEqual(m.settings, { weightUnit: 'lb', theme: 'light' });
});

test('unknown fields are preserved on round trip and merge', () => {
  const a = C.emptyData(); a.sessions.push(session({ id: 's1', futureField: { x: 1 } }));
  const m = C.mergeData(C.emptyData(), JSON.parse(JSON.stringify(a)));
  assert.deepStrictEqual(m.sessions[0].futureField, { x: 1 });
});

test('backup banner: needs 2 unbacked sessions, ignores deleted and in-progress, resets after backup', () => {
  const d = C.emptyData();
  d.sessions.push(session({ id: 'a', updatedAt: '2026-10-01T11:00:00Z' }));
  assert.strictEqual(C.shouldShowBackupBanner(d), false);
  d.sessions.push(session({ id: 'b', updatedAt: '2026-10-02T11:00:00Z' }));
  assert.strictEqual(C.shouldShowBackupBanner(d), true);
  d.sessions.find((s) => s.id === 'b').deleted = true;
  assert.strictEqual(C.shouldShowBackupBanner(d), false);
  d.sessions.find((s) => s.id === 'b').deleted = false;
  d.sessions.push(session({ id: 'c', endedAt: null, updatedAt: '2026-10-03T11:00:00Z' }));
  assert.strictEqual(C.unbackedUpCount(d), 2);
  d.lastBackupAt = '2026-10-04T00:00:00Z';
  assert.strictEqual(C.shouldShowBackupBanner(d), false);
});

test('CSV: one row per set, quotes escaped, formulas neutralised', () => {
  const d = C.emptyData();
  d.exercises.push({ id: 'ex_1', name: '=evil, "x"', updatedAt: 'z', deleted: false });
  d.sessions.push(session({ id: 's1', entries: [{ exerciseId: 'ex_1', sets: [
    { type: 'working', reps: 5, weightKg: C.toKg(135, 'lb'), enteredUnit: 'lb', completed: true },
    { type: 'warmup', reps: 8, weightKg: 20, enteredUnit: 'kg', completed: false }] }] }));
  const lines = C.toCSV(d, lib).trim().split('\r\n');
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[1].includes('"\'=evil, ""x"""'));
  assert.ok(lines[1].includes(',135,lb,'));
});

test('validate rejects bad records', () => {
  assert.deepStrictEqual(C.validate({ schemaVersion: 1, sessions: [] }), []);
  assert.ok(C.validate({ schemaVersion: 1, sessions: [{ id: 'bad id!' }] }).length);
  assert.ok(C.validate([]).length);
});

test('seed library: unique stable ids, provenance recorded', () => {
  const ids = new Set(lib.exercises.map((e) => e.id));
  assert.strictEqual(ids.size, lib.exercises.length);
  assert.ok(lib.exercises.length > 800);
  assert.ok(lib.provenance.commit && lib.provenance.url);
  assert.ok(lib.exercises.every((e) => e.source === 'standard' && e.trackingType));
});

test('set schemes: 5/3/1 is three sets of 5, 3, 1; list is fixed', () => {
  assert.deepStrictEqual(C.SET_SCHEMES.map((s) => s.label), ['3×5', '5×5', '3×8', '4×8', '3×10', '3×12', '4×12', '5/3/1']);
  const sets = C.applyScheme([], C.schemeById('531'));
  assert.deepStrictEqual(sets.map((s) => s.reps), [5, 3, 1]);
  assert.ok(sets.every((s) => !s.completed && s.weightKg == null));
});

test('applyScheme keeps checked-off sets and weights, drops extra unchecked sets', () => {
  const w = C.toKg(135, 'lb');
  const sets = [
    { type: 'working', reps: 6, weightKg: w, enteredUnit: 'lb', completed: true },
    { type: 'working', reps: 6, weightKg: w, enteredUnit: 'lb', completed: false },
    { type: 'working', reps: 6, weightKg: null, enteredUnit: null, completed: false },
    { type: 'working', reps: 6, weightKg: null, enteredUnit: null, completed: false }
  ];
  const out = C.applyScheme(sets, C.schemeById('3x10'));
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0], sets[0]);                       // checked-off set untouched
  assert.deepStrictEqual(out.map((s) => s.reps), [6, 10, 10]);
  assert.ok(out.every((s) => s.weightKg === w));            // blank weights take the last known weight
  // more checked-off sets than the scheme has: all are kept
  const done = [1, 2, 3, 4].map(() => ({ reps: 5, weightKg: 100, completed: true }));
  assert.strictEqual(C.applyScheme(done, C.schemeById('3x5')).length, 4);
});

test('extractWorkoutData unwraps a Toolbox data file', () => {
  const d = C.emptyData(); d.sessions.push(session());
  assert.strictEqual(C.extractWorkoutData({ format: 'toolbox-data', version: 1, tools: { 'workout-tracker': d } }), d);
  assert.strictEqual(C.extractWorkoutData(d), d);
  assert.throws(() => C.extractWorkoutData({ format: 'toolbox-data', version: 1, tools: {} }), /no workout tracker data/);
});

test('mergeMany: several files give the same result in any order; mergeDiff counts new/updated', () => {
  const base = C.emptyData(), a = C.emptyData(), b = C.emptyData();
  const s1 = session({ id: 'ses_1' }), s2 = session({ id: 'ses_2' }), s3 = session({ id: 'ses_3' });
  base.sessions.push(s1);
  a.sessions.push(Object.assign({}, s1, { name: 'edited', updatedAt: '2026-10-02T00:00:00Z' }), s2);
  b.sessions.push(s3, Object.assign({}, s2, { deleted: true, updatedAt: '2026-10-03T00:00:00Z' }));
  const ids = (d) => d.sessions.map((s) => s.id + (s.deleted ? '-' : '') + (s.name || '')).sort();
  const x = C.mergeMany(base, [a, b]), y = C.mergeMany(base, [b, a]);
  assert.deepStrictEqual(ids(x), ids(y));
  assert.deepStrictEqual(ids(x), ['ses_1edited', 'ses_2-', 'ses_3']);
  assert.deepStrictEqual(C.mergeDiff(base, a).sessions, { added: 1, updated: 1 });
  assert.deepStrictEqual(C.mergeDiff(x, a).sessions, { added: 0, updated: 0 });
});

test('start/finish times: datetime-local round-trip and finish-after-start check', () => {
  const iso = C.fromLocalInput('2026-10-30T18:45');
  assert.strictEqual(C.toLocalInput(iso), '2026-10-30T18:45');
  assert.strictEqual(C.fromLocalInput(''), null);
  assert.strictEqual(C.checkTimes('2026-10-30T10:00:00.000Z', '2026-10-30T11:00:00.000Z'), '');
  assert.match(C.checkTimes('2026-10-30T10:00:00.000Z', '2026-10-30T09:00:00.000Z'), /after the start/);
  assert.strictEqual(C.checkTimes('2026-10-30T10:00:00.000Z', null), '');
});
