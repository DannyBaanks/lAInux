#!/usr/bin/env bash
# Offline checks of the Manus recipe: fail-closed input pinning, uninstall
# keeps the profile, and the corpus tracks no upstream binary.
# Everything runs under a throwaway HOME; nothing real is touched.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T=$(mktemp -d -t corpus-manus-XXXXXX)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "[PASS] $*"; pass=$((pass+1)); }
bad() { echo "[FAIL] $*"; fail=$((fail+1)); }

export HOME="$T/home"; mkdir -p "$HOME/.config/Manus"
echo keep > "$HOME/.config/Manus/marker"
FAKE_WINS="$T/wins"; mkdir -p "$FAKE_WINS/bin"
printf '#!/bin/sh\nexit 0\n' > "$FAKE_WINS/bin/wins"; chmod +x "$FAKE_WINS/bin/wins"

# 1. A bundle whose hash is not pinned stops the pipeline before any write.
head -c 4096 /dev/urandom > "$T/ManusAI.Manus_9.9.9.9_neutral_~_x.Msixbundle"
out=$("$ROOT/transmute.sh" manus --wins "$FAKE_WINS" --dest "$HOME/dest" "$T/ManusAI.Manus_9.9.9.9_neutral_~_x.Msixbundle" 2>&1); rc=$?
if (( rc != 0 )) && grep -q 'FAIL CLOSED' <<<"$out" && [[ ! -e "$HOME/dest" ]] \
   && [[ -z "$(find "$HOME/.local/share" -maxdepth 1 -name '.manus-desktop.stage-*' 2>/dev/null)" ]]; then
    ok "unpinned bundle fails closed, nothing written"
else bad "unpinned bundle (rc=$rc): $out"; fi

# 2. Missing WINS is reported before the 800 MB hash.
out=$("$ROOT/transmute.sh" manus --wins "$T/nowhere" "$T/ManusAI.Manus_9.9.9.9_neutral_~_x.Msixbundle" 2>&1); rc=$?
if (( rc != 0 )) && grep -q 'WINS not found' <<<"$out"; then ok "missing WINS is reported"; else bad "missing WINS (rc=$rc): $out"; fi

# 3. Uninstall removes the install and launchers, keeps the profile.
mkdir -p "$HOME/.local/share/manus-desktop" "$HOME/.local/bin" "$HOME/.local/share/applications"
touch "$HOME/.local/bin/manus" "$HOME/.local/share/applications/manus.desktop"
"$ROOT/transmute.sh" manus --uninstall >/dev/null 2>&1
if [[ ! -e "$HOME/.local/share/manus-desktop" && ! -e "$HOME/.local/bin/manus" && -f "$HOME/.config/Manus/marker" ]]; then
    ok "uninstall keeps ~/.config/Manus"
else bad "uninstall"; fi

# 4. The corpus tracks no upstream binary.
bins=$(cd "$ROOT" && git ls-files | grep -iE '\.(exe|dll|asar|msix|msixbundle|appx|node|zip|tgz|7z|appimage|deb|rpm)$' || true)
if [[ -z "$bins" ]]; then ok "no upstream binaries tracked"; else bad "tracked binaries: $bins"; fi

# 5. Every pin is a 64-hex SHA-256.
badpins=$(grep -hE '_SHA256=' "$ROOT"/apps/*/pins.env | grep -vE '="[0-9a-f]{64}"' || true)
if [[ -z "$badpins" ]]; then ok "pins are SHA-256"; else bad "malformed pins: $badpins"; fi

echo "passed=$pass failed=$fail"
(( fail == 0 ))
