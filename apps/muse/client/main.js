// Muse (Meta) — native Linux shell (lAInux corpus).
// v0: the official Muse web app in a first-class window: isolated profile,
// no Electron fingerprint, login (auth.meta.com / accountscenter) inside the
// window, auth popups allowed. The protocol-native client (edge-chat WS,
// native composer) grows inside this same shell.
const { app, BrowserWindow, Menu } = require('electron');
const os = require('os');
const path = require('path');

const PROFILE = process.env.MUSE_PROFILE || path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'muse-desktop'
);
const PARTITION = 'persist:muse';
const HOME_URL = 'https://muse.ai/';

app.setName('muse-desktop');
app.setPath('userData', PROFILE);

const META_DOMAINS = [
  /(^|\.)muse\.ai$/i, /(^|\.)meta\.ai$/i, /(^|\.)meta\.com$/i,
  /(^|\.)facebook\.com$/i, /(^|\.)instagram\.com$/i,
  /(^|\.)fbcdn\.net$/i, /(^|\.)cdninstagram\.com$/i, /(^|\.)whatsapp\.net$/i,
];
const isMetaHost = (u) => {
  try { const h = new URL(u).hostname; return META_DOMAINS.some((r) => r.test(h)); }
  catch { return false; }
};

function cleanUA(ua) {
  return ua
    .replace(/ muse-desktop\/[0-9.]+/i, '')
    .replace(/ Electron\/[0-9.]+/i, '')
    .replace(/\s{2,}/g, ' ');
}

function hardenSession(ses) {
  ses.setUserAgent(cleanUA(ses.getUserAgent()));
  const allowed = new Set([
    'media', 'notifications', 'clipboard-read',
    'clipboard-sanitized-write', 'fullscreen', 'pointerLock',
  ]);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL && wc.getURL()) || '';
    cb(allowed.has(permission) && isMetaHost(url));
  });
}

function makeWindow(url) {
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: 'Muse',
    icon: path.join(__dirname, 'muse.png'),
    autoHideMenuBar: true,
    backgroundColor: '#0b0b0f',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  hardenSession(w.webContents.session);
  // Auth flows (facebook login, accountscenter) open popups — keep them
  // in-app on the same persistent partition so the session sticks.
  w.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 520,
      height: 720,
      autoHideMenuBar: true,
      backgroundColor: '#0b0b0f',
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    },
  }));
  w.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => {
    console.error('[muse] load failed', code, desc, failedUrl);
  });
  w.loadURL(url);
  return w;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let win = null;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    win = makeWindow(HOME_URL);
  });

  app.on('window-all-closed', () => app.quit());
}
