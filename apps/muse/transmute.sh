#!/usr/bin/env bash
# ==============================================================================
# Summary: Muse (Meta "Muse"/Endo, macOS-NATIVE SwiftUI+Rust agent) -> native
#          Linux PROTOCOL client (lAInux corpus recipe).
#
# Input : the official macOS DMG the user downloaded from Meta
#         (Muse-14.1.dmg, pinned in pins.env).
# Output: (goal) ~/.local/share/muse-desktop - native Linux client (pinned
#         Electron runtime) that logs in via auth.meta.com and talks to the
#         same endpoints as the official muse.ai web app.
#         The DMG is NEVER the runnable: it is an RE/asset reference on the
#         user's machine. Nothing proprietary is stored in this repository.
#
# Status: v0 (2026-11-27). `verify` and `inspect` work. `build`/`install` FAIL
#         CLOSED until the protocol RE gate passes — see docs/PROTOCOL.md §8.
# ==============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORPUS_ROOT="$(cd "$APP_DIR/../.." && pwd)"
# shellcheck source=../../lib/common.sh
source "$CORPUS_ROOT/lib/common.sh"
# shellcheck source=pins.env
source "$APP_DIR/pins.env"

APP_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/lainux/muse"

usage() {
    cat <<EOF
Muse (Meta) — native Linux protocol client (v0 scaffold)

  transmute.sh muse verify   [path/to/Muse-14.1.dmg]   pin check only
  transmute.sh muse inspect  [path/to/Muse-14.1.dmg]   verify + extract + RE summary
  transmute.sh muse help

  build / install: NOT_IMPLEMENTED (protocol RE in progress; docs/PROTOCOL.md)

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

cmd_build() {
    log_err "build: NOT_IMPLEMENTED — protocol RE gate not passed yet (apps/muse/docs/PROTOCOL.md §8)."
    log_err "next steps: capture logged-in muse.ai traffic → pin request shapes → then build lands here."
    exit 3
}

cmd_install() { cmd_build; }

main() {
    local cmd="${1:-help}"
    [ $# -gt 0 ] && shift || true
    case "$cmd" in
        verify)  cmd_verify "$@" ;;
        inspect) cmd_inspect "$@" ;;
        build)   cmd_build ;;
        install) cmd_install ;;
        help|-h|--help|*) usage ;;
    esac
}

main "$@"
