# Muse (Meta) — native Linux client & computer node

**App:** Muse, Meta's AI assistant (bundle `com.meta.endo`; internal codenames: Endo / Hatch / Proton / ecto1 / Tigon). Unlike the other apps in this corpus, Meta ships Muse as a **macOS-native SwiftUI + Rust binary** — **not Electron** (79 dylibs, Metal, SwiftUI, zero `app.asar`). The classic asar-swap recipe does not apply.

**How it runs on Linux:**

1. **Desktop shell (`muse-desktop`)** — hardened pinned Electron 43.6.0 window running `muse.ai` with an isolated profile (`~/.config/muse-desktop`), native dock icon extracted locally from your pinned `Muse-14.1.dmg` (`StartupWMClass=muse`), and an authenticated local broker that hands VM/chat credentials to the daemon.
2. **Native Linux computer node (`muse-node`)** — clean-room Node 24 implementation of Muse's CVM device-link protocol (`Noise_XX_25519_AESGCM_SHA256` over WebSocket, streaming RPC, protobuf chunk framing, RV enrollment, heartbeats, and `client.invoke` dispatch). Registers your Linux machine under **Settings → Devices** as `<hostname> (Linux)` and answers live invokes end to end.
3. **Fail-closed native approval (`zenity`)** — mutating commands (`files.write`, `files.mkdir`, `shell.exec`) open a native `zenity` confirmation dialog with a bounded preview of the action. The default button is **Rechazar** (an accidental Enter denies); timeout (110 s), dialog close, or missing display all deny (`permission_denied`).
4. **`systemd --user` service** — `apps/muse/daemon/install-service.sh` installs `muse-node.service` bound to `graphical-session.target`, retrying until `muse-desktop` is open.

The DMG never becomes the runnable: it stays a hash-pinned RE and icon reference on your own disk, never redistributed.

Full protocol & evidence pack: [`docs/PROTOCOL.md`](docs/PROTOCOL.md) · [`docs/evidence/2026-11-27-linux-node-invoke-acceptance.log`](docs/evidence/2026-11-27-linux-node-invoke-acceptance.log).

## Status

| Component | State |
|---|---|
| `verify` (DMG pin) | **DONE** — `Muse-14.1.dmg` SHA-256 pinned in `pins.env` |
| `inspect` (RE extraction) | **DONE** — endpoints, headers, dylibs, protocol map in `docs/PROTOCOL.md` |
| `install` (desktop shell) | **DONE** — pinned Electron 43.6.0, isolated profile, DMG icon + `StartupWMClass=muse` |
| `muse-node` (Linux computer node) | **DONE** — Noise XX transport, device registration, live `client.invoke` verified end to end |
| Native approval (`zenity`) | **DONE** — fail-closed, **Rechazar** default, preview, 110 s timeout |
| `systemd --user` service | **DONE** — `muse-node.service` with `--uninstall` |
| WINS Mach-O re-host of SwiftUI binary | **PARKED** — unnecessary once the native protocol node works; see `docs/PROTOCOL.md §8` |

## Registered Linux node commands

| Command | Approval | Notes |
|---|---|---|
| `ping` | Automatic | Liveness check (`linux`, hostname, timestamp) |
| `system.which` | Automatic | Resolve executable on `PATH` (executes nothing) |
| `files.list` | Automatic | Paginated folder listing |
| `files.search` | Automatic | Recursive name/glob search (skips hidden files) |
| `files.read` | Automatic | Paginated UTF-8 text + PNG/JPEG/GIF/WebP up to 3 MB |
| `files.write` | **Zenity prompt** | Create/overwrite UTF-8 file (120 s timeout) |
| `files.mkdir` | **Zenity prompt** | Create directory (120 s timeout) |
| `shell.exec` | **Zenity prompt** | Run `/bin/bash -lc` command (240 s timeout) |

## Usage

```bash
# 1. Install the desktop shell (uses your local Muse-14.1.dmg for the pinned icon)
./transmute.sh muse install

# 2. Launch Muse and sign in inside the window
muse-desktop

# 3. Install and start the Linux computer node as a user service (requires Node >= 24 + zenity)
./apps/muse/daemon/install-service.sh
journalctl --user -u muse-node -f

# Uninstall the service
./apps/muse/daemon/install-service.sh --uninstall

# Other recipe subcommands
./transmute.sh muse verify  [path/to/Muse-14.1.dmg]   # SHA-256 pin check only
./transmute.sh muse inspect [path/to/Muse-14.1.dmg]   # verify + extract + RE summary
```

## Tests

```bash
cd apps/muse/daemon && npm test
```

Profile (isolated): `${XDG_CONFIG_HOME:-~/.config}/muse-desktop`.
