#!/usr/bin/env bash
# ==============================================================================
# Summary: Manus Desktop (Microsoft Store .Msixbundle -> Electron 43 on Linux, companions re-hosted by WINS)
# Manus Desktop -> native Linux (recipe of the lAInux corpus)
#
# Input : the official Windows package the user downloaded from the Microsoft
#         Store / Manus (ManusAI.Manus_<ver>_neutral_~_<id>.Msixbundle).
# Output: ~/.local/share/manus-desktop - the Linux Electron runtime running the
#         untouched Manus app.asar, with the Windows-only companions
#         (device operator, sidecar, task panel...) re-hosted by WINS.
#
# Nothing proprietary is stored in this repository: the bundle comes from the
# user, every other input is fetched from its official source and pinned.
# ==============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORPUS_ROOT="$(cd "$APP_DIR/../.." && pwd)"
# shellcheck source=../../lib/common.sh
source "$CORPUS_ROOT/lib/common.sh"
# shellcheck source=pins.env
source "$APP_DIR/pins.env"

DEST="$HOME/.local/share/manus-desktop"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
WINEPREFIX_DIR="${WINEPREFIX:-$HOME/.wine}"
WINS_HOME="${WINS_HOME:-$HOME/Development/WINS}"
BUNDLE=""
DO_MINGIT=true
DO_INTEGRATE=true
FORCE=false
KEEP_PREVIOUS=false

show_help() {
    cat <<EOF
Manus Desktop -> native Linux

Usage: $(basename "$0") [options] [ManusAI.Manus_*.Msixbundle]

  --dest DIR          install directory (default: ~/.local/share/manus-desktop)
  --bin-dir DIR       launcher directory (default: ~/.local/bin)
  --desktop-dir DIR   .desktop directory (default: ~/.local/share/applications)
  --wins DIR          WINS checkout used to re-host the companions
                      (default: \$WINS_HOME or ~/Development/WINS)
  --wineprefix DIR    Wine prefix for the companions (default: \$WINEPREFIX or ~/.wine)
  --no-mingit         do not install MinGit + git-lfs into the Wine prefix
  --no-integrate      do not write the launcher and the .desktop entry
  --keep-previous     keep the replaced install as <dest>.prev
  --force             replace the install even while Manus is running from it
  --uninstall         remove the install, launcher and .desktop entry
                      (~/.config/Manus and the Wine prefix are kept)
  -h, --help          this help

Pinned inputs: Manus bundle $MANUS_VERSION, Electron $ELECTRON_VERSION,
node.exe $NODE_WIN_VERSION, MinGit $MINGIT_VERSION, git-lfs $GITLFS_VERSION.
EOF
}

uninstall() {
    log_info "Removing $DEST, $BIN_DIR/manus and $DESKTOP_DIR/manus.desktop"
    rm -rf -- "$DEST"
    rm -f -- "$BIN_DIR/manus" "$DESKTOP_DIR/manus.desktop"
    log_ok "Manus removed. ~/.config/Manus and $WINEPREFIX_DIR were not touched."
    exit 0
}

DO_UNINSTALL=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) show_help; exit 0 ;;
        --dest) DEST="$2"; shift 2 ;;
        --bin-dir) BIN_DIR="$2"; shift 2 ;;
        --desktop-dir) DESKTOP_DIR="$2"; shift 2 ;;
        --wins) WINS_HOME="$2"; shift 2 ;;
        --wineprefix) WINEPREFIX_DIR="$2"; shift 2 ;;
        --no-mingit) DO_MINGIT=false; shift ;;
        --no-integrate) DO_INTEGRATE=false; shift ;;
        --keep-previous) KEEP_PREVIOUS=true; shift ;;
        --force) FORCE=true; shift ;;
        --uninstall) DO_UNINSTALL=true; shift ;;
        -*) log_err "Unknown option: $1"; show_help; exit 1 ;;
        *) BUNDLE="$1"; shift ;;
    esac
