'use strict';
/**
 * Antigravity Context Meter Electron 主进程钩子与 IPC 通道 (meter-main.js)
 */

const fs = require('fs');
const path = require('path');
let ipcMain = null;
let electronSession = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object') {
    ipcMain = electron.ipcMain;
    electronSession = electron.session || null;
  }
} catch {}

const { normalizeLoopbackOrigin } = require('./local-api');
const { getProjectVersion } = require('./meter-storage');
const { collect, collectTurnState, collectDailyUsage, collectQuotaSummary, getSettings, saveSettings } = require('./meter-collector');

const RENDERER_CSRF_EXPR = '(() => { try { const a = window.__APP_CONFIG__ && window.__APP_CONFIG__.csrfToken; if (typeof a === "string" && a.trim()) return a.trim(); const b = window.localStorage && window.localStorage.getItem("agy_session_csrf_token"); return typeof b === "string" ? b.trim() : ""; } catch { return ""; } })()';

const PROJECT_VERSION = getProjectVersion('1.0.0');
const MAIN_STARTED_AT = Date.now();
const MAIN_CAPABILITIES = {
  scan: true,
  turnState: true,
  dailyUsage: true,
  quota: true,
  settings: true
};

const boundWindows = new WeakSet();
const boundWebContents = new WeakSet();
const inFlightInjections = new WeakMap();
const wcProbeTimers = new WeakMap();
const meterSourceCache = new Map();
let ipcRegistered = false;

function getWindowWebContents(win) {
  if (!win || win.isDestroyed?.()) return null;
  if (win.webContents && !win.webContents.isDestroyed?.()) return win.webContents;
  if (typeof win.getBrowserViews === 'function') {
    try {
      const views = win.getBrowserViews() || [];
      for (const v of views) {
        if (v?.webContents && !v.webContents.isDestroyed?.()) return v.webContents;
      }
    } catch {}
  }
  if (win.contentView && Array.isArray(win.contentView.children)) {
    for (const child of win.contentView.children) {
      if (child?.webContents && !child.webContents.isDestroyed?.()) return child.webContents;
    }
  }
  return null;
}

function isLocalMainFrameSender(event) {
  try {
    const rawUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    return normalizeLoopbackOrigin(rawUrl);
  } catch {
    return null;
  }
}

function resolveHostRemoteBackend(sender) {
  try {
    if (!sender) return null;
    const mod = require('./remote/windowBackends');
    if (mod && typeof mod.remoteBackendOf === 'function') {
      return mod.remoteBackendOf(sender) || null;
    }
  } catch {}
  return null;
}

function buildCollectorOptions(event, extraOptions = {}, deps = {}) {
  const sender = event?.sender || null;
  const senderSession = sender?.session || null;
  const remoteBackend = typeof deps.resolveRemoteBackend === 'function'
    ? deps.resolveRemoteBackend(sender)
    : resolveHostRemoteBackend(sender);
  const defaultSession = deps.defaultSession !== undefined ? deps.defaultSession : (electronSession?.defaultSession || null);
  const isRemote = Boolean(remoteBackend || (senderSession && defaultSession && senderSession !== defaultSession));
  const originScopeKey = isRemote
    ? (remoteBackend?.hostId ? `ssh:${remoteBackend.hostId}` : (typeof sender?.id === 'number' ? `remote-wc:${sender.id}` : 'remote'))
    : '';

  const opts = { ...extraOptions };
  if (isRemote) {
    opts.isRemote = true;
    opts.originScopeKey = originScopeKey;
    if (senderSession && typeof senderSession.fetch === 'function') {
      opts.sessionFetch = (url, init) => senderSession.fetch(url, init);
    }
  }
  if (sender && !sender.isDestroyed?.() && typeof sender.executeJavaScript === 'function') {
    opts.resolveRendererCsrfToken = async () => {
      try {
        if (sender.isDestroyed?.()) return '';
        const tok = await sender.executeJavaScript(RENDERER_CSRF_EXPR);
        return typeof tok === 'string' ? tok.trim() : '';
      } catch {
        return '';
      }
    };
  }
  return { opts, isRemote, remoteHost: remoteBackend?.label || null };
}

