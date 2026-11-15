#!/usr/bin/env bash
# ==============================================================================
# Summary: Kimi + Kimi Work (Moonshot's Windows installer -> Electron 43 on Linux, untouched app.asar, Linux daimon runtime)
# Kimi desktop -> native Linux (recipe of the lAInux corpus)
#
# Input : Moonshot's official Windows installer, fetched from Moonshot's CDN and
#         pinned (or --exe FILE).
# Output: ~/.local/share/kimi-desktop - the official Linux Electron runtime running
#         Moonshot's untouched app.asar, with Kimi Work's local agent ("daimon",
#         JavaScript) assembled for Linux: Kimi's Electron as its Node, Linux CPython
#         and uv, Linux jieba addon, and launchers in apps/kimi/linux (original code,
#         the counterparts of the bundle's PowerShell launchers).
#
# Not on Linux yet: Kimi Claw (gateway.asar, Windows-only native modules) and the
# Windows helper programs (kimi-webbridge, kimi-slides, kimiim-cli). Nothing
# proprietary is stored in this repository.
# ==============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORPUS_ROOT="$(cd "$APP_DIR/../.." && pwd)"
# shellcheck source=../../lib/common.sh
source "$CORPUS_ROOT/lib/common.sh"
# shellcheck source=pins.env
source "$APP_DIR/pins.env"

DEST="$HOME/.local/share/kimi-desktop"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
EXE=""
DO_INTEGRATE=true
FORCE=false
KEEP_PREVIOUS=false
DO_UNINSTALL=false

show_help() {
    cat <<EOF
Kimi + Kimi Work -> native Linux

Usage: $(basename "$0") [options]

  --exe FILE          use an already downloaded Kimi installer (.exe) instead of
                      fetching it (it must still match the pinned SHA-256)
  --dest DIR          install directory (default: ~/.local/share/kimi-desktop)
  --bin-dir DIR       launcher directory (default: ~/.local/bin)
  --desktop-dir DIR   .desktop directory (default: ~/.local/share/applications)
  --no-integrate      do not write the launcher and the .desktop entry
  --keep-previous     keep the replaced install as <dest>.prev
  --force             replace the install even while Kimi is running from it
  --uninstall         remove the install, launcher and .desktop entry
                      (~/.config/kimi-desktop, your signed-in profile, and
                      ~/Documents/kimi, Kimi Work's workspace, are kept)
  -h, --help          this help

Pinned inputs: Kimi $KIMI_VERSION (installer), Electron $ELECTRON_VERSION,
CPython 3.12 ($PYTHON_TAG), uv $UV_VERSION, @node-rs/jieba-linux-x64-gnu $JIEBA_VERSION.
EOF
}

uninstall() {
    log_info "Removing $DEST, $BIN_DIR/kimi-desktop and $DESKTOP_DIR/kimi-desktop.desktop"
    rm -rf -- "$DEST"
    rm -f -- "$BIN_DIR/kimi-desktop" "$DESKTOP_DIR/kimi-desktop.desktop"
    log_ok "Kimi removed. ~/.config/kimi-desktop and ~/Documents/kimi were not touched."
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) show_help; exit 0 ;;
        --exe) EXE="$2"; shift 2 ;;
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
require_cmds python3 curl sha256sum unzip tar
SEVENZIP=""
for c in 7zz 7z; do command -v "$c" >/dev/null 2>&1 && { SEVENZIP="$c"; break; }; done
if [[ -z "$SEVENZIP" ]]; then
    log_err "Missing 7-Zip (7zz or 7z): it unpacks Moonshot's NSIS installer. Ubuntu: sudo apt install 7zip"
    exit 1
fi
command -v git >/dev/null 2>&1 || log_warn "git is not installed: Kimi Work tasks that use git will fail (the Windows package bundles its own; on Linux it is the system's)."

if [[ -n "$EXE" ]]; then
    log_info "Verifying $EXE..."
    verify_sha256 "$EXE" "$KIMI_EXE_SHA256"
else
    log_info "Fetching Kimi $KIMI_VERSION from Moonshot's CDN (~445 MB)..."
    EXE=$(fetch_pinned "$KIMI_EXE_URL" "$KIMI_EXE_SHA256" "kimi_$KIMI_VERSION.exe")
fi

running_from_dest() {
    local p exe
    for p in /proc/[0-9]*; do
        exe=$(readlink "$p/exe" 2>/dev/null) || continue
        [[ "$exe" == "$DEST/kimi" ]] && return 0
    done
    return 1
}
if [[ -d "$DEST" ]] && running_from_dest && ! $FORCE; then
    log_err "Kimi is running from $DEST. Close it first (or pass --force)."
    exit 1
fi

# ---------------------------------------------------------------- staging
mkdir -p "$(dirname "$DEST")"
STAGE=$(mktemp -d "$(dirname "$DEST")/.kimi-desktop.stage-XXXXXX")
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

