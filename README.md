# Qwen Linux Transmuter 🚀

> **Automated Native Linux Packaging & Transmutation Pipeline for Qwen Desktop**  
> *Zero Proprietary Asset Redistribution · Pinned Cryptographic Verification · Native MCP Integration*

---

## ⚖️ Legal Disclaimer & Notice of Non-Affiliation

1. **Non-Affiliation:** This project is an independent research and interoperability tool developed by **ISyCo Labs**. It is **NOT** affiliated with, endorsed by, sponsored by, or associated in any way with **Alibaba Group**, **Alibaba Cloud**, or the **Qwen** development team.
2. **Trademark Notice:** "Qwen", "Alibaba", and all related names, marks, emblems, and images are registered trademarks of their respective owners.
3. **Zero Redistribution Policy:** This repository contains **ONLY original open-source automation scripts and text patches**. It does **NOT** contain, redistribute, or mirror any proprietary binaries (`.exe`, `.asar`), compiled Electron runtimes, application assets, or copyrighted iconography belonging to Alibaba.
4. **User Compliance:** All upstream files are fetched directly by the end-user from official Alibaba servers (`download.qwen.ai`) on demand. Users must review and comply with Qwen's official [Terms of Service](https://chat.qwen.ai/) and software license agreements before downloading and running the client.
5. **Distribution Status:** This repository is **publicly available** on GitHub as an open-source research pipeline. The code is published under the MIT license for transparency and community review.

---

## 🔍 Background & Architecture

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

## 🛡️ Security & Integrity (Fail-Closed)

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

## 🚀 Quickstart

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

## 🔒 Modern Linux Sandbox & AppArmor Notice

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

## 🧪 E2E Test Suite

A standalone test suite is provided to verify idempotency, clean uninstallation, and canary startup. **Tests run in isolated temporary directories and NEVER touch your real `~/.local/share/qwen-desktop` or `~/.local/bin/qwen`.**

```bash
./test_e2e.sh
```

---

## 🗑️ Clean Uninstallation

The transmuter provides a clean uninstallation flag that removes the native runtime, launcher, and desktop shortcut while **strictly preserving** your user data, login sessions, and chat history in `~/.config/Qwen`:
```bash
./qwen-transmute.sh --uninstall
```

---

## 📦 AppImage Support

> **Status:** Not yet implemented in the published pipeline. The reverse engineering report documents successful manual AppImage builds (171 MB self-contained bundle). A future PR will add `./qwen-transmute.sh --appimage` to generate a distributable AppImage artifact.

---

## 📄 License

This transmutation pipeline and documentation are licensed under the [MIT License](LICENSE).