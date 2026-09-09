// ReachPilot Desktop — Electron main process.
//
// ONE seamless app: the window shows the normal ReachPilot dashboard (the same
// web app, signup/onboarding unchanged). The ONLY thing this desktop adds is a
// SILENT background agent that runs the LinkedIn automation on THIS machine — so
// every LinkedIn action (and the one-time login) egresses from the user's OWN
// residential IP instead of a server/proxy. No separate screen, no buttons.
//
// How it works: the server orchestrates exactly as before and, in remote mode,
// dispatches each LinkedIn job to this agent. The agent reads the logged-in
// user's token from the dashboard and polls /api/agent/next-job, runs the REAL
// driver locally, and reports the result back.
//
// Security: the dashboard is REMOTE web content and gets NO preload / no IPC —
// it can never drive local Playwright. The agent runs only in this main process.

const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Persist the agent console to a file. The driver already logs exactly what it
// saw on a failing profile (which Connect controls, which branch it took) — in a
// packaged app that went to a stdout nobody can read, so every field failure was
// undiagnosable. Truncate at 5 MB rather than rotate; this is a debug tail, not
// an audit trail.
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

// First-run: make sure the agent can drive a browser, REUSING anything already
// present (system Chrome, or a Playwright Chromium already downloaded) and only
// downloading as a last resort — then VERIFY before we ever show signup.
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
  // Real Google Chrome (the driver prefers channel:'chrome' — best for stealth).
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
  // Run `playwright install chromium` using THIS Electron binary as Node. The
  // package is asar-unpacked, so resolve cli.js to its real on-disk path.
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

// 🔴 WHY THIS EXISTS. The LinkedIn driver does not run on our servers — it is
// esbuild-bundled into THIS app and runs on each user's machine. So a driver
// fix used to reach a customer only if that customer downloaded and reinstalled
// the app, which is not a thing anyone can be asked to do per bug. Observed:
// an Aug-7 bundle still running against an Aug-24 driver, with no signal to
// anyone that the two had diverged. This closes that gap — a driver fix now
// ships on an app restart, the same way a server fix ships on a deploy.
//
// Feed: GitHub Releases on the PUBLIC repo (see "publish" in package.json), so
// there is no server to run and NO TOKEN inside the app. electron-updater
// verifies each download against the sha512 in latest.yml, which is what makes
// an unsigned build safe to auto-update: a tampered file fails the hash and is
// discarded rather than installed.
//
// ⚠️ Every release MUST bump "version" in package.json. electron-updater
// compares versions, so shipping two builds under one version silently
// delivers nothing — exactly the failure this code exists to prevent.
function initAutoUpdate() {
  // Only a packaged, installed app can update itself; in dev this would just
  // throw ("dev-app-update.yml not found") on every launch.
  if (!app.isPackaged) return;
  let updater;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch (e) {
    alog('auto-update unavailable:', (e && e.message) || e);
    return;
  }
  updater.logger = { info: alog, warn: alog, error: alog, debug: () => {} };
  // Download in the background; ask before RESTARTING, never before downloading.
  // An unattended download costs the user nothing, but an unannounced restart
  // would kill a LinkedIn action mid-flight — and this app's whole job is to be
  // the executor, so it must never disappear underneath a running invite.
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  updater.on('error', (e) => alog('auto-update error:', (e && e.message) || e));
  updater.on('update-available', (i) => alog('update available:', i && i.version));
  updater.on('update-not-available', () => alog('already on the latest version'));

  updater.on('update-downloaded', async (info) => {
    const version = (info && info.version) || '';
    alog('update downloaded:', version, '— offering restart');
    // The dashboard is REMOTE web content with no preload and no IPC (see the
    // file header), so this prompt cannot be an in-page banner without handing
    // remote content a channel into this process. A native dialog gives the same
    // one-click "relaunch to update" without touching that boundary.
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
      // isSilent=true, isForceRunAfter=true — reinstall without the NSIS wizard
      // and come straight back up, so the agent resumes polling on its own.
      updater.quitAndInstall(true, true);
    }
  });

  const check = () => updater.checkForUpdates().catch((e) => alog('update check failed:', (e && e.message) || e));
  check();
  // A laptop that stays open for days would otherwise never see a new build.
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

// Execute one dispatched job with the real driver, keyed by the server's
// accountId so the persistent profile (session) is shared across login + actions.
async function runJob(job) {
  const d = getDriver();
  // The session the server holds for this account, forwarded per job. `cookies`
  // is the full captured jar; `li_at` is the same session in the older one-cookie
  // form, kept so an older server still works. The driver only SEEDS a profile
  // that has no session of its own — it never overwrites a live one (that bug
  // destroyed hand-made logins on the next job). Actions reuse the account's
  // persistent profile on the user's own IP.
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

// The logged-in user's access token lives in the dashboard's localStorage, and
// so does the Settings toggle for showing the browser window. Read both fresh
// each cycle so login/logout, token refresh, and flipping the toggle mid-run are
// all handled for free (each action opens its own context, so the next job picks
// up the new value). Unset headless key = headed, the previous behaviour.
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

// The public IP this machine egresses from — the SAME residential IP LinkedIn
// sees when the bundled driver runs (no proxy in desktop mode). Reported back
// with each result so the server can record which IP an account operates from.
// Best-effort: a short timeout + null on any failure so it NEVER blocks a job.
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
  // Tell the server which build is polling.
  //
  // 🔴 The point is what it says when it is ABSENT. Builds before 0.1.1 have no
  // auto-updater and can never be changed, so they will never send this header —
  // which makes its absence the one reliable signal that an install is stuck on a
  // pre-update build and needs a one-time manual reinstall. Without it every
  // agent looks identical and "which of my users still has the bug?" is
  // unanswerable. Do not make this conditional or optional on newer builds; the
  // whole mechanism rests on new = present, old = missing.
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
  // Capture the egress IP up front — the same IP the driver is about to run from —
  // so we can report it even when the job itself fails.
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
