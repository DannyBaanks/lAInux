#!/usr/bin/env bash
# Offline checks of the Gemini recipe: fail-closed input pinning, uninstall
# keeps the signed-in profile, and a .desktop entry claims no URL scheme the app
# does not register. Everything runs under a throwaway HOME; nothing real is touched.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T=$(mktemp -d -t corpus-gemini-XXXXXX)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "[PASS] $*"; pass=$((pass+1)); }
bad() { echo "[FAIL] $*"; fail=$((fail+1)); }

export HOME="$T/home"; mkdir -p "$HOME/.config/gemini"
echo keep > "$HOME/.config/gemini/marker"
command -v 7z >/dev/null 2>&1 || command -v 7zz >/dev/null 2>&1 || {
    mkdir -p "$T/bin"; printf '#!/bin/sh\nexit 0\n' > "$T/bin/7z"; chmod +x "$T/bin/7z"; export PATH="$T/bin:$PATH"; }

# 1. A package whose hash is not pinned stops the pipeline before any write.
head -c 4096 /dev/urandom > "$T/gemini.crx3"
out=$("$ROOT/transmute.sh" gemini --crx "$T/gemini.crx3" --dest "$HOME/dest" 2>&1); rc=$?
if (( rc != 0 )) && grep -q 'FAIL CLOSED' <<<"$out" && [[ ! -e "$HOME/dest" ]] \
   && [[ -z "$(find "$HOME" -maxdepth 3 -name '.gemini-desktop.stage-*' 2>/dev/null)" ]]; then
    ok "unpinned package fails closed, nothing written"
else bad "unpinned package (rc=$rc): $out"; fi

# 2. Uninstall removes the install and launchers, keeps the profile.
mkdir -p "$HOME/.local/share/gemini-desktop" "$HOME/.local/bin" "$HOME/.local/share/applications"
touch "$HOME/.local/bin/gemini-desktop" "$HOME/.local/share/applications/gemini-desktop.desktop"
"$ROOT/transmute.sh" gemini --uninstall >/dev/null 2>&1
if [[ ! -e "$HOME/.local/share/gemini-desktop" && ! -e "$HOME/.local/bin/gemini-desktop" \
      && ! -e "$HOME/.local/share/applications/gemini-desktop.desktop" && -f "$HOME/.config/gemini/marker" ]]; then
    ok "uninstall keeps ~/.config/gemini"
else bad "uninstall"; fi

# 3. A .desktop entry without a scheme has no MimeType; with one, it claims it.
(
    # shellcheck source=../lib/common.sh
    source "$ROOT/lib/common.sh"
    write_desktop_entry "$T/a.desktop" A c /bin/true i.png a "" "Utility;" >/dev/null
    write_desktop_entry "$T/b.desktop" B c /bin/true i.png b dola "Utility;" >/dev/null
)
if ! grep -q MimeType "$T/a.desktop" && grep -qx 'MimeType=x-scheme-handler/dola;' "$T/b.desktop"; then
    ok "MimeType only for apps with a URL scheme"
else bad "desktop entry MimeType: $(cat "$T/a.desktop" "$T/b.desktop")"; fi

# 4. Pins are SHA-256 and the package URL is Google's download host over https.
source "$ROOT/apps/gemini/pins.env"
if [[ "$GEMINI_CRX_SHA256" =~ ^[0-9a-f]{64}$ && "$ELECTRON_SHA256" =~ ^[0-9a-f]{64}$ \
      && "$GEMINI_CRX_URL" == https://dl.google.com/* ]]; then
    ok "Gemini pins well-formed"
else bad "Gemini pins"; fi

echo "passed=$pass failed=$fail"
(( fail == 0 ))
