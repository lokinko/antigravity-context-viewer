'use strict';
/**
 * Antigravity Context Meter 无损还原与原位卸载 (restore.js)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getStateDir, getAppDataDir, isIsolatedTestPath, builtinAsar, collectUnpackedPaths, loadAsarEngine } = require('./asar-engine');
const { discoverAntigravityCdp, createCdpClient } = require('./local-api');
const { inspectMacAsarIntegrity } = require('./macos-binary-utils');
const { acquireFileLock } = require('./meter-storage');
const {
  TAGS,
  validateSyntax,
  cleanUtilsSource,
  cleanPreloadSource,
  diagnoseCleanStructure,
  verifyCleanStructure
} = require('./modular-installer');

const asar = loadAsarEngine();
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const STALE_ADDITIONS = [
  'asar-engine.js', 'modules-config.js', 'modular-installer.js', 'host-recovery.js',
  'install.js', 'restore.js', 'meter-main.js', 'meter-core.js', 'meter-renderer.js',
  'meter-collector.js', 'meter-storage.js', 'meter-proxy.js', 'meter-cli-launcher.js',
  'meter-cli-monitor.js', 'meter-cli-adapter.js', 'meter-cli-companion.js', 'meter-cli-ui.js',
  'meter-context-unlock.js', 'meter-enhance.js', 'meter-rehydrate.js', 'meter-accounts.js',
  'meter-next-prompt.js', 'macos-binary-utils.js', 'local-api.js', 'attachment_scan.py',
  'meter-manifest.json'
];

function clearAsarCache(archivePath) {
  try {
    if (asar && typeof asar.uncacheAll === 'function') asar.uncacheAll();
    if (asar && typeof asar.uncache === 'function' && archivePath) asar.uncache(archivePath);
  } catch {}
}

function extractAllAsar(archivePath, destDir) {
  clearAsarCache(archivePath);
  try { builtinAsar.extractAll(archivePath, destDir); } catch { asar.extractAll(archivePath, destDir); }
}

function extractAsarFile(archivePath, relPath) {
  clearAsarCache(archivePath);
  try { return builtinAsar.extractFile(archivePath, relPath); } catch { return asar.extractFile(archivePath, relPath); }
}

async function tryHotDispose(options = {}) {
  try {
    const appData = getAppDataDir(options);
    if ((process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') && !options.port && !options.appDataDir) {
      if (!isIsolatedTestPath(appData)) return false;
    }
    const cdp = await discoverAntigravityCdp(options);
    const targets = Array.isArray(cdp.pages) ? cdp.pages : [];
    for (const target of targets) {
      let cdpClient = null;
      try {
        cdpClient = await createCdpClient(target.webSocketDebuggerUrl, { timeoutMs: 3000 });
        await cdpClient.evaluate('window.__AGContextMeter?.dispose()', { timeoutMs: 3000 });
      } catch {} finally {
        if (cdpClient) { try { cdpClient.close(); } catch {} }
      }
    }
    return targets.length > 0;
  } catch {
    return false;
  }
}

async function restore(options = {}) {
  const customPathIdx = process.argv.indexOf('--path');
  const customPath = options.path || (customPathIdx >= 0 ? process.argv[customPathIdx + 1] : null);
  const force = process.argv.includes('--force') || Boolean(options.force);
  const inPlaceExplicit = process.argv.includes('--in-place') || Boolean(options.inPlace);
  const stateDir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  const manifestPath = path.join(stateDir, 'installation.json');
  const hasManifest = fs.existsSync(manifestPath);

  if (!hasManifest && !customPath) {
    throw new Error('installation.json not found; nothing to restore.');
  }
  const info = hasManifest ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { installed: path.resolve(customPath) };
  const targetFile = customPath ? path.resolve(customPath) : (info.installed ? path.resolve(info.installed) : null);
  if (!targetFile || !fs.existsSync(targetFile)) {
    throw new Error(`Target file not found: ${targetFile || info.installed}`);
  }
  if (hasManifest && customPath && info.installed && path.resolve(info.installed) !== path.resolve(targetFile) && !inPlaceExplicit) {
    throw new Error(`指定的卸载目标 (${targetFile}) 与安装记录 (${info.installed}) 不一致，拒绝跨目标还原。`);
  }

  const fileLock = acquireFileLock(targetFile);
  try {
    const currentInstalledSha = sha(targetFile);
    let targetHostVer = null;
    let currentUtilsRaw = null;
    let currentPreloadRaw = null;
    let targetValid = false;
    try {
      clearAsarCache(targetFile);
      targetHostVer = JSON.parse(extractAsarFile(targetFile, 'package.json').toString('utf8')).version || null;
      currentUtilsRaw = extractAsarFile(targetFile, 'dist/utils.js').toString('utf8');
      try { currentPreloadRaw = extractAsarFile(targetFile, 'dist/preload.js').toString('utf8'); } catch { currentPreloadRaw = ''; }
      targetValid = Boolean(currentUtilsRaw && currentUtilsRaw.trim());
    } catch {
      targetValid = false;
    }

    const hasMeterTraces = Boolean(
      targetValid && currentUtilsRaw && (
        currentUtilsRaw.includes('installContextMeter') ||
        currentUtilsRaw.includes(TAGS.METER_UTILS_START) ||
        currentUtilsRaw.includes(TAGS.PROXY_START)
      )
    );

    const backupCandidates = [];
    if (info.backupsByVersion && targetHostVer && info.backupsByVersion[targetHostVer]) {
      const vb = info.backupsByVersion[targetHostVer];
      backupCandidates.push({ path: vb.backup, expected: vb.sha256 || vb.originalSha256 });
    }
    if (info.backup) backupCandidates.push({ path: info.backup, expected: info.originalSha256 });

    let validBackup = null;
    let validExpectedSha = null;
    let backupHostVer = null;
    for (const c of backupCandidates) {
      if (c.path && fs.existsSync(c.path) && c.expected && sha(c.path) === c.expected) {
        try {
          const ver = JSON.parse(extractAsarFile(c.path, 'package.json').toString('utf8')).version;
          validBackup = c.path;
          validExpectedSha = c.expected;
          backupHostVer = ver;
          if (ver && ver === targetHostVer) break;
        } catch {}
      }
    }
    const versionMatches = Boolean(!backupHostVer || !targetHostVer || backupHostVer === targetHostVer);

    const macIntegrity = inspectMacAsarIntegrity(targetFile, {
      _platform: options._platform,
      _existsSync: options._existsSync,
      _readFileSync: options._readFileSync,
      _execFileSync: options._execFileSync
    });
    const effectivePlatform = options._platform || process.platform;
    const allowMacOverride = Boolean(options.allowIntegrityOverride || process.argv.includes('--force-mac-asar'));

    if (validBackup && versionMatches && currentInstalledSha === validExpectedSha) {
      await tryHotDispose();
      return { restored: targetFile, fromBackup: validBackup, alreadyRestored: true };
    }

    if (!inPlaceExplicit && validBackup && versionMatches && currentInstalledSha === info.patchedSha256 && !force) {
      try {
        fs.copyFileSync(validBackup, targetFile);
        clearAsarCache(targetFile);
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
          throw new Error(`无法还原 ${targetFile}：文件正被运行中的 Antigravity 锁定，请先退出客户端。`);
        }
        throw err;
      }
      if (sha(targetFile) !== validExpectedSha) throw new Error('Restored file checksum mismatch');
      await tryHotDispose();
      if (hasManifest) {
        try {
          info.restoredAt = new Date().toISOString();
          fs.writeFileSync(manifestPath, JSON.stringify(info, null, 2));
        } catch {}
      }
      return { restored: targetFile, fromBackup: validBackup };
    }

    const canTryInPlace = Boolean(
      !force && (inPlaceExplicit || !validBackup || !versionMatches || currentInstalledSha !== info.patchedSha256)
    );
    if (canTryInPlace) {
      if (
        macIntegrity.isMacAppBundle &&
        (effectivePlatform === 'darwin' || options.enforceMacIntegrityCheck === true) &&
        (macIntegrity.patchRisk === 'blocked_integrity' || macIntegrity.patchRisk === 'blocked_signature') &&
        !allowMacOverride
      ) {
        throw new Error(`[macOS 完整性保护] ${macIntegrity.reason}。请使用官方安装包还原或改用 \`node cli.js watch\`。`);
      }
      if (!targetValid) throw new Error(`无法卸载 ${targetFile}：不支持或损坏的 ASAR 结构。`);
      if (!hasMeterTraces) {
        await tryHotDispose();
        return { restored: targetFile, fromBackup: null, alreadyClean: true };
      }

      const potentialCleanUtils = cleanUtilsSource(currentUtilsRaw);
      const potentialCleanPreload = currentPreloadRaw ? cleanPreloadSource(currentPreloadRaw) : '';
      const utilsDiag = diagnoseCleanStructure(potentialCleanUtils);
      if (!utilsDiag.ok || !validateSyntax(potentialCleanUtils, 'clean-utils.js') || (potentialCleanPreload && !validateSyntax(potentialCleanPreload, 'clean-preload.js'))) {
        throw new Error(`原位卸载校验失败 (${utilsDiag.stage})，已保留原文件现场。`);
      }

      const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const staging = path.join(os.tmpdir(), `ag-restore-staging-${stamp}`);
      const packed = path.join(os.tmpdir(), `ag-restore-packed-${stamp}.asar`);
      try {
        fs.mkdirSync(staging, { recursive: true });
        clearAsarCache(targetFile);
        extractAllAsar(targetFile, staging);
        fs.writeFileSync(path.join(staging, 'dist', 'utils.js'), potentialCleanUtils, 'utf8');
        if (currentPreloadRaw && fs.existsSync(path.join(staging, 'dist', 'preload.js'))) {
          fs.writeFileSync(path.join(staging, 'dist', 'preload.js'), potentialCleanPreload, 'utf8');
        }
        for (const f of STALE_ADDITIONS) {
          try { const p = path.join(staging, 'dist', f); if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
        }
        for (const d of ['i18n', 'rehydrate', 'assets']) {
          try { fs.rmSync(path.join(staging, 'dist', d), { recursive: true, force: true }); } catch {}
        }

        const unpackedPaths = collectUnpackedPaths(asar, targetFile);
        await builtinAsar.createPackageWithOptions(staging, packed, unpackedPaths.size > 0 ? { unpackedPaths } : {});
        const tempReplacement = path.join(path.dirname(targetFile), `app.asar.restore_tmp_${stamp}`);
        fs.copyFileSync(packed, tempReplacement);
        try {
          fs.copyFileSync(tempReplacement, targetFile);
          clearAsarCache(targetFile);
        } finally {
          try { if (fs.existsSync(tempReplacement)) fs.unlinkSync(tempReplacement); } catch {}
        }
        const postRestoreUtils = extractAsarFile(targetFile, 'dist/utils.js').toString('utf8');
        if (postRestoreUtils.includes('installContextMeter') || !verifyCleanStructure(postRestoreUtils)) {
          throw new Error('原位卸载写回后校验失败');
        }
        const hotDisposed = await tryHotDispose();
        if (hasManifest) {
          try {
            info.restoredAt = new Date().toISOString();
            info.inPlaceCleaned = true;
            fs.writeFileSync(manifestPath, JSON.stringify(info, null, 2));
          } catch {}
        }
        return { restored: targetFile, inPlaceCleaned: true, hotDisposed };
      } finally {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(packed, { force: true }); } catch {}
        try { fs.rmSync(packed + '.unpacked', { recursive: true, force: true }); } catch {}
      }
    }

    if (!validBackup) throw new Error('Backup checksum mismatch; refusing restore');
    fs.copyFileSync(validBackup, targetFile);
    clearAsarCache(targetFile);
    if (sha(targetFile) !== validExpectedSha) throw new Error('Restored file checksum mismatch');
    const hotDisposed = await tryHotDispose();
    return { restored: targetFile, fromBackup: validBackup, inPlaceCleaned: false, hotDisposed };
  } finally {
    fileLock.release();
  }
}

if (require.main === module) {
  restore()
    .then(res => console.log('Restored:', JSON.stringify(res)))
    .catch(err => {
      console.error(err.message);
      process.exitCode = 1;
    });
}

module.exports = { restore, tryHotDispose };
