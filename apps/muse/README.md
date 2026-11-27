# Muse (Meta) — native Linux protocol client

**App**: Muse, Meta's assistant (bundle `com.meta.endo`; internal codenames in
flight: Endo / Hatch / Proton / ecto1 / Tigon). The desktop artefact is a
macOS-NATIVE SwiftUI + Rust binary — **NOT Electron** — so the classic lAInux
asar-swap recipe does not apply (79 dylibs, Metal, SwiftUI: no `app.asar`).

**Route** (decided 2026-11-27, after isolating-installer inspection): build a
**native Linux protocol client** that logs in via the same `auth.meta.com`
OIDC dance and talks to the same endpoints as the official web app
(`https://muse.ai`, 302 from `agent.meta.ai`), whose realtime surface is
WebSocket (`wss://edge-chat-latest.meta.ai` & co) instead of the desktop
binary's native MQTT/MSYS. The DMG never becomes the runnable: it stays an RE +
asset (icon) reference on the user's disk, hash-pinned, fail closed.

Full evidence pack: `docs/PROTOCOL.md` (endpoints, headers, auth flow,
attestation risk, repro commands).

| Phase | State |
|---|---|
| `verify` (DMG pin) | DONE — Muse-14.1 sha256 pinned in `pins.env` |
| `inspect` (RE extraction) | DONE — findings land in the lAInux cache + `docs/PROTOCOL.md` |
| web-traffic capture (muse.ai logged-in) | NEXT — ground truth for request shapes |
| `build` / `install` | NOT YET — fails closed until protocol RE gate passes |
| WINS Mach-O re-host of the real binary | PARKED — DS3-scale (SwiftUI surface); see PROTOCOL.md §8 |

## Usage

```bash
./transmute.sh muse inspect [path/to/Muse-14.1.dmg]   # verify pin + extract + strings + dylibs
./transmute.sh muse verify [path/to/Muse-14.1.dmg]   # pin check only
```
