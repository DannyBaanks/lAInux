# Kimi + Kimi Work on Linux

```bash
./transmute.sh kimi            # fetches Moonshot's Windows installer, verifies it, installs
kimi-desktop                   # or "Kimi" in your application menu
./transmute.sh kimi --uninstall
```

## How it works

Kimi's Windows build is a plain Electron 43 app, so the recipe can use most of it as is:

- **App:** Moonshot's `app.asar` runs untouched on the official Linux Electron 43.7.7, the version `Kimi.exe` reports.
- **Sign-in:** Google sign-in opens your default browser, and the app receives the callback on `127.0.0.1`. That flow already works on Linux.
- **Kimi Work's local agent ("daimon"):** it is JavaScript plus a Python environment.
  - On Windows, Kimi unpacks it from `daimon-*.tar.gz` on first run. On other platforms Kimi expects it already unpacked in `resources/resources/daimon-bundle`.
  - The recipe builds that folder from the package's `daimon-core.tar.gz`, then adds the Linux builds of CPython 3.12 (python-build-standalone 20261110), uv and jieba's addon, all pinned.
  - It also adds `bin/daimon` and `bin/kimi-daimon` from [`linux/`](linux). They are original bash counterparts of the bundle's PowerShell launchers.
- **Node:** Kimi runs its own Electron as Node. The Windows `node.cmd` does this through `%KIMI_DESKTOP_RUNTIME_NODE%`. On Linux, Kimi points that variable at `runtime/node` itself, so [`linux/node`](linux/node) ignores it and runs `../../../kimi` with `ELECTRON_RUN_AS_NODE=1`.
- **git:** Kimi Work uses the system's `git`. The Windows package bundles Git for Windows instead.

## Profile and data

- `~/.config/kimi-desktop` holds your signed-in profile. Inside it, `daimon-share/` holds Kimi Work's agent state and Python environment.
- `~/Documents/kimi/workspace` is Kimi Work's default workspace.

`--uninstall` keeps both.

## Not on Linux yet

- **Kimi Claw:** `resources/resources/gateway.asar` uses Windows builds of sharp, node-pty, @napi-rs/canvas, sqlite-vec and koffi.
- **Windows helper programs:** `kimi-webbridge.exe`, `kimi-slides.exe`, `kimiim-cli.exe`.
- **Desktop addons:** the 8 `kimi-*.node` addons (screen capture, OCR, global input, scroll input, file-manager selection, named pipe…) are Windows builds. The features that need them are unavailable.
- **Debugging:** Kimi refuses to start when `--remote-debugging-port` is passed. Use its log at `~/.config/kimi-desktop/logs/main.log` instead.
