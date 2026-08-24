// Bridges the renderer UI to the Electron main process (where Playwright runs).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rp', {
  checkIp: () => ipcRenderer.invoke('check-ip'),
  openLinkedin: () => ipcRenderer.invoke('open-linkedin'),
  loginStatus: () => ipcRenderer.invoke('login-status'),
  findConnect: (url) => ipcRenderer.invoke('find-connect', url),
  agentAccount: (cfg) => ipcRenderer.invoke('agent-account', cfg),
  agentLogin: (creds) => ipcRenderer.invoke('agent-login', creds),
  startAgent: (cfg) => ipcRenderer.invoke('start-agent', cfg),
  stopAgent: () => ipcRenderer.invoke('stop-agent'),
  onAgentLog: (cb) => ipcRenderer.on('agent-log', (_e, msg) => cb(msg)),
});
