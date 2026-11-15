# Contributing a lAInux recipe

lAInux accepts **portable, reviewable, user-executed transformations**. A recipe must not commit, bundle, mirror or redistribute proprietary installers, archives, embedded application code, runtime binaries or vendor icon files.

## Recipe contract

Put each application in `apps/<app>/`.

- `transmute.sh`: executable Bash entry point, beginning with `# Summary: ...`, supporting `--dest`, `--bin-dir`, `--uninstall` and `-h`.
- `pins.env`: versioned upstream URLs or documented user-provided input, expected SHA-256 checksums, provenance and a check date.
- A short `README.md`: exact upstream input, runtime strategy, what was tested, what fails and how to remove the installation.
- An **offline** regression test under `tests/`, with a throwaway `HOME`, synthetic assets where possible and explicit fail-closed behavior.

Use `lib/common.sh` and the existing archive/parsing helpers instead of duplicating installers. Inspect the official package and use the *least invasive* transformation that works. Keep the original vendor data local to the user.

## Validation gates

| Gate | Minimum evidence |
|---|---|
| Provenance | Official download location or how the user obtains the input; pinned digest; unexpected versions rejected. |
| Packaging | Deterministic output layout, launch command and desktop integration; no proprietary bytes committed. |
| Failure handling | A failed installation does not replace a working one; uninstall retains the user profile. |
| Security | No hidden privilege escalation, no unannounced telemetry changes, no credentials/cookies in logs or commits. |
| Runtime | Actual Linux launch verified separately from login, chat, tools and desktop integrations. |
| Documentation | Limits reported as **DEMONSTRATED / INFERRED / NOT_DEMONSTRATED**. Don't claim 100% parity from a startup screenshot. |

Run relevant checks:

```bash
bash -n apps/<app>/transmute.sh
python3 -m unittest discover -s tests -p 'test_*.py'
./tests/test_<app>_recipe.sh
```

Only run `./tests/test_<app>_recipe.sh` when that script exists. The root `./test_e2e.sh` is a Qwen-specific networked test and downloads vendor assets.

## Separate code review from users' installations

1. Submit changes on a branch/PR; avoid editing deployed profiles or global application binaries to validate a patch.
2. Preserve raw test outcomes, including failures and unknowns. Redact personal session data.
3. Let a reviewer decide when to merge; a recipe passing offline tests is not a release certification.
4. If an integration needs WINS, Wine or disabled Electron sandboxing, say so in the app's README. These are distinct concerns and none is an isolation guarantee.

See [Compatibility and evidence](COMPATIBILITY.md) and [Architecture](ARCHITECTURE.md) for the shared vocabulary.
