#!/usr/bin/env bash
# ==============================================================================
# Summary: Doubao 豆包 (official Windows package -> Doubao's own UI on Electron 45, lAInux host, no Wine)
# Doubao (ByteDance, China) -> native Linux (recipe of the lAInux corpus)
#
# Input : Doubao's official Windows package, fetched from Doubao's CDN and pinned
#         (or --pkg FILE). Only its UI pack (local_webcontents/biz/biz.pak) is used;
#         nothing in it is executed.
# Output: ~/.local/share/doubao-desktop - official Linux Electron running the lAInux
#         host (apps/dola/host, original code shared with Dola, brand "doubao") with
#         Doubao's own UI extracted from biz.pak.
#
# Nothing proprietary is stored in this repository.
# ==============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORPUS_ROOT="$(cd "$APP_DIR/../.." && pwd)"
HOST_DIR="$CORPUS_ROOT/apps/dola/host"
# shellcheck source=../../lib/common.sh
source "$CORPUS_ROOT/lib/common.sh"
# shellcheck source=pins.env
source "$APP_DIR/pins.env"

DEST="$HOME/.local/share/doubao-desktop"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
PKG=""
DO_INTEGRATE=true
FORCE=false
KEEP_PREVIOUS=false
DO_UNINSTALL=false
BIZ_IN_PKG="local_webcontents/biz/biz.pak"

show_help() {
    cat <<EOF
Doubao 豆包 -> native Linux

Usage: $(basename "$0") [options]

  --pkg FILE          use an already downloaded Doubao package (.tar.zst) instead of
                      fetching it (it must still match the pinned SHA-256)
  --dest DIR          install directory (default: ~/.local/share/doubao-desktop)
  --bin-dir DIR       launcher directory (default: ~/.local/bin)
  --desktop-dir DIR   .desktop directory (default: ~/.local/share/applications)
  --no-integrate      do not write the launcher and the .desktop entry
  --keep-previous     keep the replaced install as <dest>.prev
  --force             replace the install even while Doubao is running from it
  --uninstall         remove the install, launcher and .desktop entry
                      (~/.config/doubao-linux-host, your signed-in profile, is kept)
  -h, --help          this help

Pinned inputs: Doubao $DOUBAO_VERSION (package + its biz.pak), Electron $ELECTRON_VERSION.
EOF
}

uninstall() {
    log_info "Removing $DEST, $BIN_DIR/doubao and $DESKTOP_DIR/doubao.desktop"
    rm -rf -- "$DEST"
    rm -f -- "$BIN_DIR/doubao" "$DESKTOP_DIR/doubao.desktop"
    log_ok "Doubao removed. ~/.config/doubao-linux-host was not touched."
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) show_help; exit 0 ;;
        --pkg) PKG="$2"; shift 2 ;;
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
require_cmds python3 curl sha256sum unzip tar zstd
[[ -f "$HOST_DIR/main.js" ]] || { log_err "lAInux host missing ($HOST_DIR)."; exit 1; }

if [[ -n "$PKG" ]]; then
    log_info "Verifying $PKG (~850 MB)..."
    verify_sha256 "$PKG" "$DOUBAO_PKG_SHA256"
else
    log_info "Fetching Doubao $DOUBAO_VERSION from Doubao's CDN (~850 MB)..."
    PKG=$(fetch_pinned "$DOUBAO_PKG_URL" "$DOUBAO_PKG_SHA256" "Doubao_win_X64_$DOUBAO_VERSION-signed.tar.zst")
fi

running_from_dest() {
    local p exe
    for p in /proc/[0-9]*; do
        exe=$(readlink "$p/exe" 2>/dev/null) || continue
        [[ "$exe" == "$DEST/doubao" ]] && return 0
    done
    return 1
}
if [[ -d "$DEST" ]] && running_from_dest && ! $FORCE; then
    log_err "Doubao is running from $DEST. Close it first (or pass --force)."
    exit 1
fi

# ---------------------------------------------------------------- staging
mkdir -p "$(dirname "$DEST")"
STAGE=$(mktemp -d "$(dirname "$DEST")/.doubao-desktop.stage-XXXXXX")
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

log_info "Extracting the UI pack (only $BIZ_IN_PKG)..."
zstd -dc -- "$PKG" | tar -x -C "$STAGE" -- "$BIZ_IN_PKG"
BIZ="$STAGE/$BIZ_IN_PKG"
verify_sha256 "$BIZ" "$DOUBAO_BIZ_PAK_SHA256"

log_info "Provisioning Electron $ELECTRON_VERSION for Linux..."
ELECTRON_ZIP=$(fetch_pinned "$ELECTRON_URL" "$ELECTRON_SHA256" "electron-v$ELECTRON_VERSION-linux-x64.zip")
APP="$STAGE/app"
mkdir -p "$APP"
unzip -q "$ELECTRON_ZIP" -d "$APP"
mv "$APP/electron" "$APP/doubao"
rm -f "$APP/resources/default_app.asar"

log_info "Installing the lAInux host (brand doubao) and extracting Doubao's UI..."
mkdir -p "$APP/resources/app"
cp -a "$HOST_DIR/." "$APP/resources/app/"
printf '{"brand": "doubao"}\n' > "$APP/resources/brand.json"
python3 -I "$CORPUS_ROOT/lib/pak.py" --extract-tree "$APP/resources/doubao-ui" "$BIZ" >/dev/null 2>&1
rm -rf -- "$STAGE/local_webcontents"
[[ -f "$APP/resources/doubao-ui/route.json" ]] || { log_err "biz.pak gave no route.json."; exit 1; }
ICON="$APP/resources/doubao-ui/icons/512.png"
[[ -f "$ICON" ]] || ICON="$APP/resources/doubao-ui/favicon-doubao.png"

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
    write_launcher "$BIN_DIR/doubao" "$DEST" doubao "Doubao"
    write_desktop_entry "$DESKTOP_DIR/doubao.desktop" "$DOUBAO_TITLE" "Doubao AI assistant (native Linux port)" \
        "$BIN_DIR/doubao" "$ICON" doubao-linux-host "" \
        "Utility;Network;ArtificialIntelligence;"
fi

echo
log_ok "DOUBAO NATIVE LINUX TRANSMUTATION COMPLETE"
echo "  install:  $DEST"
echo "  launcher: $BIN_DIR/doubao"
echo "  profile:  ~/.config/doubao-linux-host"
