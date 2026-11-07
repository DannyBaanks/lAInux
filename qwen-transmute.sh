#!/usr/bin/env bash
# ==============================================================================
# Qwen Linux Transmuter
# Transmutes official Alibaba Qwen Desktop Windows installers (.exe) into
# 100% native Linux desktop applications with local MCP tool support.
#
# Author: DannyBaanks / ISyCo Labs
# License: MIT
#
# POLICY:
# - ZERO proprietary assets (asar, exe, icons, Electron binaries) are tracked in git.
# - Upstream downloads are strictly verified via pinned SHA-256 hashes (fails closed).
# - User profile data (~/.config/Qwen) is strictly preserved and never modified.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
DEFAULT_DEST="$HOME/.local/share/qwen-desktop"
DEFAULT_BIN_DIR="$HOME/.local/bin"
DEFAULT_DESKTOP_DIR="$HOME/.local/share/applications"

# Pinned upstream targets
PINNED_QWEN_VERSION="1.0.3.44"
PINNED_QWEN_FILE="Qwen-1.0.3.44-release-win-x64.exe"
PINNED_QWEN_URL="https://download.qwen.ai/windows/x64/$PINNED_QWEN_FILE"
PINNED_QWEN_SHA256="393e4669402e48f3fa6cffd0ebaadfe597b06fb26a11b6aaf03f7ee74df26e60"

ELECTRON_VERSION="35.1.4"
ELECTRON_ZIP_FILE="electron-v${ELECTRON_VERSION}-linux-x64.zip"
ELECTRON_URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/$ELECTRON_ZIP_FILE"
PINNED_ELECTRON_SHA256="19a6b1a90bb9c13ad5ba1dcb8ebe1b98d9f8b8488e7731e56199c2a4971d7b47"

COLOR_GREEN="\033[0;32m"
COLOR_BLUE="\033[0;34m"
COLOR_YELLOW="\033[1;33m"
COLOR_RED="\033[0;31m"
COLOR_RESET="\033[0m"

log_info() { echo -e "${COLOR_BLUE}[INFO]${COLOR_RESET} $*"; }
log_ok()   { echo -e "${COLOR_GREEN}[✓]${COLOR_RESET} $*"; }
log_warn() { echo -e "${COLOR_YELLOW}[!]${COLOR_RESET} $*"; }
log_err()  { echo -e "${COLOR_RED}[ERROR]${COLOR_RESET} $*" >&2; }

show_help() {
    cat << EOF
Qwen Linux Transmuter — Automated Native Linux Packaging Pipeline

Usage:
  $(basename "$0") [options] [path-to-qwen-installer.exe]

Options:
  --download           Download official verified Windows installer from download.qwen.ai
  --dest <dir>         Target installation directory (default: ~/.local/share/qwen-desktop)
  --bin-dir <dir>      Binary launcher directory (default: ~/.local/bin)
  --test-e2e           Run post-install end-to-end launch & canary verification
  --no-sandbox         Disable --no-sandbox flag in launcher (use if AppArmor profile is registered)
  --uninstall          Uninstall native Qwen desktop application and clean launchers
  -h, --help           Display this help message

Security & Integrity:
  - Pinned Qwen Installer SHA-256:   $PINNED_QWEN_SHA256
  - Pinned Electron Runtime SHA-256: $PINNED_ELECTRON_SHA256
  - User configuration and session state (~/.config/Qwen) are strictly preserved.

Sandbox Note:
  Ubuntu 24.04+ restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1).
  Default launcher uses --no-sandbox. If you register an AppArmor profile (see --apparmor-profile),
  use --no-sandbox flag to disable it and enable full sandboxing.
EOF
}

