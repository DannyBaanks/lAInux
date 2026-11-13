# Manus Desktop on Linux

```bash
./transmute.sh manus ~/Downloads/ManusAI.Manus_2.1.1.0_neutral_~_vajzd2mq3s8wj.Msixbundle
manus            # or "Manus Studio" in the app launcher
```

Close Manus before running it: the recipe refuses to replace an install that is
running (`--force` overrides). A failed run restores the previous install.

## What the recipe does

| Step | Input (pinned in [`pins.env`](pins.env)) | Result |
|---|---|---|
| 1. Verify | your `.Msixbundle` (Manus 2.1.1.0) | SHA-256 must match, otherwise nothing is written |
| 2. Extract | x64 package of the bundle | `lib/msix.py` decodes the MSIX names (`%40scope` → `@scope`) |
| 3. Runtime | Electron 43.6.0 linux-x64 (GitHub) | the version `Manus.exe` was built with |
| 4. Payload | `resources/` of the package | `app.asar` stays byte-identical; `browser-js`, addons, icons included |
| 5. Native modules | node-pty Linux prebuild (shipped by Manus), `@beeper/webauthn-authenticator-linux-x64-gnu` 0.2.1 (npm) | Linux `.node` files where the package only ships Windows ones |
| 6. Bridge runtime | `node.exe` 22.14.0 (nodejs.org) | runs the local-API bridge under Wine; 22.14 loads `node:sqlite` without a flag |
| 7. Companions | WINS `heal-bin`, `heal-paths`, `port-context` | operator/sidecar/task panel under micro-Wine shims, native git/pwsh for the agent terminal, path dialect, watchdog, "Reconnect" entry |
| 8. Wine prefix | MinGit 2.56.1 + git-lfs 3.8.1 (GitHub) | fallback git for the companions (`--no-mingit` skips) |
| 9. Integrate | - | `~/.local/bin/manus`, `~/.local/share/applications/manus.desktop` |

## Requirements

`python3 curl sha256sum unzip tar wine winepath socat`, a WINS checkout
(`--wins DIR` / `WINS_HOME`), `go` (WINS builds its native exec bridge from
source) and PowerShell 7 for Linux (`pwsh`) for the agent terminal.

## Two defects the recipe fixes compared with a hand-made install

* A plain `unzip` leaves MSIX names percent-encoded: `addons/manus-computer-use/*/runtime/node_modules/%40jitl/...`
  then cannot be resolved as `@jitl/...`.
* The operator gets `MANUS_OPERATOR_BROWSER_JS_ENTRYPOINT=<resources>/browser-js/in-app-browser-js.mjs`;
  an install that skips `resources/browser-js` breaks the in-app browser tool.

## Where things are

* install `~/.local/share/manus-desktop`, notes for agents `WINS-PORT.md` inside it
* profile `~/.config/Manus` (never touched), operator log `~/.config/Manus/logs/operator.log`
* WINS logs `~/.cache/wins/logs/`, download cache `~/.cache/ai-desktop-transmuter/`

## Updating to a new Manus version

Put the new bundle's SHA-256 in `pins.env`, read the Electron version from
`Manus.exe` (`strings Manus.exe | grep -m1 -o 'Electron/[0-9.]*'`), pin that
Electron zip from its `SHASUMS256.txt`, and run `tests/test_manus_recipe.sh`.
