# lAInux

**AI apps, but make them Linux.** 🐧

Seven reproducible recipes to adapt AI desktop applications that lack an official Linux build for the targeted package versions. lAInux works **locally, on your machine**, using vendor-provided inputs and auditable scripts—not repackaged proprietary applications.

*En español: siete recetas para llevar clientes de IA a Linux sin redistribuir los binarios propietarios de sus fabricantes.*

**The seven-app milestone (2026-11-27):** **⭐ Muse (Meta)** · Qwen · Manus · Dola · Gemini desktop · Doubao · Kimi.

> **What the milestone means:** all seven have recipes committed to this corpus. It does **not** mean every feature, account-login path or desktop integration has been validated. [See the evidence-based compatibility matrix](docs/COMPATIBILITY.md).

## ⭐ Featured: Muse (Meta) — native Linux client & computer node

Unlike the Electron apps in this corpus, Meta ships **Muse** (`com.meta.endo`) as a **macOS-native SwiftUI + Rust binary** — no Electron, no `app.asar`. lAInux brings it to Linux end to end without redistributing a single vendor byte:

- **Desktop shell (`muse-desktop`)** — hardened pinned Electron 43.6.0 window running `muse.ai` with an isolated profile (`~/.config/muse-desktop`), native dock icon extracted locally from your SHA-256-pinned `Muse-14.1.dmg` (`StartupWMClass=muse`), and an authenticated local credential broker.
- **Clean-room Linux computer node (`muse-node`)** — native Node 24 implementation of Muse's CVM device-link protocol (`Noise_XX_25519_AESGCM_SHA256` over WebSocket, streaming RPC, protobuf chunk framing, RV enrollment, and live `client.invoke` dispatch). Shows up as `<hostname> (Linux)` under **Settings → Devices**.
- **8 native Linux commands** — `ping`, `system.which`, `files.list`, `files.search`, `files.read`, plus approval-gated `files.write`, `files.mkdir`, and `shell.exec`.
- **Fail-closed native approvals (`zenity`)** — every write, mkdir, or shell command opens a native confirmation dialog with a bounded preview. **Rechazar** is the default button (an accidental Enter denies); timeout, window close, or missing display all return `permission_denied`.
- **`systemd --user` service** — `./apps/muse/daemon/install-service.sh` runs `muse-node.service` with your graphical session (`--uninstall` removes it cleanly).

```bash
./transmute.sh muse install                  # pinned Electron shell + DMG icon
muse-desktop                                 # sign in inside the window
./apps/muse/daemon/install-service.sh        # enable Linux computer node (Node >= 24 + zenity)
```

Read the full guide and protocol evidence in [`apps/muse/README.md`](apps/muse/README.md) and [`apps/muse/docs/PROTOCOL.md`](apps/muse/docs/PROTOCOL.md).

### Explore the project

- [**⭐ Muse (Meta) Linux client & node**](apps/muse/README.md) — flagship clean-room protocol node, `zenity` approvals and `systemd --user` service.
- [**Compatibility & evidence**](docs/COMPATIBILITY.md) — feature-level status, known gaps and reproducible gates.
- [**Architecture**](docs/ARCHITECTURE.md) — what the transmutation pipeline actually does, including WINS/Wine boundaries.
- [**Contributing a recipe**](docs/CONTRIBUTING.md) — add an app without weakening verification or user safety.
- [**Qwen reverse-engineering report**](docs/REVERSE_ENGINEERING.md) — the experiment that started the corpus.

### Why lAInux exists

A Windows- or macOS-only installer does not always imply OS-locked application logic. Some apps mainly need a matching Linux Electron runtime and a platform patch; others require a reconstructed native host, companion bridges, or—as with **Muse**—a clean-room Linux implementation of the device-link protocol. **Each app gets its own recipe** instead of pretending that one transformation works for everything.

**Ground rules:** no vendor-owned binaries in Git; pin and verify upstream inputs; fail closed on unexpected changes; stage installs with rollback; preserve the user's profile. A Linux-native window is not necessarily sandboxed or fully feature-compatible.

## The seven recipes

Each app gets a recipe under `apps/<app>/`. A recipe takes the vendor's official
package (Windows or macOS), fetches everything else from its official source, verifies each
input against a pinned SHA-256, and assembles a native Linux install under
`~/.local/share/<app>-desktop`. This repository holds **only scripts, text
patches and hashes**: no `.exe`, `.dmg`, `.msix`, `.asar`, Electron runtime, icon or any
other vendor byte is ever committed (`tests/test_manus_recipe.sh` checks it).

