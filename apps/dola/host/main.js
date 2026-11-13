// lAInux Dola host v0 (original code, MIT): runs Dola's own desktop UI (extracted from
// the vendor's biz.pak by lib/pak.py) in Linux Electron. https://www.dola.com/** is
// answered from the local bundle when the file/route exists there (as Cici.dll does
// on Windows) and passed through to the network otherwise.
"use strict";
const { app, BrowserWindow, protocol, net, session, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const UI = process.env.DOLA_UI_DIR;                    // extracted biz/ (never shipped)
const LOG = process.env.DOLA_HOST_LOG || "";           // optional console log file
const ORIGIN_HOSTS = new Set(["www.dola.com"]);
if (!UI || !fs.existsSync(path.join(UI, "route.json"))) {
  console.error("DOLA_UI_DIR must point at the extracted biz/ bundle (route.json missing)");
  process.exit(2);
}
const routes = JSON.parse(fs.readFileSync(path.join(UI, "route.json"), "utf8")).routes
  .map(r => ({ prefix: r.urlPath, entry: r.entryName || (r.extra && r.extra.entryName) }))
  .filter(r => r.prefix && r.entry)
  .map(r => ({ prefix: r.prefix, file: path.join(UI, r.entry, "index.html") }))
  .filter(r => fs.existsSync(r.file))
  .sort((a, b) => b.prefix.length - a.prefix.length);   // longest prefix first

const MIME = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".ico": "image/x-icon", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg", ".txt": "text/plain" };

function log(line) {
  if (LOG) fs.appendFileSync(LOG, line + "\n");
}

function localFile(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(UI, rel);
  if (!file.startsWith(path.resolve(UI) + path.sep)) return null;   // no escaping the bundle
  try { if (fs.statSync(file).isFile()) return file; } catch {}
  for (const r of routes) if (pathname === r.prefix || pathname.startsWith(r.prefix + "/")) return r.file;
  return null;
}

// ------------------------------------------------------------------ neotix host
// Persistent key/value stores keyed by "biz" (neotix.localStorage / localStorageApp).
const STORE = path.join(app.getPath("userData"), "neotix-store.json");
let store = {};
try { store = JSON.parse(fs.readFileSync(STORE, "utf8")); } catch {}
const saveStore = () => fs.writeFileSync(STORE, JSON.stringify(store), { mode: 0o600 });
const bizKV = (bucket) => ({
  get: ([arg]) => ({ data: (store[bucket] || {})[arg && arg.biz] ?? "" }),
  set: ([arg]) => {
    (store[bucket] ??= {})[arg.biz] = typeof arg.data === "string" ? arg.data : JSON.stringify(arg.data ?? {});
    saveStore();
    return {};
  },
});
const crypto = require("crypto");
const { nativeTheme } = require("electron");
store.device ??= { deviceId: String(BigInt("0x" + crypto.randomBytes(7).toString("hex"))), installId: crypto.randomUUID() };
const ENV = {
  capabilities: { isImFeatureOpened: false, isImInDoubaoSidePanel: false },
  channel: "lainux", platform: "linux", appVersion: "1.0.6.7189",
};
ipcMain.on("neotix-env", (e) => { e.returnValue = ENV; });
const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
const HOST = {
  tea: { getGlobalParams: () => ({}), track: () => true, setBackgroundReady: () => true },
  cloudConfig: { get: () => ({ data: "{}" }), get2: () => ({ data: "{}" }) },
  builtin: { getBrandInfo: () => ({ brand: "dola", name: "Dola" }) },
  network: { getInternetConnectionData: () => ({ online: true, type: "unknown" }) },
  browserSettings: {
    getApplicationLocale: () => app.getLocale(),
    getColorScheme: () => (nativeTheme.shouldUseDarkColors ? "dark" : "light"),
    getGeneralSettings: () => ({}),
    getApplicationShortcutSettings: () => ({}),
  },
  system: { detectBDInternet: () => false },
  runtimeStorage: {
    get: ([k]) => ((store.runtime || {})[typeof k === "string" ? k : k && k.key] ?? null),
    set: ([kv]) => { (store.runtime ??= {})[kv.key] = kv.value; saveStore(); return true; },
    subscribe: () => true,
  },
  globalASR: { isChatASREnabled: () => false },
  sandbox: { isSupport: () => false, isSupportNoSandbox: () => false },
  appshare: { setShareInfos: () => true, getAppsList: () => [] },
  device: { getDeviceInfo: () => ({ deviceId: store.device.deviceId, installId: store.device.installId, platform: "linux" }) },
  startupMetric: { getNativeStartupCostMS: () => 0, setWebviewStartupEvent: () => true },
  audioRecorder: { setLibraExpEnabled: () => true },
  pageLoadEvent: { setPageLoadErrorEvent: ([ev]) => { log(`PAGE-ERROR ${JSON.stringify(ev).slice(0, 400)}`); return true; } },
  localStorage: bizKV("localStorage"),
  localStorageApp: bizKV("localStorageApp"),
  log: { writeLog: () => undefined },
  browser: { openURL: ([a]) => { const url = typeof a === "string" ? a : a && a.url; if (/^https?:/.test(url || "")) shell.openExternal(url); return true; } },
};
// Access-point calls. Dola runs with the liblark backend disabled by remote config
// (Cici.dll logs "Backend is disabled by cached configuration"), so backend calls fail
// the same way: callback(false, ...) and the UI takes its no-backend path.
ipcMain.handle("towel", async (_e, method, payload) => {
  log(`TOWEL ${method} ${JSON.stringify(payload).slice(0, 200)}`);
  return [false, { success: false, is_error: true, error_message: "backend disabled" }];
});
ipcMain.on("neotix-channel", (e, name, data) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("neotix-channel", name, data);
});
const misses = new Map();
const HOST_WIN = {
  window: { setTitle: (w, [a]) => { w.setTitle(String(a && a.title || "Dola")); return true; } },
  webPage: { getZoom: (w) => w.webContents.getZoomFactor() },
};
ipcMain.handle("neotix", async (e, ns, method, args) => {
  const fw = HOST_WIN[ns] && HOST_WIN[ns][method];
  if (fw) { const w = winOf(e); return { value: w ? await fw(w, args) : undefined }; }
  const f = HOST[ns] && HOST[ns][method];
  if (!f) {
    const k = `${ns}.${method}`;
    if (!misses.has(k)) log(`NEOTIX-MISS ${k} ${JSON.stringify(args).slice(0, 300)}`);
    misses.set(k, (misses.get(k) || 0) + 1);
    return { miss: true };
  }
  try { return { value: await f(args) }; }
  catch (e) { log(`NEOTIX-ERR ${ns}.${method} ${e && e.message}`); return { error: String(e && e.message || e) }; }
});

