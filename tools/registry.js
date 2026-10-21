/*
 * The list of tools shown on the landing page.
 *
 * To add a tool:
 *   1. Copy tools/notes/ to tools/<your-tool-id>/ and build it there.
 *   2. Add (or update) an entry below.
 *
 * Fields
 *   id           Unique key. Also the key the tool uses in the data file
 *                (Toolbox.get('<id>') / Toolbox.set('<id>', ...)).
 *   name         Display name.
 *   description  One sentence shown on the card.
 *   icon         One of: dumbbell, timer, note, chart, calendar, list, wrench.
 *   path         Folder of the tool's index.html, relative to the site root.
 *   status       'ready' (clickable) or 'planned' (shown as coming soon).
 *   tags         Optional short labels, used by search.
 */
window.TOOLBOX_TOOLS = [
  {
    id: 'workout-tracker',
    name: 'Workout Tracker',
    description: 'Log sessions, exercises, sets and reps, and look back over your history.',
    icon: 'dumbbell',
    path: 'tools/workout-tracker/',
    status: 'ready',
    tags: ['fitness']
  },
  {
    id: 'workout-timer',
    name: 'Workout Timer',
    description: 'Interval, rest and round timers, with presets saved to your data file.',
    icon: 'timer',
    path: 'tools/workout-timer/',
    status: 'planned',
    tags: ['fitness']
  },
  {
    id: 'notes',
    name: 'Notes',
    description: 'Plain-text notes, each saved separately in your data file. Also the starter template for new tools.',
    icon: 'note',
    path: 'tools/notes/',
    status: 'ready',
    tags: ['example', 'template']
  }
];