| App | Upstream input (you supply / we fetch) | How it runs on Linux | Recipe |
|---|---|---|---|
| **⭐ Muse (Meta)** | Official macOS `Muse-14.1.dmg` (you supply it, SHA-256 pinned for icon + RE) | Hardened Linux Electron 43 shell (`muse.ai`) + clean-room Node 24 Linux computer node (`Noise_XX_25519_AESGCM_SHA256`), `zenity` fail-closed approvals & `systemd --user` service | [`apps/muse`](apps/muse/README.md) |
| **Qwen Desktop** | NSIS `.exe` from `download.qwen.ai` | Linux Electron 35 + patched `app.asar`, MCP via host `bun`/`uv` | [`apps/qwen`](apps/qwen/transmute.sh) → `qwen-transmute.sh` |
| **Manus Desktop** | Microsoft Store `.Msixbundle` (you supply it) | Linux Electron 43 + untouched `app.asar`; Windows-only companions re-hosted by [WINS](#wins-dependency) | [`apps/manus`](apps/manus/README.md) |
| **Dola** (intl. Doubao) | `biz.pak` from your Dola install (folder, the `.pak`, or an AppImage that bundles it) | Dola's own UI on Linux Electron 45 + the lAInux host (original code); third-party sign-in in your default browser | [`apps/dola`](apps/dola/README.md) |
| **Doubao 豆包** | Doubao's package from its CDN (we fetch it, pinned to the MD5 its update API publishes + our SHA-256) | Doubao's own UI on Linux Electron 45 + the same lAInux host as Dola (brand `doubao`) | [`apps/doubao`](apps/doubao/transmute.sh) |
| **Gemini desktop** | Google's package from `dl.google.com` (we fetch it, pinned to the hash Google's update server publishes) | Linux Electron 44 + untouched `app.asar`; Google sign-in inside the app | [`apps/gemini`](apps/gemini/README.md) |
| **Kimi + Kimi Work** | Moonshot's installer from its CDN (we fetch it, pinned to the MD5 its CDN serves + our SHA-256) | Linux Electron 43 + untouched `app.asar`; Kimi Work's local agent (daimon) on Linux CPython/uv with Kimi's Electron as Node; Google sign-in in your default browser | [`apps/kimi`](apps/kimi/README.md) |

The matrix above describes the **adaptation strategy**, not an unconditional full-support claim. For known limitations—including Muse's `Node >= 24` / `zenity` node requirements, Qwen's sandbox configuration, Manus's hybrid companion path, Dola's desktop popups, Gemini's Windows-only helpers, Doubao's unverified interactive login and Kimi Claw (not on Linux yet)—read [Compatibility & evidence](docs/COMPATIBILITY.md).

## Quick start

```bash
./transmute.sh list                 # apps in the corpus
./transmute.sh muse install         # Muse (Meta): shell + DMG icon, then ./apps/muse/daemon/install-service.sh
./transmute.sh qwen --download      # same as ./qwen-transmute.sh --download
./transmute.sh manus ~/Downloads/ManusAI.Manus_2.1.1.0_neutral_~_vajzd2mq3s8wj.Msixbundle
./transmute.sh dola ~/Applications/Dola-Wine-1.0.0-x86_64.AppImage   # or your Dola folder / its biz.pak
./transmute.sh gemini                # fetches Google's package, verifies it, installs
./transmute.sh doubao                # fetches Doubao's package, verifies it, installs
./transmute.sh kimi                  # fetches Moonshot's installer, verifies it, installs
./transmute.sh <app> --uninstall    # removes the install, keeps ~/.config/<App>
```

## ⚖️ Legal Disclaimer & Notice of Non-Affiliation

1. **Non-Affiliation:** This is an independent interoperability project by **ISyCo Labs**. It is **NOT** affiliated with, endorsed by or sponsored by any vendor whose application it supports (including Meta / Muse, Alibaba Group / Qwen, Manus AI, ByteDance / Dola and Doubao, Google / Gemini, and Moonshot AI / Kimi).
2. **Trademarks:** All product names, marks and images belong to their respective owners.
3. **Zero Redistribution:** The repository contains only original automation scripts, text patches and checksums. Vendor files are obtained by the end user from the vendor's official channels and transformed locally on the user's own machine.
4. **User Compliance:** Review and comply with each vendor's Terms of Service and license before downloading and running its client.

## Adding an app

