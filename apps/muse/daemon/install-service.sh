#!/usr/bin/env bash
# Install muse-node as a systemd --user service bound to the graphical session.
# - needs the graphical session: approvals are zenity dialogs and credentials
#   come from the running muse-desktop shell (the daemon retries until it is up)
# - renders absolute paths (nvm node, repo path with spaces) at install time
# usage: install-service.sh [--uninstall]
set -euo pipefail

UNIT=muse-node.service
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DAEMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f -- "$UNIT_DIR/$UNIT"
  systemctl --user daemon-reload
  echo "removed $UNIT"
  exit 0
fi

NODE="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' \
  || { echo "node >= 24 required (found $("$NODE" --version))" >&2; exit 1; }

mkdir -p -- "$UNIT_DIR"
cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=Muse Linux computer node (lAInux)
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart="$NODE" "$DAEMON_DIR/bin/muse-node" start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=graphical-session.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"
echo "installed $UNIT_DIR/$UNIT"
echo "logs: journalctl --user -u $UNIT -f"