done
DEST="$(realpath -m -- "$DEST")"
$DO_UNINSTALL && uninstall

# ---------------------------------------------------------------- preflight
require_cmds python3 curl sha256sum unzip tar wine winepath socat
WINS="$WINS_HOME/bin/wins"
if [[ ! -x "$WINS" ]]; then
    log_err "WINS not found at $WINS_HOME (pass --wins DIR or set WINS_HOME)."
    log_err "WINS re-hosts the Windows-only companions; Manus cannot reach your PC without it."
    exit 1
fi
command -v go >/dev/null 2>&1 || log_warn "go not found: WINS cannot build the native git/pwsh bridge (agent terminal will be slow or fail)."
command -v pwsh >/dev/null 2>&1 || log_warn "pwsh not found: the agent terminal needs PowerShell 7 for Linux (https://aka.ms/powershell)."

if [[ -z "$BUNDLE" ]]; then
    BUNDLE=$(find_download 'ManusAI.Manus_*.Msixbundle') || {
        log_err "No Manus bundle given and none found in your download folders."
        log_err "Download Manus for Windows ($MANUS_VERSION) and pass the .Msixbundle path."
        exit 1
    }
    log_info "Found $BUNDLE"
fi
log_info "Verifying the Manus bundle (this reads ~800 MB)..."
verify_sha256 "$BUNDLE" "$MANUS_BUNDLE_SHA256"

running_from_dest() {
    local p exe
    for p in /proc/[0-9]*; do
        exe=$(readlink "$p/exe" 2>/dev/null) || continue
        [[ "$exe" == "$DEST/manus" ]] && return 0
    done
    return 1
}
if [[ -d "$DEST" ]] && running_from_dest && ! $FORCE; then
    log_err "Manus is running from $DEST. Close it first (or pass --force)."
    exit 1
fi

# ---------------------------------------------------------------- staging
mkdir -p "$(dirname "$DEST")"
STAGE=$(mktemp -d "$(dirname "$DEST")/.manus-desktop.stage-XXXXXX")
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

log_info "Extracting the x64 package..."
PKG="$STAGE/pkg"
python3 -I "$CORPUS_ROOT/lib/msix.py" extract "$BUNDLE" "$PKG" --arch x64
[[ -f "$PKG/resources/app.asar" ]] || { log_err "resources/app.asar missing from the package."; exit 1; }

log_info "Provisioning Electron $ELECTRON_VERSION for Linux..."
ELECTRON_ZIP=$(fetch_pinned "$ELECTRON_URL" "$ELECTRON_SHA256" "electron-v$ELECTRON_VERSION-linux-x64.zip")
APP="$STAGE/app"
mkdir -p "$APP"
unzip -q "$ELECTRON_ZIP" -d "$APP"
mv "$APP/electron" "$APP/manus"
rm -f "$APP/resources/default_app.asar"

log_info "Installing the Manus application payload..."
cp -a "$PKG/resources/." "$APP/resources/"
rm -rf -- "$PKG"

# Native modules: Linux builds of the two addons that ship Windows-only code.
NM="$APP/resources/app.asar.unpacked/node_modules"
if [[ -f "$NM/node-pty/prebuilds/linux-x64/pty.node" ]]; then
    mkdir -p "$NM/node-pty/build/Release"
    cp -a "$NM/node-pty/prebuilds/linux-x64/pty.node" "$NM/node-pty/build/Release/pty.node"
    log_ok "node-pty: Linux prebuild bound"
else
    log_warn "node-pty Linux prebuild not found in this Manus build (terminal panes may fail)."
fi
WEBAUTHN_TGZ=$(fetch_pinned "$WEBAUTHN_URL" "$WEBAUTHN_SHA256" "beeper-webauthn-authenticator-linux-x64-gnu-$WEBAUTHN_VERSION.tgz")
mkdir -p "$NM/@beeper/webauthn-authenticator"
tar -xzf "$WEBAUTHN_TGZ" -C "$NM/@beeper/webauthn-authenticator" --strip-components=1 \
    package/webauthn_authenticator.linux-x64-gnu.node
