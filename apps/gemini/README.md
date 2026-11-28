# Gemini desktop on Linux (lAInux)

Google's Gemini desktop app (Windows since 2026-09, macOS) runs on Linux with **its own
`app.asar`, untouched**, on the official Linux Electron of the same version.

```bash
./transmute.sh gemini                 # fetch, verify, install, launcher + menu entry
./transmute.sh gemini --crx FILE      # same, from an already downloaded package
./transmute.sh gemini --uninstall     # keeps ~/.config/gemini (your signed-in profile)
```

## How it was found (2026-11-14)

- `GeminiSetup.exe` from gemini.google/desktop is a 13 MB stub of Google's updater.
  The app itself comes from Google's update server: an Omaha 3.1 `updatecheck` for appid
  `{533DD80C-942A-4464-B6A9-2E59428D784E}`, `ap=prod`, returns version 1.19.0 and a 395 MB
  `.crx3` with its SHA-256. `pins.env` holds that URL and that hash.
- The `.crx3` holds `GeminiSetup-1.19.0_uncompressed.exe`, an **electron-builder NSIS**
  installer: `Gemini.exe` is Electron 44.6.0 (Chrome 152), and `resources/app.asar` (413 KB)
  loads `https://gemini.google.com/app` in its window.
- The only native piece is `gemini_native.node` (Windows): desktop helpers (selected text,
  caret, foreground app, text injection, window focus) and `argoLib`, the Windows account
  manager. On Linux it cannot load and `main.js` takes its own path:
  `gemini_native addon unavailable; Will use fallbacks`.

## What works (verified 2026-11-14)

- The app starts, loads gemini.google.com, **Google sign-in works inside the window**
  (Google does not block its own app here, unlike third-party embedded logins), chat works.
- The installed `app.asar` is byte-identical to Google's (same SHA-256).

## Known gaps

- **Alt+Space overlay, selected text, foreground-app context:** on Windows these come
  from `GeminiAppLauncher.exe` (a helper reached over the named pipe
  `\\.\pipe\Google.Gemini.AppLauncher`) and the native addon. On Linux the app retries that
  pipe with back-off (max 30 s, harmless). Node resolves that name as a Unix socket path
  relative to the working directory, which is where a Linux helper could answer later.
- **Crash reports:** the crash-dump path is built with `path.win32.join`, so it is never
  absolute on Linux and Crashpad stays off (logged once at startup). Nothing is uploaded.
- **Updates:** the app's Omaha watcher finds nothing to do on Linux; update by bumping
  `pins.env` and re-running the recipe.
