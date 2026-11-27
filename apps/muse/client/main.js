// Muse (Meta) — native Linux shell (lAInux corpus).
// v0: the official Muse web app in a first-class window: isolated profile,
// no Electron fingerprint, login (auth.meta.com / accountscenter) inside the
// window, auth popups allowed. The protocol-native client (edge-chat WS,
// native composer) grows inside this same shell.
const { app, BrowserWindow, Menu } = require('electron');
const os = require('os');
const path = require('path');
const { startCredentialBroker } = require('./broker');
const {
  acquireColdLease,
  coldLeaseSession,
  noiseNotaryToken,
  noiseToken,
  standardSession,
} = require('../daemon/lib/credentials');

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

let win = null;

async function hatchFetch(input, init = {}) {
  if (!win || win.isDestroyed()) throw new Error('Muse window is not ready');
  const { signal: _signal, ...options } = init;
  const script = `(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch(${JSON.stringify(input)}, {
        ...${JSON.stringify(options)},
        signal: controller.signal,
      });
      return { status: response.status, ok: response.ok, text: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  })()`;
  const result = await win.webContents.executeJavaScript(script, true);
  return {
    status: result.status,
    ok: result.ok,
    text: async () => result.text,
  };
}

async function handleBrokerRequest(method, params) {
  switch (method) {
    case 'session.status':
      return { ready: app.isReady(), partition: PARTITION, url: win?.webContents.getURL() ?? null };
    case 'credentials.standardSession':
      return standardSession(hatchFetch, params);
    case 'credentials.coldLease':
      return acquireColdLease(hatchFetch, { timeoutMs: 90000 });
    case 'credentials.coldSession':
      return coldLeaseSession(hatchFetch, params.vmId);
    case 'credentials.token':
      return noiseToken(hatchFetch, params);
    case 'credentials.notary':
      return noiseNotaryToken(hatchFetch, params.vmName);
    default:
      throw new Error(`Unknown Muse broker method: ${method}`);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let broker = null;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      broker = await startCredentialBroker({ profile: PROFILE, handler: handleBrokerRequest });
      console.log('[muse] local credential broker ready');
    } catch (error) {
      console.error('[muse] credential broker failed:', error.message);
    }
    win = makeWindow(HOME_URL);
  });

  app.on('before-quit', () => {
    broker?.close();
  });

  app.on('window-all-closed', () => app.quit());
}
