// Converts free-exercise-db (public domain / Unlicense) into library/exercises.v1.json
// and library/exercises.v1.js (same content wrapped for <script> loading, so the tool
// also works when opened from disk).
//
// Usage: node build/build-library.mjs <path-to-upstream-exercises.json>
// Upstream: https://github.com/yuhonas/free-exercise-db  (dist/exercises.json)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM_COMMIT = 'f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5';
const src = process.argv[2];
if (!src) { console.error('usage: node build-library.mjs <exercises.json>'); process.exit(1); }

const upstream = JSON.parse(readFileSync(src, 'utf8'));

function trackingType(x) {
  if (x.category === 'cardio' || x.category === 'stretching') return 'duration';
  if (x.equipment === 'body only') return 'bodyweight_reps';
  return 'weight_reps';
}

const seen = new Set();
const exercises = upstream.map((x) => {
  if (seen.has(x.id)) throw new Error('duplicate upstream id: ' + x.id);
  seen.add(x.id);
  return {
    id: x.id,                       // upstream ID is kept as the stable library ID
    name: x.name,
    aliases: [],
    category: x.category,
    primaryMuscles: x.primaryMuscles || [],
    secondaryMuscles: x.secondaryMuscles || [],
    equipment: x.equipment || null,
    trackingType: trackingType(x),
    instructions: (x.instructions || []).join('\n'),
    source: 'standard'
  };
}).sort((a, b) => a.name.localeCompare(b.name));

const lib = {
  schemaVersion: 1,
  libraryVersion: 1,
  provenance: {
    name: 'free-exercise-db',
    url: 'https://github.com/yuhonas/free-exercise-db',
    commit: UPSTREAM_COMMIT,
    license: 'Unlicense (public domain)',
    note: 'Converted by build/build-library.mjs. Images excluded. IDs are never reused or renamed.'
  },
  exercises
};

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'library');
const json = JSON.stringify(lib);
writeFileSync(join(dir, 'exercises.v1.json'), json);
writeFileSync(join(dir, 'exercises.v1.js'), 'window.WT_LIBRARY=' + json + ';\n');
console.log('wrote', exercises.length, 'exercises');
