// lAInux Dola host v0 (original code, MIT): runs Dola's own desktop UI (extracted from
// the vendor's biz.pak by lib/pak.py) in Linux Electron. https://www.dola.com/** is
// answered from the local bundle when the file/route exists there (as Cici.dll does
// on Windows) and passed through to the network otherwise.
"use strict";
const { app, BrowserWindow, protocol, net, session, ipcMain, shell, Menu } = require("electron");
const fs = require("fs");
const path = require("path");

// Extracted biz/ (never shipped): DOLA_UI_DIR, else resources/dola-ui of an install
// made by apps/dola/transmute.sh.
const UI = process.env.DOLA_UI_DIR || path.join(process.resourcesPath || "", "dola-ui");
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
// Uncaught errors of the UI with their stacks (the console only carries the message).
ipcMain.on("host-diag", (e, kind, text) => {
  if (!LOG) return;
  const who = (contexts.get(e.sender.id) || {}).name || "?";
  log(`DIAG[${who}] ${kind} ${String(text).slice(0, 2000)}`);
});
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
  // Shapes the chat view reads ({applist}, {proxyList}, {servers}); a bare [] made its
  // setup effect throw before it wired the composer (the input stayed blank).
  appshare: {
    setShareInfos: () => true,
    getAppsList: () => ({ applist: [] }),
    getProxyList: () => ({ proxyList: [] }),
    getAppProxyServerStatus: () => ({ servers: [] }),
  },
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
  // The UI's channel transport asks every view for its own token (getCurrentToken) to
  // address neotixChannel messages; it is the same token as windowContext's handler.
  // Missing, the transport stays uninitialised and the composer renders blank.
  popupView: { getWebContentsToken: (w) => ctxOf(w)?.token },
  pinWindow: {
    // { url, command: "newTab" | "closeTab", forceRunInClient }
    sendCommand: (w, [a]) => {
      const cmd = a && a.command;
      if (cmd === "newTab" && a.url) {
        if (isIdentityProvider(a.url) && systemLogin(a.url)) return true;
        openTab(a.url); return true;
      }
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
function newWindow(opts, name, ses) {
  const win = new BrowserWindow({ ...opts, show: opts.show ?? !process.env.DOLA_HOST_HIDDEN,
    webPreferences: { contextIsolation: false, sandbox: false, nodeIntegration: false, preload: path.join(__dirname, "preload.js"),
      ...(ses ? { session: ses } : {}) } });
  registerWindow(win, name);
  win.webContents.on("console-message", (...a) => {
    const e = a[0] && typeof a[0].message === "string" ? a[0] : { level: a[1], message: a[2], sourceId: a[4], lineNumber: a[3] };
    log(`CONSOLE[${name}:${e.level}] ${String(e.message).slice(0, 300)}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => log(`FAIL[${name}] ${code} ${desc} ${url}`));
  // window.open (e.g. the OAuth popups of the login view): log it, then let it open.
  win.webContents.setWindowOpenHandler(({ url, features }) => {
    log(`WINOPEN[${name}] ${url.slice(0, 200)} features=${features}`);
    // Identity providers refuse embedded browsers: same route as pinWindow newTab.
    if (isIdentityProvider(url) && systemLogin(url)) return { action: "deny" };
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
// Tabs run in their own persistent session WITHOUT the https interceptor: identity
// providers (Google…) need Chromium's own network stack (re-issuing their requests
// through net.fetch drops Origin/Sec-Fetch headers and upload bodies -> HTTP 400).
// Cookies the dola.com callback sets there are copied into the app session at once,
// which is what the polling login view reads.
let tabSession = null;
function tabSes() {
  if (tabSession) return tabSession;
  tabSession = session.fromPartition("persist:dola-tabs");
  tabSession.cookies.on("changed", async (_e, c, _cause, removed) => {
    if (removed || !/(^|\.)dola\.com$/.test(c.domain.replace(/^\./, ""))) return;
    const host = c.domain.replace(/^\./, "");
    try {
      await session.defaultSession.cookies.set({
        url: `https://${host}${c.path || "/"}`, name: c.name, value: c.value,
        domain: c.hostOnly ? undefined : c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
        sameSite: c.sameSite, expirationDate: c.expirationDate,
      });
      log(`COOKIE copied ${c.name} (${c.domain})`);
    } catch (e) { log(`COOKIE copy failed ${c.name}: ${e && e.message}`); }
  });
  return tabSession;
}
// Identity providers check the UA string AND Client Hints (Sec-CH-UA headers and
// navigator.userAgentData), whose brands in Electron do not include "Google Chrome".
// Present one coherent Chrome identity (same engine major version) via the emulator.
function chromeIdentity(wc) {
  const major = process.versions.chrome.split(".")[0];
  const ua = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const brands = [{ brand: "Google Chrome", version: major }, { brand: "Chromium", version: major }, { brand: "Not_A Brand", version: "24" }];
  try {
    wc.debugger.attach("1.3");
    wc.debugger.sendCommand("Emulation.setUserAgentOverride", {
      userAgent: ua, acceptLanguage: app.getLocale(), platform: "Linux x86_64",
      userAgentMetadata: { brands, fullVersionList: brands.map(b => ({ ...b, version: b.brand === "Not_A Brand" ? "24.0.0.0" : process.versions.chrome })),
        fullVersion: process.versions.chrome, platform: "Linux", platformVersion: "6.8.0", architecture: "x86", model: "", mobile: false, bitness: "64", wow64: false },
    });
  } catch (e) { log(`TAB identity failed: ${e && e.message}`); wc.setUserAgent(ua); }
}
// Google (and other identity providers) refuse sign-in inside embedded browsers, and also
// in a real browser started with --remote-debugging-port ("this browser or app may not be
// secure"). So sign-in happens in the user's DEFAULT browser (Chromium family), run as a
// plain browser: no debugging port, no automation flags, nothing injected. It gets its own
// profile with --password-store=basic, which lets the host read that profile's own cookie
// file. Dola's desktop UI IS www.dola.com, so the web session cookie is the app's session:
// the user signs in on www.dola.com, the host copies the dola.com cookies into the app.
const IDP = /(^|\.)(accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|facebook\.com|tiktok\.com)$/;
function isIdentityProvider(u) { try { return IDP.test(new URL(u).hostname); } catch { return false; } }
const CHROMIUM_FAMILY = ["brave-browser", "brave", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "vivaldi", "opera"];
function onPath(b) {
  for (const d of (process.env.PATH || "").split(":")) { const f = path.join(d, b); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {} }
  return null;
}
function findLoginBrowser() {
  if (process.env.DOLA_LOGIN_BROWSER) return process.env.DOLA_LOGIN_BROWSER;
  // The user's default browser first (xdg), when it is Chromium-based (same cookie format).
  try {
    const desk = require("child_process").execFileSync("xdg-settings", ["get", "default-web-browser"], { encoding: "utf8", timeout: 3000 }).trim();
    const base = desk.replace(/\.desktop$/, "");
    const hit = CHROMIUM_FAMILY.find(b => base === b || base.startsWith(b)) && onPath(base);
    if (hit) return hit;
    log(`LOGIN default browser ${desk} is not Chromium-based (or not on PATH); using another one`);
  } catch (e) { log(`LOGIN xdg-settings failed: ${e && e.message}`); }
  for (const b of CHROMIUM_FAMILY) { const f = onPath(b); if (f) return f; }
  return null;
}
const SESSION_COOKIES = new Set(["sessionid", "sessionid_ss", "sid_tt", "sid_guard"]);
const isDolaHost = h => /(^|\.)dola\.com$/.test(String(h).replace(/^\./, ""));
// Chromium on Linux with --password-store=basic: "v10" + AES-128-CBC, key PBKDF2-SHA1
// ("peanuts", "saltysalt", 1 iteration), IV of 16 spaces. From cookie DB version 24 on, the
// plaintext starts with SHA-256(host_key).
const BASIC_KEY = crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
function decryptCookie(enc, hostKey, dbVersion) {
  const b = Buffer.from(enc);
  if (b.length < 3 || b.subarray(0, 3).toString() !== "v10") return null;
  const d = crypto.createDecipheriv("aes-128-cbc", BASIC_KEY, Buffer.alloc(16, " "));
  let out = Buffer.concat([d.update(b.subarray(3)), d.final()]);
  if (dbVersion >= 24 && out.length >= 32 &&
      out.subarray(0, 32).equals(crypto.createHash("sha256").update(hostKey).digest())) out = out.subarray(32);
  return out.toString("utf8");
}
// Chromium keeps the DB open and flushes about every 30 s: read a copy.
function readDolaCookies(prof) {
  const src = path.join(prof, "Default", "Cookies");
  if (!fs.existsSync(src)) return [];
  const tmp = path.join(prof, "..", "login-cookies-copy");
  fs.copyFileSync(src, tmp);
  try { fs.copyFileSync(src + "-journal", tmp + "-journal"); } catch { try { fs.unlinkSync(tmp + "-journal"); } catch {} }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(tmp, { readOnly: true });
  try {
    let ver = 0;
    try { ver = Number(db.prepare("SELECT value FROM meta WHERE key='version'").get().value) || 0; } catch {}
    // Chromium time is microseconds since 1601-01-01, beyond a JS number: convert in SQL.
    const rows = db.prepare("SELECT host_key, name, value, encrypted_value, path, " +
      "CASE WHEN expires_utc > 0 THEN expires_utc / 1000000 - 11644473600 ELSE 0 END AS expires, " +
      "is_secure, is_httponly, samesite FROM cookies").all();
    return rows.filter(r => isDolaHost(r.host_key)).map(r => ({
      domain: r.host_key, name: r.name, path: r.path || "/", secure: !!r.is_secure, httpOnly: !!r.is_httponly,
      value: r.value || decryptCookie(r.encrypted_value, r.host_key, ver) || "",
      expires: Number(r.expires) || 0,
      sameSite: { 0: "no_restriction", 1: "lax", 2: "strict" }[r.samesite] || "unspecified",
    }));
  } finally { db.close(); }
}
// The browser's real main process, from the profile's SingletonLock ("<host>-<pid>"). The
// launcher (brave-browser, google-chrome) is a wrapper that exits at once, so its own
// pid/exit says nothing. The pid is only trusted if its command line names this profile.
function profileBrowserPid(prof) {
  try {
    const pid = Number(fs.readlinkSync(path.join(prof, "SingletonLock")).split("-").pop());
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    // Chromium may rewrite its argv as one space-separated string (process title).
    const flag = `--user-data-dir=${prof}`;
    return [flag + "\0", flag + " "].some(f => cmd.includes(f)) || cmd.endsWith(flag) ? pid : null;
  } catch { return null; }
}
let loginPoll = null;
const LOGIN_WAIT_MS = 15 * 60 * 1000;
function systemLogin(_idpUrl) {
  const bin = findLoginBrowser();
  if (!bin) { log("LOGIN no Chromium-family browser found, falling back to an embedded tab"); return false; }
  const prof = path.join(app.getPath("userData"), "login-browser-" + path.basename(bin));
  fs.mkdirSync(prof, { recursive: true });
  // www.dola.com itself, not the IdP URL: that URL carries an OAuth state bound to the app's
  // cookies, which a fresh profile does not have. The website runs its own complete flow.
  // A second click just opens another window in the running instance of that profile.
  const proc = require("child_process").spawn(bin, [`--user-data-dir=${prof}`, "--password-store=basic", "--no-first-run",
    "--no-default-browser-check", "--new-window", "https://www.dola.com/"], { stdio: "ignore" });
  proc.on("error", e => log(`LOGIN browser spawn failed: ${e && e.message}`));
  log(`LOGIN browser ${bin} launcher pid=${proc.pid} profile=${prof}`);
  if (loginPoll) return true;   // already watching this profile
  const started = Date.now();
  loginPoll = (async () => {
    let seenRunning = false, missing = 0;
    while (Date.now() - started < LOGIN_WAIT_MS) {
      await new Promise(r => setTimeout(r, 2000));
      // Closed by the user: closing flushes the cookie DB, so read a few more times, then stop.
      if (profileBrowserPid(prof)) seenRunning = true;
      else if (seenRunning && ++missing > 3) break;
      let got;
      try { got = readDolaCookies(prof); } catch (e) { log(`LOGIN cookie read failed: ${e && e.message}`); continue; }
      if (!got.some(c => SESSION_COOKIES.has(c.name) && c.value)) continue;
      for (const c of got) {
        try {
          await session.defaultSession.cookies.set({ url: `https://${c.domain.replace(/^\./, "")}${c.path}`, name: c.name, value: c.value,
            domain: c.domain.startsWith(".") ? c.domain : undefined, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
            sameSite: c.sameSite, expirationDate: c.expires > 0 ? c.expires : undefined });
        } catch (e) { log(`COOKIE copy failed ${c.name}: ${e && e.message}`); }
      }
      log(`LOGIN session received from the browser (${got.length} dola.com cookies)`);
      const pid = profileBrowserPid(prof);   // the login profile's own browser, nothing else
      if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
      if (loginWin && !loginWin.isDestroyed()) loginWin.close();   // closing reloads the main view
      else if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.reload();
      return;
    }
    log("LOGIN stopped watching: browser closed or timed out without a dola.com session");
  })().catch(e => log(`LOGIN browser error: ${e && e.message}`)).finally(() => { loginPoll = null; });
  return true;
}
function openTab(url) {
  const t = newWindow({ width: 1000, height: 760, title: "Dola", autoHideMenuBar: true }, "tab", tabSes());
  chromeIdentity(t.webContents);
  t.webContents.on("did-navigate", (_e, u) => log(`TAB nav ${u.slice(0, 120)}`));
  tabs.add(t);
  t.on("closed", () => tabs.delete(t));
  t.loadURL(url);
  log(`TAB open ${url.slice(0, 160)}`);
  if (process.env.DOLA_HOST_TAB_SHOT) t.webContents.once("did-finish-load", () => setTimeout(async () => {
    if (!t.isDestroyed()) { fs.writeFileSync(process.env.DOLA_HOST_TAB_SHOT, (await t.webContents.capturePage()).toPNG()); log(`TAB screenshot ${t.webContents.getURL().slice(0, 120)}`); }
  }, 6000));
  return t;
}

