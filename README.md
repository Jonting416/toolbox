# Toolbox

A static, client-side toolbox. No server, no accounts: every tool reads and writes
its own section of **one JSON data file** that the user keeps on their own device.

```
index.html              Landing page (data file panel + tool grid)
lib/toolbox.js          Data layer + shared data-file bar (used by every page)
lib/toolbox.css         Shared styles (light/dark)
tools/registry.js       The list of tools shown on the landing page
tools/notes/            Example tool — copy it to start a new one
tools/workout-tracker/  Workout tracker (see its own README.md)
```

## Statement of purpose

Ideas and tools that I think are useful, which are all served as static websites! If it involves more structured hosting online, then this can have a link.

## Hosting

Upload the folder to any static host (GitHub Pages, Netlify, Cloudflare Pages, S3…).
It also works opened straight from disk (`index.html`), though hosting over HTTPS
is the most reliable for the "save automatically" behaviour.

## How data is stored

```json
{
  "format": "toolbox-data",
  "version": 1,
  "createdAt": "2026-10-18T22:00:00.000Z",
  "updatedAt": "2026-10-18T22:05:00.000Z",
  "tools": {
    "notes": { "schemaVersion": 1, "text": "…", "updatedAt": "…" },
    "workout-tracker": { "schemaVersion": 1, "...": "…" }
  }
}
```

- **Chrome, Edge, Opera (and other Chromium browsers):** the site gets a handle to
  the real file and saves changes to it automatically. The browser remembers the
  file between visits; it may ask for permission again with one click ("Reconnect").
- **Firefox, Safari:** the file is opened with a normal file picker. Changes are kept
  as a working copy in the browser until the user clicks **Download file**, then
  they replace their old file with the download.

Put the data file in a synced folder (iCloud Drive, Dropbox, OneDrive…) to use it
across devices. Avoid editing in two tabs at once — the last save wins.

## Adding a tool

1. Copy `tools/notes/` to `tools/<tool-id>/`.
2. In the copy, set `TOOL_ID = '<tool-id>'` and replace the UI and logic.
3. Add an entry to `tools/registry.js` with `status: 'ready'`.

The API a tool uses:

| Call | What it does |
| --- | --- |
| `Toolbox.get(id, fallback)` | Copy of the tool's data, or `fallback` |
| `Toolbox.set(id, value)` | Replace the tool's data (returns `false` if no file is open) |
| `Toolbox.update(id, fn, fallback)` | Read-modify-write helper |
| `Toolbox.remove(id)` | Delete the tool's data from the file |
| `Toolbox.on(fn)` | Called on open / reconnect / close / save; `status.generation` changes when a different file is loaded |
| `Toolbox.status()` | `{ connected, mode, fileName, dirty, needsReconnect, toolIds, … }` |
| `Toolbox.ready` | Promise that resolves once the remembered file has been checked |
| `Toolbox.mountDataBar(el)` | Drop-in open/create/reconnect/save bar |
| `Toolbox.mountAccount(el)` | Header chip showing the open file like a signed-in account; while a file is in use it replaces the data bar |

Keep stored data plain JSON, as an object with a numeric `schemaVersion`
(`Toolbox.set` logs a console warning if it's missing). The file's top-level
`version` covers the envelope only; each tool versions its own section. When a
tool's data shape changes, bump its `schemaVersion` and upgrade older data on
load. See `migrate()` in `tools/notes/` for the pattern.
