#!/usr/bin/env bash
# ==============================================================================
# Summary: Gemini desktop (Google's Windows package -> Electron 44 on Linux, untouched app.asar)
# Gemini desktop -> native Linux (recipe of the lAInux corpus)
#
# Input : Google's own Gemini package, fetched from dl.google.com and pinned by
#         the SHA-256 Google's update server publishes for it (or --crx FILE).
# Output: ~/.local/share/gemini-desktop - the official Linux Electron runtime
#         running Google's untouched app.asar.
#
# The Windows-only native addon (gemini_native.node: desktop helpers and the
# Windows account manager) cannot load on Linux; the app's own fallback path
# runs instead ("addon unavailable; Will use fallbacks") and Google sign-in
# happens inside the app window. Nothing proprietary is stored in this repository.
# ==============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORPUS_ROOT="$(cd "$APP_DIR/../.." && pwd)"
# shellcheck source=../../lib/common.sh
source "$CORPUS_ROOT/lib/common.sh"
# shellcheck source=pins.env
source "$APP_DIR/pins.env"

DEST="$HOME/.local/share/gemini-desktop"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
CRX=""
DO_INTEGRATE=true
FORCE=false
KEEP_PREVIOUS=false
DO_UNINSTALL=false

show_help() {
    cat <<EOF
Gemini desktop -> native Linux

Usage: $(basename "$0") [options]

  --crx FILE          use an already downloaded Gemini package (.crx3) instead
                      of fetching it (it must still match the pinned SHA-256)
  --dest DIR          install directory (default: ~/.local/share/gemini-desktop)
  --bin-dir DIR       launcher directory (default: ~/.local/bin)
  --desktop-dir DIR   .desktop directory (default: ~/.local/share/applications)
  --no-integrate      do not write the launcher and the .desktop entry
  --keep-previous     keep the replaced install as <dest>.prev
  --force             replace the install even while Gemini is running from it
  --uninstall         remove the install, launcher and .desktop entry
                      (~/.config/gemini, your signed-in profile, is kept)
  -h, --help          this help

Pinned inputs: Gemini $GEMINI_VERSION (Google package), Electron $ELECTRON_VERSION.
EOF
}

uninstall() {
    log_info "Removing $DEST, $BIN_DIR/gemini-desktop and $DESKTOP_DIR/gemini-desktop.desktop"
    rm -rf -- "$DEST"
    rm -f -- "$BIN_DIR/gemini-desktop" "$DESKTOP_DIR/gemini-desktop.desktop"
    log_ok "Gemini removed. ~/.config/gemini was not touched."
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) show_help; exit 0 ;;
        --crx) CRX="$2"; shift 2 ;;
        --dest) DEST="$2"; shift 2 ;;
        --bin-dir) BIN_DIR="$2"; shift 2 ;;
        --desktop-dir) DESKTOP_DIR="$2"; shift 2 ;;
        --no-integrate) DO_INTEGRATE=false; shift ;;
        --keep-previous) KEEP_PREVIOUS=true; shift ;;
        --force) FORCE=true; shift ;;
        --uninstall) DO_UNINSTALL=true; shift ;;
        *) log_err "Unknown argument: $1"; show_help; exit 1 ;;
    esac
done
DEST="$(realpath -m -- "$DEST")"
$DO_UNINSTALL && uninstall

# ---------------------------------------------------------------- preflight
require_cmds python3 curl sha256sum unzip
SEVENZIP=""
for c in 7zz 7z; do command -v "$c" >/dev/null 2>&1 && { SEVENZIP="$c"; break; }; done
if [[ -z "$SEVENZIP" ]]; then
    log_err "Missing 7-Zip (7zz or 7z): it unpacks Google's NSIS installer. Ubuntu: sudo apt install 7zip"
    exit 1
fi

if [[ -n "$CRX" ]]; then
    log_info "Verifying $CRX..."
    verify_sha256 "$CRX" "$GEMINI_CRX_SHA256"
else
    log_info "Fetching Gemini $GEMINI_VERSION from Google (~395 MB)..."
    CRX=$(fetch_pinned "$GEMINI_CRX_URL" "$GEMINI_CRX_SHA256" "gemini-$GEMINI_VERSION.crx3")
