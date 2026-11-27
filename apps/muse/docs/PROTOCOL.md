# Muse (Meta) — artefact & protocol evidence

v0, 2026-11-27 — captured during route selection (chosen route: native protocol
client; see §8). All findings reproducible from the pinned DMGs; the /tmp
scratch used while gathering is NOT evidence, regenerate with §9.

## 1. What the artefact is (Muse-14.1.dmg, pinned)

- `Muse Installer/Muse.app`, bundle `com.meta.endo` ("EndoForMacOS"), display
  name **Muse**, version 14.1.
- Meta build: Buck2 (`FBBuildNumber 1124369063`), SDK macosx27.0, min macOS
  15.0, Sparkle updater (`SUFeedURL …facebook.com/endo/release/appcast.xml?channel=production`).
- **NOT Electron**: no `app.asar`, no Electron framework. Mach-O universal:
  x86_64 slice @0x4000 + arm64, `MH_EXECUTE` filetype=2, ncmds=106,
  `LC_MAIN` entryoff=0xc3cd40, build_version minos=15.0 sdk=27.0.
- **SwiftUI shell** (8,904 string hits) + AppKit; **Rust core** (v0-mangled
  symbols: `MsysTransport*`, `MCITransportAgnosticLoggingRoute*`,
  `hatch::attestation2v1`, proton login struct — see §2).
- 79 load-command dylibs: AppKit, SwiftUI, Metal/MetalKit/MPS, Vision, Speech,
  AVKit/AVFoundation, CallKit, EventKit/Contacts, WebKit (WKWebView —
  markdown-editor webviews), Photos/PhotosUI, ScreenCaptureKit, PDFKit,
  CryptoKit, LocalAuthentication, Network/NetworkExtension, CoreWLAN, IOKit,
  Sparkle, Swift runtime libs.
- Multibrand styling: `muse-brand-loader-middle-out.json` (Lottie v5.12.1
  loader animation) — Dola/Doubao-style brand loader.
- Internal codenames observed: Endo, Hatch, Proton (API ns), Tigon (HTTP
  client), falco (telemetry), MSYS/MCI (transport), ecto1 (CDN), heisenberg.

## 2. Endpoints from the binary (strings, 14.1)

### auth
- `https://auth.meta.com/oidc` · `/form/?form_id=1195697011444585` · `/forgot_password/` · `/hatch/session/bootstrap/`
- `https://accountscenter.meta.com/authorize?token=scripted-…` (system-webview login)
- `https://meta.graph.meta.com/oidc_callback_uri/` (callback) · `/mobileconfigsessionless` · `/webview_blobs_decrypt` · `/webview_tokens_query`
- custom schemes: `hatch://` (`hatch://frl_login`, `cvm_switch`…); app URL schemes `endo` / `endo-window`
- passkeys telemetry: `fx_meta_passkey_events`
- **login request struct fields seen next to `proton/login`**: `apiVersion`, `userAgent`, `deviceID`, `timeout` (Rust struct, verbatim run-together string in binary)

### agent / chat / config
- `https://api.meta.ai/proton/login`
- `https://api.meta.ai/proton/hatch/voice/tts/stream` (TTS streaming)
- `https://api.meta.ai/metaconfig/exposure` + `/metaconfig/metaconfig` (remote config/flags)
- `https://hatch-api.meta.ai/hatch/login` · `/hatch/help_ticket`
- `https://meta.graph.meta.com` (graph/multiagent surfaces)
- `https://agent.meta.ai/connectors/connect/` + `?settings_tab=`
- desktop realtime: **edge-mqtt with MSYS framing** (symbols `MsysEventLogSubscriber`, `CS2MQTT`, metric "Cold Start to MQTT ConnAck Latency")

### headers of interest
`X-Hatch-Notary-Authorization`, `X-Hatch-Region-Hint`, `X-Tigon-Is-Retry`,
`X-FB-*`, `X-Meta-USDID-UUID`, `X-Meta-ZCA2-Verdict`.

## 3. Web counterpart = muse.ai (LIVE, public, 2026-11-27)

