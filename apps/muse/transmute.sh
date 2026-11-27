#!/usr/bin/env bash
# ==============================================================================
# Summary: Muse (Meta "Muse"/Endo, macOS-NATIVE SwiftUI+Rust agent) -> native
#          Linux client (lAInux corpus recipe).
#
# Input : the official macOS DMG the user downloaded from Meta
#         (Muse-14.1.dmg, pinned in pins.env).
# Output: ~/.local/share/muse-desktop - v0 shell: the official Muse web app in
#         a hardened Electron window (pinned runtime), isolated profile
#         ~/.config/muse-desktop, launcher + icon in the app grid. The icon is
#         extracted from the user's pinned DMG at install time (never stored
#         here). The protocol-native client (edge-chat WS) grows in the same
#         shell - see docs/PROTOCOL.md §8.
#
# Status: v0.1 (2026-11-27). verify/inspect/install work. The v1 protocol
#         client is gated on the logged-in traffic capture (PROTOCOL.md §8).
# ==============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORPUS_ROOT="$(cd "$APP_DIR/../.." && pwd)"
# shellcheck source=../../lib/common.sh
source "$CORPUS_ROOT/lib/common.sh"
# shellcheck source=pins.env
source "$APP_DIR/pins.env"

APP_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/lainux/muse"
DEST="${MUSE_DEST:-${XDG_DATA_HOME:-$HOME/.local/share}/muse-desktop}"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

usage() {
    cat <<EOF
Muse (Meta) — native Linux client (v0.1 shell)

  transmute.sh muse verify   [path/to/Muse-14.1.dmg]   pin check only
  transmute.sh muse inspect  [path/to/Muse-14.1.dmg]   verify + extract + RE summary
  transmute.sh muse install                            deploy the v0 shell + icon
  transmute.sh muse help

  install: pinned Electron $ELECTRON_VERSION + client v$MUSE_CLIENT_VERSION, icon from the pinned DMG.
  Protocol-native v1: in progress — docs/PROTOCOL.md §8.

DMG discovery order: <arg> > \$MUSE_DMG > ~/Descargas/$MUSE_DMG_NAME > ~/Downloads/$MUSE_DMG_NAME.
Artifacts land in $APP_CACHE/<run>/.
EOF
}

need() { command -v "$1" >/dev/null 2>&1 || { log_err "missing command: $1"; exit 1; }; }

pin_ok() { # pin_ok <file> <expected-sha256>
    local actual
    actual="$(sha256sum "$1" | awk '{print $1}')"
    [ "$actual" = "$2" ] || { log_err "SHA-256 mismatch for $1"; log_err "  expected $2"; log_err "  got      $actual"; return 1; }
}

find_muse_dmg() {
    local p
    for p in \
        "${MUSE_DMG:-}" \
        "$HOME/Descargas/$MUSE_DMG_NAME" \
        "$HOME/Downloads/$MUSE_DMG_NAME"
    do
        [ -n "$p" ] && [ -f "$p" ] && { printf '%s' "$p"; return 0; }
    done
    return 1
}

cmd_verify() {
    local dmg="${1:-}"
    need sha256sum
    if [ -z "$dmg" ]; then
        dmg="$(find_muse_dmg)" || { log_err "DMG not found; pass the path (Muse-$MUSE_VERSION.dmg)"; exit 1; }
    fi
    log_info "verifying $dmg against pin…"
    pin_ok "$dmg" "$MUSE_DMG_SHA256" && log_ok "Muse $MUSE_VERSION DMG pinned OK ($MUSE_DMG_SHA256)"
}

cmd_inspect() {
    local dmg="${1:-}"
    local sevenz
    if [ -z "$dmg" ]; then
        dmg="$(find_muse_dmg)" || { log_err "DMG not found; pass the path (Muse-$MUSE_VERSION.dmg)"; exit 1; }
    fi
    cmd_verify "$dmg"

    sevenz="$(command -v 7zz || command -v 7z)" || { log_err "need 7zz (7-zip 24+) on PATH"; exit 1; }
    need strings; need file; need python3; need grep

    local run stamp work findings
    stamp="$(date +%Y%m%d-%H%M%S)"
    run="inspect-$MUSE_VERSION-$stamp"
    work="$APP_CACHE/$run"
    findings="$work/FINDINGS.txt"
    mkdir -p "$work"

    log_info "extracting Muse binary + Info.plist + falco events → $work"
    "$sevenz" x -y -o"$work" "$dmg" \
        "Muse Installer/Muse.app/Contents/MacOS/Muse" \
        "Muse Installer/Muse.app/Contents/Info.plist" \
        "Muse Installer/Muse.app/Contents/Resources/falco_declared_events.txt" \
        >/dev/null 2>&1
    local bin="$work/Muse Installer/Muse.app/Contents/MacOS/Muse"
    [ -f "$bin" ] || { log_err "extraction failed (Muse binary missing)"; exit 1; }
    file "$bin" | tee -a "$findings"

    log_info "strings → muse.strings.txt"
    strings -a "$bin" > "$work/muse.strings.txt"
    {
        echo "== EOF: run $run =="
        file "$bin"
        echo; echo "== endpoints (auth/proton/hatch/graph) =="
        grep -oE 'https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+' "$work/muse.strings.txt" \
            | sort -u | grep -iE 'meta\.ai|meta\.com|muse\.ai|graph|endo' || true
        echo; echo "== headers X-* =="
        grep -oE '[Xx]-[A-Za-z0-9][A-Za-z0-9-]{2,30}' "$work/muse.strings.txt" \
            | sort -u | grep -iE '^X-?(Tigon|Hatch|FB|Meta|M)' || true
        echo; echo "== hatch paths =="
        grep -oE 'hatch[a-zA-Z0-9/_.-]{0,45}' "$work/muse.strings.txt" | sort -u | head -50 || true
        echo; echo "== proton paths =="
        grep -ioE 'proton[a-z0-9/_.-]{0,40}' "$work/muse.strings.txt" | sort -u || true
        echo; echo "== falco events (from DMG file) =="
        cat "$work/Muse Installer/Muse.app/Contents/Resources/falco_declared_events.txt" 2>/dev/null || true
        echo; echo "== dylibs (LC_LOAD_*) =="
        python3 "$APP_DIR/tools/dylds.py" "$bin"
    } >> "$findings" 2>&1

    log_ok "inspect done → $findings"
    log_info "protocol analysis: apps/muse/docs/PROTOCOL.md (update it with anything new)"
}

