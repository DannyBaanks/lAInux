// lAInux boot for Kimi on Linux. Electron loads resources/app before resources/app.asar;
// this file fixes one Linux behaviour and then runs Moonshot's untouched main from app.asar.
//
// On Linux (X11), inside a "resize" event BaseWindow.getContentSize() still returns the
// size of the PREVIOUS event (measured on Electron 43.7.7: maximize reports 1952x1038
// while the window is already 1920x996; restore keeps the maximized size). Kimi lays out
// its views from getContentSize() on "resize" (its "will-resize"/"resized" paths are
// Windows/macOS only), so its views stay one step behind. Re-emitting "resize" once the
// size has settled lets Kimi's own handler see the real size.
import { BaseWindow } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform === "linux") {
  const emit = BaseWindow.prototype.emit;
  const SETTLE_MS = 50;
  BaseWindow.prototype.emit = function (event, ...args) {
    const result = emit.call(this, event, ...args);
    if (event === "resize" && !this.__lainuxResettling) {
      clearTimeout(this.__lainuxResizeTimer);
      this.__lainuxResizeTimer = setTimeout(() => {
        if (this.isDestroyed()) return;
        this.__lainuxResettling = true;
        try { emit.call(this, "resize"); } finally { this.__lainuxResettling = false; }
      }, SETTLE_MS);
    }
    return result;
  };
}

await import(pathToFileURL(join(process.resourcesPath, "app.asar", "out", "main", "index.js")).href);
