// lAInux Dola host v0 (original code, MIT): runs Dola's own desktop UI (extracted from
// the vendor's biz.pak by lib/pak.py) in Linux Electron. https://www.dola.com/** is
// answered from the local bundle when the file/route exists there (as Cici.dll does
// on Windows) and passed through to the network otherwise.
"use strict";
const { app, BrowserWindow, protocol, net, session, ipcMain, shell, Menu } = require("electron");
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
  // Cookies of the main (home) tab: the login view reads passport_csrf_token here.
  tabs: {
    getHomeTabCookie: async ([a]) => {
      const name = a && a.key;
      const [c] = await session.defaultSession.cookies.get({ url: "https://www.dola.com", name });
      return { cookie: c ? c.value : "" };
    },
  },
  pageLoadEvent: { setPageLoadErrorEvent: ([ev]) => { log(`PAGE-ERROR ${JSON.stringify(ev).slice(0, 600)}`); return true; } },
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
ipcMain.on("neotix-channel", (e, name, args, tokens) => {
  for (const c of contexts.values()) {
    if (Array.isArray(tokens) && !tokens.includes(c.token)) continue;
    if (!c.win.isDestroyed()) c.win.webContents.send("neotix-channel", name, args, (contexts.get(e.sender.id) || {}).token || "");
  }
  log(`CHANNEL ${name} -> ${Array.isArray(tokens) ? tokens.length + " target(s)" : "all"} ${JSON.stringify(args).slice(0, 300)}`);
});
const misses = new Map();
const ctxOf = (w) => contexts.get(w.webContents.id);
const HOST_WIN = {
  window: { setTitle: (w, [a]) => { w.setTitle(String(a && a.title || "Dola")); return true; } },
  webPage: { getZoom: (w) => w.webContents.getZoomFactor() },
  pinWindow: {
    // { url, command: "newTab" | "closeTab", forceRunInClient }
    sendCommand: (w, [a]) => {
      const cmd = a && a.command;
      if (cmd === "newTab" && a.url) { openTab(a.url); return true; }
      if (cmd === "closeTab") {
        const target = [...tabs].find(t => t.webContents === w.webContents) ||
          [...tabs].find(t => a.url && t.webContents.getURL().split("#")[0] === String(a.url).split("#")[0]);
        if (target) target.close();
        return true;
      }
      log(`TAB unsupported command ${JSON.stringify(a).slice(0, 200)}`);
      return false;
    },
    setFloating: () => true,
    getFloating: () => false,
  },
  windowContext: {
    getHandlerToken: (w) => ctxOf(w)?.token,
    getWindowContextInfo: (_w, [name]) => {
      for (const c of contexts.values()) if (c.name === name) return { token: c.token, name: c.name };
      throw new Error(`no window context ${name}`);
    },
  },
  browserWindow: {
    // args: { entry, feature, afterLoginToUrl, loginUrl?, extraQuery?, closeWhenClickMask }
    popupLoginWindow: (w, [a]) => {
      if (loginWin && !loginWin.isDestroyed()) { loginWin.focus(); return true; }
      // The desktop login view is the bundle's "login" entry (entry-client-login, routed
      // at /login); /client-login-modal does not exist on the public site.
      const u = new URL((a && a.loginUrl) || "https://www.dola.com/client-login-modal");
      if (u.hostname === "www.dola.com" && u.pathname.startsWith("/client-login-modal")) u.pathname = "/login";
      const url = u.toString();
      log(`LOGIN open ${url} args=${JSON.stringify(a).slice(0, 400)}`);
      loginWin = newWindow({ width: 460, height: 640, parent: w, modal: true, title: "Dola", autoHideMenuBar: true }, "login_view");
      loginWin.on("closed", () => {
        loginWin = null;
        // The session lives in shared cookies: reload so the main view picks it up even
        // if no channel event announced the login.
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.reload();
      });
      loginWin.loadURL(url);
      if (process.env.DOLA_HOST_LOGIN_SHOT) {   // test hook: screenshot the login window
        loginWin.webContents.once("did-finish-load", () => setTimeout(async () => {
          if (!loginWin || loginWin.isDestroyed()) return;
          fs.writeFileSync(process.env.DOLA_HOST_LOGIN_SHOT, (await loginWin.webContents.capturePage()).toPNG());
          log("LOGIN screenshot written");
          if (process.env.DOLA_HOST_TEST_GOOGLE) {   // test hook: press "Continue with Google"
            const r = await loginWin.webContents.executeJavaScript(`(() => {
              const all = [...document.querySelectorAll('*')].filter(e => /Google/.test((e.innerText||'').trim()) && e.offsetParent);
              const inner = all.filter(e => !all.some(o => o !== e && e.contains(o)));
              if (!inner[0]) return 'no google button'; inner[0].click(); return 'clicked ' + inner[0].tagName; })()`, true);
            log(`LOGIN google: ${r}`);
          }
        }, 7000));
      }
      return true;
    },
    closeLoginWindow: () => { if (loginWin && !loginWin.isDestroyed()) loginWin.close(); return true; },
    resizeLoginWindow: (_w, [a]) => {
      log(`LOGIN resize ${JSON.stringify(a)}`);
      if (loginWin && a && a.width && a.height) loginWin.setContentSize(Math.round(a.width), Math.round(a.height));
      return true;
    },
    updateLoginWindowConfig: (_w, [a]) => { log(`LOGIN config ${JSON.stringify(a)}`); return true; },
    setLoginWindowIgnoreResize: (_w, [a]) => { log(`LOGIN ignoreResize ${JSON.stringify(a)}`); return true; },
  },
};
ipcMain.handle("neotix", async (e, ns, method, args) => {
  const fw = HOST_WIN[ns] && HOST_WIN[ns][method];
  if (fw) { const w = winOf(e); return { value: w ? await fw(w, args) : undefined }; }
  const f = HOST[ns] && HOST[ns][method];
  if (!f) {
    const k = `${ns}.${method}`;
    const who = (contexts.get(e.sender.id) || {}).name || "?";
    if (!misses.has(k)) log(`NEOTIX-MISS[${who}] ${k} ${JSON.stringify(args).slice(0, 300)}`);
    misses.set(k, (misses.get(k) || 0) + 1);
    return { miss: true };
  }
  try { return { value: await f(args) }; }
  catch (e) { log(`NEOTIX-ERR ${ns}.${method} ${e && e.message}`); return { error: String(e && e.message || e) }; }
});

