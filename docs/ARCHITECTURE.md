# lAInux architecture

lAInux is a **recipe corpus**, not a Windows emulator or a single universal binary converter. Each recipe is an auditable way to assemble a Linux desktop application from vendor-supplied inputs **on the user's own computer**.

## The pipeline

```text
Official vendor package / user-supplied installer
                 |
          pins.env + hashes
                 |
        verify (fail closed)
                 |
       temporary staging tree
                 |
  extract + adapt only what is needed
                 |
   Linux runtime / original host shim
                 |
   smoke checks + transactional install
                 |
  user-space launcher + desktop entry
```

The repository does not ship upstream proprietary `.exe`, `.msix`, `.asar`, `.pak`, icons or Electron binaries. Vendor licensing and terms still apply when users fetch and run them.

## Components

| Component | Responsibility |
|---|---|
| `transmute.sh` | Discover and dispatch recipes under `apps/<name>/transmute.sh`. |
| `apps/<name>/pins.env` | Fix expected versions and hashes for downloaded or supplied inputs. |
| `lib/common.sh` | Shared verification, download and desktop-install routines. |
| `lib/msix.py`, `lib/asar.py`, `lib/patcher.py`, `lib/pak.py` | Format extraction and targeted transformations. |
| `apps/dola/host/` | Original Linux Electron host consumed by both Dola and Doubao. |
| `WINS` (separate project) | Required for Manus's Windows-only companion programs; not used as the main runtime for Qwen, Dola, Doubao or Gemini. |
| `tests/` | Offline recipe and synthetic parser checks; app-level interactive checks remain separate. |

## Five different adaptation paths

- **Qwen:** unpack a Windows Electron installer; patch platform-specific JavaScript; use the matching Linux Electron runtime and Linux-hosted MCP executables.
- **Manus:** run the original Electron archive on Linux, substitute native addons where needed, and rehost Windows-specific companions using WINS and some Wine-backed bridges. **Hybrid**, not fully Wine-free.
- **Dola:** extract the vendor UI bundle from the user's own package and serve it with the original lAInux host on Linux Electron. Its browser login and desktop UI require dedicated integration.
- **Gemini desktop:** preserve Google's `app.asar` byte-for-byte on matching Linux Electron; Windows-native desktop helpers fall back or remain unavailable.
- **Doubao:** verify the vendor package, extract its `biz.pak` UI and use the same lAInux host as Dola with a different brand and upstream origin. Account sign-in must be checked separately.

## What the guarantees do—and do not—mean

- **Pinned hashes** detect unexpected input changes; they do not prove that the upstream publisher or download endpoint is trustworthy.
- **Staging and rollback** help protect existing installations; test all destructive paths with a throwaway `HOME` before relying on them.
- **Keeping profiles** matters: a failed conversion or uninstall should not wipe credentials, history or session state.
- **Native Linux process** does *not* imply an application is sandboxed. In particular, Qwen's documented `--no-sandbox` default reduces Electron isolation unless the user configures an appropriate AppArmor policy.
- **Compatibility** is granular: launching a window, authenticating, sending a message, and reproducing all Windows desktop integrations are different milestones.
- **WINS and Wine are not security boundaries**; use separate isolation when running untrusted input.

See [Compatibility and evidence](COMPATIBILITY.md) for the per-application status and [Contributing a recipe](CONTRIBUTING.md) for acceptance criteria.
