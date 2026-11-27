// Dump the runtime JS of the logged-in Muse web client (protocol RE helper).
//
//   electron --no-sandbox tools/webclient-dump.js [--profile DIR] [--url URL] [--out DIR]
//
// The web client ships a complete Noise + CVM-gateway implementation; this
// helper lists every JS resource the app loads so the chunks can be fetched
// and grepped (see docs/PROTOCOL.md §9). Use a *copy* of the desktop profile
// (~/.config/muse-desktop), never the live one.
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT = path.resolve(arg('--out', '/tmp/opencode/muse-webclient'));
const PROFILE = path.resolve(arg('--profile', path.join(OUT, 'profile')));
const TARGET = arg('--url', 'https://muse.ai/?settings_tab=permissions&pane=connectors');
const WAIT_MS = Number(arg('--wait', '15000'));

app.setName('muse-desktop');
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('disable-gpu');

const META_DOMAINS = [/(^|\.)muse\.ai$/i,/(^|\.)meta\.ai$/i,/(^|\.)meta\.com$/i,/(^|\.)facebook\.com$/i,/(^|\.)instagram\.com$/i,/(^|\.)fbcdn\.net$/i,/(^|\.)cdninstagram\.com$/i,/(^|\.)whatsapp\.net$/i];
const isMetaHost = (u) => { try { const h = new URL(u).hostname; return META_DOMAINS.some((r) => r.test(h)); } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:muse');
  ses.setUserAgent(ses.getUserAgent().replace(/ muse-desktop\/[0-9.]+/i, '').replace(/ Electron\/[0-9.]+/i, '').replace(/\s{2,}/g, ' '));
  const allowed = new Set(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL && wc.getURL()) || '';
    cb(allowed.has(permission) && isMetaHost(url));
  });

  const win = new BrowserWindow({ width: 1440, height: 900, show: true,
    webPreferences: { partition: 'persist:muse', contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on('will-navigate', (e, u) => { if (/^https?:/i.test(u) && !isMetaHost(u)) e.preventDefault(); });

  await win.loadURL(TARGET).catch(() => {});
  await sleep(WAIT_MS);

  const urls = await win.webContents.executeJavaScript(`(() => {
    const out = new Set();
    performance.getEntriesByType('resource').forEach((e) => {
      if (e.name.includes('.js') || e.name.includes('/_next/')) out.add(e.name);
    });
    return [...out];
  })()`, true).catch(() => []);

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'runtime-js.json'), JSON.stringify(urls, null, 2));
  fs.writeFileSync(path.join(OUT, 'runtime-js.txt'), urls.join('\n'));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'screen.png'), img.toPNG());
  console.log(`WROTE ${urls.length} urls -> ${OUT}`);
  app.quit();
});
