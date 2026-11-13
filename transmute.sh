#!/usr/bin/env bash
# ==============================================================================
# AI Desktop Transmuter - corpus of AI desktop apps that ship no Linux build.
#   ./transmute.sh list               apps in the corpus
#   ./transmute.sh <app> [options]    run that app's recipe (see <app> --help)
# Every recipe follows the same policy: no upstream binary in git, every input
# pinned by SHA-256 (fail closed), the user's profile is never touched.
# ==============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

list_apps() {
    local d
    for d in "$ROOT"/apps/*/; do
        d="${d%/}"
        [[ -x "$d/transmute.sh" ]] || continue
        printf '  %-10s %s\n' "$(basename "$d")" "$(sed -n 's/^# *Summary: *//p' "$d/transmute.sh" | head -n1)"
    done
}

case "${1:-}" in
    ""|-h|--help|help)
        sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'
        echo; echo "Apps:"; list_apps ;;
    list) list_apps ;;
    *)
        app="$1"; shift
        if [[ ! -x "$ROOT/apps/$app/transmute.sh" ]]; then
            echo "unknown app: $app" >&2; list_apps >&2; exit 1
        fi
        exec "$ROOT/apps/$app/transmute.sh" "$@" ;;
esac