// dola:// is Dola's scheme for its own desktop views (dola://dola-login/login,
// dola://dola-audio-recorder, ...): host "dola-<entry>" serves the bundle's <entry>/ app,
// with root-relative assets (/static/...) from the bundle root.
protocol.registerSchemesAsPrivileged([{ scheme: "dola", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: true } }]);
function dolaFile(u) {
  const entry = u.hostname.replace(/^dola-/, "");
  const direct = localFile(u.pathname);
  if (direct && !direct.endsWith(path.sep + "index.html")) return direct;     // a real asset
  const idx = path.join(UI, entry, "index.html");
  return fs.existsSync(idx) ? idx : direct;
}

// ------------------------------------------------------------------ windows
// Every window gets a context name and a token (neotix.windowContext); the channel
// routes events by token (sendToTargets) or to all windows (broadcast).
const contexts = new Map(); // webContents.id -> { name, token, win }
function registerWindow(win, name) {
  contexts.set(win.webContents.id, { name, token: crypto.randomUUID(), win });
  win.on("closed", () => { for (const [k, v] of contexts) if (v.win === win) contexts.delete(k); });
}
function newWindow(opts, name) {
  const win = new BrowserWindow({ ...opts, show: opts.show ?? !process.env.DOLA_HOST_HIDDEN,
    webPreferences: { contextIsolation: false, sandbox: false, nodeIntegration: false, preload: path.join(__dirname, "preload.js") } });
  registerWindow(win, name);
  win.webContents.on("console-message", (...a) => {
    const e = a[0] && typeof a[0].message === "string" ? a[0] : { level: a[1], message: a[2], sourceId: a[4], lineNumber: a[3] };
    log(`CONSOLE[${name}:${e.level}] ${String(e.message).slice(0, 300)}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => log(`FAIL[${name}] ${code} ${desc} ${url}`));
  // window.open (e.g. the OAuth popups of the login view): log it, then let it open.
  win.webContents.setWindowOpenHandler(({ url, features }) => {
    log(`WINOPEN[${name}] ${url.slice(0, 200)} features=${features}`);
    return { action: "allow" };
  });
  win.webContents.on("did-create-window", (child) => {
    child.webContents.on("did-navigate", (_e, url) => log(`POPUP-NAV ${url.slice(0, 200)}`));
  });
  return win;
}
let mainWin = null, loginWin = null;
// Dola is also a browser: pinWindow "newTab" opens a page in a tab of the SAME profile.
// Third-party login (Google, …) relies on it: the OAuth page redirects to
// https://www.dola.com/auth/callback, which sets the session cookies here, while the
// login view polls for the result. "closeTab" closes that tab again.
const tabs = new Set();
// Plain Chrome UA for tabs: identity providers refuse embedded browsers that announce
// themselves as Electron or as another app.
const chromeUA = () => session.defaultSession.getUserAgent().replace(/\s(Electron|qwen|dola-linux-host)\/\S+/gi, "");
function openTab(url) {
  const t = newWindow({ width: 1000, height: 760, title: "Dola", autoHideMenuBar: true }, "tab");
  t.webContents.setUserAgent(chromeUA());
  tabs.add(t);
  t.on("closed", () => tabs.delete(t));
  t.loadURL(url);
  log(`TAB open ${url.slice(0, 160)}`);
  if (process.env.DOLA_HOST_TAB_SHOT) t.webContents.once("did-finish-load", () => setTimeout(async () => {
    if (!t.isDestroyed()) { fs.writeFileSync(process.env.DOLA_HOST_TAB_SHOT, (await t.webContents.capturePage()).toPNG()); log(`TAB screenshot ${t.webContents.getURL().slice(0, 120)}`); }
  }, 6000));
  return t;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // Dola has no File/Edit/View menu; editing shortcuts still work
  session.defaultSession.protocol.handle("dola", async (req) => {
    const u = new URL(req.url);
    const f = dolaFile(u);
    log(`DOLA ${u.hostname}${u.pathname} -> ${f ? path.relative(UI, f) : "404"}`);
    if (!f) return new Response("not found", { status: 404 });
    return new Response(fs.readFileSync(f), { headers: { "content-type": MIME[path.extname(f)] || "application/octet-stream" } });
  });
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
  // Dola's hidden background page (dola://dola-background): serves "AgentBackground"
  // RPCs (rfc-request) for the visible windows, as the Windows host keeps it running.
  const bg = newWindow({ width: 800, height: 600, show: false }, "background");
  bg.loadURL("dola://dola-background/");
  const win = mainWin = newWindow({ width: 1280, height: 800, title: "Dola" }, "chat_view");
  win.loadURL("https://www.dola.com/chat/");
  if (process.env.DOLA_HOST_SHOT) {
    setTimeout(async () => {
      fs.writeFileSync(process.env.DOLA_HOST_SHOT, (await win.webContents.capturePage()).toPNG());
      app.exit(0);
    }, Number(process.env.DOLA_HOST_SHOT_MS || 25000));
  }
});
