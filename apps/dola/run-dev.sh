#!/bin/sh
# Dev launcher for the Dola Linux host, until the recipe pins an official Electron.
#   LAINUX_ELECTRON_DIR  an unpacked Electron runtime (default: the Qwen Desktop one)
#   DOLA_UI_DIR          the UI extracted from YOUR Dola install with lib/pak.py
# The runtime is hard-linked into ~/.cache/lainux/dola-dev-runtime with resources/app
# pointing at host/ (no vendor bytes are copied into this repository).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
RT="${LAINUX_ELECTRON_DIR:-$HOME/.local/share/qwen-desktop}"
CACHE="$HOME/.cache/lainux"
DEV="$CACHE/dola-dev-runtime"
export DOLA_UI_DIR="${DOLA_UI_DIR:-$CACHE/dola-ui}"
if [ ! -f "$DOLA_UI_DIR/route.json" ]; then
    echo "Extract the UI first:  python3 lib/pak.py --extract-tree $DOLA_UI_DIR <Dola>/local_webcontents/biz/biz.pak" >&2
    exit 2
fi
BIN=""
for b in electron qwen; do [ -x "$RT/$b" ] && BIN="$b" && break; done
[ -n "$BIN" ] || { echo "no Electron binary in $RT" >&2; exit 2; }
if [ ! -x "$DEV/$BIN" ]; then
    mkdir -p "$DEV"
    cp -al "$RT/." "$DEV/" 2>/dev/null || cp -a "$RT/." "$DEV/"
    rm -rf "$DEV/resources"
    mkdir -p "$DEV/resources"
fi
ln -sfn "$HERE/host" "$DEV/resources/app"
exec "$DEV/$BIN" --no-sandbox "$@"