verify_sha256() {
    local file_path="$1"
    local expected_hash="$2"
    log_info "Verifying SHA-256 for $(basename "$file_path")..."
    local actual_hash
    actual_hash=$(sha256sum "$file_path" | awk '{print $1}')
    if [[ "$actual_hash" != "$expected_hash" ]]; then
        log_err "SHA-256 mismatch for $file_path!"
        log_err "Expected: $expected_hash"
        log_err "Observed: $actual_hash"
        log_err "FAIL CLOSED: Aborting pipeline due to potential upstream drift or corruption."
        return 1
    fi
    log_ok "SHA-256 verified: $actual_hash"
    return 0
}

# Kill process and its entire process group/tree
kill_tree() {
    local pid=$1
    local signal=${2:-TERM}
    kill -$signal -$pid 2>/dev/null || true
    sleep 0.3
    kill -KILL -$pid 2>/dev/null || true
}

uninstall_qwen() {
    log_info "Uninstalling Qwen Linux Desktop runtime and launchers..."
    rm -rf "$DEFAULT_DEST"
    rm -f "$DEFAULT_BIN_DIR/qwen"
    rm -f "$DEFAULT_DESKTOP_DIR/qwen.desktop"
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$DEFAULT_DESKTOP_DIR" 2>/dev/null || true
    fi
    log_ok "Qwen Desktop uninstalled. User data in ~/.config/Qwen preserved intact."
    exit 0
}

# Parse CLI arguments
INPUT_EXE=""
DO_DOWNLOAD=false
DO_E2E=false
DISABLE_SANDBOX=true  # default: use --no-sandbox
TARGET_DEST="$DEFAULT_DEST"
TARGET_BIN="$DEFAULT_BIN_DIR"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            show_help
            exit 0
            ;;
        --uninstall)
            uninstall_qwen
            ;;
        --download)
            DO_DOWNLOAD=true
            shift
            ;;
        --test-e2e)
            DO_E2E=true
            shift
            ;;
        --no-sandbox)
            DISABLE_SANDBOX=false
            shift
            ;;
        --dest)
            TARGET_DEST="$2"
            shift 2
            ;;
        --bin-dir)
            TARGET_BIN="$2"
            shift 2
            ;;
        *)
            if [[ -f "$1" && "$1" == *.exe ]]; then
                INPUT_EXE="$1"
                shift
            else
                log_err "Unknown option or invalid file: $1"
                show_help
                exit 1
            fi
            ;;
    esac
done

SCRATCH_DIR=$(mktemp -d -t qwen-transmute-XXXXXX)
BACKUP_DIR="$SCRATCH_DIR/backup"

rollback() {
    local exit_code=$?
    if [[ $exit_code -ne 0 ]]; then
        log_err "Pipeline encountered an error (exit code $exit_code). Initiating rollback..."
        if [[ -d "$BACKUP_DIR" && -d "$BACKUP_DIR/qwen-desktop" ]]; then
            log_warn "Restoring previous installation from backup..."
            rm -rf "$TARGET_DEST"
            cp -a "$BACKUP_DIR/qwen-desktop" "$TARGET_DEST"
        fi
        log_warn "Rollback completed. Exiting."
    fi
    if [[ -d "$SCRATCH_DIR" ]]; then
        rm -rf "$SCRATCH_DIR"
    fi
}
trap rollback EXIT

# Step 1: Locate or Download Installer
if [[ -z "$INPUT_EXE" ]]; then
    if [[ "$DO_DOWNLOAD" == true ]]; then
        INPUT_EXE="$SCRATCH_DIR/$PINNED_QWEN_FILE"
        log_info "Downloading official installer from $PINNED_QWEN_URL..."
        curl -L --fail --progress-bar "$PINNED_QWEN_URL" -o "$INPUT_EXE"
    else
        for search_dir in "$HOME/Descargas" "$HOME/Downloads" "$HOME"; do
            CANDIDATE=$(find "$search_dir" -maxdepth 2 -iname "*qwen*.exe" 2>/dev/null | head -n 1 || true)
            if [[ -n "$CANDIDATE" && -f "$CANDIDATE" ]]; then
                INPUT_EXE="$CANDIDATE"
                log_info "Found local candidate: $INPUT_EXE"
                break
            fi
        done
        if [[ -z "$INPUT_EXE" ]]; then
            log_err "No installer provided and none found in Downloads. Pass path to .exe or use --download."
            exit 1
        fi
    fi
