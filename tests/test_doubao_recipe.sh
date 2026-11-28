#!/usr/bin/env bash
# Offline checks of the Doubao recipe: fail-closed package pinning, uninstall keeps the
# profile, pins well-formed, and the shared host knows the brand.
# Everything runs under a throwaway HOME; nothing real is touched.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T=$(mktemp -d -t corpus-doubao-XXXXXX)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "[PASS] $*"; pass=$((pass+1)); }
bad() { echo "[FAIL] $*"; fail=$((fail+1)); }

export HOME="$T/home"; mkdir -p "$HOME/.config/doubao-linux-host"
echo keep > "$HOME/.config/doubao-linux-host/marker"

# 1. A package whose hash is not pinned stops the pipeline before any write.
head -c 4096 /dev/urandom > "$T/Doubao.tar.zst"
out=$("$ROOT/transmute.sh" doubao --pkg "$T/Doubao.tar.zst" --dest "$HOME/dest" 2>&1); rc=$?
if (( rc != 0 )) && grep -q 'FAIL CLOSED' <<<"$out" && [[ ! -e "$HOME/dest" ]] \
   && [[ -z "$(find "$HOME" -maxdepth 3 -name '.doubao-desktop.stage-*' 2>/dev/null)" ]]; then
    ok "unpinned package fails closed, nothing written"
else bad "unpinned package (rc=$rc): $out"; fi

# 2. Uninstall removes the install and launchers, keeps the profile.
mkdir -p "$HOME/.local/share/doubao-desktop" "$HOME/.local/bin" "$HOME/.local/share/applications"
touch "$HOME/.local/bin/doubao" "$HOME/.local/share/applications/doubao.desktop"
"$ROOT/transmute.sh" doubao --uninstall >/dev/null 2>&1
if [[ ! -e "$HOME/.local/share/doubao-desktop" && ! -e "$HOME/.local/bin/doubao" \
      && ! -e "$HOME/.local/share/applications/doubao.desktop" && -f "$HOME/.config/doubao-linux-host/marker" ]]; then
    ok "uninstall keeps ~/.config/doubao-linux-host"
else bad "uninstall"; fi

# 3. Pins are well-formed; the package comes from Doubao's CDN over https.
source "$ROOT/apps/doubao/pins.env"
if [[ "$DOUBAO_PKG_SHA256" =~ ^[0-9a-f]{64}$ && "$DOUBAO_BIZ_PAK_SHA256" =~ ^[0-9a-f]{64}$ \
      && "$DOUBAO_PKG_MD5" =~ ^[0-9a-f]{32}$ && "$ELECTRON_SHA256" =~ ^[0-9a-f]{64}$ \
      && "$DOUBAO_PKG_URL" == https://lf-flow-web-cdn.doubao.com/* ]]; then
    ok "Doubao pins well-formed"
else bad "Doubao pins"; fi

# 4. The shared host has a doubao brand with its origin, scheme and UA token.
H="$ROOT/apps/dola/host/main.js"
if grep -q 'origin: "www.doubao.com"' "$H" && grep -q 'scheme: "doubao"' "$H" && grep -q 'uaToken: "SamanthaDoubao"' "$H"; then
    ok "host knows the doubao brand"
else bad "host brand table"; fi

echo "passed=$pass failed=$fail"
(( fail == 0 ))
