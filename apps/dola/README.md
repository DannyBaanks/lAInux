# Dola on Linux (lAInux) — host v0

Dola (international Doubao) runs its **own desktop UI** in Linux Electron, with no Wine:
the UI bundle comes from the vendor's `biz.pak` on the user's machine; everything in
`host/` is original code.

```
host/main.js     https://www.dola.com/** served from the local bundle (route.json SPA
                 routes + files), everything else passed to the network; window; neotix host
host/preload.js  window.neotix (Proxy over IPC), window.neotixChannel, towel access points
```

Status (2026-11-13, measured in a hidden Xvfb window):
- the main chat window renders (es-MX locale, system color scheme), 582 bundle files served
  locally, API calls go to Dola's servers;
- sending a message reaches the server: Dola answers with its age confirmation (18+),
  which only the user may accept;
- the liblark backend is disabled in Dola by remote config, so access-point calls answer
  `backend disabled` exactly like Cici.dll;
- of ~880 `neotix` methods the UI knows, the startup path calls ~35: the implemented ones
  are in `HOST`/`HOST_WIN`; any other answers `No such method!` (the UI's own
  "not supported" path) and is logged as `NEOTIX-MISS` with DOLA_HOST_LOG set.

Run it (needs an Electron runtime and the UI extracted from your own install):

```bash
python3 lib/pak.py --extract-tree /tmp/dola-ui  <Dola>/local_webcontents/biz/biz.pak
DOLA_UI_DIR=/tmp/dola-ui  electron apps/dola/host          # DOLA_HOST_LOG=file to trace
```

Not yet: login window (`browserWindow.popupLoginWindow`), `dola://` / `chrome://` views
(audio recorder, ai-views popups), entry-moa/entry-main JS apps, packaging as a recipe
(`transmute.sh dola`) with a pinned official Electron.
