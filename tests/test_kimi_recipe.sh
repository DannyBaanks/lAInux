#!/usr/bin/env bash
# Offline checks of the Kimi recipe: fail-closed input pinning, uninstall keeps
# the signed-in profile, and the Linux launchers of Kimi's Node runtime and daimon.
# Everything runs under a throwaway HOME; nothing real is touched.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T=$(mktemp -d -t corpus-kimi-XXXXXX)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "[PASS] $*"; pass=$((pass+1)); }
bad() { echo "[FAIL] $*"; fail=$((fail+1)); }

export HOME="$T/home"; mkdir -p "$HOME/.config/kimi-desktop"
echo keep > "$HOME/.config/kimi-desktop/marker"
command -v 7z >/dev/null 2>&1 || command -v 7zz >/dev/null 2>&1 || {
    mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 0\n' > "$T/bin/7z"; chmod +x "$T/bin/7z"; export PATH="$T/bin:$PATH"; }

# 1. A package whose hash is not pinned stops the pipeline before any write.
head -c 4096 /dev/urandom > "$T/kimi.exe"
out=$("$ROOT/transmute.sh" kimi --exe "$T/kimi.exe" --dest "$HOME/dest" 2>&1); rc=$?
if (( rc != 0 )) && grep -q 'FAIL CLOSED' <<<"$out" && [[ ! -e "$HOME/dest" ]] \
   && [[ -z "$(find "$HOME" -maxdepth 3 -name '.kimi-desktop.stage-*' 2>/dev/null)" ]]; then
    ok "unpinned package fails closed, nothing written"
else bad "unpinned package (rc=$rc): $out"; fi

# 2. Uninstall removes the install and launchers, keeps the profile.
mkdir -p "$HOME/.local/share/kimi-desktop" "$HOME/.local/bin" "$HOME/.local/share/applications"
touch "$HOME/.local/bin/kimi-desktop" "$HOME/.local/share/applications/kimi-desktop.desktop"
"$ROOT/transmute.sh" kimi --uninstall >/dev/null 2>&1
if [[ ! -e "$HOME/.local/share/kimi-desktop" && ! -e "$HOME/.local/bin/kimi-desktop" \
      && ! -e "$HOME/.local/share/applications/kimi-desktop.desktop" && -f "$HOME/.config/kimi-desktop/marker" ]]; then
    ok "uninstall keeps ~/.config/kimi-desktop"
else bad "uninstall"; fi

# 3. Kimi points KIMI_DESKTOP_RUNTIME_NODE at runtime/node itself: the shim must
#    run the Electron binary at the install root as Node, not loop on itself.
inst="$T/inst"; mkdir -p "$inst/resources/resources/runtime"
printf '#!/bin/sh\necho "node-ok RUN_AS_NODE=$ELECTRON_RUN_AS_NODE $*"\n' > "$inst/kimi"; chmod +x "$inst/kimi"
cp "$ROOT/apps/kimi/linux/node" "$inst/resources/resources/runtime/node"
out=$(KIMI_DESKTOP_RUNTIME_NODE="$inst/resources/resources/runtime/node" timeout 5 "$inst/resources/resources/runtime/node" -v 2>&1)
if [[ "$out" == "node-ok RUN_AS_NODE=1 -v" ]]; then
    ok "runtime/node runs the install's Electron as Node, ignoring the self-pointing variable"
else bad "runtime/node: $out"; fi

# 4. The daimon launchers hand the bundle's Linux CPython/uv to the daimon CLI.
b="$T/bundle"; mkdir -p "$b/bin" "$b/app/daimon/dist/src/runner"
cp "$ROOT/apps/kimi/linux/daimon" "$ROOT/apps/kimi/linux/kimi-daimon" "$b/bin/"
printf '#!/bin/sh\necho "$DAIMON_UV_PATH|$DAIMON_PYTHON_BASE_PATH|$*"\n' > "$T/fakenode"; chmod +x "$T/fakenode"
out=$(HOME="$T/home" timeout 5 "$b/bin/daimon" --node "$T/fakenode" control 2>&1)
if [[ "$out" == "$b/runtime/uv/uv|$b/runtime/python/cpython-3.12/bin/python3|$b/app/daimon/dist/src/runner/cli.js control serve" ]]; then
    ok "daimon control -> kimi-daimon control serve with Linux runtimes"
else bad "daimon launcher: $out"; fi

# 5. Pins are SHA-256 and the installer comes from Moonshot's CDN over https.
source "$ROOT/apps/kimi/pins.env"
good=true
for v in KIMI_EXE_SHA256 ELECTRON_SHA256 PYTHON_SHA256 UV_SHA256 JIEBA_SHA256; do
    [[ "${!v}" =~ ^[0-9a-f]{64}$ ]] || good=false
done
if $good && [[ "$KIMI_EXE_URL" == https://kimi-img.moonshot.cn/* ]]; then
    ok "Kimi pins well-formed"
else bad "Kimi pins"; fi

echo "passed=$pass failed=$fail"
(( fail == 0 ))
