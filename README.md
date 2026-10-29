# Toolbox

A static, client-side toolbox. No server, no accounts: every tool reads and writes
its own section of **one JSON data file** that the user keeps on their own device
or in their own Google Drive.

```
index.html              Landing page (data file panel + tool grid)
lib/toolbox.config.js   Site config: Google Drive client ID / API key / project number
lib/toolbox.js          Data layer: the data file, saving, conflicts, the Toolbox API
lib/providers/local.js  Storage on this device (file handle, or download fallback)
lib/providers/gdrive.js Storage in Google Drive
lib/toolbox-ui.js       Shared UI: data-file bar, header chip, dialogs, icons
lib/analytics.js        Page-view counting and its privacy notice
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
is the most reliable for the "save automatically" behaviour. Google Drive needs the
site served over `http://localhost` or HTTPS; the Drive option is hidden on `file:`.

## Privacy and third-party services

The site itself has no server and never receives tool data. Third-party services:

| What | Where it goes | What is sent |
| --- | --- | --- |
| Your tool data (notes, workouts, …), file on this device | Nowhere. It stays in your own data file (and this browser's working copy) | Nothing |
| Your tool data, file in Google Drive (only if you choose it) | Your own Google Drive, straight from your browser (`googleapis.com`) | The data file. Sign-in goes through `accounts.google.com`; Toolbox can only see files it created or that you picked (`drive.file` scope) |
| Page views | `aremi.goatcounter.com` | Page path, referrer, browser and screen size, country (derived from IP, not stored). No cookies, no personal identifiers |

- Google's scripts (`accounts.google.com/gsi/client`, `apis.google.com/js/api.js`) load only
  when a visitor points at or uses a Google Drive button, never on a plain page view.
- The Google access token (valid about an hour) and the signed-in email are kept in this
  browser's `localStorage` (`toolbox:gdrive-token`, `toolbox:gdrive-account`) so tool pages
  don't each ask for sign-in. **Sign out of Google Drive** in the file menu revokes the token.

- The counter is loaded once by `lib/analytics.js` for every page, from `https://gc.zgo.at/count.js`.
  Don't add the GoatCounter snippet to individual pages; new tools copied from
  `tools/notes/` are counted automatically.
- On a visitor's first page load, a notice explains this and offers **Don't count my
  visits**. The landing-page footer shows whether visits are counted and lets the visitor
  opt out or back in. Both choices are stored in that browser's `localStorage`
  (`toolbox:analytics`, `toolbox:analytics-notice-seen`).
- GoatCounter ignores `localhost` and pages opened from disk, so local testing isn't counted.
- To change the counter, edit `GOATCOUNTER_ENDPOINT` in `lib/analytics.js`. To turn counting
  off entirely, remove the `startCounting()` call there.
- The exercise library in `tools/workout-tracker/library/` is bundled with the site
  ([free-exercise-db](https://github.com/yuhonas/free-exercise-db), public domain); apart
  from the counter and Google Drive (when used), nothing else is fetched at runtime.

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
- **Firefox, Safari:** the file is opened with a normal file picker. These browsers
  can't write to files, so changes are kept as a working copy in the browser until the
  user clicks **Save file**. An info box explains this (it can be turned off with
  "Don't show this again"), then the browser downloads an updated copy that replaces
  the old file.

- **Google Drive (any browser, when configured):** choose **New in Google Drive** or
  **Open from Google Drive** (the Google Picker). Changes save automatically about two
  seconds after you stop typing. Google's sign-in lasts about an hour; after that the
  bar shows **Reconnect**, and one click signs in again (usually without asking). Unsaved
  changes stay in the working copy meanwhile.

The **Storage** selector at the top right, beside the open file, shows where the file is
kept (**This device**, or **Google Drive** once it's set up) and decides where **Create** and
**Open** go when no file is open. Changing it closes the open file. Anything that can still
be saved is saved first. If changes would be lost (download mode, a pending Reconnect, or
an unresolved conflict), it warns and offers **Download my copy** before switching. Pages get
the selector from `Toolbox.mountAccount(el)`; pass `{ storagePicker: false }` to leave it out.

To use the file across devices, keep it in Google Drive or in a synced folder (iCloud
Drive, Dropbox, OneDrive…). With a local file, avoid editing in two tabs at once — the
last save wins. With Google Drive, Toolbox notices when the file changed somewhere else
and asks whether to **Reload from Google Drive**, **Keep mine**, or **Download my copy** first.

## Google Drive setup

Drive sign-in runs entirely in the browser (Google Identity Services token flow), so there
is no client secret and nothing to host. Do this once per site in
[Google Cloud Console](https://console.cloud.google.com):

1. Create a project (e.g. `toolbox`). Note its **project number** (Dashboard → Project info).
2. **APIs & Services → Library:** enable **Google Drive API** and **Google Picker API**.
3. **Google Auth Platform → Branding:** app name, support email, and under *Authorised
   domains* the domain you host on (e.g. `you.github.io`). A privacy-policy URL is needed
   before publishing. A page with the privacy section above is enough.
4. **Audience:** user type **External**. While the app is in *Testing*, add your Google
   accounts as test users.
5. **Data access → Add or remove scopes:** add only `.../auth/drive.file`. It's a
   non-sensitive scope, so you can then **Publish app** without Google's verification
   review. (Don't add `drive` or `drive.readonly`: those are restricted and need a paid
   security assessment.)
6. **Clients → Create client → Web application.** Under *Authorised JavaScript origins* add
   `http://localhost:8765`, `http://127.0.0.1:8765` (local preview) and your site's
   `https://` origin. No redirect URIs are needed. Copy the **Client ID**.
7. **APIs & Services → Credentials → Create credentials → API key.** Restrict it to the
   **Google Picker API**, with *Website* restrictions for the same origins.
8. Put the three values in `lib/toolbox.config.js`:
   ```js
   google: { clientId: '….apps.googleusercontent.com', apiKey: 'AIza…', appId: '123456789012' }
   ```
   None of these are secrets; the origin restrictions are what protect them. Once all
   three are set, the Google Drive buttons appear.

## Adding a storage provider

Storage lives behind a small interface, documented under "storage providers" in
`lib/toolbox.js`, so another service (S3, Google Cloud Storage, …) is one new file:

1. Create `lib/providers/<id>.js` that calls `Toolbox.registerProvider({...})` with `id`,
   `label`, `kind: 'cloud'`, `autosave`, `available()`, `authorize({ interactive })`,
   `pick()`, `create(name, text)`, `read(ref)`, `write(ref, text, { ifVersion })` and,
   optionally, `prepare()`, `account()`, `signOut()`. `lib/providers/gdrive.js` is the example.
2. Add a `<script>` tag for it after `providers/gdrive.js` on every page (the landing page
   and each tool), and its settings to `lib/toolbox.config.js`.
3. Throw `Toolbox.storageError('NeedsReconnect' | 'NotFound' | 'Conflict', message)` so the
   core shows Reconnect, forgets a missing file, or asks which version to keep. Return a
   revision as `version` (ETag, generation, …) and set `checksVersion: true` if `write`
   refuses stale versions.

Notes for the likely next ones:
- **Google Cloud Storage:** the same Google sign-in with scope `devstorage.read_write`, which
  is *sensitive*, so it needs Google's verification for public users. Use the JSON API with
  `ifGenerationMatch` for conflict-safe writes. The bucket needs a CORS policy for the
  site's origin.
- **S3:** browsers can't safely hold AWS keys. Either use a Cognito Identity Pool federated
  with Google sign-in for temporary credentials (S3 supports `If-Match` PUTs), or add a
  small token broker (e.g. a Cloudflare Worker) that checks the user's Google ID token and
  returns presigned URLs. A worker like that can also run the OAuth authorization-code
  flow, keeping refresh tokens in an encrypted `HttpOnly` cookie and the client secret as a
  worker secret, if Drive sessions should outlast Google's one-hour token.

## Adding a tool

1. Copy `tools/notes/` to `tools/<tool-id>/`.
2. In the copy, set `TOOL_ID = '<tool-id>'` and replace the UI and logic. Keep the block of
   shared `<script>` tags (config, `toolbox.js`, providers, `toolbox-ui.js`, `analytics.js`)
   in that order, before the tool's own scripts.
3. Add an entry to `tools/registry.js` with `status: 'ready'`.

The API a tool uses:

| Call | What it does |
| --- | --- |
| `Toolbox.get(id, fallback)` | Copy of the tool's data, or `fallback` |
| `Toolbox.set(id, value)` | Replace the tool's data (returns `false` if no file is open) |
| `Toolbox.update(id, fn, fallback)` | Read-modify-write helper |
| `Toolbox.remove(id)` | Delete the tool's data from the file |
| `Toolbox.on(fn)` | Called on open / reconnect / close / save; `status.generation` changes when a different file is loaded |
| `Toolbox.status()` | `{ connected, mode, provider, storage, fileName, dirty, needsReconnect, conflict, toolIds, … }`; `mode` is `'file'`, `'download'` or `'cloud'`; `storage` is `'device'` or a cloud provider id |
| `Toolbox.switchStorage(id)` | Change where the file is kept (`'device'`, `'gdrive'`); closes the open file after confirming |
| `Toolbox.ready` | Promise that resolves once the remembered file has been checked |
| `Toolbox.mountDataBar(el)` | Drop-in open/create/reconnect/save bar |
| `Toolbox.mountAccount(el)` | Header chip showing the open file like a signed-in account; while a file is in use it replaces the data bar |

Keep stored data plain JSON, as an object with a numeric `schemaVersion`
(`Toolbox.set` logs a console warning if it's missing). The file's top-level
`version` covers the envelope only; each tool versions its own section. When a
tool's data shape changes, bump its `schemaVersion` and upgrade older data on
load. See `migrate()` in `tools/notes/` for the pattern.
