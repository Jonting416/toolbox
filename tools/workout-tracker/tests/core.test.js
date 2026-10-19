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
