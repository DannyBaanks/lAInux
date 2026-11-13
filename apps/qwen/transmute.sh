#!/usr/bin/env bash
# Summary: Qwen Desktop (Windows NSIS .exe -> Electron 35 on Linux, MCP via host bun/uv)
# The Qwen recipe still lives at the repository root (qwen-transmute.sh) so the
# existing launchers and links keep working.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/qwen-transmute.sh" "$@"