1. `apps/<app>/transmute.sh` - first comment line `# Summary: ...` (shown by `./transmute.sh list`); accept `--dest`, `--bin-dir`, `--uninstall`, `-h`.
2. `apps/<app>/pins.env` - every upstream input as URL + `*_SHA256`, checked against the publisher's own checksum, with the date.
3. Use `lib/common.sh` (`verify_sha256`, `fetch_pinned`, `write_launcher`, `write_desktop_entry`), `lib/msix.py` for MSIX / MSIX bundles and `lib/asar.py` to read single files out of an `app.asar`.
4. Stage the build next to the destination and swap it in at the end; restore the previous install on failure.
5. Add an offline test under `tests/` (fail-closed pin, uninstall keeps the profile).

<a id="wins-dependency"></a>
## WINS dependency (Manus)

Manus ships Windows-only companions (its device operator is a Go `.exe` that talks to the cloud for the agent). The recipe re-hosts them with **WINS** (`wins heal-bin`, `wins heal-paths`, `wins port-context`): micro-Wine shims, a native git/pwsh bridge for the agent terminal, Linux↔`Z:\` path translation, a watchdog and a "Reconnect" entry in the device menu. Point the recipe at a WINS checkout with `--wins DIR` or `WINS_HOME`.

## 🧪 Tests

```bash
(cd apps/muse/daemon && npm test)                      # Muse Linux node (Noise XX, RPC, commands, zenity approval)
python3 -m unittest discover -s tests -p 'test_*.py'   # MSIX extractor (synthetic packages)
./tests/test_manus_recipe.sh                           # Manus recipe, offline, throwaway HOME
./test_e2e.sh                                          # Qwen pipeline (downloads)
```

---

## Qwen Desktop

### ⚖️ Legal Disclaimer & Notice of Non-Affiliation

1. **Non-Affiliation:** This project is an independent research and interoperability tool developed by **ISyCo Labs**. It is **NOT** affiliated with, endorsed by, sponsored by, or associated in any way with **Alibaba Group**, **Alibaba Cloud**, or the **Qwen** development team.
2. **Trademark Notice:** "Qwen", "Alibaba", and all related names, marks, emblems, and images are registered trademarks of their respective owners.
3. **Zero Redistribution Policy:** This repository contains **ONLY original open-source automation scripts and text patches**. It does **NOT** contain, redistribute, or mirror any proprietary binaries (`.exe`, `.asar`), compiled Electron runtimes, application assets, or copyrighted iconography belonging to Alibaba.
4. **User Compliance:** All upstream files are fetched directly by the end-user from official Alibaba servers (`download.qwen.ai`) on demand. Users must review and comply with Qwen's official [Terms of Service](https://chat.qwen.ai/) and software license agreements before downloading and running the client.
5. **Distribution Status:** This repository is **publicly available** on GitHub as an open-source research pipeline. The code is published under the MIT license for transparency and community review.

---

### 🔍 Background & Architecture

Official public releases of Qwen Desktop currently target Windows and macOS. Reverse engineering and static analysis via REA (*Reverse Engineer Anything*) demonstrated that:
* The Windows client is packaged as an Electron v35.1.4 application.
* The application code contains **zero native C++ binary addons (`.node`)**; all logic is 100% portable JavaScript and standard web APIs.
* The only barrier preventing execution on Linux was an artificial platform check in `out/main/index.js` that threw `Unsupported platform: linux`, combined with a Windows-only auto-updater feed.

The **Qwen Linux Transmuter** automates the local adaptation on the user's machine:
```
[Official Windows .exe]
          │
          ▼  (Local extraction in user scratchpad)
[resources/app.asar]
          │
          ▼  (Local AST/regex patching via lib/patcher.py)
[Linux-Enabled app/] + [Official Native Linux Electron v35.1.4]
          │
          ▼  (Wire local MCP shims for bun / uv)