fi

running_from_dest() {
    local p exe
    for p in /proc/[0-9]*; do
        exe=$(readlink "$p/exe" 2>/dev/null) || continue
        [[ "$exe" == "$DEST/gemini" ]] && return 0
    done
    return 1
}
if [[ -d "$DEST" ]] && running_from_dest && ! $FORCE; then
    log_err "Gemini is running from $DEST. Close it first (or pass --force)."
    exit 1
fi

# ---------------------------------------------------------------- staging
mkdir -p "$(dirname "$DEST")"
STAGE=$(mktemp -d "$(dirname "$DEST")/.gemini-desktop.stage-XXXXXX")
PREV="$DEST.prev"
SWAPPED=false
cleanup() {
    local rc=$?
    if (( rc != 0 )); then
        log_err "Pipeline failed (exit $rc)."
        if $SWAPPED && [[ -d "$PREV" ]]; then
            log_warn "Restoring the previous install."
            rm -rf -- "$DEST"; mv -- "$PREV" "$DEST"
        fi
    fi
    rm -rf -- "$STAGE"
}
trap cleanup EXIT

# A CRX3 is a signed header followed by a zip; zipfile skips the header.
log_info "Unpacking the package..."
python3 -I - "$CRX" "$GEMINI_SETUP_NAME" "$STAGE/setup.exe" <<'EOF'
import shutil, sys, zipfile
crx, member, out = sys.argv[1:]
with zipfile.ZipFile(crx) as z, z.open(member) as src, open(out, "wb") as dst:
    shutil.copyfileobj(src, dst, 1 << 20)
EOF
RES="app-$GEMINI_VERSION/resources"
"$SEVENZIP" x -y -bso0 -bsp0 -o"$STAGE/nsis" "$STAGE/setup.exe" "$RES/*" -r >/dev/null
rm -f -- "$STAGE/setup.exe"
[[ -f "$STAGE/nsis/$RES/app.asar" ]] || { log_err "$RES/app.asar missing from Google's installer."; exit 1; }

log_info "Provisioning Electron $ELECTRON_VERSION for Linux..."
ELECTRON_ZIP=$(fetch_pinned "$ELECTRON_URL" "$ELECTRON_SHA256" "electron-v$ELECTRON_VERSION-linux-x64.zip")
APP="$STAGE/app"
mkdir -p "$APP"
unzip -q "$ELECTRON_ZIP" -d "$APP"
mv "$APP/electron" "$APP/gemini"
rm -f "$APP/resources/default_app.asar"

log_info "Installing Google's application payload (untouched)..."
cp -a "$STAGE/nsis/$RES/." "$APP/resources/"
rm -rf -- "$STAGE/nsis"
python3 -I "$CORPUS_ROOT/lib/asar.py" --extract "$APP/resources/app.asar" assets/icon.png "$APP/gemini.png"

# ---------------------------------------------------------------- swap in
log_info "Installing into $DEST..."
rm -rf -- "$PREV"
if [[ -d "$DEST" ]]; then
    mv -- "$DEST" "$PREV"
fi
SWAPPED=true
mv -- "$APP" "$DEST"
if ! $KEEP_PREVIOUS; then rm -rf -- "$PREV"; fi
SWAPPED=false
log_ok "Installed $DEST"

if $DO_INTEGRATE; then
    write_launcher "$BIN_DIR/gemini-desktop" "$DEST" gemini "$GEMINI_TITLE"
    write_desktop_entry "$DESKTOP_DIR/gemini-desktop.desktop" "$GEMINI_TITLE" "Gemini desktop (native Linux port)" \
        "$BIN_DIR/gemini-desktop" "$DEST/gemini.png" gemini "" \
        "Utility;Network;ArtificialIntelligence;"
fi

echo
log_ok "GEMINI NATIVE LINUX TRANSMUTATION COMPLETE"
echo "  install:  $DEST"
echo "  launcher: $BIN_DIR/gemini-desktop"
echo "  profile:  ~/.config/gemini (sign in once inside the app)"
