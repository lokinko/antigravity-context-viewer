'use strict';
/**
 * Antigravity Context Meter 极简注入与清洗引擎 (modular-installer.js)
 */

const vm = require('vm');

const TAGS = {
  PROXY_START: '// --- Antigravity Proxy NoTun Injection Start ---',
  PROXY_END: '// --- Antigravity Proxy NoTun Injection End ---',
  CHINESE_START: '// --- Antigravity Chinese Localization Injection Start ---',
  CHINESE_END: '// --- Antigravity Chinese Localization Injection End ---',
  METER_UTILS_START: '// --- Antigravity Context Meter utils Injection Start ---',
  METER_UTILS_END: '// --- Antigravity Context Meter utils Injection End ---',
  METER_PRELOAD_START: '// --- Antigravity Context Meter preload Injection Start ---',
  METER_PRELOAD_END: '// --- Antigravity Context Meter preload Injection End ---'
};

function validateSyntax(code, filename = 'script.js') {
  if (typeof code !== 'string') return false;
  try {
    new vm.Script(code, { filename });
    return true;
  } catch {
    return false;
  }
}

function generateMeterUtilsCode() {
  const storageFallbackLine = '    if (storageManager) globalThis.__agDefaultStorageManager = storageManager; else if (globalThis.__agDefaultStorageManager) storageManager = globalThis.__agDefaultStorageManager;';
  const hookLine = '    require("./meter-main").installContextMeter(win);\n';
  return {
    storageFallback: `\n${storageFallbackLine}`,
    menuBarOption: `\n        autoHideMenuBar: true,`,
    windowLoadHook: `${TAGS.METER_UTILS_START}\n${hookLine}${TAGS.METER_UTILS_END}\n`,
    focusHook: `\n        try { require("./meter-main").installContextMeter(wins[0]); require("./meter-main").ensureMeterInjected(wins[0], { force: true }); } catch {}`,
    createHook: `\n        try { require("./meter-main").installContextMeter(_mWin); require("./meter-main").ensureMeterInjected(_mWin, { force: true }); } catch {}`
  };
}

function generateMeterPreloadCode() {
  return `\n${TAGS.METER_PRELOAD_START}
electron_1.contextBridge.exposeInMainWorld("contextMeterAPI", {
  getRuntimeInfo: () => electron_1.ipcRenderer.invoke("context-meter:runtime-info"),
  scan: (id, force) => electron_1.ipcRenderer.invoke("context-meter:scan", id, force === true),
  getTurnState: (id) => electron_1.ipcRenderer.invoke("context-meter:turn-state", id),
  getDailyUsage: (force) => electron_1.ipcRenderer.invoke("context-meter:daily-usage", force === true),
  getSettings: () => electron_1.ipcRenderer.invoke("context-meter:get-settings"),
  saveSettings: (payload) => electron_1.ipcRenderer.invoke("context-meter:save-settings", payload)
});
${TAGS.METER_PRELOAD_END}\n`;
}

function cleanUtilsSource(source) {
  if (!source || typeof source !== 'string') return source;
  let code = source;

  const proxyRegex = new RegExp(`\\r?\\n?[ \\t]*${TAGS.PROXY_START}[\\s\\S]*?${TAGS.PROXY_END}\\r?\\n?`, 'g');
  code = code.replace(proxyRegex, '\n');

  const meterRegex = new RegExp(`\\r?\\n?[ \\t]*${TAGS.METER_UTILS_START}[\\s\\S]*?${TAGS.METER_UTILS_END}\\r?\\n?`, 'g');
  code = code.replace(meterRegex, '\n');

  const storageFallbackLine = '    if (storageManager) globalThis.__agDefaultStorageManager = storageManager; else if (globalThis.__agDefaultStorageManager) storageManager = globalThis.__agDefaultStorageManager;';
  code = code
    .replace(/\s*try\s*\{\s*require\("\.\/meter-main"\)\.ensureProxyEnvironment\(process\.env\);\s*\}\s*catch\s*\{\}\r?\n?/g, '')
    .replace(/\s*try\s*\{\s*require\("\.\/meter-main"\)\.ensureProxyEnvironment\(env\);\s*\}\s*catch\s*\{\}\r?\n?/g, '')
    .replace('\n' + storageFallbackLine, '')
    .replace(/[ \t]*require\("\.\/meter-main"\)\.installContextMeter\(win\);?[ \t]*\r?\n?/g, '')
    .replace(/\n\s*try\s*\{\s*require\("\.\/meter-main"\)\.installContextMeter\(wins\[0\]\);[\s\S]*?\}\s*catch\s*\{\}/g, '')
    .replace(/const _mWin = createWindow\(`\$\{constants_1\.WINDOW_ORIGIN\}:\$\{port\}\/`\);\s*\n\s*try\s*\{\s*require\("\.\/meter-main"\)\.installContextMeter\(_mWin\);[\s\S]*?\}\s*catch\s*\{\}/g, 'createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);')
    .replace(/\n {8}autoHideMenuBar:\s*true,/, '');

  return code;
}