// One instance per profile. Two Electron processes on the same userData fight over its
// IndexedDB/LocalStorage locks and the UI breaks (seen 2026-11-14: after the first
// message the composer went blank). A second launch (menu, launcher) brings the running
// window forward instead.
if (!app.requestSingleInstanceLock()) {
  log("SINGLE-INSTANCE another Dola is running on this profile; handing over");
  app.exit(0);
}
app.on("second-instance", () => {
  const w = mainWin;
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
});

// The UI recognises the desktop client by its User-Agent token "SamanthaDola/<version>":
// that is where pc_version comes from, and without it the server answers as to a
// generic web client (no mode-select menu in action_bar_v3/brief_list, so the composer
// of every conversation stays on its empty fallback). Version: the Windows client the
// update API offers (www.dola.com/samantha/desktop/get_latest_version, 2026-11-14).
const DOLA_CLIENT_VERSION = process.env.DOLA_CLIENT_VERSION || "2.32.6";

app.whenReady().then(() => {
  app.userAgentFallback = `${chromeUA()} SamanthaDola/${DOLA_CLIENT_VERSION}`;
  session.defaultSession.setUserAgent(app.userAgentFallback);
  log(`UA ${app.userAgentFallback}`);
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
    try {
      return await net.fetch(req, { bypassCustomProtocolHandlers: true });
    } catch (e) {   // DNS/connection failures must not become uncaught exceptions
      log(`NETERR ${u.hostname}${u.pathname} ${e && e.message}`);
      return new Response("", { status: 502, statusText: String(e && e.message || "network error") });
    }
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
