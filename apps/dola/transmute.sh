#!/usr/bin/env bash
# ==============================================================================
# Summary: Dola (your Dola install's biz.pak -> Dola's own UI on Electron 45, lAInux host, no Wine)
# Dola (international Doubao) -> native Linux (recipe of the lAInux corpus)
#
# Input : Dola's UI pack from YOUR Dola for Windows install, given as one of
#           - the install folder (contains local_webcontents/biz/biz.pak)
#           - the biz.pak file itself
#           - an AppImage that bundles a Dola install (read with unsquashfs,
#             never executed)
# Output: ~/.local/share/dola-desktop - official Linux Electron running the lAInux
#         host (apps/dola/host, original code) with Dola's own UI extracted from
#         biz.pak. Google/Apple/Facebook sign-in opens your default browser.
#
# Nothing proprietary is stored in this repository.
# ==============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORPUS_ROOT="$(cd "$APP_DIR/../.." && pwd)"
# shellcheck source=../../lib/common.sh
source "$CORPUS_ROOT/lib/common.sh"
# shellcheck source=pins.env
source "$APP_DIR/pins.env"

DEST="$HOME/.local/share/dola-desktop"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
INPUT=""
DO_INTEGRATE=true
FORCE=false
KEEP_PREVIOUS=false
DO_UNINSTALL=false
BIZ_IN_PREFIX="local_webcontents/biz/biz.pak"

show_help() {
    cat <<EOF
Dola -> native Linux

Usage: $(basename "$0") [options] [DOLA_INSTALL_DIR | biz.pak | Dola*.AppImage]

  --dest DIR          install directory (default: ~/.local/share/dola-desktop)
  --bin-dir DIR       launcher directory (default: ~/.local/bin)
  --desktop-dir DIR   .desktop directory (default: ~/.local/share/applications)
  --no-integrate      do not write the launcher and the .desktop entry
  --keep-previous     keep the replaced install as <dest>.prev
  --force             replace the install even while Dola is running from it
  --uninstall         remove the install, launcher and .desktop entry
                      (~/.config/dola-linux-host, your signed-in profile, is kept)
  -h, --help          this help

Without an input, Dola*.AppImage is looked up in ~/Applications and your
download folders. Pinned inputs: biz.pak ${DOLA_BIZ_PAK_SHA256:0:12}…, Electron $ELECTRON_VERSION.
EOF
}

uninstall() {
    log_info "Removing $DEST, $BIN_DIR/dola and $DESKTOP_DIR/dola.desktop"
    rm -rf -- "$DEST"
    rm -f -- "$BIN_DIR/dola" "$DESKTOP_DIR/dola.desktop"
    log_ok "Dola removed. ~/.config/dola-linux-host was not touched."
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) show_help; exit 0 ;;
        --dest) DEST="$2"; shift 2 ;;
        --bin-dir) BIN_DIR="$2"; shift 2 ;;
        --desktop-dir) DESKTOP_DIR="$2"; shift 2 ;;
        --no-integrate) DO_INTEGRATE=false; shift ;;
        --keep-previous) KEEP_PREVIOUS=true; shift ;;
        --force) FORCE=true; shift ;;
        --uninstall) DO_UNINSTALL=true; shift ;;
        -*) log_err "Unknown option: $1"; show_help; exit 1 ;;
        *) INPUT="$1"; shift ;;
    esac
done
DEST="$(realpath -m -- "$DEST")"
$DO_UNINSTALL && uninstall

# ---------------------------------------------------------------- preflight
require_cmds python3 curl sha256sum unzip
if [[ -z "$INPUT" ]]; then
    INPUT=$(find "$HOME/Applications" -maxdepth 1 -type f -iname 'Dola*.AppImage' 2>/dev/null | sort | tail -n 1)
    [[ -n "$INPUT" ]] || INPUT=$(find_download 'Dola*.AppImage') || {
        log_err "No Dola input given and no Dola*.AppImage found."
        log_err "Pass your Dola install folder (from Windows), its $BIZ_IN_PREFIX, or a Dola AppImage."
        exit 1
    }
    log_info "Found $INPUT"
fi
[[ -e "$INPUT" ]] || { log_err "Not found: $INPUT"; exit 1; }

running_from_dest() {
    local p exe
    for p in /proc/[0-9]*; do
        exe=$(readlink "$p/exe" 2>/dev/null) || continue
        [[ "$exe" == "$DEST/dola" ]] && return 0
    done
    return 1
}
if [[ -d "$DEST" ]] && running_from_dest && ! $FORCE; then
    log_err "Dola is running from $DEST. Close it first (or pass --force)."
    exit 1
