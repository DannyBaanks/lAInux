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

**Staged status (2026-11-27):** v0 shell installed — muse.ai in a hardened
Electron window (UA without the Electron token, meta-domain permission
allowlist, auth popups in-app on the same persistent partition, icon from the
DMG). v1 protocol-native: gated on the logged-in capture of muse.ai
(login OIDC dance, `wss://edge-chat-latest.meta.ai` frames, TTS stream
headers) — that capture defines request shapes for the native composer.

## 9. Device link / computer node `[CURRENT 2026-11-27]`

**Why this exists.** The web product (muse.ai) gives chat + cloud Secure VM, but
the agent only reaches *your* machine through a **paired device**. The Mac app
is that device: it signs in, enrolls a key with the user's CVM and registers as
a **node** on the CVM gateway; the agent then invokes node commands (filesystem,
Apple Notes/Mail/Calendar/Reminders/WhatsApp connectors, computer-use) with
per-action HITL approval. The web UI has **no** way to add a computer (Settings →
Dispositivos only lists the iPhone) and **no** custom-MCP connector path
(Settings → Conectores is a curated marketplace; platform.muse.ai is
submit-for-review). Linux therefore needs the node protocol implemented as a
native daemon — the "Manus companion daemon" move.

Evidence: Mac binary strings (v14.1) + muse.ai runtime JS chunks (the web client
ships a complete Noise + gateway implementation) + live settings UI (logged-in
profile snapshot, 2026-11-27).

### 9.1 Auth chain

| Piece | Value |
|---|---|
| OIDC client id | `1302642031697155` |
| Authorize | `https://auth.muse.ai/oidc/muse/` |
| Redirect | `https://muse.ai/oidc/callback` (then `hatch://` deep link) |
| PKCE | `oauth_pkce_verifier`, `oauth_csrf_token`, `code_challenge_method` |
| Web session bootstrap | `POST https://auth.meta.com/hatch/session/bootstrap/` |
| URL schemes | `hatch` (both apps), `fb1408214714122653` (iOS FB SDK) |

Web session cookies are enough for the same-origin hatch proxies below; a
daemon can reuse the shell profile or replay the OIDC flow.

### 9.2 CVM credential chain (same-origin, session cookies)

| Step | Call | Returns |
|---|---|---|
| lease | `POST /api/hatch/lease-vm {vmType}` | lease attempt (`vmId`) |
| credentials | `GET /api/hatch/cold-lease-cvm?vmId=<id>` | `{ok, session:{vmId, vmName, gatewayUrl, authToken, noiseNotaryToken, notaryTokenExpirationTs}}` |
| notary | `POST /api/hatch/noise-notary-token {vmName}` | `{notaryToken}` |
| wake | `/api/hatch/vm/wake` | (VM lifecycle) |

`gatewayUrl` host is validated to equal `vmName`. Tokens can also arrive as
`delegation.…` strings endorsed via `POST /v1/noise`.

### 9.3 Noise transport (reference implementation in the web client)

- Suite: `Noise_XX_25519_AESGCM_SHA256`; WebCrypto (`x25519_backend:
  webcrypto|libsodium`), CipherState = AES-GCM 128-bit tag, 12-byte nonce
  (4 zero + uint64 BE), HKDF-HMAC-SHA256 (`mixHash`/`mixKey`).
- Flow: msg1 (ephemeral) → msg2 (server ephemeral+static, encrypted) → msg3
  (client static + payload) → `split()` → transport keys. Attestation payload
  travels in msg2/3; SEV-SNP verifier, tiers `off|staging|prod`,
  `confidential_downgrade` / `attestation_failed` are hard failures.
- Client static key: **rvKey = derive(recoveryKey, vmId)**. Recovery key lives
  in IndexedDB `hatch-cvm-credentials/keys` (empty in the web profile → the web
  app never enrolled a CVM key; enrollment required before any gateway dial).
- Notary token: `getNoiseNotaryToken(gatewayUrl, vmName)` — cached or fetched
  from `/api/hatch/noise-notary-token`; used in the WS URL/handshake.
- WebSocket: `binaryType=arraybuffer`, URL carries `vm_id`, `auth_token`,
  `app_id`, `request_id` (+ notary for primary policy).
- Framing after handshake: HTTP-like request/response frames over Noise, with
  streaming (`streamId`, data/reset) and chunked payloads
  (`chunkId, chunkIndex, totalChunks`, ≤65489 bytes each), services (`yolk`,
  `vm-noise`, …).

