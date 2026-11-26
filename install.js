'use strict';
/**
 * Antigravity Context Meter ASAR 持久化安装与 CDP 热注入 (install.js)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { loadAsarEngine, builtinAsar, collectUnpackedPaths, getStateDir, getAppDataDir, isIsolatedTestPath, findAsarPath, getRawFs } = require('./asar-engine');
const { inspectMacAsarIntegrity } = require('./macos-binary-utils');
const { discoverAntigravityCdp, createCdpClient } = require('./local-api');
const { acquireFileLock, getProjectVersion } = require('./meter-storage');
const {
  TAGS,
  validateSyntax,
  generateMeterUtilsCode,
  generateMeterPreloadCode,
  cleanUtilsSource,
  cleanPreloadSource,
  injectWindowLoadHook,
  diagnoseCleanStructure,
  verifyCleanStructure
} = require('./modular-installer');

const asar = loadAsarEngine();
const rawFs = getRawFs();
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

const RUNTIME_FILES = [
  'asar-engine.js',
  'meter-storage.js',
  'local-api.js',
  'meter-core.js',
  'meter-collector.js',
  'meter-main.js',
  'meter-renderer.js'
];

function clearAsarCache(archivePath) {
  try {
    if (asar && typeof asar.uncacheAll === 'function') asar.uncacheAll();
    if (asar && typeof asar.uncache === 'function' && archivePath) asar.uncache(archivePath);
  } catch {}
}

function extractAsarFile(archivePath, relPath) {
  clearAsarCache(archivePath);
  try {
    return builtinAsar.extractFile(archivePath, relPath);
  } catch {
    return asar.extractFile(archivePath, relPath);
  }
}

function extractAllAsar(archivePath, destDir) {
  clearAsarCache(archivePath);
  try {
    builtinAsar.extractAll(archivePath, destDir);
  } catch {
    asar.extractAll(archivePath, destDir);
  }
}

function postLiveHttpJson(port, token, routePath, origin, body = {}, timeoutMs = 2500) {
  return new Promise((resolve) => {
    try {
      const net = require('net');
      const dataStr = JSON.stringify(body || {});
      const numPort = Number(port);
      const req = http.request({
        hostname: '127.0.0.1',
        port: numPort,
        path: routePath,
        method: 'POST',
        agent: false,
        createConnection: () => net.connect(numPort, '127.0.0.1'),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataStr),
          'Origin': origin,
          'X-AG-Context-Token': String(token || '')
        }
      }, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, ...JSON.parse(raw || '{}') });
          } catch {
            resolve({ ok: false, statusCode: res.statusCode });
          }
        });
      });
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.on('error', e => resolve({ ok: false, error: e.message }));
      req.end(dataStr);
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

async function probeLiveHostRuntimeInfo(liveInfo, origin = null) {
  if (!liveInfo || !liveInfo.port || !liveInfo.token) return { ok: false, error: 'missing_live_info' };
  const probeOrigin = origin || liveInfo.origin || (Array.isArray(liveInfo.origins) && liveInfo.origins[0]) || null;
  if (!probeOrigin) return { ok: false, error: 'missing_origin' };
  return postLiveHttpJson(liveInfo.port, liveInfo.token, '/runtime-info', probeOrigin, {}, 2500);
}

async function shutdownLiveHostGracefully(liveInfo) {
  if (!liveInfo || !liveInfo.pid) return { ok: false, reason: 'no_pid' };
  const targetOrigin = liveInfo.origin || (Array.isArray(liveInfo.origins) && liveInfo.origins[0]) || 'https://127.0.0.1:1';
  if (liveInfo.port && liveInfo.token) {
    const res = await postLiveHttpJson(liveInfo.port, liveInfo.token, '/shutdown', targetOrigin, {}, 1200);
    if (res && res.ok) {
      await new Promise(r => setTimeout(r, 150));
      return { ok: true, method: 'http_shutdown', pid: liveInfo.pid };
    }
  }
  try {
    process.kill(liveInfo.pid, 0);
    process.kill(liveInfo.pid);
    return { ok: true, method: 'process_kill', pid: liveInfo.pid };
  } catch {
    return { ok: true, method: 'already_exited', pid: liveInfo.pid };
  }
}

async function tryHotInjectDetailed(options = {}) {
  const report = {
    ok: false,
    reason: null,
    windowCount: 0,
    injectedCount: 0,
    backendSource: options.backendSource || null,
    backendVersion: options.backendVersion || null,
    backendVerified: false,
    windows: []
  };
  try {
    const appData = getAppDataDir(options);
    if ((process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') && !options.port && !options.appDataDir) {
      if (!isIsolatedTestPath(appData)) {
        report.reason = 'test_mode_isolated';
        return report;
      }
    }

    let targets;
    try {
      const cdp = await discoverAntigravityCdp(options);
      targets = Array.isArray(cdp.pages) ? cdp.pages : [];
    } catch (cdpErr) {
      const msg = String(cdpErr?.message || '');
      report.reason = msg.includes('未找到 Antigravity 主窗口')
        ? 'no_page_targets'
        : (msg.includes('连接信息无效') ? 'invalid_cdp_port' : 'cdp_not_enabled');
      return report;
    }
    report.windowCount = targets.length;
    if (!targets.length) {
      report.reason = 'no_page_targets';
      return report;
    }

    const pkgVersion = getProjectVersion('1.0.0');
    const stateDir = options.stateDir || getStateDir();
    const livePath = fs.existsSync(path.join(stateDir, '.live-session.json'))
      ? path.join(stateDir, '.live-session.json')
      : path.join(__dirname, '.live-session.json');
    let liveInfo = options.liveInfo || (fs.existsSync(livePath) ? JSON.parse(fs.readFileSync(livePath, 'utf8')) : null);
    let liveProbeOk = Boolean(options.liveVerified);
    if (liveInfo && !liveProbeOk) {
      const probe = await probeLiveHostRuntimeInfo(liveInfo, new URL(targets[0].url).origin);
      if (probe && probe.ok && probe.backendVersion) {
        liveProbeOk = probe.backendVersion === pkgVersion;
        liveInfo = {
          ...liveInfo,
          version: probe.backendVersion,
          backendSource: 'live-host',
          capabilities: probe.capabilities || liveInfo.capabilities || {},
          origins: probe.origins || liveInfo.origins || [liveInfo.origin]
        };
      }
    }

    const bundle = ['meter-core.js', 'meter-renderer.js']
      .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8'))
      .join('\n');

    let cachedSettings = null;
    try {
      const { getSettings } = require('./meter-collector');
      const snap = getSettings({ stateDir });
      if (snap && snap.ok) cachedSettings = snap;
    } catch {}

    for (const target of targets) {
      const targetOrigin = new URL(target.url).origin;
      const winEntry = { origin: targetOrigin, injected: false, rendererVersion: null, backendSource: null, backendVersion: null, error: null };
      let cdpClient = null;
      try {
        cdpClient = await createCdpClient(target.webSocketDebuggerUrl, { timeoutMs: 5000 });
        const evalExpr = (expression, evalTimeoutMs = 6000) => cdpClient.evaluate(expression, { timeoutMs: evalTimeoutMs });

        const liveCoversOrigin = Boolean(
          liveInfo && liveInfo.port && liveInfo.token &&
          (liveInfo.origin === targetOrigin || (Array.isArray(liveInfo.origins) && liveInfo.origins.includes(targetOrigin)))
        );
        if (options.clearStaleLiveBridge) {
          await evalExpr('window.__AGContextMeterLive = null;');
        } else if (liveCoversOrigin) {
          await evalExpr('window.__AGContextMeterLive=' + JSON.stringify({
            port: liveInfo.port,
            token: liveInfo.token,
            origin: targetOrigin,
            origins: liveInfo.origins || [liveInfo.origin],
            version: liveInfo.version || pkgVersion,
            backendSource: liveInfo.backendSource || 'live-host',
            capabilities: liveInfo.capabilities || null,
            verified: liveProbeOk
          }));
        }
        await evalExpr('window.__AGContextMeterHotReloadContext=' + JSON.stringify({
          expectedVersion: pkgVersion,
          source: options.source || 'cli',
          hotInjectedAt: Date.now(),
          preferLiveHost: Boolean(liveCoversOrigin && (options.preferLiveHost || liveProbeOk))
        }));
        if (cachedSettings) {
          await evalExpr('window.__AGContextMeterSettings=' + JSON.stringify(cachedSettings));
        }

        const evalRes = await evalExpr(bundle, 8000);
        if (evalRes && !evalRes.exceptionDetails) {
          winEntry.injected = true;
          report.injectedCount++;
          try {
            const verifyRes = await evalExpr(`(() => {
              const api = window.__AGContextMeter;
              if (!api) return null;
              return { rendererVersion: api.version || null, buildId: api.buildId || null };
            })()`, 3000);
            const val = verifyRes?.result?.value;
            if (val && typeof val === 'object') {
              winEntry.rendererVersion = val.rendererVersion || pkgVersion;
              winEntry.backendSource = liveCoversOrigin ? 'live-host' : 'electron-ipc';
              winEntry.backendVersion = liveInfo?.version || pkgVersion;
              report.backendVerified = true;
              report.backendSource = winEntry.backendSource;
              report.backendVersion = winEntry.backendVersion;
            }
          } catch {}
        } else {
          winEntry.error = evalRes?.exceptionDetails?.text || 'eval_failed';
        }
      } catch (e) {
        winEntry.error = e.message;
      } finally {
        if (cdpClient) { try { cdpClient.close(); } catch {} }
      }
      report.windows.push(winEntry);
    }

    report.ok = report.injectedCount > 0;
    if (!report.ok && !report.reason) report.reason = 'injection_failed';
    return report;
  } catch (e) {
    report.reason = e?.message || 'unknown_error';
    return report;
  }
}

async function tryHotInject(options = {}) {
  const res = await tryHotInjectDetailed(options);
  return Boolean(res && res.ok);
}

async function install(options = {}) {
  if (options && typeof options === 'object') {
    if (options.path === undefined) {
      const misnamedKey = ['asarPath', 'targetPath', 'target', 'file', 'asar'].find(k => options[k] !== undefined);
      if (misnamedKey) {
        throw new Error(`无效的安装选项字段 "${misnamedKey}"：请使用 { path: "<app.asar>" } 指定安装目标。`);
      }
    } else if (options.path !== null && (typeof options.path !== 'string' || !options.path.trim())) {
      throw new Error('安装选项 path 必须为非空字符串。');
    }
  }
  const customPathIdx = process.argv.indexOf('--path');
  const customPath = options.path || (customPathIdx >= 0 ? process.argv[customPathIdx + 1] : null);
  const customBackupIdx = process.argv.indexOf('--backup');
  const explicitBackup = options.backup || (customBackupIdx >= 0 ? process.argv[customBackupIdx + 1] : null);

  const installed = findAsarPath(customPath);
  const macIntegrity = inspectMacAsarIntegrity(installed, {
    _platform: options._platform,
    _existsSync: options._existsSync,
    _readFileSync: options._readFileSync,
    _execFileSync: options._execFileSync
  });
  const allowMacOverride = Boolean(options.allowIntegrityOverride || process.argv.includes('--force-mac-asar'));
  if (
    macIntegrity.isMacAppBundle &&
    ((options._platform || process.platform) === 'darwin' || options.enforceMacIntegrityCheck === true)
  ) {
    if ((macIntegrity.patchRisk === 'blocked_integrity' || macIntegrity.patchRisk === 'blocked_signature') && !allowMacOverride) {
      throw new Error(
        `[macOS 完整性保护] ${macIntegrity.reason}。\n` +
        '为避免破坏官方签名或导致客户端启动闪退，默认已中止修改磁盘 app.asar。\n' +
        '推荐方案: 请改用免改盘守护模式 `node cli.js watch`。\n' +
        '（若明确需强行注入，可追加 `--force-mac-asar` 参数）'
      );
    }
  }

  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  let sourceArchive = installed;
  let previousManifest = null;
  const manifestPath = path.join(stateDir, 'installation.json');
  if (fs.existsSync(manifestPath)) {
    try { previousManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  }

  const fileLock = acquireFileLock(installed);
  try {
    if (explicitBackup) {
      const resolvedBackup = path.resolve(String(explicitBackup).trim());
      if (!rawFs.existsSync(resolvedBackup) || !rawFs.statSync(resolvedBackup).isFile()) {
        throw new Error(`指定的 --backup 文件不存在或无效: ${resolvedBackup}`);
      }
      const bHostVer = JSON.parse(extractAsarFile(resolvedBackup, 'package.json').toString('utf8')).version;
      const bUtils = extractAsarFile(resolvedBackup, 'dist/utils.js').toString('utf8');
      const tHostVer = JSON.parse(extractAsarFile(installed, 'package.json').toString('utf8')).version;
      if (bHostVer && tHostVer && bHostVer !== tHostVer) {
        throw new Error(`指定的 --backup 宿主版本 (v${bHostVer}) 与当前目标宿主版本 (v${tHostVer}) 不匹配。`);
      }
      if (bUtils.includes('installContextMeter') || bUtils.includes(TAGS.METER_UTILS_START)) {
        throw new Error('指定的 --backup 文件包含插件修改痕迹，不能作为原版基底。');
      }
      if (!verifyCleanStructure(bUtils)) {
        throw new Error('指定的 --backup 文件的 dist/utils.js 结构或语法校验未通过。');
      }
      sourceArchive = resolvedBackup;
    }

    let inPlaceCleanedUtils = null;
    let inPlaceCleanedPreload = null;
    if (sourceArchive === installed) {
      const currentUtilsRaw = extractAsarFile(installed, 'dist/utils.js').toString('utf8');
      const currentPreloadRaw = extractAsarFile(installed, 'dist/preload.js').toString('utf8');
      const targetHostVer = JSON.parse(extractAsarFile(installed, 'package.json').toString('utf8')).version;

      const hasPluginTrace = currentUtilsRaw.includes('installContextMeter') ||
        currentUtilsRaw.includes(TAGS.METER_UTILS_START) ||
        currentUtilsRaw.includes(TAGS.PROXY_START) ||
        currentPreloadRaw.includes(TAGS.METER_PRELOAD_START) ||
        currentPreloadRaw.includes(TAGS.CHINESE_START);

      if (hasPluginTrace) {
        const potentialCleanUtils = cleanUtilsSource(currentUtilsRaw);
        const potentialCleanPreload = cleanPreloadSource(currentPreloadRaw);
        if (verifyCleanStructure(potentialCleanUtils)) {
          inPlaceCleanedUtils = potentialCleanUtils;
          inPlaceCleanedPreload = potentialCleanPreload;
        } else {
          const isSameTarget = Boolean(previousManifest?.installed && path.resolve(previousManifest.installed) === path.resolve(installed));
          let matchedBackup = null;
          if (isSameTarget && previousManifest?.backup && rawFs.existsSync(previousManifest.backup)) {
            if (sha(rawFs.readFileSync(previousManifest.backup)) === previousManifest.originalSha256) {
              const bVer = JSON.parse(extractAsarFile(previousManifest.backup, 'package.json').toString('utf8')).version;
              if (bVer === targetHostVer) matchedBackup = previousManifest.backup;
            }
          }
          if (!matchedBackup) {
            throw new Error('当前 ASAR 包含未知修改痕迹且无法安全原位解构，也未找到匹配原版备份，已中止安装。');
          }
          sourceArchive = matchedBackup;
        }
      }
    }

    const version = JSON.parse(extractAsarFile(sourceArchive, 'package.json').toString('utf8')).version;
    const pkgVersion = getProjectVersion('1.0.0');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
    const backupDir = path.join(stateDir, 'backups');
    const snapshotDir = path.join(backupDir, 'snapshots');
    fs.mkdirSync(snapshotDir, { recursive: true });

    const currentInstalledSha = sha(rawFs.readFileSync(installed));
    const snapshotFile = path.join(snapshotDir, `app-${version}-preinstall-${stamp}-${currentInstalledSha.slice(0, 8)}.asar`);
    rawFs.copyFileSync(installed, snapshotFile);

    const targetKey = crypto.createHash('sha256').update(path.resolve(installed)).digest('hex').slice(0, 8);
    const backup = path.join(backupDir, `app-${version}-${targetKey}-base.asar`);
    const isReadableAsar = (p) => {
      try {
        if (!p || !rawFs.existsSync(p)) return false;
        const pkg = JSON.parse(extractAsarFile(p, 'package.json').toString('utf8'));
        return Boolean(pkg && pkg.name);
      } catch { return false; }
    };
    if (!isReadableAsar(backup)) {
      if (sourceArchive !== installed && isReadableAsar(sourceArchive)) {
        rawFs.copyFileSync(sourceArchive, backup);
      } else if (!extractAsarFile(sourceArchive, 'dist/utils.js').toString('utf8').includes('installContextMeter')) {
        rawFs.copyFileSync(sourceArchive, backup);
      }
    }

    const staging = path.join(os.tmpdir(), `ag-context-meter-pkg-${stamp}`);
    const packed = path.join(os.tmpdir(), `ag-context-meter-${stamp}.asar`);
    try {
      fs.mkdirSync(staging, { recursive: true });
      clearAsarCache(sourceArchive);
      extractAllAsar(sourceArchive, staging);

      const cleanUtils = cleanUtilsSource(inPlaceCleanedUtils || extractAsarFile(sourceArchive, 'dist/utils.js').toString('utf8'));
      const cleanPreload = cleanPreloadSource(inPlaceCleanedPreload || extractAsarFile(sourceArchive, 'dist/preload.js').toString('utf8'));
      const cleanDiag = diagnoseCleanStructure(cleanUtils);
      if (!cleanDiag.ok) {
        throw new Error(`清洗后的 dist/utils.js 结构校验未通过 [stage=${cleanDiag.stage}]: ${cleanDiag.reason}`);
      }

      const meterUtils = generateMeterUtilsCode();
      let finalUtils = cleanUtils.replace("titleBarStyle: 'hidden',", () => `titleBarStyle: 'hidden',${meterUtils.menuBarOption}`);
      finalUtils = injectWindowLoadHook(finalUtils, meterUtils.windowLoadHook);
      const createWinSig = 'function createWindow(url, storageManager, options) {';
      if (finalUtils.includes(createWinSig) && !finalUtils.includes('__agDefaultStorageManager')) {
        finalUtils = finalUtils.replace(createWinSig, createWinSig + meterUtils.storageFallback);
      }
      if (finalUtils.includes('wins[0].focus();') && !finalUtils.includes('ensureMeterInjected(wins[0]')) {
        finalUtils = finalUtils.replace('wins[0].focus();', 'wins[0].focus();' + meterUtils.focusHook);
      }
      if (finalUtils.includes('createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);') && !finalUtils.includes('ensureMeterInjected(_mWin')) {
        finalUtils = finalUtils.replace('createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);', 'const _mWin = createWindow(`${constants_1.WINDOW_ORIGIN}:${port}/`);' + meterUtils.createHook);
      }

      const finalPreload = cleanPreload + generateMeterPreloadCode();
      if (!validateSyntax(finalUtils, 'dist/utils.js')) throw new Error('注入后 dist/utils.js 语法校验失败');
      if (!validateSyntax(finalPreload, 'dist/preload.js')) throw new Error('注入后 dist/preload.js 语法校验失败');

      fs.writeFileSync(path.join(staging, 'dist', 'utils.js'), finalUtils, 'utf8');
      fs.writeFileSync(path.join(staging, 'dist', 'preload.js'), finalPreload, 'utf8');

      // 清理旧版本遗留模块（若存在）
      for (const stale of [
        'modules-config.js', 'host-recovery.js', 'meter-proxy.js', 'meter-enhance.js',
        'meter-rehydrate.js', 'meter-accounts.js', 'meter-next-prompt.js', 'meter-context-unlock.js',
        'meter-cli-launcher.js', 'meter-cli-monitor.js', 'meter-cli-adapter.js',
        'meter-cli-companion.js', 'meter-cli-ui.js', 'attachment_scan.py'
      ]) {
        const sp = path.join(staging, 'dist', stale);
        try { if (fs.existsSync(sp)) fs.unlinkSync(sp); } catch {}
      }
      for (const staleDir of ['i18n', 'rehydrate', 'assets']) {
        try { fs.rmSync(path.join(staging, 'dist', staleDir), { recursive: true, force: true }); } catch {}
      }

      const builtRendererPath = path.join(__dirname, 'meter-renderer.js');
      if (!fs.existsSync(builtRendererPath)) {
        require('./scripts/build-renderer').buildRenderer({ rootDir: __dirname });
      }

      for (const file of RUNTIME_FILES) {
        const srcP = path.join(__dirname, file);
        if (!fs.existsSync(srcP)) throw new Error(`缺少必需运行时文件: ${file}`);
        fs.copyFileSync(srcP, path.join(staging, 'dist', file));
      }
      fs.writeFileSync(path.join(staging, 'dist', 'meter-manifest.json'), JSON.stringify({
        version: pkgVersion,
        hostVersion: version,
        updatedAt: new Date().toISOString()
      }, null, 2), 'utf8');

      const originalEntries = asar.listPackage(sourceArchive);
      const unpackedPaths = collectUnpackedPaths(asar, sourceArchive);
      await builtinAsar.createPackageWithOptions(staging, packed, unpackedPaths.size > 0 ? { unpackedPaths } : {});

      let verified = 0;
      const allowedChanges = new Set([
        'dist/utils.js',
        'dist/preload.js',
        'dist/meter-manifest.json',
        ...RUNTIME_FILES.map(f => 'dist/' + f)
      ].map(p => path.normalize(p)));

      for (const file of originalEntries) {
        const name = path.normalize(file.slice(1));
        let before = null;
        let after = null;
        try { before = asar.statFile(sourceArchive, name); } catch {}
        try { after = asar.statFile(packed, name); } catch {}
        if (!before || before.files || before.link) continue;
        if (!after) throw new Error(`打包后缺失原文件: ${name}`);
        if (Boolean(before.unpacked) !== Boolean(after.unpacked)) throw new Error(`unpacked 标记不一致: ${name}`);
        if (!allowedChanges.has(name) && !before.unpacked) {
          if (sha(asar.extractFile(sourceArchive, name)) !== sha(asar.extractFile(packed, name))) {
            throw new Error(`发现预期外的文件变更: ${name}`);
          }
        }
        verified++;
      }

      const origSha = isReadableAsar(backup) ? sha(rawFs.readFileSync(backup)) : previousManifest?.originalSha256;
      const prevBackupsByVersion = (previousManifest?.installed && path.resolve(previousManifest.installed) === path.resolve(installed) && previousManifest.backupsByVersion)
        ? { ...previousManifest.backupsByVersion }
        : {};
      if (version && isReadableAsar(backup)) {
        prevBackupsByVersion[version] = { backup, sha256: origSha, recordedAt: new Date().toISOString() };
      }

      const manifest = {
        meterVersion: pkgVersion,
        version,
        installed,
        installerDir: __dirname,
        cliPath: path.join(__dirname, 'cli.js'),
        backup,
        originalSha256: origSha,
        patchedSha256: sha(rawFs.readFileSync(packed)),
        originalFilesVerified: verified,
        added: RUNTIME_FILES.map(f => 'dist/' + f),
        modified: ['dist/utils.js', 'dist/preload.js'],
        installedAt: new Date().toISOString(),
        backupsByVersion: prevBackupsByVersion,
        ...(macIntegrity.isMacAppBundle ? { macAsarIntegrity: macIntegrity } : {})
      };

      const tempReplacement = path.join(path.dirname(installed), `app.asar.tmp_${stamp}`);
      let installCommitted = false;
      try {
        rawFs.copyFileSync(packed, tempReplacement);
        try {
          rawFs.copyFileSync(tempReplacement, installed);
          clearAsarCache(installed);
        } catch (err) {
          if (err.code === 'EBUSY') {
            throw new Error(`无法写入 ${installed}：文件被运行中的 Antigravity 锁定，请完全退出客户端（含右下角托盘图标）后重试。`);
          }
          if (err.code === 'EPERM' || err.code === 'EACCES') {
            throw new Error(`无法写入 ${installed}：写入权限不足或文件正被占用；请完全退出 Antigravity，若客户端安装在 Program Files 目录，请以管理员身份运行安装。`);
          }
          throw err;
        } finally {
          try { if (rawFs.existsSync(tempReplacement)) rawFs.unlinkSync(tempReplacement); } catch {}
        }

        if (sha(rawFs.readFileSync(installed)) !== manifest.patchedSha256) {
          throw new Error('写入后校验和不匹配');
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        installCommitted = true;

        const hotInjectReport = options.noHotInject
          ? { ok: false, reason: 'skipped_by_option', windowCount: 0, injectedCount: 0, windows: [] }
          : await tryHotInjectDetailed(options.hotInjectOptions || {});
        return { ...manifest, liveInjected: hotInjectReport.ok, hotInjectReport };
      } catch (err) {
        if (!installCommitted && rawFs.existsSync(snapshotFile)) {
          try {
            rawFs.copyFileSync(snapshotFile, installed);
            clearAsarCache(installed);
          } catch {}
        }
        throw err;
      }
    } finally {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      try { if (rawFs.existsSync(packed)) rawFs.unlinkSync(packed); } catch {}
      try { fs.rmSync(packed + '.unpacked', { recursive: true, force: true }); } catch {}
    }
  } finally {
    fileLock.release();
  }
}

function getRendererBuildId(filePath = null) {
  try {
    const p = filePath || path.join(__dirname, 'meter-renderer.js');
    if (!fs.existsSync(p)) return null;
    return sha(fs.readFileSync(p)).slice(0, 12);
  } catch { return null; }
}

function getHostCoreBuildId(baseDir = null) {
  try {
    const root = baseDir || __dirname;
    const h = crypto.createHash('sha256');
    for (const f of ['meter-core.js', 'meter-collector.js', 'meter-storage.js', 'local-api.js', 'asar-engine.js']) {
      const p = path.join(root, f);
      if (fs.existsSync(p)) h.update(f + ':').update(fs.readFileSync(p));
    }
    return h.digest('hex').slice(0, 12);
  } catch { return null; }
}

function getWatchBundleBuildId(baseDir = null) {
  try {
    const root = baseDir || __dirname;
    const h = crypto.createHash('sha256');
    for (const f of [...RUNTIME_FILES, 'live-host.js', 'package.json']) {
      const p = path.join(root, f);
      if (fs.existsSync(p)) h.update(f + ':').update(fs.readFileSync(p));
    }
    return h.digest('hex').slice(0, 12);
  } catch { return null; }
}

if (require.main === module) {
  install()
    .then(manifest => console.log(JSON.stringify(manifest, null, 2)))
    .catch(error => {
      console.error(String(error.stack || error.message).slice(0, 2000));
      process.exitCode = 1;
    });
}

module.exports = {
  RUNTIME_FILES,
  install,
  findAsarPath,
  tryHotInject,
  tryHotInjectDetailed,
  probeLiveHostRuntimeInfo,
  shutdownLiveHostGracefully,
  extractAsarFile,
  getRendererBuildId,
  getHostCoreBuildId,
  getWatchBundleBuildId
};
