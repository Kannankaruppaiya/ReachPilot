// ReachPilot Desktop (Electron main process). The window shows the normal web
// dashboard; a silent background agent polls /api/agent/next-job with the
// user's token and runs the real LinkedIn driver on this machine's own IP.
// The dashboard is remote content with no preload and no IPC, so it can never
// drive local Playwright.

const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Agent console log in userData (packaged stdout is unreadable). Truncated at 5 MB.
const AGENT_LOG = path.join(app.getPath('userData'), 'agent.log');
try {
  if (fs.statSync(AGENT_LOG).size > 5 * 1024 * 1024) fs.truncateSync(AGENT_LOG, 0);
} catch {}
for (const level of ['log', 'warn', 'error', 'debug']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    orig(...a);
    try {
      const line = a
        .map((x) => (typeof x === 'string' ? x : JSON.stringify(x, (_k, v) => (v instanceof Error ? String(v) : v))))
        .join(' ');
      fs.appendFileSync(AGENT_LOG, `${new Date().toISOString()} ${line}
`);
    } catch {}
  };
}

const DASHBOARD_URL = 'https://reachpilot-eight.vercel.app';
const API_BASE = 'https://api.reachpilot.dpdns.org';
const ACCESS_TOKEN_KEY = 'rp_access'; // dashboard's localStorage keys (src/constants)
const HEADLESS_KEY = 'rp_headless';

let mainWin = null;
let realDriver = null; // the bundled REAL PlaywrightLinkedInDriver (built by build:agent)
let looping = false;

/* ---------------- window + first-run setup ---------------- */