log_ok "@beeper/webauthn-authenticator: Linux build bound"

# node.exe for the local-API bridge under Wine. The operator's addons need
# node:sqlite without a flag, which 22.11 lacks.
NODE_EXE=$(fetch_pinned "$NODE_WIN_URL" "$NODE_WIN_SHA256" "node-v$NODE_WIN_VERSION-win-x64.exe")
cp "$NODE_EXE" "$APP/resources/bin/node.exe"
log_ok "node.exe $NODE_WIN_VERSION bound"

# ---------------------------------------------------------------- WINS
log_info "Re-hosting the Windows companions with WINS ($WINS_HOME)..."
"$WINS" heal-bin "$APP" --app-id manus
"$WINS" heal-paths "$APP"

# ---------------------------------------------------------------- Wine prefix
if $DO_MINGIT; then
    MG="$WINEPREFIX_DIR/drive_c/MinGit"
    if [[ -f "$MG/cmd/git.exe" && -f "$MG/cmd/git-lfs.exe" ]]; then
        log_ok "MinGit already in the Wine prefix ($MG)"
    else
        if [[ ! -d "$WINEPREFIX_DIR/drive_c" ]]; then
            log_info "Creating Wine prefix $WINEPREFIX_DIR..."
            WINEPREFIX="$WINEPREFIX_DIR" WINEDEBUG=-all wineboot -i >/dev/null 2>&1
        fi
        MINGIT_ZIP=$(fetch_pinned "$MINGIT_URL" "$MINGIT_SHA256" "MinGit-$MINGIT_VERSION-64-bit.zip")
        GITLFS_ZIP=$(fetch_pinned "$GITLFS_URL" "$GITLFS_SHA256" "git-lfs-windows-amd64-v$GITLFS_VERSION.zip")
        mkdir -p "$MG"
        unzip -q -o "$MINGIT_ZIP" -d "$MG"
        unzip -q -o -j "$GITLFS_ZIP" '*/git-lfs.exe' -d "$MG/cmd"
        log_ok "MinGit $MINGIT_VERSION + git-lfs $GITLFS_VERSION installed in $MG (fallback git for the companions)"
    fi
fi

# ---------------------------------------------------------------- swap in
log_info "Installing into $DEST..."
rm -rf -- "$PREV"
if [[ -d "$DEST" ]]; then
    mv -- "$DEST" "$PREV"
fi
SWAPPED=true
mv -- "$APP" "$DEST"
"$WINS" port-context --app-id manus --title "$MANUS_PORT_TITLE" --install-dir "$DEST" >/dev/null \
    || log_warn "port-context failed: the agent-facing host notes (WINS-PORT.md) were not written."
if ! $KEEP_PREVIOUS; then rm -rf -- "$PREV"; fi
SWAPPED=false
log_ok "Installed $DEST"

if $DO_INTEGRATE; then
    write_launcher "$BIN_DIR/manus" "$DEST" manus "$MANUS_TITLE"
    write_desktop_entry "$DESKTOP_DIR/manus.desktop" "$MANUS_TITLE" "Manus AI Desktop (native Linux port)" \
        "$BIN_DIR/manus" "$DEST/resources/icon.png" "$MANUS_TITLE" manus \
        "Utility;Network;ArtificialIntelligence;Development;"
fi

echo
log_ok "MANUS NATIVE LINUX TRANSMUTATION COMPLETE"
echo "  install:  $DEST"
echo "  launcher: $BIN_DIR/manus"
echo "  profile:  ~/.config/Manus (untouched)"
echo "  logs:     ~/.config/Manus/logs/operator.log, ~/.cache/wins/logs/"
