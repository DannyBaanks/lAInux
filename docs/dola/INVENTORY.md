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

## Phase 2 — what WINS x64 must grow

**Measured with the real loader (2026-11-13).** WINS branch `feat/x64-dll-loader`
(`aaf3aa0`) adds `winload64`, a multi-image x86-64 DLL loader (validated 12/12 against
Wine on synthetic DLLs). `winload64 --check` on `liblark.dll` + `sscronet.dll` (nothing
executed) maps and relocates both images and stops at **209 unresolved import slots**
(listed in `winload64_unresolved.txt`): kernel32 53, iphlpapi 32, crypt32 19, user32 18,
api-ms-win-crt-* 38, advapi32 12, ws2_32 11 (ordinals already translated), dbghelp 7,
ntdll 6, winhttp 4, and a few in vcruntime/ole/propsys/bcrypt.

The earlier name-based estimate (`tools/pe_gaps.py`, now following winrun's @import
closure: 338 present / 4 32-only / 198 missing) agrees in size; the loader's list is
the authoritative one.

Runtime features: TLS callbacks, DllMain and per-image TLS are done in winload64.
Still missing: **x64 SEH dispatch** (liblark has 408 580 `.pdata` entries; validated,
not dispatched), new threads + DLL_THREAD_ATTACH (Cronet/Rust start worker threads),
CFG is tolerated (guard check pointers stay at their in-image defaults).

## Next milestones (phase 2 proper, in WINS, own branch)

1. ~~x64 DLL load~~ **done** (WINS `aaf3aa0`): map, relocate, bind across images, TLS
   callbacks + DllMain, per-image TLS, GS TEB/PEB. SEH table registration pending.
2. ~~`liblark.dll`: call `lark_sdk_version`~~ **done** (WINS `4abfb4b`, 2026-11-13): liblark +
   sscronet run CRT init, TLS callbacks and DllMain under winload64 and
   `lark_sdk_version(&out)` returns `cd59a1aa_8.4.0`, **identical to the real Windows
   loader under Wine**. No Wine in the run. Needed: module registry (GetModuleHandle/
   GetProcAddress were stubs), Windows VM model (PartitionAlloc), futex SRW/CS/condvars/
   WaitOnAddress, UCRT startup/math/stdio, and two WINS bugs fixed (msvcrt shim used the
   SysV ABI on x86-64; printf ignored MSVC widths). 162 imports still trapped, none hit.
3. `lark_sdk_pre_init` / `lark_sdk_init_pc` with sscronet loaded; differential oracle =
   the same calls under Wine (WINS rule).
4. Sockets/TLS: ws2_32 + iphlpapi + crypt32 via winluxtrust; a login round-trip.

NOT_DEMONSTRATED: any execution of vendor code outside Wine; that the 333 "32-only"
names are complete; the protobuf command set behind `CallAsyncWithServerPB`.

## Finding 2026-11-13: Dola does not use liblark today

Running the real Dola (Wine build, hidden Xvfb, capture proxy in place of liblark.dll)
logs `BackendService::OnLoadLibraryComplete failed to load liblark: Backend is disabled
by cached configuration` and the app works fully (UI, chat, Work, login button).
`lark_sdk_init_pc` is never called; sscronet.dll is loaded by Cici.dll for networking.
So the liblark/CallAsync transport serves features ByteDance keeps off in Dola (IM,
Feishu, Office…; likely on in Chinese Doubao). The InitSDKRequest schema
(`basic.v1.InitSDKRequest`, protobuf-lite in Cici.dll, prost in liblark) was not needed.
Consequence for Plan A: the Linux host must support the "backend disabled" path first;
liblark under winload64 stays as the route for Doubao / when the backend is enabled.