app.whenReady().then(() => {
  session.defaultSession.protocol.handle("https", async (req) => {
    const u = new URL(req.url);
    if (ORIGIN_HOSTS.has(u.hostname) && req.method === "GET") {
      const f = localFile(u.pathname);
      if (f) {
        log(`LOCAL ${u.pathname}`);
        return new Response(fs.readFileSync(f), { headers: { "content-type": MIME[path.extname(f)] || "application/octet-stream" } });
      }
    }
    log(`NET ${req.method} ${u.hostname}${u.pathname}`);
    // The UI silences console in production and reports JS errors to its monitor
    // endpoint: with DOLA_HOST_LOG_MONITOR=1 keep those reports for debugging the host.
    if (process.env.DOLA_HOST_LOG_MONITOR && /monitor|collect|slardar/.test(u.pathname)) {
      try { log(`MONITOR ${u.hostname}${u.pathname} ${(await req.clone().text()).slice(0, 20000)}`); } catch {}
    }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
  const win = new BrowserWindow({ width: 1280, height: 800, show: !process.env.DOLA_HOST_HIDDEN,
    webPreferences: { contextIsolation: false, sandbox: false, nodeIntegration: false, preload: path.join(__dirname, "preload.js") } });
  win.webContents.on("console-message", (...a) => {
    const e = a[0] && typeof a[0].message === "string" ? a[0] : { level: a[1], message: a[2], sourceId: a[4], lineNumber: a[3] };
    log(`CONSOLE[${e.level}] ${String(e.message).slice(0, 400)}  (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => log(`FAIL ${code} ${desc} ${url}`));
  win.loadURL("https://www.dola.com/chat/");
  if (process.env.DOLA_HOST_SHOT) {
    setTimeout(async () => {
      fs.writeFileSync(process.env.DOLA_HOST_SHOT, (await win.webContents.capturePage()).toPNG());
      app.exit(0);
    }, Number(process.env.DOLA_HOST_SHOT_MS || 25000));
  }
});
