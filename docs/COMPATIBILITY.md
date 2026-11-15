# Compatibility and evidence

**Snapshot:** 2026-11-14 · **six recipes in the repository** · **not six claims of complete feature parity**.

This is a public status ledger for the recipes in `apps/`. A committed recipe, an offline test, a rendered desktop window and a full interactive workflow answer **different questions**. Do not collapse them into one "works 100%" number.

## Application matrix

| App | Linux strategy | What is documented or demonstrated | Known gaps / next gate | Primary evidence |
|---|---|---|---|---|
| **Qwen Desktop** | Extract NSIS; patch platform gate and updater; Linux Electron 35 + native MCP tools | Linux startup, desktop integration, MCP runtime wiring are described in the reverse-engineering report | Verify current upstream release; automated AppImage packaging is not part of the published recipe; review Electron sandbox configuration | [Qwen report](REVERSE_ENGINEERING.md), [recipe](../apps/qwen/transmute.sh) |
| **Manus Desktop** | Linux Electron 43 + native modules; WINS and Wine-assisted Windows companion bridges | Install and companion adaptation path documented; an offline recipe test exists | Full operator, browser and sign-in workflows need independent end-to-end evidence; requires WINS | [Manus guide](../apps/manus/README.md), [offline test](../tests/test_manus_recipe.sh) |
| **Dola** | Vendor `biz.pak` UI on original lAInux Electron host | UI and network messages are documented; third-party browser login recorded with a real account in the app guide | Some native popup/`chrome://` views and associated controls are not yet implemented; chat input must be retested on affected setups | [Dola guide](../apps/dola/README.md), [recipe](../apps/dola/transmute.sh) |
| **Gemini desktop** | Original `app.asar` on matching Linux Electron 44; Windows native addon falls back | App startup, Google sign-in and chat are documented as verified on 2026-11-14 | Windows-only helper features (Alt+Space, selection/foreground context), Crashpad and automatic updates | [Gemini guide](../apps/gemini/README.md), [recipe](../apps/gemini/transmute.sh) |
| **Doubao 豆包** | Pinned official package; vendor `biz.pak` UI on shared Dola/lAInux host | Extraction, version/hash ledger and install recipe are in the repository; offline recipe test exists | **Interactive authentication and end-to-end chat are not established by the published evidence**; Chinese phone/Douyin login may be necessary | [recipe](../apps/doubao/transmute.sh), [pins](../apps/doubao/pins.env), [offline test](../tests/test_doubao_recipe.sh) |
| **Kimi + Kimi Work** | Original `app.asar` on matching Linux Electron 43; Kimi Work's daimon (JavaScript) assembled with Linux CPython 3.12, uv and jieba, run by Kimi's Electron as Node | On 2026-11-14 the owner signed in with Google (the app opens the default browser and receives the callback on 127.0.0.1), chatted in Chat, and Kimi Work's daimon reached `ready` with the Work home rendered | Kimi Claw (`gateway.asar`: Windows-only sharp/node-pty/canvas/sqlite-vec/koffi builds) and the Windows helpers `kimi-webbridge`, `kimi-slides`, `kimiim-cli`; the 8 `kimi-*.node` desktop addons (screen capture, OCR, global input…) are Windows builds; a Work task end to end is not yet recorded | [Kimi guide](../apps/kimi/README.md), [recipe](../apps/kimi/transmute.sh), [offline test](../tests/test_kimi_recipe.sh) |

### Status interpretation

- **Recipe present:** repository includes the files to attempt the conversion. This does not mean launch or login passed.
- **Offline tested:** test scripts verify selected extraction, pinning, installation or uninstall contracts. They do not test the vendor's live backend.
- **Application demonstrated:** a specific workflow was exercised and described. It is not proof of every menu, input method or environment.
- **Not verified:** no reproducible evidence in this repository for that capability; do not infer success from a screenshot of another feature.

This ledger summarizes evidence already documented in the repository. It is **not** a claim that every test was rerun when this page was written.

## Reproduction checklist for a new application

1. Record exact upstream version, source URL, checksum source and SHA-256 of each input; refuse a mismatch.
2. Run the recipe in a disposable `HOME` with existing-install rollback checked.
3. Verify that the native Linux process starts without a blank or crashed window.
4. Separately record **login**, **text input**, **response rendering**, **file/desktop tools**, **relaunch** and **uninstall preserves profile**.
5. Record any Windows helper, Wine/WINS dependence or `--no-sandbox` requirement visibly.
6. Save failure logs with credentials, tokens and cookies redacted. Distinguish **DEMONSTRATED / INFERRED / NOT_DEMONSTRATED** rather than guessing.

Suggested offline checks from the repository root:

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
./tests/test_dola_recipe.sh
./tests/test_doubao_recipe.sh
./tests/test_gemini_recipe.sh
./tests/test_kimi_recipe.sh
./tests/test_manus_recipe.sh
# Qwen: networked end-to-end pipeline (downloads upstream assets)
./test_e2e.sh
```

For broader architecture and the precise limits of "native", see [Architecture](ARCHITECTURE.md).
