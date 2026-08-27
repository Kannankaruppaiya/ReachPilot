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
const ACCESS_TOKEN_KEY = 'rp_access'; // dashboard's localStorage key (src/constants)

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

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'ReachPilot', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
  ]));
  boot();
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

// The logged-in user's access token lives in the dashboard's localStorage. Read
// it fresh each cycle so login/logout and token refresh are handled for free.
async function readToken() {
  if (!mainWin || mainWin.isDestroyed()) return null;
  try {
    const t = await mainWin.webContents.executeJavaScript(
      `localStorage.getItem(${JSON.stringify(ACCESS_TOKEN_KEY)})`,
      true,
    );
    return t || null;
  } catch {
    return null;
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
  const h = { Authorization: `Bearer ${token}` };
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
      const token = await readToken(); // null until the user is logged into the dashboard
      const state = token ? 'token PRESENT' : 'no token yet (log in to the dashboard)';
      if (state !== lastTokenState) { alog(state); lastTokenState = state; }
      if (token) busy = await pollOnce(token);
    } catch (e) {
      alog('loop error:', (e && e.message) || e);
    }
    await new Promise((r) => setTimeout(r, busy ? 500 : 5000)); // fast when busy, idle 5s
  }
}