cmd_install() {
    local dmg sevenz ez stage icondir
    require_cmds curl unzip sha256sum python3
    need grep

    dmg="$(find_muse_dmg)" || { log_err "DMG not found; it supplies the icon (pinned) — pass MUSE_DMG=<path>"; exit 1; }
    cmd_verify "$dmg"
    sevenz="$(command -v 7zz || command -v 7z)" || { log_err "need 7zz (7-zip 24+) on PATH"; exit 1; }

    log_info "provisioning pinned Electron $ELECTRON_VERSION…"
    ez="$(fetch_pinned "$ELECTRON_URL" "$ELECTRON_SHA256" "electron-v$ELECTRON_VERSION-linux-x64.zip")" || exit 1

    stage="$(mktemp -d "${TMPDIR:-/tmp}/muse-install.XXXXXX")"
    icondir="$(mktemp -d "${TMPDIR:-/tmp}/muse-icon.XXXXXX")"
    trap 'rm -rf -- "${stage:-}" "${icondir:-}"' EXIT

    log_info "unpacking Electron…"
    mkdir -p "$stage/electron"
    unzip -q "$ez" -d "$stage/electron"
    chmod +x "$stage/electron/electron"

    log_info "extracting the app icon from the pinned DMG…"
    "$sevenz" x -y -o"$icondir" "$dmg" "Muse Installer/Muse.app/Contents/Resources/AppIcon.icns" >/dev/null 2>&1
    python3 "$APP_DIR/tools/icns2png.py" \
        "$icondir/Muse Installer/Muse.app/Contents/Resources/AppIcon.icns" \
        "$stage/muse.png"

    log_info "assembling client v$MUSE_CLIENT_VERSION…"
    mkdir -p "$stage/app"
    cp -a "$APP_DIR/client/." "$stage/app/"
    cp -a "$APP_DIR/daemon" "$stage/daemon"
    cp "$stage/muse.png" "$stage/app/muse.png"
    cat > "$stage/muse" <<'WRAP'
#!/usr/bin/env bash
# Muse launcher core (generated by lainux): pinned Electron + our app dir.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/electron/electron" --no-sandbox "$HERE/app" "$@"
WRAP
    chmod +x "$stage/muse"

    mkdir -p "$(dirname "$DEST")" "$BIN_DIR" "$DESKTOP_DIR"
    if [ -d "$DEST" ]; then
        rm -rf -- "$DEST.prev"
        mv -- "$DEST" "$DEST.prev"
        log_info "previous install moved to $DEST.prev"
    fi
    mv -- "$stage" "$DEST"

    write_launcher "$BIN_DIR/muse-desktop" "$DEST" "muse" "$MUSE_TITLE"

    cat > "$DESKTOP_DIR/muse-desktop.desktop" <<EOF
[Desktop Entry]
Name=Muse
Comment=Muse (Meta) — native Linux shell (lAInux)
Exec=$BIN_DIR/muse-desktop %U
Icon=$DEST/muse.png
Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=muse-desktop
EOF
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    log_ok "desktop entry: $DESKTOP_DIR/muse-desktop.desktop"

    log_ok "Muse v$MUSE_CLIENT_VERSION installed → $DEST"
    log_info "profile (isolated): \${XDG_CONFIG_HOME:-~/.config}/muse-desktop — log in inside the window."
    log_info "v1 (protocol-native client) pending the traffic capture — docs/PROTOCOL.md §8"
}

main() {
    local cmd="${1:-help}"
    [ $# -gt 0 ] && shift || true
    case "$cmd" in
        verify)  cmd_verify "$@" ;;
        inspect) cmd_inspect "$@" ;;
        install|build) cmd_install ;;
        help|-h|--help|*) usage ;;
    esac
}

main "$@"