function getMeterSource() {
  const key = __dirname;
  if (meterSourceCache.has(key)) return meterSourceCache.get(key);
  const core = fs.readFileSync(path.join(__dirname, 'meter-core.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
  const combined = `${core}\n${renderer}\ntrue;`;
  meterSourceCache.set(key, combined);
  return combined;
}

function clearMeterSourceCacheForTest() {
  meterSourceCache.clear();
}

function registerMeterIpcHandlers(targetIpcMain = ipcMain, deps = {}) {
  if (!targetIpcMain || typeof targetIpcMain.handle !== 'function') return false;
  if (targetIpcMain === ipcMain && ipcRegistered) return true;
  if (targetIpcMain === ipcMain) ipcRegistered = true;

  const remove = (ch) => {
    try { if (typeof targetIpcMain.removeHandler === 'function') targetIpcMain.removeHandler(ch); } catch {}
  };

  remove('context-meter:runtime-info');
  targetIpcMain.handle('context-meter:runtime-info', (event) => {
    const origin = isLocalMainFrameSender(event);
    if (!origin) throw new Error('仅允许本机主聊天窗口');
    const ctx = buildCollectorOptions(event, {}, deps);
    return {
      ok: true,
      backendVersion: PROJECT_VERSION,
      backendSource: 'electron-ipc',
      pid: process.pid,
      startedAt: MAIN_STARTED_AT,
      origin,
      isRemote: Boolean(ctx.isRemote),
      remoteHost: ctx.remoteHost,
      capabilities: { ...MAIN_CAPABILITIES }
    };
  });

  remove('context-meter:scan');
  targetIpcMain.handle('context-meter:scan', async (event, id, force = false) => {
    const origin = isLocalMainFrameSender(event);
    if (!origin) throw new Error('仅允许本机主聊天窗口');
    const { opts } = buildCollectorOptions(event, { force: force === true, supersedePrevious: true }, deps);
    return collect(origin, id, opts);
  });

  remove('context-meter:turn-state');
  targetIpcMain.handle('context-meter:turn-state', async (event, id) => {
    const origin = isLocalMainFrameSender(event);
    if (!origin) throw new Error('仅允许本机主聊天窗口');
    const { opts } = buildCollectorOptions(event, {}, deps);
    return collectTurnState(origin, id, opts);
  });

  remove('context-meter:daily-usage');
  targetIpcMain.handle('context-meter:daily-usage', async (event, force = false) => {
    const origin = isLocalMainFrameSender(event);
    if (!origin) throw new Error('仅允许本机主聊天窗口');
    const { opts } = buildCollectorOptions(event, { force: force === true }, deps);
    return collectDailyUsage(origin, opts);
  });

  remove('context-meter:quota');
  targetIpcMain.handle('context-meter:quota', async (event, force = false) => {
    const origin = isLocalMainFrameSender(event);
    if (!origin) throw new Error('仅允许本机主聊天窗口');
    const { opts } = buildCollectorOptions(event, { force: force === true }, deps);
    return collectQuotaSummary(origin, opts);
  });

  remove('context-meter:get-settings');
  targetIpcMain.handle('context-meter:get-settings', (event) => {
    const origin = isLocalMainFrameSender(event);
    if (!origin) throw new Error('仅允许本机主聊天窗口');
    return getSettings();
  });

  remove('context-meter:save-settings');
  targetIpcMain.handle('context-meter:save-settings', (event, payload) => {
    const origin = isLocalMainFrameSender(event);
    if (!origin) throw new Error('仅允许本机主聊天窗口');
    return saveSettings(payload);
  });

  return true;
}

async function runEnsureMeterInjected(win, options = {}) {
  const wc = getWindowWebContents(win);
  if (!wc || wc.isDestroyed?.() || typeof wc.executeJavaScript !== 'function') return false;
  const rawUrl = wc.getURL?.() || '';
  if (!normalizeLoopbackOrigin(rawUrl)) return false;

  try {
    if (options.force !== true) {
      const alreadyLoaded = await wc.executeJavaScript(
        `Boolean(window.__AGContextMeter && window.__AGContextMeter.version === ${JSON.stringify(PROJECT_VERSION)} && document.getElementById('ag-context-meter'))`
      );
      if (alreadyLoaded) return true;
    }
    const source = getMeterSource();
    const res = await wc.executeJavaScript(source);
    return res !== false;
  } catch {
    return false;
  }
}

async function ensureMeterInjected(win, options = {}) {
  if (!win || win.isDestroyed?.()) return false;
  const existing = inFlightInjections.get(win);
  if (existing && options.force !== true) return existing;

  const task = (async () => {
    try {
      return await runEnsureMeterInjected(win, options);
    } finally {
      if (inFlightInjections.get(win) === task) inFlightInjections.delete(win);
    }
  })();
  inFlightInjections.set(win, task);
  return task;
}

function installContextMeter(win) {
  registerMeterIpcHandlers();
  if (!win || win.isDestroyed?.()) return;

  if (!boundWindows.has(win)) {
    boundWindows.add(win);
    if (process.platform === 'win32') {
      try {
        if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
        win.autoHideMenuBar = true;
      } catch {}
    }
    let lastActiveProbeAt = 0;
    const onActive = () => {
      const now = Date.now();
      if (now - lastActiveProbeAt < 2000) return;
      lastActiveProbeAt = now;
      void ensureMeterInjected(win, { force: false });
    };
    win.on?.('show', onActive);
    win.on?.('restore', onActive);
    win.on?.('focus', onActive);
  }

  const bindToWc = (wc) => {
    if (!wc || boundWebContents.has(wc)) return;
    boundWebContents.add(wc);
    wc.on('did-finish-load', () => { void ensureMeterInjected(win, { force: true }); });
    wc.on('dom-ready', () => { void ensureMeterInjected(win, { force: false }); });
    wc.on('did-navigate', () => { void ensureMeterInjected(win, { force: false }); });
    wc.on('did-navigate-in-page', () => { void ensureMeterInjected(win, { force: false }); });
  };

  const initialWc = getWindowWebContents(win);
  if (initialWc) {
    bindToWc(initialWc);
  } else {
    const prevTimer = wcProbeTimers.get(win);
    if (prevTimer) clearInterval(prevTimer);
    let retries = 0;
    const timer = setInterval(() => {
      retries++;
      const wc = getWindowWebContents(win);
      if (wc) {
        clearInterval(timer);
        wcProbeTimers.delete(win);
        bindToWc(wc);
        void ensureMeterInjected(win, { force: false });
      } else if (retries > 40 || win.isDestroyed?.()) {
        clearInterval(timer);
        wcProbeTimers.delete(win);
      }
    }, 150);
    wcProbeTimers.set(win, timer);
  }
}

module.exports = {
  PROJECT_VERSION,
  MAIN_CAPABILITIES,
  installContextMeter,
  ensureMeterInjected,
  registerMeterIpcHandlers,
  buildCollectorOptions,
  isLocalMainFrameSender,
  getWindowWebContents,
  getMeterSource,
  clearMeterSourceCacheForTest
};