[Native Linux Desktop Application in ~/.local/share/qwen-desktop]
```

For the complete technical report, see [docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md).

---

### 🛡️ Security & Integrity (Fail-Closed)

To prevent supply-chain tampering and unexpected upstream payload drift, the pipeline enforces strict SHA-256 hash validation:

| Target | Upstream Source | Pinned SHA-256 |
|---|---|---|
| **Qwen Windows Installer v1.0.3.44** | `download.qwen.ai` | `393e4669402e48f3fa6cffd0ebaadfe597b06fb26a11b6aaf03f7ee74df26e60` |
| **Electron Runtime v35.1.4 (Linux x64)** | `github.com/electron/electron` | `19a6b1a90bb9c13ad5ba1dcb8ebe1b98d9f8b8488e7731e56199c2a4971d7b47` |

If any file hash does not match the pinned ledger, the pipeline **fails closed**, aborts immediately, and initiates an automatic rollback without altering existing configurations.

**Additional Hardening:**
* The patcher (`lib/patcher.py`) fails if no modifications are applied (prevents silent no-op patches).
* E2E tests run in fully isolated temporary directories — **never touching your real installation**.
* Launcher sandbox mode is configurable (`--no-sandbox` flag).

---

### 🚀 Quickstart

### Prerequisites
* Linux (x86_64, tested on Ubuntu 24.04 LTS).
* `python3`, `curl`, `unzip`, `sha256sum`.
* `wine` (for headless NSIS extraction) and `bunx` / `npx` (for ASAR extraction).
* *(Optional, for MCP tool calling)*: `bun` and `uv` / `uvx` in your host `$PATH`.

### Installation

1. **Option A: Transmute an existing downloaded installer:**
   ```bash
   ./qwen-transmute.sh ~/Descargas/Qwen-1.0.3.44-release-win-x64.exe
   ```

2. **Option B: Automatically download and verify the official release:**
   ```bash
   ./qwen-transmute.sh --download
   ```

3. **Option C: Run End-to-End (E2E) verification after transmuting:**
   ```bash
   ./qwen-transmute.sh --download --test-e2e
   ```

4. **Option D: Enable full sandboxing (requires AppArmor profile):**
   ```bash
   ./qwen-transmute.sh --download --test-e2e --no-sandbox
   ```

### Launching Qwen
Once transmutation is complete:
* **From Terminal:**
  ```bash
  qwen
  ```
* **From Desktop:** Open your application launcher and search for **"Qwen"**.

---

### 🔒 Modern Linux Sandbox & AppArmor Notice

Ubuntu 24.04+ restricts unprivileged user namespaces via AppArmor (`kernel.apparmor_restrict_unprivileged_userns = 1`). As a result, standard Electron applications require either:
1. Running with `--no-sandbox` (configured automatically in `~/.local/bin/qwen` by default), or
2. Registering an AppArmor profile in `/etc/apparmor.d/qwen` permitting unprivileged user namespace creation.

**To enable full sandboxing:**
```bash
# 1. Create AppArmor profile (one-time setup, requires sudo)
sudo tee /etc/apparmor.d/qwen << 'EOF'
#include <tunables/global>
profile qwen /home/*/.local/share/qwen-desktop/qwen {
  #include <abstractions/base>
  #include <abstractions/fonts>
  capability setuid,
  capability setgid,
  network inet,
  network inet6,
  unix (send, receive),
  /home/*/.local/share/qwen-desktop/** r,
  /home/*/.config/Qwen/** rwk,
  /home/*/.cache/qwen-transmuter/** r,
  owner /home/*/.local/share/qwen-desktop/qwen ix,
  owner /home/*/.local/share/qwen-desktop/** m,
  owner /tmp/** rw,
  owner /run/user/*/wayland* rw,
  owner @{PROC}/[0-9]*/** r,
  # Allow unprivileged user namespaces for Electron sandbox
  namespace unprivileged,
}
EOF

# 2. Load profile
sudo apparmor_parser -r /etc/apparmor.d/qwen

# 3. Re-run transmuter with --no-sandbox flag (disables the launcher's --no-sandbox)
./qwen-transmute.sh --download --test-e2e --no-sandbox
```

---

### 🧪 E2E Test Suite

A standalone test suite is provided to verify idempotency, clean uninstallation, and canary startup. **Tests run in isolated temporary directories and NEVER touch your real `~/.local/share/qwen-desktop` or `~/.local/bin/qwen`.**

```bash
./test_e2e.sh
```

---

### 🗑️ Clean Uninstallation

The transmuter provides a clean uninstallation flag that removes the native runtime, launcher, and desktop shortcut while **strictly preserving** your user data, login sessions, and chat history in `~/.config/Qwen`:
```bash
./qwen-transmute.sh --uninstall
```

---

### 📦 AppImage Support

> **Status:** Not yet implemented in the published pipeline. The reverse engineering report documents successful manual AppImage builds (171 MB self-contained bundle). A future PR will add `./qwen-transmute.sh --appimage` to generate a distributable AppImage artifact.

---

---

## 📄 License

This transmutation pipeline and documentation are licensed under the [MIT License](LICENSE).
