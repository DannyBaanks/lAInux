#!/usr/bin/env bash
# Offline checks of the Dola recipe: fail-closed biz.pak pinning, input validation,
# uninstall keeps the signed-in profile, pins well-formed.
# Everything runs under a throwaway HOME; nothing real is touched.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T=$(mktemp -d -t corpus-dola-XXXXXX)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "[PASS] $*"; pass=$((pass+1)); }
bad() { echo "[FAIL] $*"; fail=$((fail+1)); }

export HOME="$T/home"; mkdir -p "$HOME/.config/dola-linux-host"
echo keep > "$HOME/.config/dola-linux-host/marker"

# 1. A biz.pak whose hash is not pinned stops the pipeline before any write.
head -c 4096 /dev/urandom > "$T/biz.pak"
out=$("$ROOT/transmute.sh" dola --dest "$HOME/dest" "$T/biz.pak" 2>&1); rc=$?
if (( rc != 0 )) && grep -q 'FAIL CLOSED' <<<"$out" && [[ ! -e "$HOME/dest" ]] \
   && [[ -z "$(find "$HOME" -maxdepth 3 -name '.dola-desktop.stage-*' 2>/dev/null)" ]]; then
    ok "unpinned biz.pak fails closed, nothing written"
else bad "unpinned biz.pak (rc=$rc): $out"; fi

# 2. The same pack inside an install folder is found and still fails closed.
mkdir -p "$T/Dola/local_webcontents/biz"; cp "$T/biz.pak" "$T/Dola/local_webcontents/biz/"
out=$("$ROOT/transmute.sh" dola --dest "$HOME/dest" "$T/Dola" 2>&1); rc=$?
if (( rc != 0 )) && grep -q 'FAIL CLOSED' <<<"$out"; then ok "install folder input reaches the pin check"
else bad "install folder input (rc=$rc): $out"; fi

# 3. A folder that is not a Dola install is rejected by name.
mkdir -p "$T/notdola"
out=$("$ROOT/transmute.sh" dola --dest "$HOME/dest" "$T/notdola" 2>&1); rc=$?
if (( rc != 0 )) && grep -q 'not a Dola install folder' <<<"$out"; then ok "non-Dola folder rejected"
else bad "non-Dola folder (rc=$rc): $out"; fi

# 4. Uninstall removes the install and launchers, keeps the profile.
mkdir -p "$HOME/.local/share/dola-desktop" "$HOME/.local/bin" "$HOME/.local/share/applications"
touch "$HOME/.local/bin/dola" "$HOME/.local/share/applications/dola.desktop"
"$ROOT/transmute.sh" dola --uninstall >/dev/null 2>&1
if [[ ! -e "$HOME/.local/share/dola-desktop" && ! -e "$HOME/.local/bin/dola" \
      && ! -e "$HOME/.local/share/applications/dola.desktop" && -f "$HOME/.config/dola-linux-host/marker" ]]; then
    ok "uninstall keeps ~/.config/dola-linux-host"
else bad "uninstall"; fi

# 5. Pins are SHA-256.
source "$ROOT/apps/dola/pins.env"
if [[ "$DOLA_BIZ_PAK_SHA256" =~ ^[0-9a-f]{64}$ && "$ELECTRON_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    ok "Dola pins well-formed"
else bad "Dola pins"; fi

echo "passed=$pass failed=$fail"
(( fail == 0 ))