# The NSIS installer carries the app as $PLUGINSDIR/app-64.7z; only its resources/
# (app.asar, its unpacked files and Kimi's own resources) is used.
log_info "Unpacking the installer..."
"$SEVENZIP" e -y -bso0 -bsp0 -o"$STAGE" "$EXE" "\$PLUGINSDIR/app-64.7z" >/dev/null
[[ -f "$STAGE/app-64.7z" ]] || { log_err "app-64.7z missing from Moonshot's installer."; exit 1; }
"$SEVENZIP" x -y -bso0 -bsp0 -o"$STAGE/pkg" "$STAGE/app-64.7z" "resources/*" >/dev/null
rm -f -- "$STAGE/app-64.7z"
PKG_RES="$STAGE/pkg/resources"
for f in app.asar resources/daimon-core.tar.gz resources/runtime/npm.asar; do
    [[ -f "$PKG_RES/$f" ]] || { log_err "resources/$f missing from Moonshot's installer."; exit 1; }
done

log_info "Provisioning Electron $ELECTRON_VERSION for Linux..."
ELECTRON_ZIP=$(fetch_pinned "$ELECTRON_URL" "$ELECTRON_SHA256" "electron-v$ELECTRON_VERSION-linux-x64.zip")
APP="$STAGE/app"
mkdir -p "$APP"
unzip -q "$ELECTRON_ZIP" -d "$APP"
mv "$APP/electron" "$APP/kimi"
rm -f "$APP/resources/default_app.asar"

log_info "Installing Moonshot's application payload (untouched)..."
cp -a "$PKG_RES/." "$APP/resources/"
rm -rf -- "$STAGE/pkg"
R="$APP/resources/resources"

# Kimi's desktop Node runtime: node/npm/npx run Kimi's Electron as Node.
cp "$APP_DIR/linux/node" "$APP_DIR/linux/npm" "$APP_DIR/linux/npx" "$R/runtime/"
chmod +x "$R/runtime/node" "$R/runtime/npm" "$R/runtime/npx"

# Kimi Work's daimon: on Windows Kimi extracts the daimon-*.tar.gz components on
# first run; elsewhere it expects them already laid out in resources/daimon-bundle.
log_info "Assembling Kimi Work's local agent (daimon) for Linux..."
PY_TGZ=$(fetch_pinned "$PYTHON_URL" "$PYTHON_SHA256" "cpython-3.12.16+$PYTHON_TAG-x86_64-unknown-linux-gnu-install_only.tar.gz")
UV_TGZ=$(fetch_pinned "$UV_URL" "$UV_SHA256" "uv-$UV_VERSION-x86_64-unknown-linux-gnu.tar.gz")
JIEBA_TGZ=$(fetch_pinned "$JIEBA_URL" "$JIEBA_SHA256" "jieba-linux-x64-gnu-$JIEBA_VERSION.tgz")
B="$R/daimon-bundle"
mkdir -p "$B/runtime/python" "$B/runtime/uv"
tar -xzf "$R/daimon-core.tar.gz" -C "$B"
rm -f -- "$B"/bin/*.cmd "$B"/bin/*.ps1
cp "$APP_DIR/linux/daimon" "$APP_DIR/linux/kimi-daimon" "$B/bin/"
chmod +x "$B/bin/daimon" "$B/bin/kimi-daimon"
tar -xzf "$PY_TGZ" -C "$B/runtime/python"
mv "$B/runtime/python/python" "$B/runtime/python/cpython-3.12"
tar -xzf "$UV_TGZ" -C "$B/runtime/uv" --strip-components=1
J="$B/app/daimon/node_modules/@node-rs"
rm -rf -- "$J/jieba-win32-x64-msvc"
mkdir -p "$J/jieba-linux-x64-gnu"
tar -xzf "$JIEBA_TGZ" -C "$J/jieba-linux-x64-gnu" --strip-components=1
# The Windows component archives are consumed above (core) or replaced (python, uv,
# git: the system git is used).
rm -f -- "$R"/daimon-*.tar.gz
for f in bin/daimon app/daimon/dist/src/runner/cli.js release/manifest.json runtime/python/cpython-3.12/bin/python3 runtime/uv/uv; do
    [[ -e "$B/$f" ]] || { log_err "daimon bundle incomplete: $f"; exit 1; }
done

ICON_IN_ASAR=$(python3 -I "$CORPUS_ROOT/lib/asar.py" --list "$APP/resources/app.asar" \
    | awk -F'\t' '{print $NF}' | grep -m1 -E '^out/renderer/assets/kimi-app-icon-[^/]*\.png$' || true)
if [[ -n "$ICON_IN_ASAR" ]]; then
    python3 -I "$CORPUS_ROOT/lib/asar.py" --extract "$APP/resources/app.asar" "$ICON_IN_ASAR" "$APP/kimi.png"
fi

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
    write_launcher "$BIN_DIR/kimi-desktop" "$DEST" kimi "$KIMI_TITLE"
    write_desktop_entry "$DESKTOP_DIR/kimi-desktop.desktop" "$KIMI_TITLE" "Kimi and Kimi Work (native Linux port)" \
        "$BIN_DIR/kimi-desktop" "$DEST/kimi.png" kimi-desktop "" \
        "Utility;Network;ArtificialIntelligence;"
fi

echo
log_ok "KIMI NATIVE LINUX TRANSMUTATION COMPLETE"
echo "  install:  $DEST"
echo "  launcher: $BIN_DIR/kimi-desktop"
echo "  profile:  ~/.config/kimi-desktop (sign in once; Google opens in your default browser)"