- `https://agent.meta.ai/` → **302 → `https://muse.ai/`** (HTTP/2 200).
- muse.ai CSP names the web-side endpoints — this is the surface the client replicates:
  - `connect-src`: `wss://gateway.meta.ai wss://edge-chat-latest.meta.ai wss://edge-chat.meta.ai wss://shortwave.meta.ai` (+ stripe, + `ws://localhost:7700` dev)
  - `frame-src`: `https://auth.meta.com`, `*.metaaiusercontent.com`, `*.ecto1usercontent.com`, `meta-agents-apps.workers.dev`
  - `form-action`: `auth.meta.com`, `agent.meta.ai`, facebook/instagram
  - media/CDN: `*.metaaiusercontent.com`, `*.ecto1usercontent.com`
- ⇒ the web client streams chat over **WebSocket edge-chat*** (browser-grade),
  while the desktop binary keeps native MQTT/MSYS. Decision: replicate the
  **web** path; use the desktop strings as cross-reference only. Unverified
  whether edge-chat WS is MQTT-over-WS or another protocol — capture decides.

## 4. Feature surface (falco_declared_events.txt, from the DMG)

`endo_dictation*`, `endo_interactions*`, `endo_onboarding*`,
`fx_meta_passkey_events*`, `hatch_app_events` / `hatch_impressions` /
`hatch_interactions` / `hatch_install_events`,
`hatch_node_operations` (agent graph ops!), `ls_rtc_*` (voice-call sessions).
Full list via `./transmute.sh muse inspect` → cache FINDINGS file.

## 5. iOS counterpart

`~/Downloads/ipas/Muse.ipa` (131.0M), already extracted at
`~/Downloads/ipas/extracted/Muse` (`META-INF/`, `Payload/`, `iTunesMetadata.plist`).
Arm64 Mach-O + plists, same backend; expected to confirm URL schemes and maybe
carry JS/Hermes payloads. NOT inspected yet.

## 6. Personas / models

`~/Descargas/jailbreaks-main/Meta/` notes ("Muse Spark 1.3", "Muse-wonder",
"muse-ember") document the assistant personas' system prompts. Personas are
server-side: not present as plain strings in the binary. Identity/limits of
models TBD from captured traffic.

## 7. Risks / open questions

- **Notary/attestation**: Rust crate `hatch::attestation2v1` (SEV-SNP cert
  chains, transparency proofs, SnpEvidence) + header `X-Hatch-Notary-Authorization`.
  Unknown whether chat requests REQUIRE client attestation. Measure on muse.ai
  web traffic first: if the web app doesn't emit such tokens, risk is low.
- MSYS framing details (topics `/t/…`) — only needed for the desktop path;
  deprioritized in favour of edge-chat WS.
- TTS auth: session cookie vs signed URL — capture decides.
- Persona/model selection parameters — capture decides.

## 8. Chosen route (2026-11-27, Danny: "cliente nativo")

Build a **native Linux protocol client** (pinned Electron runtime, corpus
style): webview login through the real `auth.meta.com` flow, chat/TTS against
muse.ai's own endpoints, isolated profile ~`/.config/muse-desktop`, install to
`~/.local/share/muse-desktop`. Assets (launcher icon) extracted from the user's
DMG at build time, hash-pinned. The WINS Mach-O re-host of the actual binary is
**parked** (SwiftUI+AppKit+Metal surface = DS3-scale; wins-macho corpus is
CLI-only today, 19/19 Sonoma).

## 9. Repro

```bash
# corpus root, DMG in ~/Descargas
./transmute.sh muse inspect            # verify pin + extract + strings + dylibs → cache
./transmute.sh muse inspect ~/Descargas/Muse-14.1.dmg

# raw manual path
7zz x -so ~/Descargas/Muse-14.1.dmg "Muse Installer/Muse.app/Contents/MacOS/Muse" > /tmp/muse.bin
strings -a /tmp/muse.bin | grep -iE 'meta\.ai|auth\.meta|hatch|proton' | sort -u
python3 apps/muse/tools/dylds.py /tmp/muse.bin   # exact LC_LOAD_* table
```