function cleanPreloadSource(source) {
  if (!source || typeof source !== 'string') return source;
  let code = source;

  const chineseRegex = new RegExp(`\\n?\\s*${TAGS.CHINESE_START}[\\s\\S]*?${TAGS.CHINESE_END}\\n?`, 'g');
  code = code.replace(chineseRegex, '\n');

  const meterRegex = new RegExp(`\\n?\\s*${TAGS.METER_PRELOAD_START}[\\s\\S]*?${TAGS.METER_PRELOAD_END}\\n?`, 'g');
  code = code.replace(meterRegex, '\n');

  const legacyMeterRegex = /\r?\n?\/\/ Context Meter v2: narrow read-only conversation scan API\r?\nelectron_1\.contextBridge\.exposeInMainWorld\("contextMeterAPI",\s*\{[\s\S]*?\}\);\r?\n?/g;
  code = code.replace(legacyMeterRegex, '\n');

  return code;
}

const LEGACY_WINDOW_LOAD_MARKER = '    void win.loadURL(url);';
const HUB_WINDOW_LOAD_RE = /^[ \t]+(?:(?:void|await)[ \t]+)?(?:loadHubWindowUrl|[\w$]+\.loadHubWindowUrl|\(0,\s*[\w$.]+\.loadHubWindowUrl\))\(\s*win\s*,\s*url(?:\s*,(?:[^)\r\n]*|\s*\{[^{}();]*\}))?\s*\);[ \t]*\r?$/gm;
const CREATE_WINDOW_LOAD_URL_RE = /^[ \t]+(?:void|await)[ \t]+win\.loadURL\(\s*url\s*\);[ \t]*\r?$/gm;

function extractCreateWindowSpan(source) {
  if (!source || typeof source !== 'string') return null;
  const sigMatch = /\bfunction\s+createWindow\s*\([^)]*\)\s*\{/.exec(source);
  if (!sigMatch) return null;
  const bodyStart = sigMatch.index + sigMatch[0].length;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (escaped) { escaped = false; continue; }
    if (inSingle || inDouble || inTemplate) {
      if (ch === '\\') { escaped = true; continue; }
      if (inSingle && ch === '\'') inSingle = false;
      else if (inDouble && ch === '"') inDouble = false;
      else if (inTemplate && ch === '`') inTemplate = false;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === '\'') { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '`') { inTemplate = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { start: bodyStart, end: i };
    }
  }
  return null;
}