fi

# ---------------------------------------------------------------- staging
mkdir -p "$(dirname "$DEST")"
STAGE=$(mktemp -d "$(dirname "$DEST")/.dola-desktop.stage-XXXXXX")
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

# Locate biz.pak in the input.
BIZ=""
if [[ -d "$INPUT" ]]; then
    BIZ="$INPUT/$BIZ_IN_PREFIX"
    [[ -f "$BIZ" ]] || { log_err "$INPUT is not a Dola install folder ($BIZ_IN_PREFIX missing)."; exit 1; }
elif [[ "$INPUT" == *.pak ]]; then
    BIZ="$INPUT"
elif [[ "$INPUT" == *.[Aa]pp[Ii]mage ]]; then
    require_cmds unsquashfs
    # The squashfs starts where the ELF runtime ends (section headers are last).
    OFFSET=$(python3 -I - "$INPUT" <<'EOF'
import struct, sys
h = open(sys.argv[1], "rb").read(64)
if h[:4] != b"\x7fELF" or h[4] != 2:
    sys.exit("not a 64-bit ELF AppImage")
shoff, = struct.unpack_from("<Q", h, 0x28); size, num = struct.unpack_from("<HH", h, 0x3A)
print(shoff + size * num)
EOF
)
    log_info "Reading the Dola install inside the AppImage (offset $OFFSET, not executed)..."
    LIST=$(unsquashfs -o "$OFFSET" -l "$INPUT" 2>/dev/null | grep -E "/$BIZ_IN_PREFIX\$" | head -n 1 || true)
    [[ -n "$LIST" ]] || { log_err "No $BIZ_IN_PREFIX inside $INPUT."; exit 1; }
    INNER="${LIST#squashfs-root/}"
    unsquashfs -q -o "$OFFSET" -d "$STAGE/appimage" -f "$INPUT" "$INNER" >/dev/null
    BIZ="$STAGE/appimage/$INNER"
else
    log_err "Unrecognised input: $INPUT (expected a folder, a .pak or an .AppImage)."
    exit 1
fi
log_info "Verifying biz.pak (258 MB)..."
verify_sha256 "$BIZ" "$DOLA_BIZ_PAK_SHA256"

log_info "Provisioning Electron $ELECTRON_VERSION for Linux..."
ELECTRON_ZIP=$(fetch_pinned "$ELECTRON_URL" "$ELECTRON_SHA256" "electron-v$ELECTRON_VERSION-linux-x64.zip")
APP="$STAGE/app"
mkdir -p "$APP"
unzip -q "$ELECTRON_ZIP" -d "$APP"
mv "$APP/electron" "$APP/dola"
rm -f "$APP/resources/default_app.asar"

log_info "Installing the lAInux host and extracting Dola's UI..."
mkdir -p "$APP/resources/app"
cp -a "$APP_DIR/host/." "$APP/resources/app/"
python3 -I "$CORPUS_ROOT/lib/pak.py" --extract-tree "$APP/resources/dola-ui" "$BIZ" >/dev/null
rm -rf -- "$STAGE/appimage"
[[ -f "$APP/resources/dola-ui/route.json" ]] || { log_err "biz.pak gave no route.json."; exit 1; }
ICON="$APP/resources/dola-ui/icons/512.png"
[[ -f "$ICON" ]] || ICON="$APP/resources/dola-ui/favicon-dola.png"

# ---------------------------------------------------------------- swap in
log_info "Installing into $DEST..."
rm -rf -- "$PREV"
if [[ -d "$DEST" ]]; then
    mv -- "$DEST" "$PREV"
fi
SWAPPED=true
mv -- "$APP" "$DEST"
ICON="$DEST/${ICON#"$APP"/}"
if ! $KEEP_PREVIOUS; then rm -rf -- "$PREV"; fi
SWAPPED=false
log_ok "Installed $DEST"

if $DO_INTEGRATE; then
    write_launcher "$BIN_DIR/dola" "$DEST" dola "$DOLA_TITLE"
    write_desktop_entry "$DESKTOP_DIR/dola.desktop" "$DOLA_TITLE" "Dola AI assistant (native Linux port)" \
        "$BIN_DIR/dola" "$ICON" dola-linux-host "" \
        "Utility;Network;ArtificialIntelligence;"
fi

echo
log_ok "DOLA NATIVE LINUX TRANSMUTATION COMPLETE"
echo "  install:  $DEST"
echo "  launcher: $BIN_DIR/dola"
echo "  profile:  ~/.config/dola-linux-host (Google sign-in opens your default browser)"