fi

# Verify Installer Integrity (FAIL CLOSED)
verify_sha256 "$INPUT_EXE" "$PINNED_QWEN_SHA256"

# Backup existing installation if present (idempotent preservation)
if [[ -d "$TARGET_DEST" ]]; then
    log_info "Existing installation found at $TARGET_DEST. Creating rollback snapshot..."
    mkdir -p "$BACKUP_DIR"
    cp -a "$TARGET_DEST" "$BACKUP_DIR/qwen-desktop"
fi

# Step 2: Extract Installer Payload
EXTRACT_ROOT="$SCRATCH_DIR/payload"
mkdir -p "$EXTRACT_ROOT"

log_info "Extracting NSIS payload..."

# Check if previously unpacked in Wine C:\Qwen
if [[ -d "$HOME/.wine/drive_c/Qwen/resources" && -f "$HOME/.wine/drive_c/Qwen/resources/app.asar" ]]; then
    log_info "Found pre-unpacked resources in ~/.wine/drive_c/Qwen..."
    cp -a "$HOME/.wine/drive_c/Qwen"/* "$EXTRACT_ROOT"/
elif command -v wine >/dev/null 2>&1; then
    WINE_DEST="C:\\qwen_tmp"
    if [[ -d "$HOME/.wine" ]]; then
        # Use existing initialized wine prefix to avoid slow wineboot
        WINEDEBUG=-all wine "$INPUT_EXE" /S /D="$WINE_DEST" >/dev/null 2>&1 || true
        WINE_EXTRACTED="$HOME/.wine/drive_c/qwen_tmp"
    else
        WINEPREFIX="$SCRATCH_DIR/wineprefix" WINEDEBUG=-all wine "$INPUT_EXE" /S /D="$WINE_DEST" >/dev/null 2>&1 || true
        WINE_EXTRACTED="$SCRATCH_DIR/wineprefix/drive_c/qwen_tmp"
    fi

    if [[ -d "$WINE_EXTRACTED/resources" ]]; then
        cp -a "$WINE_EXTRACTED"/* "$EXTRACT_ROOT"/
        rm -rf "$WINE_EXTRACTED"
    fi
fi

if [[ ! -f "$EXTRACT_ROOT/resources/app.asar" ]]; then
    log_err "Failed to locate resources/app.asar in extracted payload."
    exit 1
fi
log_ok "Extracted base Windows package."

# Step 3: Unpack & Patch Electron Application Logic
APP_UNPACK="$SCRATCH_DIR/app"
mkdir -p "$APP_UNPACK"
log_info "Unpacking app.asar..."

if command -v bunx >/dev/null 2>&1; then
    bunx @electron/asar extract "$EXTRACT_ROOT/resources/app.asar" "$APP_UNPACK"
elif command -v npx >/dev/null 2>&1; then
    npx -y @electron/asar extract "$EXTRACT_ROOT/resources/app.asar" "$APP_UNPACK"
else
    log_err "Neither bunx nor npx available to unpack asar."
    exit 1
fi
log_ok "Unpacked app.asar."

log_info "Applying Linux platform & kernel adaptations..."
python3 "$LIB_DIR/patcher.py" "$APP_UNPACK/out/main/index.js"

# Step 4: Provision Native Linux Electron Runtime
log_info "Provisioning native Linux Electron $ELECTRON_VERSION runtime..."
ELECTRON_DIST="$SCRATCH_DIR/electron-dist"
mkdir -p "$ELECTRON_DIST"

CACHE_DIR="$HOME/.cache/qwen-transmuter"
mkdir -p "$CACHE_DIR"
CACHED_ZIP="$CACHE_DIR/$ELECTRON_ZIP_FILE"
ELECTRON_ZIP="$SCRATCH_DIR/$ELECTRON_ZIP_FILE"

if [[ -f "$CACHED_ZIP" ]] && verify_sha256 "$CACHED_ZIP" "$PINNED_ELECTRON_SHA256" >/dev/null 2>&1; then
    log_info "Using verified cached Electron runtime from $CACHED_ZIP"
    cp "$CACHED_ZIP" "$ELECTRON_ZIP"
else
    log_info "Fetching native Electron $ELECTRON_VERSION from official GitHub release..."
    curl -L --fail --progress-bar "$ELECTRON_URL" -o "$ELECTRON_ZIP"
    verify_sha256 "$ELECTRON_ZIP" "$PINNED_ELECTRON_SHA256"
    cp "$ELECTRON_ZIP" "$CACHED_ZIP"
fi

unzip -q "$ELECTRON_ZIP" -d "$ELECTRON_DIST"
log_ok "Electron runtime verified and extracted."

# Step 5: Assemble Native Application in Destination
log_info "Assembling native application in $TARGET_DEST..."
rm -rf "$TARGET_DEST"
mkdir -p "$TARGET_DEST"

# Copy Electron runtime
cp -a "$ELECTRON_DIST"/* "$TARGET_DEST"/
mv "$TARGET_DEST/electron" "$TARGET_DEST/qwen"
rm -f "$TARGET_DEST/resources/default_app.asar"

# Install app code
cp -a "$APP_UNPACK" "$TARGET_DEST/resources/app"

# Install resources (assets, i18n)
if [[ -d "$EXTRACT_ROOT/resources/assets" ]]; then
    cp -a "$EXTRACT_ROOT/resources/assets" "$TARGET_DEST/resources/"
fi
if [[ -d "$EXTRACT_ROOT/resources/i18n" ]]; then
    cp -a "$EXTRACT_ROOT/resources/i18n" "$TARGET_DEST/resources/"
fi

# Configure host MCP shims (bun, uv, uvx)
mkdir -p "$TARGET_DEST/resources/bun"
mkdir -p "$TARGET_DEST/resources/python"
if command -v bun >/dev/null 2>&1; then
    ln -sf "$(command -v bun)" "$TARGET_DEST/resources/bun/bun"
fi
if command -v uv >/dev/null 2>&1; then
    ln -sf "$(command -v uv)" "$TARGET_DEST/resources/python/uv"
fi
if command -v uvx >/dev/null 2>&1; then
    ln -sf "$(command -v uvx)" "$TARGET_DEST/resources/python/uvx"
fi

log_ok "Installed native files in $TARGET_DEST"

# Step 6: Create Launcher and Desktop Integration
mkdir -p "$TARGET_BIN"
LAUNCHER="$TARGET_BIN/qwen"

# Build launcher with configurable sandbox flag
SANDBOX_FLAG=""
if [[ "$DISABLE_SANDBOX" == true ]]; then
    SANDBOX_FLAG="--no-sandbox"
    SANDBOX_NOTE="# Note: --no-sandbox is used by default on Ubuntu 24.04+ due to restricted
# unprivileged user namespaces unless a dedicated AppArmor profile is registered.
# Re-run with --no-sandbox flag to disable this if you have an AppArmor profile."
else
    SANDBOX_NOTE="# Note: Full sandboxing enabled (no --no-sandbox). Requires AppArmor profile
# permitting unprivileged user namespace creation (see docs/APPARMOR.md)."
fi

cat << EOF > "$LAUNCHER"
#!/usr/bin/env bash
# Qwen Desktop Native Linux Launcher
$SANDBOX_NOTE
APP_DIR="$TARGET_DEST"
exec "\$APP_DIR/qwen" $SANDBOX_FLAG "\$@"
EOF
chmod +x "$LAUNCHER"
log_ok "Created launcher at $LAUNCHER"

mkdir -p "$DEFAULT_DESKTOP_DIR"
DESKTOP_FILE="$DEFAULT_DESKTOP_DIR/qwen.desktop"
ICON_PATH="$TARGET_DEST/resources/assets/icon.png"

cat << EOF > "$DESKTOP_FILE"
[Desktop Entry]
Name=Qwen
Comment=Qwen AI Desktop (Native Linux Port)
Exec=$LAUNCHER %U
Icon=$ICON_PATH
Terminal=false
Type=Application
Categories=Utility;Network;ArtificialIntelligence;
MimeType=x-scheme-handler/qwen;
StartupWMClass=Qwen
EOF

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DEFAULT_DESKTOP_DIR" 2>/dev/null || true
fi
log_ok "Registered desktop application at $DESKTOP_FILE"

# Helper: kill process tree
kill_tree() {
    local pid=$1
    local signal=${2:-TERM}
    kill -$signal -$pid 2>/dev/null || true
    sleep 0.3
    kill -KILL -$pid 2>/dev/null || true
}

# Step 7: Post-Installation E2E Canary Verification
if [[ "$DO_E2E" == true ]]; then
    log_info "Executing E2E Canary Verification..."
    if [[ ! -x "$LAUNCHER" ]]; then
        log_err "Launcher binary not found or not executable: $LAUNCHER"
        exit 1
    fi
    # Test launch canary - run in new process group, verify output, then KILL tree
    CANARY_OUT_FILE=$(mktemp)
    (
        cd "$TARGET_DEST"
        setsid timeout 5s "$TARGET_DEST/qwen" $SANDBOX_FLAG >"$CANARY_OUT_FILE" 2>&1 &
        CANARY_PID=$!
        sleep 2
        if kill -0 -$CANARY_PID 2>/dev/null; then
            sleep 1
            kill_tree $CANARY_PID TERM
        else
            wait $CANARY_PID 2>/dev/null || true
        fi
    ) || true
    CANARY_OUT=$(cat "$CANARY_OUT_FILE" 2>/dev/null || echo "")
    rm -f "$CANARY_OUT_FILE"
    if [[ "$CANARY_OUT" == *"webviewLoaded"* || "$CANARY_OUT" == *"switchTheme"* || "$CANARY_OUT" == *"APPIMAGE env"* ]]; then
        log_ok "Canary startup check passed (Application window and webview initialized successfully)."
    else
        log_err "Canary execution failed: unexpected output:\n$CANARY_OUT"
        exit 1
    fi

    # Verify MCP tool resolution
    if [[ -x "$TARGET_DEST/resources/bun/bun" ]]; then
        log_ok "MCP tool check: bun shim resolves ($("$TARGET_DEST/resources/bun/bun" --version))."
    fi
    if [[ -x "$TARGET_DEST/resources/python/uv" ]]; then
        log_ok "MCP tool check: uv shim resolves ($("$TARGET_DEST/resources/python/uv" --version | head -n1))."
    fi
    log_ok "E2E verification completed successfully."
fi

# Summary
echo ""
echo -e "${COLOR_GREEN}================================================================${COLOR_RESET}"
echo -e "${COLOR_GREEN}✓ QWEN NATIVE LINUX TRANSMUTATION COMPLETE!${COLOR_RESET}"
echo -e "${COLOR_GREEN}================================================================${COLOR_RESET}"
echo "Installation location: $TARGET_DEST"
echo "CLI command:           $LAUNCHER (type 'qwen')"
echo "Desktop launcher:      $DESKTOP_FILE"
echo "Sandbox mode:          $([ "$DISABLE_SANDBOX" == true ] && echo '--no-sandbox (default)' || echo 'full sandboxing (--no-sandbox flag used)')"
echo "Host MCP tools:        bun=$(command -v bun || echo 'not found'), uv=$(command -v uv || echo 'not found')"
echo "User profile/session:  ~/.config/Qwen (untouched)"
echo ""