function inspectWindowLoadAnchors(cleanUtils) {
  if (!cleanUtils || typeof cleanUtils !== 'string') {
    return { target: null, status: 'missing', count: 0 };
  }
  const matches = [];
  let legacyPos = cleanUtils.indexOf(LEGACY_WINDOW_LOAD_MARKER);
  while (legacyPos !== -1) {
    matches.push({ kind: 'legacy', index: legacyPos, match: LEGACY_WINDOW_LOAD_MARKER });
    legacyPos = cleanUtils.indexOf(LEGACY_WINDOW_LOAD_MARKER, legacyPos + LEGACY_WINDOW_LOAD_MARKER.length);
  }
  HUB_WINDOW_LOAD_RE.lastIndex = 0;
  let m;
  while ((m = HUB_WINDOW_LOAD_RE.exec(cleanUtils)) !== null) {
    matches.push({ kind: 'hub_loader_v234', index: m.index, match: m[0] });
  }
  if (matches.length === 1) return { target: matches[0], status: 'unique', count: 1 };
  if (matches.length > 1) return { target: null, status: 'ambiguous', count: matches.length };

  const span = extractCreateWindowSpan(cleanUtils);
  if (span) {
    const body = cleanUtils.slice(span.start, span.end);
    const scopedMatches = [];
    CREATE_WINDOW_LOAD_URL_RE.lastIndex = 0;
    let sm;
    while ((sm = CREATE_WINDOW_LOAD_URL_RE.exec(body)) !== null) {
      scopedMatches.push({ kind: 'create_window_load_url', index: span.start + sm.index, match: sm[0] });
    }
    if (scopedMatches.length === 1) return { target: scopedMatches[0], status: 'unique', count: 1 };
    if (scopedMatches.length > 1) return { target: null, status: 'ambiguous', count: scopedMatches.length };
  }
  return { target: null, status: 'missing', count: 0 };
}

function findWindowLoadHookTarget(cleanUtils) {
  return inspectWindowLoadAnchors(cleanUtils).target;
}

function injectWindowLoadHook(utilsCode, windowLoadHook) {
  const target = findWindowLoadHookTarget(utilsCode);
  if (!target) {
    throw new Error('未找到唯一的宿主窗口加载锚点 (createWindow loadURL/loadHubWindowUrl)，中止写入以保护宿主环境。');
  }
  return utilsCode.slice(0, target.index) + windowLoadHook + utilsCode.slice(target.index);
}

function diagnoseCleanStructure(cleanUtils) {
  if (!cleanUtils || typeof cleanUtils !== 'string') {
    return { ok: false, stage: 'empty_source', reason: 'dist/utils.js 内容为空或不可读' };
  }
  if (
    cleanUtils.includes('installContextMeter') ||
    cleanUtils.includes(TAGS.PROXY_START) ||
    cleanUtils.includes(TAGS.METER_UTILS_START)
  ) {
    return { ok: false, stage: 'residual_plugin_trace', reason: '清洗后仍残留旧版插件注入标记' };
  }
  if (!cleanUtils.includes('function setupNodeWrapper(env) {') && !cleanUtils.includes('function createWindow(')) {
    return { ok: false, stage: 'missing_host_entry', reason: '未找到宿主窗口入口函数' };
  }
  const anchorInfo = inspectWindowLoadAnchors(cleanUtils);
  if (!anchorInfo.target) {
    if (anchorInfo.status === 'ambiguous') {
      return {
        ok: false,
        stage: 'ambiguous_window_load_anchor',
        reason: `发现多个窗口加载锚点候选（共 ${anchorInfo.count} 处），存在注入歧义`
      };
    }
    return {
      ok: false,
      stage: 'missing_window_load_anchor',
      reason: '未找到唯一的 createWindow 窗口加载调用（loadURL / loadHubWindowUrl）'
    };
  }
  if (!validateSyntax(cleanUtils, 'dist/utils.js')) {
    return { ok: false, stage: 'syntax_error', reason: '清洗后的 dist/utils.js JavaScript 语法校验失败' };
  }
  return { ok: true, stage: 'ok', anchorKind: anchorInfo.target.kind, reason: 'ok' };
}

function verifyCleanStructure(cleanUtils) {
  return diagnoseCleanStructure(cleanUtils).ok;
}

module.exports = {
  TAGS,
  validateSyntax,
  generateMeterUtilsCode,
  generateMeterPreloadCode,
  cleanUtilsSource,
  cleanPreloadSource,
  extractCreateWindowSpan,
  inspectWindowLoadAnchors,
  findWindowLoadHookTarget,
  injectWindowLoadHook,
  diagnoseCleanStructure,
  verifyCleanStructure
};
