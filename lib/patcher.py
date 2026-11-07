#!/usr/bin/env python3
"""
Qwen Linux Transmuter - Core AST / Code Patcher
Patches extracted Qwen Electron bundle to enable native Linux support.

FAIL-CLOSED: Returns non-zero exit code if no modifications were applied,
preventing silent no-op patches from being treated as success.
"""

import sys
import os
import re

def patch_main_index(file_path: str) -> bool:
    if not os.path.isfile(file_path):
        print(f"[ERROR] Target file not found: {file_path}", file=sys.stderr)
        return False

    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    modified = False

    # 1. Patch getPlatformDir
    platform_dir_target = """function getPlatformDir(platform = os.platform(), arch = os.arch()) {
  if (platform === "darwin") {
    return arch === "arm64" ? "mac-arm64" : "mac-x64";
  }
  if (platform === "win32") {
    return "win-x64";
  }
  throw new Error(`Unsupported platform: ${platform}, arch: ${arch}`);
}"""

    platform_dir_replacement = """function getPlatformDir(platform = os.platform(), arch = os.arch()) {
  if (platform === "darwin") {
    return arch === "arm64" ? "mac-arm64" : "mac-x64";
  }
  if (platform === "win32") {
    return "win-x64";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "linux-arm64" : "linux-x64";
  }
  throw new Error(`Unsupported platform: ${platform}, arch: ${arch}`);
}"""

    if platform_dir_target in content:
        content = content.replace(platform_dir_target, platform_dir_replacement)
        print("[+] Patched getPlatformDir: Added native Linux platform mapping (linux-x64 / linux-arm64).")
        modified = True
    else:
        # Fallback regex
        pattern = r'(function getPlatformDir\([^)]*\)\s*\{[\s\S]*?)(throw new Error\(`Unsupported platform:)'
        if re.search(pattern, content):
            replacement = r'\1if (platform === "linux") { return arch === "arm64" ? "linux-arm64" : "linux-x64"; }\n  \2'
            content = re.sub(pattern, replacement, content, count=1)
            print("[+] Patched getPlatformDir via regex fallback.")
            modified = True
        else:
            print("[!] Warning: getPlatformDir pattern not found (might already be patched or upstream changed).")

    # 2. Patch initializeAutoUpdater
    updater_target = """  if (process.platform === "darwin") {
    platformSpecificPath = `macos/${process.arch}/`;
  } else if (process.platform === "win32") {
    platformSpecificPath = `windows/${process.arch}/`;
  }"""

    updater_replacement = """  if (process.platform === "darwin") {
    platformSpecificPath = `macos/${process.arch}/`;
  } else if (process.platform === "win32") {
    platformSpecificPath = `windows/${process.arch}/`;
  } else {
    return;
  }"""

    if updater_target in content:
        content = content.replace(updater_target, updater_replacement)
        print("[+] Patched initializeAutoUpdater: Guarded against Windows/macOS feed requests on Linux.")
        modified = True
    else:
        updater_pattern = r'(if\s*\(process\.platform\s*===\s*["\']darwin["\']\)[\s\S]*?else if\s*\(process\.platform\s*===\s*["\']win32["\']\)[\s\S]*?;\s*\})'
        if re.search(updater_pattern, content):
            content = re.sub(updater_pattern, r'\1 else { return; }', content, count=1)
            print("[+] Patched initializeAutoUpdater via regex fallback.")
            modified = True
        else:
            print("[!] Warning: initializeAutoUpdater pattern not found (might already be patched or upstream changed).")

    if modified:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"[✓] Successfully wrote patches to {file_path}")
        return True

    print("[ERROR] No modifications were applied. Upstream may have changed; refusing to proceed (fail-closed).", file=sys.stderr)
    return False

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: patcher.py <path/to/out/main/index.js>")
        sys.exit(1)
    target_path = sys.argv[1]
    if not patch_main_index(target_path):
        sys.exit(1)