// Push a status line to the setup screen (setup.html defines window.setStatus).
function setStatus(msg, isError) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents
      .executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(msg)}, ${isError ? 'true' : 'false'})`)
      .catch(() => {});
  }
}

// First run: reuse system Chrome or an existing Playwright Chromium, download
// only as a last resort, and verify before showing signup.
async function ensureSetup() {
  const fs = require('fs');
  const os = require('os');

  // A Playwright Chromium lives at <root>/chromium-<rev>/chrome-win64/chrome.exe.
  const hasChromium = (root) => {
    try {
      return fs.existsSync(root) && fs.readdirSync(root).some(
        (d) => d.startsWith('chromium-') && fs.existsSync(path.join(root, d, 'chrome-win64', 'chrome.exe')),
      );
    } catch { return false; }
  };
  // Real Google Chrome (the driver prefers channel:'chrome').
  const systemChrome = () => {
    const c = [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData\\Local'), 'Google\\Chrome\\Application\\chrome.exe'),
    ];
    return c.some((p) => { try { return fs.existsSync(p); } catch { return false; } });
  };

  const defaultCache = path.join(process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  const appCache = path.join(app.getPath('userData'), 'ms-playwright');

  // 1) System Chrome present → the driver will use it; no download needed.
  if (systemChrome()) return;
  // 2) A Playwright Chromium already in the default cache (dev / prior install)? Reuse it.
  if (hasChromium(defaultCache)) { process.env.PLAYWRIGHT_BROWSERS_PATH = defaultCache; return; }
  // 3) Already downloaded into our app dir on a previous run? Reuse it.
  if (hasChromium(appCache)) { process.env.PLAYWRIGHT_BROWSERS_PATH = appCache; return; }

  // 4) Nothing found → download once into our own writable dir.
  process.env.PLAYWRIGHT_BROWSERS_PATH = appCache;
  fs.mkdirSync(appCache, { recursive: true });
  setStatus('Downloading browser (one-time, ~150 MB)…');
  // Run `playwright install chromium` with this Electron binary as Node; cli.js is
  // asar-unpacked.
  const cli = require.resolve('playwright/cli.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const { execFile } = require('child_process');
  await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cli, 'install', 'chromium'],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    );
    const onData = (d) => setStatus(String(d).replace(/\s+/g, ' ').trim().slice(0, 70));
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('browser install exited ' + code))));
  });

  // VERIFY it actually landed before continuing to signup.
  if (!hasChromium(appCache)) throw new Error('Browser missing after download');
}

async function boot() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'ReachPilot',
    webPreferences: { contextIsolation: true, nodeIntegration: false }, // NO preload for remote UI
  });
  mainWin.on('closed', () => { mainWin = null; });
  // Open external links (LinkedIn "Open profile", etc.) in the system browser.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(DASHBOARD_URL)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  await mainWin.loadFile(path.join(__dirname, 'setup.html'));
  try {
    setStatus('Checking setup…');
    await ensureSetup(); // download + verify the browser FIRST
    setStatus('Ready! Opening ReachPilot…');
    await mainWin.loadURL(DASHBOARD_URL); // normal signup/onboarding, unchanged
    agentLoop(); // silent background agent — runs LinkedIn jobs on THIS machine's IP
  } catch (e) {
    setStatus('Setup failed: ' + ((e && e.message) || e) + '. Check your internet and restart.', true);
  }
}

/* ---------------- auto-update ---------------- */

// Auto-update: the LinkedIn driver ships inside this app, so updates are how a
// driver fix reaches users. Feed = GitHub Releases on the public repo (no token);
// electron-updater checks each download's sha512 from latest.yml.
// ⚠️ Every release MUST bump "version" in package.json, or nothing is delivered.
function initAutoUpdate() {
  // Only a packaged app can update; in dev this throws on every launch.
  if (!app.isPackaged) return;
  let updater;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch (e) {
    alog('auto-update unavailable:', (e && e.message) || e);
    return;
  }
  updater.logger = { info: alog, warn: alog, error: alog, debug: () => {} };
  // Download silently, but ask before restarting: a restart would kill a running action.
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  updater.on('error', (e) => alog('auto-update error:', (e && e.message) || e));
  updater.on('update-available', (i) => alog('update available:', i && i.version));
  updater.on('update-not-available', () => alog('already on the latest version'));

  updater.on('update-downloaded', async (info) => {
    const version = (info && info.version) || '';
    alog('update downloaded:', version, '— offering restart');
    // A native dialog: the remote dashboard has no IPC channel for an in-page prompt.
    const { dialog } = require('electron');
    const { response } = await dialog.showMessageBox(mainWin && !mainWin.isDestroyed() ? mainWin : null, {
      type: 'info',
      buttons: ['Relaunch now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `ReachPilot ${version} is ready to install.`,
      detail:
        'Relaunching takes a few seconds. If you choose Later, the update installs by itself the next time you close ReachPilot.',
    });
    if (response === 0) {
      // Silent reinstall, then relaunch so the agent resumes polling.
      updater.quitAndInstall(true, true);
    }
  });

  const check = () => updater.checkForUpdates().catch((e) => alog('update check failed:', (e && e.message) || e));
  check();
  // Also check periodically; a laptop can stay open for days.
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'ReachPilot', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
  ]));
  boot();
  initAutoUpdate();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) boot(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ---------------- the REAL driver (bundled from server-v2, no duplication) ---------------- */

function getDriver() {
  if (!realDriver) {
    const { PlaywrightLinkedInDriver } = require(path.join(__dirname, 'agent', 'driver.bundle.js'));
    realDriver = new PlaywrightLinkedInDriver();
  }
  return realDriver;
}

// Run one dispatched job, keyed by the server's accountId so login and actions
// share one persistent profile.
async function runJob(job) {
  const d = getDriver();
  // `cookies` is the full jar; `li_at` is kept for older servers. The driver only
  // seeds a profile that has no session of its own.
  const ctx = {
    accountId: job.accountId,
    workspaceId: job.workspaceId,
    li_at: job.li_at,
    cookies: job.cookies,
  };
  switch (job.action) {
    case 'login':
      // One-time login on the user's own IP — populates the accountId profile.
      return d.login({ accountId: job.accountId, workspaceId: job.workspaceId, email: job.email, password: job.password, totpSecret: job.totpSecret });
    case 'connect_request': return d.sendConnectRequest(job.targetUrl, job.message || '', ctx);
    case 'linkedin_message': return d.sendMessage(job.targetUrl, job.message || '', ctx);
    case 'visit_profile': return d.visitProfile(job.targetUrl, ctx);
    case 'follow': return d.follow(job.targetUrl, ctx);
    case 'inmail': return d.sendInMail(job.targetUrl, job.subject || '', job.message || '', ctx);
    case 'like_post': return d.likeRecentPost(job.targetUrl, ctx);
    case 'endorse_skill': return d.endorseSkill(job.targetUrl, ctx);
    default: return { status: 'failed', error: `unknown_action:${job.action}` };
  }
}

/* ---------------- silent background agent poll loop ---------------- */

// Read the token and the "show browser" toggle from the dashboard's localStorage
// each cycle, so login/logout and toggle changes apply to the next job.
async function readDashboardState() {
  if (!mainWin || mainWin.isDestroyed()) return {};
  try {
    return await mainWin.webContents.executeJavaScript(
      `({ token: localStorage.getItem(${JSON.stringify(ACCESS_TOKEN_KEY)}),
          headless: localStorage.getItem(${JSON.stringify(HEADLESS_KEY)}) === '1' })`,
      true,
    );
  } catch {
    return {};
  }
}

function alog(...a) { console.log('[agent]', new Date().toISOString().slice(11, 19), ...a); }

// This machine's public IP (what LinkedIn sees), reported with each result.
// Best-effort with a short timeout; never blocks a job.
async function getPublicIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j && j.ip) || null;
  } catch {
    return null;
  }
}

async function pollOnce(token) {
  // 🔴 Always send X-Agent-Version: builds before 0.1.1 can't auto-update and never
  // send it, so a missing header is how the server spots them. Never make it optional.
  const h = { Authorization: `Bearer ${token}`, 'X-Agent-Version': app.getVersion() };
  let res;
  try {
    res = await fetch(`${API_BASE}/api/agent/next-job`, { headers: h });
  } catch (e) {
    alog('next-job fetch ERROR:', (e && e.message) || e);
    return false;
  }
  if (!res.ok) { alog('next-job HTTP', res.status); return false; }
  const { job } = await res.json();
  if (!job) return false;
  alog('got job:', job.action, job.accountId);
  // Capture the IP up front so it's reported even when the job fails.
  const reportedIp = await getPublicIp();
  const result = await runJob(job).catch((e) => ({ status: 'failed', error: String((e && e.message) || e) }));
  if (result && typeof result === 'object' && reportedIp) result.reportedIp = reportedIp;
  alog('job', job.action, '→', result.status, result.error || '', reportedIp ? `ip=${reportedIp}` : '');
  await fetch(`${API_BASE}/api/agent/job-result`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: job.token, result }),
  }).catch((e) => alog('post result ERROR:', (e && e.message) || e));
  return true;
}

let lastTokenState = null;
async function agentLoop() {
  if (looping) return;
  looping = true;
  alog('agent loop started → polling', API_BASE);
  for (;;) {
    let busy = false;
    try {
      const { token, headless } = await readDashboardState(); // token null until logged in
      // The bundled driver reads this via agent/shims/env.js at context launch.
      process.env.PLAYWRIGHT_HEADLESS = headless ? '1' : '0';
      const state = token ? 'token PRESENT' : 'no token yet (log in to the dashboard)';
      if (state !== lastTokenState) { alog(state); lastTokenState = state; }
      if (token) busy = await pollOnce(token);
    } catch (e) {
      alog('loop error:', (e && e.message) || e);
    }
    await new Promise((r) => setTimeout(r, busy ? 500 : 5000)); // fast when busy, idle 5s
  }
}
