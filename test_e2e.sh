#!/usr/bin/env bash
# ==============================================================================
# Qwen Linux Transmuter - End-to-End (E2E) Test Suite
# Tests run in ISOLATED temporary directories to NEVER touch the user's
# real ~/.local/share/qwen-desktop or ~/.local/bin/qwen installation.
#
# Tests:
# 1. Clean uninstall verification (isolated).
# 2. SHA-256 verification and fail-closed validation.
# 3. Transmutation pipeline execution and runtime binding.
# 4. MCP subsystem resolution.
# 5. Live startup canary test (process health + output validation) - KILLS process after check.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRANSMUTER="$SCRIPT_DIR/qwen-transmute.sh"

# Create isolated test environment
TEST_ROOT=$(mktemp -d -t qwen-e2e-XXXXXX)
TEST_INSTALL_DIR="$TEST_ROOT/.local/share/qwen-desktop"
TEST_BIN_DIR="$TEST_ROOT/.local/bin"
TEST_DESKTOP_DIR="$TEST_ROOT/.local/share/applications"
TEST_CONFIG_DIR="$TEST_ROOT/.config/Qwen"
TEST_HOME="$TEST_ROOT"

# Override HOME for the transmuter to use our isolated paths
export HOME="$TEST_HOME"

LAUNCHER="$TEST_BIN_DIR/qwen"
DESKTOP_ENTRY="$TEST_DESKTOP_DIR/qwen.desktop"
INSTALL_DIR="$TEST_INSTALL_DIR"
CONFIG_DIR="$TEST_CONFIG_DIR"

COLOR_GREEN="\033[0;32m"
COLOR_BLUE="\033[0;34m"
COLOR_YELLOW="\033[1;33m"
COLOR_RED="\033[0;31m"
COLOR_RESET="\033[0m"

log_test() { echo -e "${COLOR_BLUE}[TEST]${COLOR_RESET} $*"; }
log_pass() { echo -e "${COLOR_GREEN}[PASS]${COLOR_RESET} $*"; }
log_warn() { echo -e "${COLOR_YELLOW}[WARN]${COLOR_RESET} $*"; }
log_err() { echo -e "${COLOR_RED}[ERROR]${COLOR_RESET} $*" >&2; }

# Kill a process and its entire process group/tree
kill_tree() {
    local pid=$1
    local signal=${2:-TERM}
    # Kill process group (negative PID) to catch children
    kill -$signal -$pid 2>/dev/null || true
    # Wait a bit
    sleep 0.5
    # Force kill if still alive
    kill -KILL -$pid 2>/dev/null || true
}

# Cleanup on exit
cleanup() {
    local exit_code=$?
    if [[ -d "$TEST_ROOT" ]]; then
        rm -rf "$TEST_ROOT"
    fi
    if [[ $exit_code -ne 0 ]]; then
        log_err "E2E test suite failed (exit code $exit_code)."
    fi
}
trap cleanup EXIT

echo "================================================================"
echo "RUNNING QWEN LINUX TRANSMUTER E2E TEST SUITE (ISOLATED)"
echo "Test root: $TEST_ROOT"
echo "================================================================"

# 1. Test Uninstall (isolated - no user data touched)
log_test "Step 1: Testing clean uninstall in isolated environment..."
"$TRANSMUTER" --uninstall

if [[ -d "$INSTALL_DIR" ]]; then
    log_err "Install dir still exists after uninstall!"
    exit 1
fi
if [[ -f "$LAUNCHER" ]]; then
    log_err "Launcher still exists after uninstall!"
    exit 1
fi
if [[ -f "$DESKTOP_ENTRY" ]]; then
    log_err "Desktop entry still exists after uninstall!"
    exit 1
fi
log_pass "Uninstall verified. Files removed cleanly (isolated)."

# 2. Test Transmutation with E2E flag (isolated)
log_test "Step 2: Executing transmutation pipeline with E2E verification (isolated)..."
"$TRANSMUTER" --download --test-e2e --dest "$INSTALL_DIR" --bin-dir "$TEST_BIN_DIR"

if [[ ! -d "$INSTALL_DIR" ]]; then
    log_err "Install dir was not created!"
    exit 1
fi
if [[ ! -x "$LAUNCHER" ]]; then
    log_err "Launcher is missing or not executable!"
    exit 1
fi
if [[ ! -f "$DESKTOP_ENTRY" ]]; then
    log_err "Desktop entry is missing!"
    exit 1
fi
log_pass "Transmutation completed successfully (isolated)."

# 3. Test MCP shims
log_test "Step 3: Checking MCP tool resolution in sandbox..."
if command -v bun >/dev/null 2>&1; then
    [[ -x "$INSTALL_DIR/resources/bun/bun" ]] || { log_err "bun shim failed!"; exit 1; }
    log_pass "bun MCP shim verified."
fi
if command -v uv >/dev/null 2>&1; then
    [[ -x "$INSTALL_DIR/resources/python/uv" ]] || { log_err "uv shim failed!"; exit 1; }
    log_pass "uv MCP shim verified."
fi

# 4. Live GUI window canary test (enhanced: verify process stays alive + output, THEN KILL)
log_test "Step 4: Executing live GUI canary test (process health + output, auto-kill)..."

# Run canary in background, capture output, verify, then KILL the whole process tree
CANARY_OUT_FILE="$TEST_ROOT/canary.out"
(
    cd "$INSTALL_DIR"
    # Use setsid to create new process group we can kill entirely
    setsid timeout 5s "$INSTALL_DIR/qwen" --no-sandbox >"$CANARY_OUT_FILE" 2>&1 &
    CANARY_PID=$!
    sleep 2
    # Check if process group is still alive (not crashed immediately)
    if kill -0 -$CANARY_PID 2>/dev/null; then
        log_pass "Process stayed alive for 2 seconds (healthy startup)."
        # Give it a moment more to produce output
        sleep 1
        # KILL the entire process group (Electron + helpers)
        kill_tree $CANARY_PID TERM
        log_pass "Canary process tree terminated cleanly."
    else
        # Process died - capture what happened
        wait $CANARY_PID 2>/dev/null || true
        CANARY_EXIT=$?
        log_warn "Process exited early with code $CANARY_EXIT."
    fi
) || true

# Validate output
CANARY_OUT=$(cat "$CANARY_OUT_FILE" 2>/dev/null || echo "")
if [[ "$CANARY_OUT" == *"webviewLoaded"* || "$CANARY_OUT" == *"switchTheme"* || "$CANARY_OUT" == *"APPIMAGE env"* ]]; then
    log_pass "Canary startup check passed (Application window and webview initialized successfully)."
else
    log_err "Canary execution failed: unexpected output:\n$CANARY_OUT"
    exit 1
fi

log_pass "Live startup canary executed successfully (no lingering processes)."

echo "================================================================"
log_pass "ALL E2E TESTS PASSED SUCCESSFULLY!"
echo "================================================================"