'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

describe('renderer build & smoke test', () => {
  it('builds a compact, syntactically valid meter-renderer.js', () => {
    const rendererPath = path.join(__dirname, '..', 'meter-renderer.js');
    const code = fs.readFileSync(rendererPath, 'utf8');
    assert.ok(code.length > 2000 && code.length < 150000, `Unexpected bundle size: ${code.length}`);
    assert.doesNotThrow(() => new vm.Script(code, { filename: 'meter-renderer.js' }));
    for (const cls of ['ico-speed', 'ico-cache', 'ico-5h', 'ico-weekly', '--font-sans', 'font-family: inherit']) {
      assert.ok(code.includes(cls), `Missing expected CSS token ${cls}`);
    }
  });

  it('mounts pill and renders context %, speed, TTFT, and cache hit in Shadow DOM', async () => {
    const coreCode = fs.readFileSync(path.join(__dirname, '..', 'meter-core.js'), 'utf8');
    const rendererCode = fs.readFileSync(path.join(__dirname, '..', 'meter-renderer.js'), 'utf8');

    const listeners = new Map();
    function makeEl(tag) {
      const attrs = new Map();
      const children = [];
      const classSet = new Set();
      const el = {
        tagName: String(tag || 'DIV').toUpperCase(),
        id: '',
        hidden: false,
        checked: true,
        style: {},
        children,
        parentElement: null,
        _textContent: '',
        _innerHTML: '',
        classList: {
          add: (...c) => c.forEach(x => classSet.add(x)),
          remove: (...c) => c.forEach(x => classSet.delete(x)),
          toggle: (c, force) => { if (force === undefined ? !classSet.has(c) : force) classSet.add(c); else classSet.delete(c); },
          contains: (c) => classSet.has(c)
        },
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => attrs.get(k) ?? null,
        appendChild: (ch) => { ch.parentElement = el; children.push(ch); return ch; },
        insertBefore: (ch, ref) => {
          ch.parentElement = el;
          const idx = children.indexOf(ref);
          if (idx >= 0) children.splice(idx, 0, ch); else children.push(ch);
          return ch;
        },
        remove: () => {
          if (el.parentElement) {
            const idx = el.parentElement.children.indexOf(el);
            if (idx >= 0) el.parentElement.children.splice(idx, 1);
            el.parentElement = null;
          }
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, left: 0, right: 800, bottom: 32, width: 800, height: 32 }),
        addEventListener: (ev, fn) => {
          if (!listeners.has(el)) listeners.set(el, new Map());
          listeners.get(el).set(ev, fn);
        },
        attachShadow: () => {
          const idMap = new Map();
          const root = {
            _innerHTML: '',
            get innerHTML() { return this._innerHTML; },
            set innerHTML(html) {
              this._innerHTML = String(html);
              const re = /\bid="([^"]+)"/g;
              let m;
              while ((m = re.exec(this._innerHTML)) !== null) {
                if (!idMap.has(m[1])) {
                  const node = makeEl('div');
                  node.id = m[1];
                  if (m[1] === 'panel') node.hidden = true;
                  idMap.set(m[1], node);
                }
              }
            },
            getElementById: (id) => idMap.get(id) || null
          };
          el.shadowRoot = root;
          return root;
        },
        get textContent() { return this._textContent; },
        set textContent(v) { this._textContent = String(v); },
        get innerHTML() { return this._innerHTML; },
        set innerHTML(v) { this._innerHTML = String(v); children.length = 0; },
        get isConnected() { return Boolean(el.parentElement); }
      };
      return el;
    }

    const body = makeEl('body');
    const docEl = makeEl('html');
    docEl.appendChild(body);

    let pollFn = null;
    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval: (fn) => { pollFn = fn; return 1; },
      clearInterval: () => {},
      location: {
        origin: 'http://127.0.0.1:41000',
        pathname: '/chat/11111111-2222-3333-4444-555555555555',
        hash: '',
        search: ''
      },
      MutationObserver: class { observe() {} disconnect() {} },
      document: {
        hidden: false,
        body,
        documentElement: docEl,
        createElement: makeEl,
        getElementById: (id) => body.children.find(c => c.id === id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {}
      },
      window: null,
      globalThis: null,
      addEventListener: () => {},
      removeEventListener: () => {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.getComputedStyle = () => ({ backgroundColor: 'rgb(24, 24, 27)' });
    sandbox.contextMeterAPI = {
      getSettings: async () => ({ ok: true, settings: { showSpeedInPill: true, showCacheInPill: true, showQuotaInPill: true } }),
      saveSettings: async (p) => ({ ok: true, settings: p }),
      getQuota: async () => ({
        ok: true,
        groups: [
          {
            key: 'gemini',
            displayName: 'Gemini Models',
            shortName: 'Gemini',
            fiveHour: { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.4905, remainingPct: 49.1, resetInSec: 9000 },
            weekly: { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.6338, remainingPct: 63.4, resetInSec: 518400 }
          },
          {
            key: 'third_party',
            displayName: 'Claude and GPT models',
            shortName: 'Claude / GPT',
            fiveHour: { bucketId: '3p-5h', window: '5h', remainingFraction: 1, remainingPct: 100, resetInSec: 18000 },
            weekly: { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5334, remainingPct: 53.3, resetInSec: 518400 }
          }
        ]
      }),
      getTurnState: async () => ({
        ok: true,
        sessionSpeed: { avgTps: 10.0, count: 1 },
        sessionCache: { cacheReadPct: 10.0, totalInput: 1000, evaluatedRequestCount: 1, cacheHitRequestCount: 1 }
      }),
      getDailyUsage: async () => ({
        ok: true,
        todayKey: '2026-11-25',
        today: { date: '2026-11-25', totalTokens: 125000, totalInput: 120000, cacheRead: 90000, totalOutput: 5000, callCount: 8, cacheReadPct: 75 },
        last7Days: [{ date: '2026-11-25', totalTokens: 125000, callCount: 8 }],
        last14Days: [{ date: '2026-11-25', totalTokens: 125000, callCount: 8 }],
        last7DaysTotals: { totalTokens: 320000 },
        last30DaysTotals: { totalTokens: 900000 },
        allTimeTotals: { totalTokens: 1200000 },
        modelsByScope: {
          today: [{ model: 'Gemini 4 Neon', totalTokens: 125000, totalInput: 120000, totalOutput: 5000, cacheReadPct: 75, callCount: 8, sharePct: 100 }],
          last7d: [
            { model: 'Gemini 4 Hydrogen', totalTokens: 200000, totalInput: 190000, totalOutput: 10000, cacheReadPct: 80, callCount: 12, sharePct: 62.5 },
            { model: 'codex/gpt-6.2-sol', isExternal: true, source: 'codex-api', totalTokens: 120000, totalInput: 115000, totalOutput: 5000, cacheReadPct: 75, callCount: 8, sharePct: 37.5 }
          ],
          last30d: [],
          all: []
        },
        days: [{ date: '2026-11-25', totalTokens: 125000, totalInput: 120000, totalOutput: 5000, cacheReadPct: 75 }]
      }),
      scan: async () => ({
        conversation: '11111111-2222-3333-4444-555555555555',
        cascadeStatus: 'CASCADE_RUN_STATUS_IDLE',
        latest: {
          model: 'Gemini Pro',
          used: 25000,
          actual: 25000,
          budget: 100000,
          remaining: 75000,
          percent: 25,
          cached: 18000,
          uncachedInput: 6000,
          rawInput: 6000,
          cacheWrite: 0,
          output: 1000,
          cacheHitRate: 75,
          status: 'reported',
          speed: { displayTps: 88.5, tps: 80, ttft: 0.45, streamingSec: 1.13, outputTokens: 1000, thinkingTokens: 0, phase: 'settled' }
        },
        sessionSpeed: { avgTps: 82.1, count: 3 },
        sessionCache: { cacheReadPct: 72.5, totalInput: 40000, evaluatedRequestCount: 3, cacheHitRequestCount: 3 },
        sessionTotals: { totalTokens: 43000, totalInput: 40000, cacheRead: 29000, totalOutput: 3000, callCount: 3 },
        sessionModels: [
          { model: 'Gemini Pro', totalTokens: 43000, totalInput: 40000, totalOutput: 3000, cacheReadPct: 72.5, callCount: 3, sharePct: 100 }
        ],
        recentCalls: [],
        session: { steps: 6, groups: {} }
      })
    };

    vm.runInNewContext(coreCode + '\n' + rendererCode, sandbox);
    await new Promise(r => setTimeout(r, 30));

    const host = sandbox.document.getElementById('ag-context-meter');
    assert.ok(host);
    const sr = host.shadowRoot;
    assert.equal(sr.getElementById('pill-pct').textContent, 'context 25%');
    assert.equal(sr.getElementById('pill-speed').textContent, 'decode 88.5 tok/s');
    assert.equal(sr.getElementById('pill-cache').textContent, 'kv-cache 75%');
    assert.equal(sr.getElementById('pill-q5h').textContent, '5h 49%');
    assert.equal(sr.getElementById('pill-qw').textContent, 'weekly 63%');
    assert.equal(sr.getElementById('pill-q5h-wrap').hidden, false);
    assert.equal(sr.getElementById('pill-qw-wrap').hidden, false);
    assert.equal(sr.getElementById('pill-quota').hidden, false);

    // Open panel and check session totals + full-session stats preserved across turn-state poll
    listeners.get(sr.getElementById('pill')).get('click')({ stopPropagation: () => {} });
    await pollFn();
    assert.equal(sr.getElementById('quota-card').hidden, false);
    assert.equal(sr.getElementById('quota-list').children.length, 2);
    assert.equal(sr.getElementById('sp-avg').textContent, '82.1 tok/s (3)');
    assert.equal(sr.getElementById('ca-session').textContent, '72.5%');
    assert.equal(sr.getElementById('ca-total-in').textContent, '40K');
    assert.equal(sr.getElementById('st-total').textContent, '43K');
    assert.equal(sr.getElementById('st-calls').textContent, '3 次请求');
    assert.equal(sr.getElementById('st-models').hidden, false);
    assert.equal(sr.getElementById('st-models').children.length, 1);

    listeners.get(sr.getElementById('tab-daily')).get('click')();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(sr.getElementById('dy-today-total').textContent, '125K');
    assert.equal(sr.getElementById('dy-7d').textContent, '320K');
    assert.equal(sr.getElementById('dy-models-list').children.length, 1);

    listeners.get(sr.getElementById('dy-scope-last7d')).get('click')();
    assert.equal(sr.getElementById('dy-models-list').children.length, 2);
    assert.equal(sr.getElementById('dy-model-bar').children.length, 2);
    const extRow = sr.getElementById('dy-models-list').children[1];
    const extNameWrap = extRow.children[0].children[0];
    assert.ok(extNameWrap.children.some(ch => (ch.className === 'model-ext-badge' || ch.classList?.contains('model-ext-badge')) && ch.textContent === 'API'));
    sandbox.__AGContextMeter.dispose();
  });

  it('mounts directly after composer model-selector-trigger and opens popover upward', async () => {
    const coreCode = fs.readFileSync(path.join(__dirname, '..', 'meter-core.js'), 'utf8');
    const rendererCode = fs.readFileSync(path.join(__dirname, '..', 'meter-renderer.js'), 'utf8');

    const listeners = new Map();
    function makeEl(tag, rect = { top: 740, left: 120, right: 240, bottom: 764, width: 120, height: 24 }) {
      const attrs = new Map();
      const children = [];
      const classSet = new Set();
      const el = {
        tagName: String(tag || 'DIV').toUpperCase(),
        id: '',
        hidden: false,
        checked: true,
        style: {},
        children,
        parentElement: null,
        _textContent: '',
        _innerHTML: '',
        classList: {
          add: (...c) => c.forEach(x => classSet.add(x)),
          remove: (...c) => c.forEach(x => classSet.delete(x)),
          toggle: (c, force) => { if (force === undefined ? !classSet.has(c) : force) classSet.add(c); else classSet.delete(c); },
          contains: (c) => classSet.has(c)
        },
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => attrs.get(k) ?? null,
        closest: () => null,
        appendChild: (ch) => { ch.parentElement = el; children.push(ch); return ch; },
        insertBefore: (ch, ref) => {
          ch.parentElement = el;
          const idx = children.indexOf(ref);
          if (idx >= 0) children.splice(idx, 0, ch); else children.push(ch);
          return ch;
        },
        remove: () => {
          if (el.parentElement) {
            const idx = el.parentElement.children.indexOf(el);
            if (idx >= 0) el.parentElement.children.splice(idx, 1);
            el.parentElement = null;
          }
        },
        get nextElementSibling() {
          if (!el.parentElement) return null;
          const idx = el.parentElement.children.indexOf(el);
          return idx >= 0 && idx + 1 < el.parentElement.children.length ? el.parentElement.children[idx + 1] : null;
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => rect,
        addEventListener: (ev, fn) => {
          if (!listeners.has(el)) listeners.set(el, new Map());
          listeners.get(el).set(ev, fn);
        },
        attachShadow: () => {
          const idMap = new Map();
          const root = {
            _innerHTML: '',
            get innerHTML() { return this._innerHTML; },
            set innerHTML(html) {
              this._innerHTML = String(html);
              const re = /\bid="([^"]+)"/g;
              let m;
              while ((m = re.exec(this._innerHTML)) !== null) {
                if (!idMap.has(m[1])) {
                  const node = makeEl('div', rect);
                  node.id = m[1];
                  if (m[1] === 'panel') node.hidden = true;
                  idMap.set(m[1], node);
                }
              }
            },
            getElementById: (id) => idMap.get(id) || null
          };
          el.shadowRoot = root;
          return root;
        },
        get textContent() { return this._textContent; },
        set textContent(v) { this._textContent = String(v); },
        get innerHTML() { return this._innerHTML; },
        set innerHTML(v) { this._innerHTML = String(v); children.length = 0; },
        get isConnected() { return Boolean(el.parentElement); }
      };
      return el;
    }

    const body = makeEl('body');
    const docEl = makeEl('html');
    const composerBar = makeEl('div');
    const modelTrigger = makeEl('button', { top: 740, left: 80, right: 114, bottom: 764, width: 34, height: 24 });
    const sendBtn = makeEl('button', { top: 740, left: 300, right: 330, bottom: 764, width: 30, height: 24 });
    modelTrigger.closest = (sel) => (sel.includes('composer') ? composerBar : null);
    composerBar.appendChild(modelTrigger);
    composerBar.appendChild(sendBtn);
    body.appendChild(composerBar);
    docEl.appendChild(body);

    let pollFn = null;
    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval: (fn) => { pollFn = fn; return 1; },
      clearInterval: () => {},
      innerWidth: 1280,
      innerHeight: 800,
      location: { origin: 'http://127.0.0.1:41000', pathname: '/chat/11111111-2222-3333-4444-555555555555', hash: '', search: '' },
      MutationObserver: class { observe() {} disconnect() {} },
      document: {
        hidden: false,
        body,
        documentElement: docEl,
        createElement: (tag) => makeEl(tag),
        getElementById: (id) => composerBar.children.find(c => c.id === id) || null,
        querySelector: () => null,
        querySelectorAll: (sel) => (sel.includes('model-selector-trigger') ? [modelTrigger] : []),
        addEventListener: () => {},
        removeEventListener: () => {}
      },
      window: null,
      globalThis: null,
      addEventListener: () => {},
      removeEventListener: () => {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.getComputedStyle = () => ({ backgroundColor: 'rgb(24, 24, 27)' });
    sandbox.contextMeterAPI = {
      getSettings: async () => ({ ok: true, settings: { showSpeedInPill: true, showCacheInPill: true, showQuotaInPill: true } }),
      saveSettings: async (p) => ({ ok: true, settings: p }),
      getQuota: async () => ({
        ok: true,
        groups: [
          {
            key: 'gemini',
            displayName: 'Gemini Models',
            shortName: 'Gemini',
            fiveHour: { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.4905, remainingPct: 49.1, resetInSec: 9000 },
            weekly: { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.6338, remainingPct: 63.4, resetInSec: 518400 }
          },
          {
            key: 'third_party',
            displayName: 'Claude and GPT models',
            shortName: 'Claude / GPT',
            fiveHour: { bucketId: '3p-5h', window: '5h', remainingFraction: 1, remainingPct: 100, resetInSec: 18000 },
            weekly: { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5334, remainingPct: 53.3, resetInSec: 518400 }
          }
        ]
      }),
      getTurnState: async () => ({
        ok: true,
        sessionSpeed: { avgTps: 10.0, count: 1 },
        sessionCache: { cacheReadPct: 10.0, totalInput: 1000, evaluatedRequestCount: 1, cacheHitRequestCount: 1 }
      }),
      getDailyUsage: async () => ({ ok: true, todayKey: '2026-11-25', today: {}, last14Days: [], days: [] }),
      scan: async () => ({
        conversation: '11111111-2222-3333-4444-555555555555',
        cascadeStatus: 'CASCADE_RUN_STATUS_IDLE',
        latest: { model: 'Gemini Pro', used: 25000, actual: 25000, budget: 100000, remaining: 75000, percent: 25, cacheHitRate: 75, status: 'reported' },
        sessionTotals: { totalTokens: 43000, totalInput: 40000, cacheRead: 29000, totalOutput: 3000, callCount: 3 },
        sessionModels: [
          { model: 'Gemini Pro', totalTokens: 43000, totalInput: 40000, totalOutput: 3000, cacheReadPct: 72.5, callCount: 3, sharePct: 100 }
        ],
        recentCalls: [],
        session: { steps: 6, groups: {} }
      })
    };

    vm.runInNewContext(coreCode + '\n' + rendererCode, sandbox);
    await new Promise(r => setTimeout(r, 30));

    assert.equal(composerBar.children[0], modelTrigger);
    assert.equal(composerBar.children[1].id, 'ag-context-meter');
    assert.equal(composerBar.children[2], sendBtn);
    assert.equal(sandbox.__AGContextMeter.getState().mountMode, 'composer');

    const sr = composerBar.children[1].shadowRoot;
    listeners.get(sr.getElementById('pill')).get('click')({ stopPropagation: () => {} });
    const panel = sr.getElementById('panel');
    assert.equal(panel.hidden, false);
    assert.equal(panel.style.top, 'auto');
    assert.equal(panel.style.bottom, '68px');
    assert.equal(panel.style.left, '120px');
    sandbox.__AGContextMeter.dispose();
  });

  it('skips block wrapper around model-selector-trigger and mounts into horizontal flex row', async () => {
    const coreCode = fs.readFileSync(path.join(__dirname, '..', 'meter-core.js'), 'utf8');
    const rendererCode = fs.readFileSync(path.join(__dirname, '..', 'meter-renderer.js'), 'utf8');

    function makeEl(tag, styleObj = {}) {
      const children = [];
      const classSet = new Set();
      const el = {
        tagName: String(tag || 'DIV').toUpperCase(),
        id: '',
        hidden: false,
        checked: true,
        style: { ...styleObj },
        children,
        parentElement: null,
        _textContent: '',
        _innerHTML: '',
        classList: {
          add: (...c) => c.forEach(x => classSet.add(x)),
          remove: (...c) => c.forEach(x => classSet.delete(x)),
          toggle: (c, force) => { if (force === undefined ? !classSet.has(c) : force) classSet.add(c); else classSet.delete(c); },
          contains: (c) => classSet.has(c)
        },
        setAttribute: () => {},
        getAttribute: () => null,
        closest: () => null,
        matches: () => false,
        appendChild: (ch) => { ch.parentElement = el; children.push(ch); return ch; },
        insertBefore: (ch, ref) => {
          ch.parentElement = el;
          const idx = children.indexOf(ref);
          if (idx >= 0) children.splice(idx, 0, ch); else children.push(ch);
          return ch;
        },
        remove: () => {
          if (el.parentElement) {
            const idx = el.parentElement.children.indexOf(el);
            if (idx >= 0) el.parentElement.children.splice(idx, 1);
            el.parentElement = null;
          }
        },
        get nextElementSibling() {
          if (!el.parentElement) return null;
          const idx = el.parentElement.children.indexOf(el);
          return idx >= 0 && idx + 1 < el.parentElement.children.length ? el.parentElement.children[idx + 1] : null;
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 740, left: 120, right: 240, bottom: 764, width: 120, height: 24 }),
        addEventListener: () => {},
        attachShadow: () => {
          const idMap = new Map();
          const root = {
            _innerHTML: '',
            get innerHTML() { return this._innerHTML; },
            set innerHTML(html) {
              this._innerHTML = String(html);
              const re = /\bid="([^"]+)"/g;
              let m;
              while ((m = re.exec(this._innerHTML)) !== null) {
                if (!idMap.has(m[1])) {
                  const node = makeEl('div');
                  node.id = m[1];
                  if (m[1] === 'panel') node.hidden = true;
                  idMap.set(m[1], node);
                }
              }
            },
            getElementById: (id) => idMap.get(id) || null
          };
          el.shadowRoot = root;
          return root;
        },
        get textContent() { return this._textContent; },
        set textContent(v) { this._textContent = String(v); },
        get innerHTML() { return this._innerHTML; },
        set innerHTML(v) { this._innerHTML = String(v); children.length = 0; },
        get isConnected() { return Boolean(el.parentElement); }
      };
      return el;
    }

    const body = makeEl('body', { backgroundColor: 'rgb(24, 24, 27)' });
    const docEl = makeEl('html');
    const composerRoot = makeEl('div', { display: 'flex', flexDirection: 'column' });
    const toolbarRow = makeEl('div', { display: 'flex', flexDirection: 'row', justifyContent: 'space-between' });
    const popoverWrapper = makeEl('div', { display: 'block' });
    const modelTrigger = makeEl('button', { display: 'inline-flex' });
    const rightGroup = makeEl('div', { display: 'flex', flexDirection: 'row' });

    modelTrigger.closest = (sel) => (sel.includes('composer') ? composerRoot : null);
    popoverWrapper.appendChild(modelTrigger);
    toolbarRow.appendChild(popoverWrapper);
    toolbarRow.appendChild(rightGroup);
    composerRoot.appendChild(toolbarRow);
    body.appendChild(composerRoot);
    docEl.appendChild(body);

    let pollFn = null;
    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval: (fn) => { pollFn = fn; return 1; },
      clearInterval: () => {},
      innerWidth: 1280,
      innerHeight: 800,
      location: { origin: 'http://127.0.0.1:41000', pathname: '/chat/11111111-2222-3333-4444-555555555555', hash: '', search: '' },
      MutationObserver: class { observe() {} disconnect() {} },
      document: {
        hidden: false,
        body,
        documentElement: docEl,
        createElement: (tag) => makeEl(tag),
        getElementById: (id) => toolbarRow.children.find(c => c.id === id) || null,
        querySelector: () => null,
        querySelectorAll: (sel) => (sel.includes('model-selector-trigger') ? [modelTrigger] : []),
        addEventListener: () => {},
        removeEventListener: () => {}
      },
      window: null,
      globalThis: null,
      addEventListener: () => {},
      removeEventListener: () => {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.getComputedStyle = (node) => node?.style || {};
    sandbox.contextMeterAPI = {
      getSettings: async () => ({ ok: true, settings: { showSpeedInPill: true, showCacheInPill: true, showQuotaInPill: true } }),
      saveSettings: async (p) => ({ ok: true, settings: p }),
      getQuota: async () => ({
        ok: true,
        groups: [
          {
            key: 'gemini',
            displayName: 'Gemini Models',
            shortName: 'Gemini',
            fiveHour: { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.4905, remainingPct: 49.1, resetInSec: 9000 },
            weekly: { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.6338, remainingPct: 63.4, resetInSec: 518400 }
          },
          {
            key: 'third_party',
            displayName: 'Claude and GPT models',
            shortName: 'Claude / GPT',
            fiveHour: { bucketId: '3p-5h', window: '5h', remainingFraction: 1, remainingPct: 100, resetInSec: 18000 },
            weekly: { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5334, remainingPct: 53.3, resetInSec: 518400 }
          }
        ]
      }),
      getTurnState: async () => ({
        ok: true,
        sessionSpeed: { avgTps: 10.0, count: 1 },
        sessionCache: { cacheReadPct: 10.0, totalInput: 1000, evaluatedRequestCount: 1, cacheHitRequestCount: 1 }
      }),
      getDailyUsage: async () => ({ ok: true }),
      scan: async () => ({
        conversation: '11111111-2222-3333-4444-555555555555',
        cascadeStatus: 'CASCADE_RUN_STATUS_IDLE',
        latest: { model: 'Gemini Pro', used: 25000, actual: 25000, budget: 100000, remaining: 75000, percent: 25, status: 'reported' },
        sessionTotals: { totalTokens: 43000, totalInput: 40000, cacheRead: 29000, totalOutput: 3000, callCount: 3 },
        sessionModels: [
          { model: 'Gemini Pro', totalTokens: 43000, totalInput: 40000, totalOutput: 3000, cacheReadPct: 72.5, callCount: 3, sharePct: 100 }
        ],
        recentCalls: [],
        session: { steps: 6, groups: {} }
      })
    };

    vm.runInNewContext(coreCode + '\n' + rendererCode, sandbox);
    await new Promise(r => setTimeout(r, 30));

    assert.equal(popoverWrapper.children.length, 1);
    assert.equal(toolbarRow.children[0], popoverWrapper);
    assert.equal(toolbarRow.children[1].id, 'ag-context-meter');
    assert.equal(toolbarRow.children[1].style.marginRight, 'auto');
    assert.equal(toolbarRow.children[2], rightGroup);
    sandbox.__AGContextMeter.dispose();
  });

  it('skips idle full rescans during polling when stepCount and lastModifiedTime are unchanged', async () => {
    const coreCode = fs.readFileSync(path.join(__dirname, '..', 'meter-core.js'), 'utf8');
    const rendererCode = fs.readFileSync(path.join(__dirname, '..', 'meter-renderer.js'), 'utf8');

    const body = { tagName: 'BODY', children: [], style: {}, appendChild(c) { c.parentElement = this; this.children.push(c); return c; } };
    function makeSimpleEl(tag) {
      const attrs = new Map();
      const children = [];
      const classSet = new Set();
      const el = {
        tagName: String(tag || 'DIV').toUpperCase(),
        id: '',
        hidden: false,
        checked: true,
        style: {},
        children,
        parentElement: null,
        _textContent: '',
        classList: {
          add: (...c) => c.forEach(x => classSet.add(x)),
          remove: (...c) => c.forEach(x => classSet.delete(x)),
          toggle: (c, f) => { if (f === undefined ? !classSet.has(c) : f) classSet.add(c); else classSet.delete(c); },
          contains: (c) => classSet.has(c)
        },
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => attrs.get(k) ?? null,
        appendChild: (ch) => { ch.parentElement = el; children.push(ch); return ch; },
        remove: () => { const i = body.children.indexOf(el); if (i >= 0) body.children.splice(i, 1); el.parentElement = null; },
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, left: 0, right: 800, bottom: 32, width: 800, height: 32 }),
        addEventListener: () => {},
        attachShadow: () => {
          const idMap = new Map();
          el.shadowRoot = {
            _innerHTML: '',
            get innerHTML() { return this._innerHTML; },
            set innerHTML(html) {
              this._innerHTML = String(html);
              const re = /\bid="([^"]+)"/g;
              let m;
              while ((m = re.exec(this._innerHTML)) !== null) {
                if (!idMap.has(m[1])) {
                  const node = makeSimpleEl('div');
                  node.id = m[1];
                  if (m[1] === 'panel') node.hidden = true;
                  idMap.set(m[1], node);
                }
              }
            },
            getElementById: (id) => idMap.get(id) || null
          };
          return el.shadowRoot;
        },
        get textContent() { return this._textContent; },
        set textContent(v) { this._textContent = String(v); },
        get innerHTML() { return ''; },
        set innerHTML(v) { children.length = 0; },
        get isConnected() { return Boolean(el.parentElement); }
      };
      return el;
    }

    let pollFn = null;
    let scanCalls = 0;
    let turnStateCalls = 0;
    let curSteps = 6;
    let curMod = '2026-11-25T10:00:00Z';

    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval: (fn) => { pollFn = fn; return 1; },
      clearInterval: () => {},
      location: { origin: 'http://127.0.0.1:41000', pathname: '/chat/11111111-2222-3333-4444-555555555555', hash: '', search: '' },
      MutationObserver: class { observe() {} disconnect() {} },
      document: {
        hidden: false,
        body,
        documentElement: body,
        createElement: makeSimpleEl,
        getElementById: (id) => body.children.find(c => c.id === id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {}
      },
      window: null,
      globalThis: null,
      addEventListener: () => {},
      removeEventListener: () => {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.getComputedStyle = () => ({ backgroundColor: 'rgb(24, 24, 27)' });
    sandbox.contextMeterAPI = {
      getSettings: async () => ({ ok: true, settings: { showSpeedInPill: true, showCacheInPill: true } }),
      saveSettings: async (p) => ({ ok: true, settings: p }),
      getTurnState: async () => {
        turnStateCalls++;
        return {
          ok: true,
          cascadeStatus: 'CASCADE_RUN_STATUS_IDLE',
          stepCount: curSteps,
          lastModifiedTime: curMod,
          latest: { model: 'Gemini Pro', used: 25000, actual: 25000, budget: 100000, percent: 25, status: 'reported' },
          turnTiming: { isRunning: false }
        };
      },
      getDailyUsage: async () => ({ ok: true }),
      scan: async () => {
        scanCalls++;
        return {
          conversation: '11111111-2222-3333-4444-555555555555',
          cascadeStatus: 'CASCADE_RUN_STATUS_IDLE',
          lastModifiedTime: curMod,
          latest: { model: 'Gemini Pro', used: 25000, actual: 25000, budget: 100000, percent: 25, status: 'reported' },
          sessionTotals: { totalTokens: 25000, totalInput: 24000, cacheRead: 20000, totalOutput: 1000, callCount: 2 },
          sessionModels: [],
          recentCalls: [],
          session: { steps: curSteps, groups: {} }
        };
      }
    };

    vm.runInNewContext(coreCode + '\n' + rendererCode, sandbox);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(scanCalls, 1);

    // First idle poll executes turn-state, skips scan because stepCount & lastModifiedTime match
    await pollFn();
    assert.equal(turnStateCalls, 1);
    assert.equal(scanCalls, 1);

    // Immediate non-forced poll is throttled by idle backoff
    await pollFn();
    assert.equal(turnStateCalls, 1);

    // Forced wake with unchanged metadata still skips full scan
    await pollFn(true);
    assert.equal(turnStateCalls, 2);
    assert.equal(scanCalls, 1);

    // Forced wake after stepCount increments triggers full scan
    curSteps = 7;
    curMod = '2026-11-25T10:01:00Z';
    await pollFn(true);
    assert.equal(turnStateCalls, 3);
    assert.equal(scanCalls, 2);

    sandbox.__AGContextMeter.dispose();
  });
});