### 9.4 Gateway RPC surface (from the client method table)

```
chat.subscribe / chat.stream / chat.send / chat.cancel / chat.resume /
chat.stream-events / chat.search
client.register_capabilities   /client/register-capabilities   (noiseOnly)
client.invoke.result           /client/invoke-result           (noiseOnly)
connection.ping                /api/ping                       (noiseOnly)
node.register   /api/nodes/register  (alias /nodes/register)
node.heartbeat  /api/nodes/heartbeat node.list /api/nodes/list
node.unpair /api/nodes/unpair   node.rename /api/nodes/rename
node.disconnect /api/nodes/disconnect
nodes.invoke_result /nodes/invoke-result
nodes.invoke_ack    /nodes/invoke-ack
nodes.sync          /nodes/sync
fs.* (list/read/write/search/subscribe), git.*, model.*, widgets.*,
activity.*, identity/skills/spaces/theme/navigation subscriptions
```

- **Node registration payload** (web client, verified in chunk): 
  `node.register {node_id, display_name, platform, commands_v2:{<command>:{description,…}}}`
  The web client registers itself with only `ping`; the Mac app registers its
  local connector/computer-use command surface the same way.
- **Invokes**: the gateway pushes `client.invoke {command_id, invoke_id, payload}`;
  the node replies `nodes.invoke_result {invoke_id, ok, payload_json}` (acks via
  `nodes.invoke_ack`, backfill via `nodes.sync`).
- **Device approval**: `/api/nodes/device-approval`,
  `/api/nodes/recipient-approval`, `hatch_desktop:enable_device_approval_binding`,
  `device_approval_binding`; enrollment states `UNENROLLED/ENROLLING/ENROLLED`;
  flows `enroll_new | enroll_existing | unlock | replacement`; recovery-key
  backup password errors (`ALREADY_REGISTERED`, `INVALID_PASSWORD`, …).

### 9.5 What the Mac app exposes (command surface to port)

Local connectors: **Filesystem** (list/search/read/write/create/delete),
**Apple Notes**, **Apple Mail**, **Calendar**, **Reminders**, **WhatsApp** —
each with `LocalConnectorHITL` defaults `auto_allow | always_ask`. Computer-use
commands (click/drag/type/scroll/screenshot/observe) come from the same node
dispatch (`hatch_node_operations`). A Linux daemon starts with the filesystem +
shell + screen subset.

### 9.6 Daemon plan (v2, Manus-style native system)

1. **Enrollment**: generate recovery key (X25519), dial gateway with
   `allowUnprovisionedEnrollment`, `completeProvisioning`, device approval —
   once per machine; key persists under `~/.config/muse-desktop/` (own store).
2. **Transport**: port the web client's NoiseXX + NoiseTransport to Node 24
   (native WebSocket + WebCrypto); reuse the method table above.
3. **Node**: `node.register` with `commands_v2` (fs.list/read/write/search,
   shell.exec, screen.screenshot, open_app) + heartbeat; invoke loop with HITL
   approval for writes.
4. **Acceptance**: in chat, Muse lists/reads a file under `~/Documents` and
   reports it came from the Linux computer; device appears in Settings →
   Dispositivos.

## 10. Repro

```bash
# corpus root, DMG in ~/Descargas
./transmute.sh muse inspect            # verify pin + extract + strings + dylibs → cache
./transmute.sh muse inspect ~/Descargas/Muse-14.1.dmg

# web client protocol evidence (needs a copy of the logged-in profile)
rsync -a --exclude Cache --exclude 'Code Cache' --exclude GPUCache \
  ~/.config/muse-desktop/ /tmp/opencode/muse-profile-copy/
electron --no-sandbox apps/muse/tools/webclient-dump.js \
  --profile /tmp/opencode/muse-profile-copy --out /tmp/opencode/muse-webclient
# then fetch the listed chunks and grep the Noise/node RPC code:
#   grep -l 'Noise_XX\|nodes/register\|client.invoke' /tmp/opencode/muse-webclient/*.js

# raw manual path
7zz x -so ~/Descargas/Muse-14.1.dmg "Muse Installer/Muse.app/Contents/MacOS/Muse" > /tmp/muse.bin
strings -a /tmp/muse.bin | grep -iE 'meta\.ai|auth\.meta|hatch|proton' | sort -u
python3 apps/muse/tools/dylds.py /tmp/muse.bin   # exact LC_LOAD_* table
```
