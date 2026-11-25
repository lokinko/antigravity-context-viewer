'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('path');
const http = require('node:http');

const { builtinAsar } = require('../asar-engine');
const {
  TAGS,
  cleanUtilsSource,
  cleanPreloadSource,
  inspectWindowLoadAnchors,
  injectWindowLoadHook,
  diagnoseCleanStructure,
  generateMeterUtilsCode,
  generateMeterPreloadCode
} = require('../modular-installer');
const { install } = require('../install');
const { restore } = require('../restore');
const { createLiveRequestHandler } = require('../live-host');

describe('modular-installer, ASAR install/restore & live-host', () => {
  let tmpDir;
  let origTestMode;
  let origStateDir;

  beforeEach(() => {
    origTestMode = process.env.AG_METER_TEST_MODE;
    origStateDir = process.env.AG_METER_STATE_DIR;
    process.env.AG_METER_TEST_MODE = '1';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-meter-inst-'));
    process.env.AG_METER_STATE_DIR = path.join(tmpDir, 'state');
  });

  afterEach(() => {
    if (origTestMode === undefined) delete process.env.AG_METER_TEST_MODE;
    else process.env.AG_METER_TEST_MODE = origTestMode;
    if (origStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = origStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('supports Antigravity 2.34.0 loadHubWindowUrl anchor and cleans legacy tags', () => {
    const sampleUtils = `"use strict";
function setupNodeWrapper(env) {}
function createWindow(url, storageManager, options) {
    const win = { loadURL: async () => {} };
    void loadHubWindowUrl(win, url, { skipBootstrapMint: true });
    return win;
}`;
    const anchor = inspectWindowLoadAnchors(sampleUtils);
    assert.equal(anchor.status, 'unique');
    assert.equal(anchor.target.kind, 'hub_loader_v234');

    const meter = generateMeterUtilsCode();
    const patched = injectWindowLoadHook(`${TAGS.PROXY_START}\nconst x = 1;\n${TAGS.PROXY_END}\n` + sampleUtils, meter.windowLoadHook);
    const cleaned = cleanUtilsSource(patched);
    assert.equal(diagnoseCleanStructure(cleaned).ok, true);
    assert.equal(cleaned.includes('installContextMeter'), false);
    assert.equal(cleaned.includes(TAGS.PROXY_START), false);

    const preloadBase = 'const electron_1 = require("electron");\n';
    const legacyPreload = preloadBase + `${TAGS.CHINESE_START}\nwindow.__X=1;\n${TAGS.CHINESE_END}\n` + generateMeterPreloadCode();
    assert.equal(cleanPreloadSource(legacyPreload).trim(), preloadBase.trim());
  });

  it('performs full ASAR install and lossless restore round-trip', async () => {
    const srcApp = path.join(tmpDir, 'src-app');
    const distDir = path.join(srcApp, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(srcApp, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.34.0' }));
    const origUtils = `"use strict";
function setupNodeWrapper(env) {}
function createWindow(url, storageManager, options) {
    const win = { loadURL: async () => {} };
    void loadHubWindowUrl(win, url);
    return win;
}`;
    const origPreload = 'const electron_1 = require("electron");\n';
    fs.writeFileSync(path.join(distDir, 'utils.js'), origUtils);
    fs.writeFileSync(path.join(distDir, 'preload.js'), origPreload);

    const mockAsar = path.join(tmpDir, 'app.asar');
    await builtinAsar.createPackage(srcApp, mockAsar);
    const origBytes = fs.readFileSync(mockAsar);

    const stateDir = path.join(tmpDir, 'state');
    const resInstall = await install({ path: mockAsar, stateDir, noHotInject: true });
    assert.equal(resInstall.version, '2.34.0');
    assert.ok(fs.existsSync(resInstall.backup));

    const patchedUtils = builtinAsar.extractFile(mockAsar, 'dist/utils.js').toString('utf8');
    assert.ok(patchedUtils.includes('installContextMeter'));
    const patchedPreload = builtinAsar.extractFile(mockAsar, 'dist/preload.js').toString('utf8');
    assert.ok(patchedPreload.includes('contextMeterAPI'));

    const resRestore = await restore({ path: mockAsar, stateDir });
    assert.equal(resRestore.fromBackup, resInstall.backup);
    assert.deepEqual(fs.readFileSync(mockAsar), origBytes);
  });

  it('enforces loopback Origin & token auth on live-host', async () => {
    const secret = 'test-secret-token';
    const handler = createLiveRequestHandler({
      api: { origin: 'http://127.0.0.1:41000', origins: ['http://127.0.0.1:41000'] },
      secret
    });
    const srv = http.createServer(handler);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    try {
      const badTokenRes = await fetch(`http://127.0.0.1:${port}/runtime-info`, {
        method: 'POST',
        headers: { Origin: 'http://127.0.0.1:41000', 'X-AG-Context-Token': 'wrong' },
        body: '{}'
      });
      assert.equal(badTokenRes.status, 403);

      const badOriginRes = await fetch(`http://127.0.0.1:${port}/runtime-info`, {
        method: 'POST',
        headers: { Origin: 'http://evil.example', 'X-AG-Context-Token': secret },
        body: '{}'
      });
      assert.equal(badOriginRes.status, 403);

      const okRes = await fetch(`http://127.0.0.1:${port}/runtime-info`, {
        method: 'POST',
        headers: { Origin: 'http://127.0.0.1:41000', 'X-AG-Context-Token': secret, 'Content-Type': 'application/json' },
        body: '{}'
      });
      assert.equal(okRes.status, 200);
      const data = await okRes.json();
      assert.equal(data.ok, true);
      assert.equal(data.backendSource, 'live-host');
    } finally {
      await new Promise(r => srv.close(r));
    }
  });
});
