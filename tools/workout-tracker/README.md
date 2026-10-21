# Workout Tracker

Implements `workout-tracker-requirements.md` as a Toolbox tool. Data is stored under
the `workout-tracker` key of the user's Toolbox data file, in the documented export
format (requirements §5): `kg` is canonical (`weightKg` + `enteredUnit`), UUIDv7 ids,
tombstone deletes, `updatedAt` last-writer-wins merge.

```
index.html / workout-tracker.css   UI shell
app.js                             UI + events
core.js                            Pure logic: units, ids, merge, migrate, validate, CSV, backup-banner rule
library/exercises.v1.{json,js}     Generated standard library (876 exercises, free-exercise-db, pinned commit)
build/build-library.mjs            node build/build-library.mjs <upstream exercises.json>
tests/core.test.js                 node --test tools/workout-tracker/tests/core.test.js
```

## Logging weight
- Weights are typed into a box. The **±** button beside it opens an "Adjust weight" sheet
  with steps of 5 / 10 / 25 / 45 lb (2.5 / 5 / 10 / 20 kg).
- By default an exercise has **one weight for all its sets**. "Different weight per set"
  switches that exercise to a weight box on every set; "Same weight for all sets" switches
  back (using set 1's weight).
- Every set still stores its own `weightKg`, so history, CSV, merge and "Previous" are
  unaffected. The entry only records `weightMode: 'shared' | 'perSet'`; entries without it
  are shared when all their sets have the same weight (see `core.weightMode`).

## Differences from the requirements doc
The spec assumed a standalone Svelte/IndexedDB PWA; as a Toolbox tool it instead:
- stores data in the shared Toolbox data file (no IndexedDB, no per-tool service worker);
- uses plain JS with no build step or runtime dependencies;
- treats a JSON export as the "backup" for the FR-19a reminder (the data file itself is the working store);
- validates imports with a hand-written structural check (`core.validate`) rather than Ajv + a published JSON Schema (not yet written).

Not built (spec "Next"/"Later"): cloud sync (placeholders say "Coming Soon"), rest timer, PR detection, charts, other-tracker CSV import.
Exercise tracking types other than weight×reps / bodyweight reps are stored but use the same weight+reps UI.
