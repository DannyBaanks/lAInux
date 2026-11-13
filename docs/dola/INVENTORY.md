# Dola (Doubao international) — port inventory

Date: 2026-11-13 · Status: phase 1 done, phase 2 = static gap map (nothing executed).
No vendor byte is in this repository; inputs are identified by SHA-256 only.

## Inputs (user-supplied, hashed)

| File | SHA-256 | Notes |
|---|---|---|
| `Dola_1635145195666449874d28_online_installer.exe` | `26f01657…278e83` | official online installer (7.7 MB); downloads the client |
| `Dola/Cici.exe` | `58ed90cf…00a6ff` | launcher (the product was "Cici" before the Dola rename) |
| `Dola/Cici.dll` | `89783328…6fb5` | 321 MB: embedded **Chromium 147.0.7727.149** + "Aha/MOA" app framework |
| `Dola/liblark.dll` | `008f7ceb…47fa8` | 170 MB Rust SDK: the whole backend (network, auth, protobuf, crypto) |
| `Dola/sscronet.dll` | `eb1dbb28…de4c` | 9.9 MB Cronet network stack used by liblark |
| `local_webcontents/biz/biz.pak` | `642524dd…74179` | 258 MB UI (biz 1.0.6.7189; apps 1.0.4.4612) |

Full hashes: `pe_gaps.json` next to this file (regenerate with `tools/pe_gaps.py`).

## Architecture (as shipped)

```
Cici.exe → Cici.dll  = Chromium 147 + Aha/MOA host ("ByteDance's Electron")
            ├─ local_webcontents/apps/entry-main, entry-moa   JS "main process"
            │     asks the host for 23 capabilities: ahalet app appConfig app-frame
            │     audio-recorder clipboard dialog domain env featureGating font fs git
            │     imageViewer ipc media navigation passport sandbox_fs security system
            │     uiState widget
            ├─ local_webcontents/biz/biz.pak  Chromium .pak v5, 10 586 resources;
            │     resource 1 = ByteDance index {entries:[{id,path}], content_hash, arch,
            │     code_cache}. Internally the app is "doubao" (ahalets/doubao/…).
            └─ liblark.dll (+ sscronet.dll)   49 C exports (lark_sdk_init_pc,
                  lark_sdk_invoke_v2, invoke_async_v2, lark_sdk_post_gateway,
                  molten_ffi_*, larkpassport_*, resource_encrypt_*); no graphics imports
```

**The UI ↔ backend funnel is small.** Every chat/server call goes through one transport
(`neotix` runtime channel, message types connect/call/notify/disconnect/push/broadcast):

| UI API | Host method |
|---|---|
| `transport.sdk.callRustApi` | `backend_liblark::CallAsync` (28 call sites) |
| `transport.server.callServerApi` | `backend_liblark::CallAsyncWithServerPB` (31 call sites) |
| `transport.encodePb` / `decodePb` | `backend_liblark::EncodePb` / `DecodePb` |
| `transport.onSdkPush` / `onServerPush` | pushes from liblark |

Other host calls seen in the UI: Lark JSBridge (`LarkWebViewJavaScriptBridge`,
`LkWebViewJavascriptBridge`), `globalThis.__office_sdk_doubao__`, 33 literal
`invoke()` names (office, workbook-link, cua, remoteControl).

## Why not the Qwen route

No `app.asar`, no `.node`: there is no Electron to swap. Running `Cici.exe` whole under
WINS means hosting a full Chromium-in-a-DLL (sandbox, ANGLE/D3D11, DirectComposition):
months. **Plan A:** Linux Chromium host + the vendor's UI and JS apps + our own
implementation of the 23 capabilities and the transport, with **`liblark.dll` executed
as-is by the WINS x64 loader** (a real vendor artifact, no Wine).

## Phase 2 — what WINS x64 must grow (static, `tools/pe_gaps.py`)

`liblark.dll` + `sscronet.dll` import 540 functions outside the pair:

| Class | Count | Meaning |
|---|---|---|
| x64 | 9 | already in the x86-64 loader (`winrun_impl.zig`) |
| 32-only | 333 | a same-named symbol exists for `winrun32` → logic to port to the x64 ABI |
| missing | 198 | nowhere in `native/*.zig` (iphlpapi 27, ws2_32 30*, crypt32 17, CRT ~38, kernel32 45…) |

\* ws2_32 is imported by ordinal (`#1`=accept…); the matcher does not translate
ordinals, so that row is overcounted (WINS has `winrun_ordinals.zig`). Name matching is
an approximation: a symbol name in WINS source is not proof of a complete implementation.

Runtime features the x64 loader lacks today (v0 = console EXE, 7 kernel32 functions):
DLL loading + calling exports, TEB/PEB via GS, **TLS callbacks** (liblark 1, sscronet 4),
**x64 SEH** (liblark has 408 580 `.pdata` entries), CFG-instrumented images
(guard flags 0x100 / 0x500), delay import (`powrprof.dll`), api-set CRT
(`api-ms-win-crt-*` → a UCRT implementation).

Reusable pieces already in WINS: `winluxtrust` (Windows cert trust → Linux CA store, what
`crypt32`'s chain checks need), `winluxhttp`, ordinals table, 32-bit kernel32/msvcrt logic.

## Next milestones (phase 2 proper, in WINS, own branch)

1. x64 DLL load: map, relocate, bind imports across images, run TLS callbacks + DllMain,
   GS-based TEB/PEB, RtlAddFunctionTable over `.pdata`. Fixture: a synthetic x64 DLL.
2. `liblark.dll`: resolve + call `lark_sdk_version` (pure, no I/O) → first proof.
3. `lark_sdk_pre_init` / `lark_sdk_init_pc` with sscronet loaded; differential oracle =
   the same calls under Wine (WINS rule).
4. Sockets/TLS: ws2_32 + iphlpapi + crypt32 via winluxtrust; a login round-trip.

NOT_DEMONSTRATED: any execution of vendor code outside Wine; that the 333 "32-only"
names are complete; the protobuf command set behind `CallAsyncWithServerPB`.
