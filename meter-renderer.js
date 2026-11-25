(function () {
  const METER_VERSION = '1.0.0';
  const METER_DISPLAY_VERSION = '1.0.0';
  const BUILD_ID = 'def5ca866a5a';
  const RING_CIRCUMFERENCE = 2 * Math.PI * 7;
  const MODEL_COLORS = ['#3b82f6', '#10b981', '#a855f7', '#f59e0b', '#ec4899', '#06b6d4'];

  if (typeof globalThis.__AGContextMeter?.dispose === 'function') {
    try { globalThis.__AGContextMeter.dispose(); } catch {}
  }

  const core = globalThis.__AGContextMeterCore;
  if (!core) return;

  const existingHost = document.getElementById('ag-context-meter');
  if (existingHost) existingHost.remove();

  const host = document.createElement('div');
  host.id = 'ag-context-meter';
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `<style>
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.4;
  color: var(--fg);
  display: inline-flex;
  align-items: center;
  position: relative;
  z-index: 2147483000;
  user-select: none;
  -webkit-app-region: no-drag;
}

:host([data-theme="dark"]) {
  --bg: rgba(24, 24, 27, 0.96);
  --card: rgba(36, 36, 42, 0.72);
  --border: rgba(255, 255, 255, 0.12);
  --fg: #f4f4f5;
  --muted: #a1a1aa;
  --pill-bg: rgba(255, 255, 255, 0.06);
  --pill-hover: rgba(255, 255, 255, 0.12);
  --track: rgba(255, 255, 255, 0.1);
  --shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}

:host([data-theme="light"]) {
  --bg: rgba(255, 255, 255, 0.97);
  --card: rgba(244, 244, 246, 0.85);
  --border: rgba(0, 0, 0, 0.1);
  --fg: #18181b;
  --muted: #52525b;
  --pill-bg: rgba(0, 0, 0, 0.05);
  --pill-hover: rgba(0, 0, 0, 0.1);
  --track: rgba(0, 0, 0, 0.09);
  --shadow: 0 12px 28px rgba(0, 0, 0, 0.16);
}

:host {
  --ok: #22c55e;
  --warn: #f59e0b;
  --crit: #ef4444;
  --cache: #10b981;
  --uncached: #3b82f6;
  --write: #a855f7;
  --output: #f59e0b;
}

.wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.wrap.floating {
  position: fixed;
  top: 8px;
  right: 14px;
}

.wrap.in-composer .pill {
  height: 22px;
  padding: 0 7px;
  font-size: 11px;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--pill-bg);
  color: var(--fg);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  transition: background 0.15s ease, border-color 0.15s ease;
  white-space: nowrap;
}

.pill:hover {
  background: var(--pill-hover);
}

.pill.warn { border-color: rgba(245, 158, 11, 0.45); }
.pill.crit { border-color: rgba(239, 68, 68, 0.55); }

.ring {
  width: 14px;
  height: 14px;
  transform: rotate(-90deg);
  flex-shrink: 0;
}

.ring-bg {
  fill: none;
  stroke: var(--track);
  stroke-width: 2.5;
}

.ring-fg {
  fill: none;
  stroke: var(--ok);
  stroke-width: 2.5;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.25s ease, stroke 0.2s ease;
}

.pill.warn .ring-fg { stroke: var(--warn); }
.pill.crit .ring-fg { stroke: var(--crit); }

.pill-sep { opacity: 0.35; }
.pill-chip { color: var(--muted); font-size: 10.5px; }
.pill-chip.live { color: var(--cache); }

.panel {
  position: fixed;
  width: 356px;
  max-height: calc(100vh - 52px);
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(14px);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  z-index: 2147483001;
}

.panel[hidden] { display: none; }

.hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.hdr-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
}

.dot.ok { background: var(--ok); }
.dot.run { background: var(--warn); animation: pulse 1s infinite; }
.dot.err { background: var(--crit); }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.model-name {
  font-weight: 600;
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hdr-actions {
  display: inline-flex;
  gap: 4px;
  flex-shrink: 0;
}

.icon-btn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  border-radius: 6px;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}

.icon-btn:hover {
  background: var(--pill-hover);
  color: var(--fg);
}

.tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background: var(--card);
  border: 1px solid var(--border);
}

.tab {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.tab:hover { color: var(--fg); }

.tab.active {
  background: var(--pill-hover);
  color: var(--fg);
}

.view {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.view[hidden] { display: none; }

.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 10px;
}

.ctx-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.ctx-main {
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.ctx-pct {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.muted-note {
  font-size: 10.5px;
  color: var(--muted);
}

.ctx-sub {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}

.seg-bar {
  height: 7px;
  border-radius: 999px;
  background: var(--track);
  overflow: hidden;
  display: flex;
  margin-top: 8px;
}

.seg { height: 100%; transition: width 0.25s ease; }
.seg-cache { background: var(--cache); }
.seg-uncached { background: var(--uncached); }
.seg-write { background: var(--write); }
.seg-output { background: var(--output); }

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 7px;
  font-size: 10.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.leg-item { display: inline-flex; align-items: center; gap: 4px; }
.leg-swatch { width: 7px; height: 7px; border-radius: 2px; }

.strip-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 7px;
  padding-top: 7px;
  border-top: 1px solid var(--border);
}

.mini-stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-variant-numeric: tabular-nums;
}

.mini-stat .k { font-size: 10px; color: var(--muted); }
.mini-stat .v { font-size: 11.5px; font-weight: 600; }

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.card-title {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 6px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.kv {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  padding: 2px 0;
  font-variant-numeric: tabular-nums;
}

.kv .k { color: var(--muted); }
.kv .v { font-weight: 600; }

.comp-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 10px;
}

.bar-chart {
  display: grid;
  grid-template-columns: repeat(14, 1fr);
  gap: 4px;
  align-items: stretch;
  height: 76px;
  padding-top: 6px;
}

.bar-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
  gap: 4px;
  cursor: pointer;
  background: transparent;
  border: none;
  padding: 0;
  color: inherit;
}

.bar-track {
  width: 100%;
  height: 56px;
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  border-radius: 3px;
  background: var(--track);
  overflow: hidden;
}

.bar-fill {
  width: 100%;
  background: var(--uncached);
  border-radius: 3px 3px 0 0;
  transition: height 0.2s ease, background 0.15s ease;
}

.bar-col:hover .bar-fill,
.bar-col.selected .bar-fill {
  background: var(--cache);
}

.bar-lbl {
  display: block;
  height: 12px;
  min-height: 12px;
  line-height: 12px;
  flex-shrink: 0;
  text-align: center;
  font-size: 9px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.bar-col.selected .bar-lbl {
  color: var(--fg);
  font-weight: 600;
}

.scope-pills {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: var(--track);
}

.scope-btn {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
}

.scope-btn:hover { color: var(--fg); }

.scope-btn.active {
  background: var(--pill-hover);
  color: var(--fg);
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.model-list.compact {
  margin-top: 7px;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  gap: 4px;
}

.model-list[hidden] { display: none; }

.model-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-variant-numeric: tabular-nums;
}

.model-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
}

.model-name-lbl {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.model-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.model-val {
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}

.model-row-sub {
  font-size: 10px;
  color: var(--muted);
  padding-left: 11px;
}

.model-empty {
  font-size: 10.5px;
  color: var(--muted);
  text-align: center;
  padding: 4px 0;
}

table.calls {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

table.calls th {
  text-align: right;
  color: var(--muted);
  font-weight: 500;
  padding: 0 3px 4px;
  border-bottom: 1px solid var(--border);
}

table.calls th:first-child { text-align: left; }
table.calls td { text-align: right; padding: 3px 3px 0; }
table.calls td:first-child { text-align: left; color: var(--muted); }

.notice {
  font-size: 11px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(245, 158, 11, 0.35);
  background: rgba(245, 158, 11, 0.1);
  color: var(--fg);
}

.notice.err {
  border-color: rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.12);
}

.ftr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 10.5px;
  color: var(--muted);
  padding-top: 2px;
}

.opts { display: inline-flex; align-items: center; gap: 8px; }
.opt { display: inline-flex; align-items: center; gap: 3px; cursor: pointer; }
.opt input { margin: 0; cursor: pointer; }
</style>
<div class="wrap" id="wrap">
  <button class="pill" id="pill" type="button" title="查看上下文、生成速度、缓存命中与每日用量">
    <svg class="ring" viewBox="0 0 18 18" aria-hidden="true">
      <circle class="ring-bg" cx="9" cy="9" r="7"></circle>
      <circle class="ring-fg" id="ring-fg" cx="9" cy="9" r="7" stroke-dasharray="43.98" stroke-dashoffset="43.98"></circle>
    </svg>
    <span id="pill-pct">—</span>
    <span class="pill-sep" id="pill-sep-speed" hidden>·</span>
    <span class="pill-chip" id="pill-speed" hidden></span>
    <span class="pill-sep" id="pill-sep-cache" hidden>·</span>
    <span class="pill-chip" id="pill-cache" hidden></span>
  </button>

  <div class="panel" id="panel" hidden>
    <div class="hdr">
      <div class="hdr-left">
        <span class="dot" id="status-dot"></span>
        <span class="model-name" id="model-name">等待会话</span>
      </div>
      <div class="hdr-actions">
        <button class="icon-btn" id="btn-refresh" type="button" title="刷新">↻</button>
        <button class="icon-btn" id="btn-close" type="button" title="关闭">×</button>
      </div>
    </div>

    <div class="tabs" role="tablist">
      <button class="tab active" id="tab-session" type="button" role="tab" aria-selected="true">当前对话</button>
      <button class="tab" id="tab-daily" type="button" role="tab" aria-selected="false">每日用量</button>
    </div>

    <div id="view-session" class="view">
      <div class="notice" id="notice" hidden></div>

      <div class="card">
        <div class="ctx-top">
          <span class="ctx-main" id="ctx-headline">— / —</span>
          <span class="ctx-pct" id="ctx-pct">—</span>
        </div>
        <div class="ctx-sub">
          <span id="ctx-status">未采集</span>
          <span id="ctx-remaining">剩余 —</span>
        </div>
        <div class="seg-bar">
          <div class="seg seg-cache" id="seg-cache" style="width:0%"></div>
          <div class="seg seg-uncached" id="seg-uncached" style="width:0%"></div>
          <div class="seg seg-write" id="seg-write" style="width:0%"></div>
          <div class="seg seg-output" id="seg-output" style="width:0%"></div>
        </div>
        <div class="legend" id="ctx-legend">
          <span class="leg-item"><i class="leg-swatch" style="background:var(--cache)"></i><span id="leg-cache">缓存读 —</span></span>
          <span class="leg-item"><i class="leg-swatch" style="background:var(--uncached)"></i><span id="leg-uncached">新输入 —</span></span>
          <span class="leg-item"><i class="leg-swatch" style="background:var(--write)"></i><span id="leg-write">写缓存 —</span></span>
          <span class="leg-item"><i class="leg-swatch" style="background:var(--output)"></i><span id="leg-output">输出 —</span></span>
        </div>
      </div>

      <div class="card" id="session-totals-card">
        <div class="card-title">
          <span>本对话累计总消耗</span>
          <span id="st-calls">—</span>
        </div>
        <div class="ctx-top">
          <span class="ctx-main" id="st-total">—</span>
          <span class="muted-note">输入 + 输出累计</span>
        </div>
        <div class="strip-3">
          <div class="mini-stat"><span class="k">累计输入</span><span class="v" id="st-in">—</span></div>
          <div class="mini-stat"><span class="k">缓存读取</span><span class="v" id="st-cache">—</span></div>
          <div class="mini-stat"><span class="k">累计输出</span><span class="v" id="st-out">—</span></div>
        </div>
        <div class="model-list compact" id="st-models" hidden></div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-title">
            <span>生成速度 & 延迟</span>
            <span id="speed-phase"></span>
          </div>
          <div class="kv"><span class="k">流式速度</span><span class="v" id="sp-stream">—</span></div>
          <div class="kv"><span class="k">首字延迟</span><span class="v" id="sp-ttft">—</span></div>
          <div class="kv"><span class="k">生成耗时</span><span class="v" id="sp-dur">—</span></div>
          <div class="kv"><span class="k">本次输出</span><span class="v" id="sp-out">—</span></div>
          <div class="kv"><span class="k">会话均速</span><span class="v" id="sp-avg">—</span></div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>缓存命中</span>
            <span id="cache-reqs"></span>
          </div>
          <div class="kv"><span class="k">本次命中</span><span class="v" id="ca-last">—</span></div>
          <div class="kv"><span class="k">会话加权</span><span class="v" id="ca-session">—</span></div>
          <div class="kv"><span class="k">缓存读取</span><span class="v" id="ca-read">—</span></div>
          <div class="kv"><span class="k">未缓存输入</span><span class="v" id="ca-uncached">—</span></div>
          <div class="kv"><span class="k">累计输入</span><span class="v" id="ca-total-in">—</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>上下文构成（估算）</span>
          <span id="comp-steps"></span>
        </div>
        <div class="comp-list">
          <div class="kv"><span class="k">系统提示</span><span class="v" id="cmp-sys">—</span></div>
          <div class="kv"><span class="k">工具定义</span><span class="v" id="cmp-def">—</span></div>
          <div class="kv"><span class="k">用户输入</span><span class="v" id="cmp-user">—</span></div>
          <div class="kv"><span class="k">模型回复</span><span class="v" id="cmp-asst">—</span></div>
          <div class="kv"><span class="k">思考过程</span><span class="v" id="cmp-think">—</span></div>
          <div class="kv"><span class="k">工具调用</span><span class="v" id="cmp-tools">—</span></div>
        </div>
      </div>

      <div class="card" id="recent-card" hidden>
        <div class="card-title"><span>最近请求</span></div>
        <table class="calls">
          <thead>
            <tr><th>#</th><th>输入</th><th>缓存%</th><th>输出</th><th>TTFT</th><th>速度</th></tr>
          </thead>
          <tbody id="recent-tbody"></tbody>
        </table>
      </div>
    </div>

    <div id="view-daily" class="view" hidden>
      <div class="card">
        <div class="card-title">
          <span>今日总消耗</span>
          <span id="dy-today-calls">—</span>
        </div>
        <div class="ctx-top">
          <span class="ctx-main" id="dy-today-total">—</span>
          <span class="ctx-pct" id="dy-today-hit">—</span>
        </div>
        <div class="strip-3">
          <div class="mini-stat"><span class="k">今日输入</span><span class="v" id="dy-today-in">—</span></div>
          <div class="mini-stat"><span class="k">今日缓存</span><span class="v" id="dy-today-cache">—</span></div>
          <div class="mini-stat"><span class="k">今日输出</span><span class="v" id="dy-today-out">—</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>近 14 天趋势</span>
          <span id="dy-selected-detail">点击柱条查看单日</span>
        </div>
        <div class="bar-chart" id="dy-chart"></div>
      </div>

      <div class="card">
        <div class="card-title"><span>周期汇总</span></div>
        <div class="strip-3">
          <div class="mini-stat"><span class="k">近 7 天</span><span class="v" id="dy-7d">—</span></div>
          <div class="mini-stat"><span class="k">近 30 天</span><span class="v" id="dy-30d">—</span></div>
          <div class="mini-stat"><span class="k">累计总计</span><span class="v" id="dy-all">—</span></div>
        </div>
      </div>

      <div class="card" id="dy-models-card">
        <div class="card-title">
          <span>按模型消耗</span>
          <div class="scope-pills" id="dy-model-scopes">
            <button class="scope-btn active" id="dy-scope-today" type="button">今日</button>
            <button class="scope-btn" id="dy-scope-last7d" type="button">7天</button>
            <button class="scope-btn" id="dy-scope-last30d" type="button">30天</button>
            <button class="scope-btn" id="dy-scope-all" type="button">全部</button>
          </div>
        </div>
        <div class="seg-bar" id="dy-model-bar"></div>
        <div class="model-list" id="dy-models-list"></div>
      </div>

      <div class="card">
        <div class="card-title"><span>每日明细</span></div>
        <table class="calls">
          <thead>
            <tr><th>日期</th><th>总计</th><th>输入</th><th>输出</th><th>缓存%</th></tr>
          </thead>
          <tbody id="dy-tbody"></tbody>
        </table>
      </div>
    </div>

    <div class="ftr">
      <span id="conn-meta">— · <span id="ver">v1.0.0</span></span>
      <div class="opts">
        <label class="opt"><input type="checkbox" id="opt-speed" checked />速度</label>
        <label class="opt"><input type="checkbox" id="opt-cache" checked />缓存</label>
      </div>
    </div>
  </div>
</div>`;

  const el = (id) => shadow.getElementById(id);

  const state = {
    route: null,
    open: false,
    mountMode: 'floating',
    activeTab: 'session',
    modelScope: 'today',
    loading: false,
    dailyLoading: false,
    error: null,
    scan: null,
    turnState: null,
    dailyUsage: null,
    selectedDay: null,
    settings: {
      showSpeedInPill: true,
      showCacheInPill: true,
      compactPill: false,
      customBudget: null
    },
    transport: null,
    disposed: false
  };

  if (window.__AGContextMeterSettings?.settings) {
    Object.assign(state.settings, window.__AGContextMeterSettings.settings);
  }

  function detectTheme() {
    try {
      const bg = window.getComputedStyle(document.body).backgroundColor || '';
      const m = bg.match(/\d+/g);
      if (m && m.length >= 3) {
        const lum = (0.299 * Number(m[0]) + 0.587 * Number(m[1]) + 0.114 * Number(m[2]));
        host.setAttribute('data-theme', lum > 140 ? 'light' : 'dark');
        return;
      }
    } catch {}
    host.setAttribute('data-theme', 'dark');
  }

  function extractRouteUuid() {
    const raw = `${location.pathname || ''} ${location.hash || ''} ${location.search || ''}`;
    const m = raw.match(/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/i);
    if (m) return m[0];
    try {
      const activeLink = document.querySelector('[aria-current="page"][href], a[data-active="true"][href]');
      const href = activeLink?.getAttribute('href') || '';
      const lm = href.match(/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/i);
      if (lm) return lm[0];
    } catch {}
    return null;
  }

  async function callBackend(action, payload = {}) {
    const preferLive = Boolean(window.__AGContextMeterHotReloadContext?.preferLiveHost && window.__AGContextMeterLive?.port);
    const hasIpc = Boolean(window.contextMeterAPI && typeof window.contextMeterAPI.scan === 'function');
    const live = window.__AGContextMeterLive;

    const invokeIpc = () => {
      state.transport = 'IPC';
      if (action === 'scan') return window.contextMeterAPI.scan(payload.id, payload.force === true);
      if (action === 'turn-state') return window.contextMeterAPI.getTurnState(payload.id);
      if (action === 'daily-usage') return window.contextMeterAPI.getDailyUsage(payload.force === true);
      if (action === 'get-settings') return window.contextMeterAPI.getSettings();
      if (action === 'save-settings') return window.contextMeterAPI.saveSettings(payload);
    };

    if (!preferLive && hasIpc) return invokeIpc();

    if (live && live.port && live.token) {
      state.transport = 'Live';
      const routeMap = {
        'scan': '/scan',
        'turn-state': '/turn-state',
        'daily-usage': '/daily-usage',
        'get-settings': '/get-settings',
        'save-settings': '/save-settings'
      };
      const res = await fetch(`http://127.0.0.1:${live.port}${routeMap[action]}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AG-Context-Token': live.token
        },
        body: JSON.stringify({ origin: location.origin, ...payload })
      });
      if (!res.ok) throw new Error(`Live HTTP ${res.status}`);
      return res.json();
    }

    if (hasIpc) return invokeIpc();
    throw new Error('后端通道未就绪');
  }

  function findComposerModelTrigger() {
    try {
      const triggers = Array.from(document.querySelectorAll('[data-testid="model-selector-trigger"]') || []);
      const valid = triggers.filter(node => {
        if (!node || !node.parentElement) return false;
        if (node.closest?.('#ag-context-meter, [role="dialog"]')) return false;
        const rect = node.getBoundingClientRect?.();
        if (rect && rect.width === 0 && rect.height === 0 && typeof document.contains === 'function') {
          return false;
        }
        return true;
      });
      if (!valid.length) return null;
      const inComposer = valid.filter(n => Boolean(n.closest?.('.surface-composer, [data-testid="composer"], form')));
      const pool = inComposer.length ? inComposer : valid;
      let best = pool[pool.length - 1];
      let bestBottom = -Infinity;
      for (const node of pool) {
        const rect = node.getBoundingClientRect?.();
        const b = Number.isFinite(rect?.bottom) ? rect.bottom : 0;
        if (b >= bestBottom) {
          bestBottom = b;
          best = node;
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  function findComposerHorizontalSlot(modelTrigger) {
    let child = modelTrigger;
    let parent = modelTrigger?.parentElement || null;
    let spaceBetweenCandidate = null;
    for (let depth = 0; depth < 5 && parent; depth++) {
      if (parent === document.body || parent === document.documentElement) break;
      if (parent.matches?.('.surface-composer, [data-testid="composer"], form')) break;
      let cs = null;
      try { cs = window.getComputedStyle(parent); } catch {}
      const display = String(cs?.display || '');
      const dir = String(cs?.flexDirection || 'row');
      const isHorizontalFlex = (display === 'flex' || display === 'inline-flex') && dir !== 'column' && dir !== 'column-reverse';
      if (isHorizontalFlex) {
        if (cs?.justifyContent === 'space-between') {
          if (!spaceBetweenCandidate) spaceBetweenCandidate = { parent, anchor: child, isSpaceBetween: true };
        } else {
          return { parent, anchor: child, isSpaceBetween: false };
        }
      }
      child = parent;
      parent = parent.parentElement;
    }
    return spaceBetweenCandidate || { parent: modelTrigger.parentElement, anchor: modelTrigger, isSpaceBetween: false };
  }

  function findHostTitlebar() {
    try {
      const candidates = Array.from(document.querySelectorAll('[class*="@container/titlebar"]'));
      if (candidates.length > 1) {
        let best = null, bestTop = Infinity, bestRight = -Infinity;
        for (const node of candidates) {
          const rect = node?.getBoundingClientRect?.();
          if (!rect || (rect.width <= 0 && rect.height <= 0)) continue;
          if (!best || rect.top < bestTop - 4 || (Math.abs(rect.top - bestTop) <= 4 && rect.right > bestRight)) {
            best = node; bestTop = rect.top; bestRight = rect.right;
          }
        }
        if (best) return best;
      }
      if (candidates.length === 1) return candidates[0];

      const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const ideBtn = btns.find(b => {
        const text = (b?.textContent || '').trim();
        return text === 'Open IDE' || text === '打开 IDE';
      });
      if (ideBtn) return ideBtn.closest('header, nav, [class*="titlebar"], [class*="toolbar"], div.flex.items-center');
    } catch {}
    return null;
  }

  function mountHost() {
    if (state.disposed) return;
    detectTheme();
    const wrap = el('wrap');

    const modelTrigger = findComposerModelTrigger();
    if (modelTrigger && modelTrigger.parentElement) {
      const slot = findComposerHorizontalSlot(modelTrigger);
      const parent = slot.parent;
      const anchor = slot.anchor;
      state.mountMode = 'composer';
      wrap?.classList.remove('floating');
      wrap?.classList.add('in-composer');
      host.style.display = 'inline-flex';
      host.style.alignItems = 'center';
      host.style.marginLeft = '6px';
      host.style.marginRight = slot.isSpaceBetween ? 'auto' : '';
      host.style.flexShrink = '0';
      const nextEl = anchor.nextElementSibling ?? anchor.nextSibling ?? null;
      if (host.parentElement !== parent || nextEl !== host) {
        try {
          if (nextEl && nextEl.parentElement === parent) parent.insertBefore(host, nextEl);
          else parent.appendChild(host);
        } catch {
          try { parent.appendChild(host); } catch {}
        }
      }
      return;
    }

    wrap?.classList.remove('in-composer');
    host.style.display = '';
    host.style.alignItems = '';
    host.style.marginLeft = '';
    host.style.marginRight = '';
    host.style.flexShrink = '';

    const titlebar = findHostTitlebar();
    if (titlebar) {
      state.mountMode = 'titlebar';
      wrap?.classList.remove('floating');
      const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild || titlebar;
      const targetParent = (rightGroup && rightGroup !== titlebar.firstElementChild) ? rightGroup : titlebar;
      let anchor = null;
      try {
        const btns = Array.from(targetParent.querySelectorAll('button, a, [role="button"]'));
        const ideBtn = btns.find(b => {
          const text = (b?.textContent || '').trim();
          return text === 'Open IDE' || text === '打开 IDE';
        });
        if (ideBtn) {
          const prev = ideBtn.previousElementSibling;
          anchor = (prev && prev !== host && prev.tagName === 'BUTTON') ? prev : ideBtn;
        }
      } catch {}
      const refNode = (anchor && anchor.parentElement === targetParent) ? anchor : targetParent.firstElementChild;
      if (refNode !== host && (host.parentElement !== targetParent || host.nextElementSibling !== refNode)) {
        try {
          if (refNode && refNode.parentElement === targetParent) targetParent.insertBefore(host, refNode);
          else targetParent.appendChild(host);
        } catch {
          try { targetParent.appendChild(host); } catch {}
        }
      }
      return;
    }

    state.mountMode = 'floating';
    if (host.parentElement !== document.body) {
      document.body.appendChild(host);
    }
    wrap?.classList.add('floating');
  }

  function positionPanel() {
    const panel = el('panel');
    const pill = el('pill');
    if (!panel || !pill || panel.hidden) return;
    const rect = pill.getBoundingClientRect();
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const panelW = 356;

    const spaceBelow = vh - rect.bottom;
    const openUpward = state.mountMode === 'composer' || (spaceBelow < 320 && rect.top > spaceBelow);
    if (openUpward) {
      panel.style.top = 'auto';
      panel.style.bottom = `${Math.max(8, Math.round(vh - rect.top + 8))}px`;
      panel.style.maxHeight = `${Math.max(200, Math.min(560, Math.round(rect.top - 16)))}px`;
    } else {
      panel.style.bottom = 'auto';
      panel.style.top = `${Math.max(8, Math.round(rect.bottom + 6))}px`;
      panel.style.maxHeight = `${Math.max(200, Math.min(560, Math.round(vh - rect.bottom - 16)))}px`;
    }

    if (state.mountMode === 'composer') {
      const left = Math.max(8, Math.min(Math.round(rect.left), Math.max(8, vw - panelW - 8)));
      panel.style.left = `${left}px`;
      panel.style.right = 'auto';
    } else {
      panel.style.left = 'auto';
      panel.style.right = `${Math.max(8, Math.round(vw - rect.right))}px`;
    }
  }

  function midTok(g) {
    if (!g) return '—';
    const mid = Math.round(((Number(g.low) || 0) + (Number(g.high) || 0)) / 2);
    return mid > 0 ? core.formatTokens(mid) : '0';
  }

  function syncTabView() {
    const isDaily = state.activeTab === 'daily';
    el('tab-session')?.classList.toggle('active', !isDaily);
    el('tab-daily')?.classList.toggle('active', isDaily);
    if (el('view-session')) el('view-session').hidden = isDaily;
    if (el('view-daily')) el('view-daily').hidden = !isDaily;
  }

  function renderModelList(containerEl, barEl, models, compact = false) {
    const list = Array.isArray(models) ? models : [];
    if (barEl) {
      barEl.innerHTML = '';
      barEl.hidden = list.length === 0;
      list.forEach((m, idx) => {
        const seg = document.createElement('div');
        seg.className = 'seg';
        seg.style.width = `${m.sharePct || 0}%`;
        seg.style.background = MODEL_COLORS[idx % MODEL_COLORS.length];
        seg.title = `${m.model}: ${core.formatTokens(m.totalTokens)} (${m.sharePct}%)`;
        barEl.appendChild(seg);
      });
    }
    if (!containerEl) return;
    containerEl.innerHTML = '';
    if (compact) containerEl.hidden = list.length === 0;
    if (list.length === 0) {
      if (!compact) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'model-empty';
        emptyEl.textContent = '该时段暂无模型调用记录';
        containerEl.appendChild(emptyEl);
      }
      return;
    }
    list.forEach((m, idx) => {
      const color = MODEL_COLORS[idx % MODEL_COLORS.length];
      const row = document.createElement('div');
      row.className = 'model-row';

      const top = document.createElement('div');
      top.className = 'model-row-top';

      const nameWrap = document.createElement('span');
      nameWrap.className = 'model-name-lbl';
      const dot = document.createElement('i');
      dot.className = 'model-dot';
      dot.style.background = color;
      const nameTxt = document.createElement('span');
      nameTxt.textContent = m.model;
      nameWrap.appendChild(dot);
      nameWrap.appendChild(nameTxt);

      const val = document.createElement('span');
      val.className = 'model-val';
      val.textContent = compact
        ? `${core.formatTokens(m.totalTokens)} · ${m.callCount}次 (${m.sharePct}%)`
        : `${core.formatTokens(m.totalTokens)} (${m.sharePct}%)`;

      top.appendChild(nameWrap);
      top.appendChild(val);
      row.appendChild(top);

      if (!compact) {
        const sub = document.createElement('div');
        sub.className = 'model-row-sub';
        const hitStr = m.cacheReadPct != null ? `${m.cacheReadPct.toFixed(0)}%` : '—';
        sub.textContent = `${m.callCount} 次 · 输入 ${core.formatTokens(m.totalInput)} / 输出 ${core.formatTokens(m.totalOutput)} · 缓存 ${hitStr}`;
        row.appendChild(sub);
      }
      containerEl.appendChild(row);
    });
  }

  function renderDaily() {
    const dy = state.dailyUsage;
    if (!dy) {
      el('dy-today-total').textContent = state.dailyLoading ? '统计中…' : '—';
      el('dy-today-hit').textContent = '—';
      el('dy-today-calls').textContent = '';
      el('dy-today-in').textContent = '—';
      el('dy-today-cache').textContent = '—';
      el('dy-today-out').textContent = '—';
      el('dy-7d').textContent = '—';
      el('dy-30d').textContent = '—';
      el('dy-all').textContent = '—';
      return;
    }

    const today = dy.today || {};
    el('dy-today-total').textContent = core.formatTokens(today.totalTokens || 0);
    el('dy-today-hit').textContent = today.cacheReadPct != null ? `缓存 ${today.cacheReadPct.toFixed(1)}%` : '缓存 —';
    el('dy-today-calls').textContent = today.callCount ? `${today.callCount} 次请求` : '0 次';
    el('dy-today-in').textContent = core.formatTokens(today.totalInput || 0);
    el('dy-today-cache').textContent = core.formatTokens(today.cacheRead || 0);
    el('dy-today-out').textContent = core.formatTokens(today.totalOutput || 0);

    el('dy-7d').textContent = core.formatTokens(dy.last7DaysTotals?.totalTokens || 0);
    el('dy-30d').textContent = core.formatTokens(dy.last30DaysTotals?.totalTokens || 0);
    el('dy-all').textContent = core.formatTokens(dy.allTimeTotals?.totalTokens || 0);

    for (const sc of ['today', 'last7d', 'last30d', 'all']) {
      el(`dy-scope-${sc}`)?.classList.toggle('active', state.modelScope === sc);
    }
    const scopedModels = dy.modelsByScope?.[state.modelScope] || [];
    renderModelList(el('dy-models-list'), el('dy-model-bar'), scopedModels, false);

    const series = Array.isArray(dy.last14Days) ? dy.last14Days : [];
    const chartEl = el('dy-chart');
    if (chartEl) {
      chartEl.innerHTML = '';
      const maxVal = series.reduce((m, d) => Math.max(m, Number(d.totalTokens || 0)), 0);
      const selectedKey = state.selectedDay || dy.todayKey;
      const selectedObj = series.find(d => d.date === selectedKey) || dy.today;
      if (selectedObj && el('dy-selected-detail')) {
        el('dy-selected-detail').textContent = `${selectedObj.date?.slice(5) || ''} · ${core.formatTokens(selectedObj.totalTokens || 0)} (${selectedObj.callCount || 0}次)`;
      }

      series.forEach((d, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bar-col' + (d.date === selectedKey ? ' selected' : '');
        btn.title = `${d.date}: ${core.formatTokens(d.totalTokens || 0)}`;
        const pct = maxVal > 0 && d.totalTokens > 0 ? Math.max(8, Math.round((d.totalTokens / maxVal) * 100)) : 0;

        const track = document.createElement('div');
        track.className = 'bar-track';
        const fill = document.createElement('div');
        fill.className = 'bar-fill';
        fill.style.height = `${pct}%`;
        track.appendChild(fill);

        const lbl = document.createElement('span');
        lbl.className = 'bar-lbl';
        lbl.textContent = (idx % 3 === 0 || idx === series.length - 1) ? String(d.date || '').slice(8) : '\u00A0';

        btn.appendChild(track);
        btn.appendChild(lbl);
        btn.addEventListener('click', () => {
          state.selectedDay = d.date;
          renderDaily();
        });
        chartEl.appendChild(btn);
      });
    }

    const tbody = el('dy-tbody');
    if (tbody) {
      tbody.innerHTML = '';
      const rows = (Array.isArray(dy.days) ? dy.days : []).slice(0, 10);
      if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = '暂无已记录的每日用量';
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        rows.forEach(d => {
          const tr = document.createElement('tr');
          const cells = [
            String(d.date || '').slice(5),
            core.formatTokens(d.totalTokens || 0),
            core.formatTokens(d.totalInput || 0),
            core.formatTokens(d.totalOutput || 0),
            d.cacheReadPct != null ? `${d.cacheReadPct.toFixed(0)}%` : '—'
          ];
          cells.forEach(txt => {
            const td = document.createElement('td');
            td.textContent = txt;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
      }
    }
  }

  function render() {
    const data = state.scan;
    const turn = state.turnState;
    const latest = turn?.latest || data?.latest || null;
    const timing = turn?.turnTiming || data?.turnTiming || null;
    const sessionSpeed = data?.sessionSpeed || turn?.sessionSpeed || null;
    const sessionCache = data?.sessionCache || turn?.sessionCache || null;
    const sessionTotals = data?.sessionTotals || null;
    const isRunning = Boolean(timing?.isRunning || (turn?.cascadeStatus || data?.cascadeStatus) === 'CASCADE_RUN_STATUS_RUNNING');

    const budget = state.settings.customBudget || latest?.budget || null;
    const used = latest?.used ?? null;
    const pctRaw = (used !== null && budget > 0) ? (used / budget) * 100 : (latest?.percent ?? null);
    const pctClamped = pctRaw !== null && Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, pctRaw)) : 0;

    // Pill
    const pill = el('pill');
    const ringFg = el('ring-fg');
    const pillPct = el('pill-pct');
    if (ringFg) {
      ringFg.style.strokeDashoffset = String((RING_CIRCUMFERENCE * (1 - pctClamped / 100)).toFixed(2));
    }
    if (pill) {
      pill.classList.toggle('warn', pctRaw !== null && pctRaw >= 65 && pctRaw < 85);
      pill.classList.toggle('crit', pctRaw !== null && pctRaw >= 85 || Boolean(latest?.exceeded));
    }
    if (pillPct) {
      if (!state.route) pillPct.textContent = '空闲';
      else if (pctRaw !== null && Number.isFinite(pctRaw)) pillPct.textContent = `${pctRaw.toFixed(pctRaw >= 10 ? 0 : 1)}%`;
      else if (used !== null) pillPct.textContent = core.formatTokens(used);
      else pillPct.textContent = state.loading ? '…' : '—';
    }

    const speed = latest?.speed || null;
    const liveTtft = timing?.inFlightTtftSec;
    const pillSpeed = el('pill-speed');
    const pillSepSpeed = el('pill-sep-speed');
    let speedChip = '';
    if (state.settings.showSpeedInPill && state.route) {
      if (isRunning && liveTtft !== null && liveTtft !== undefined && (!speed || speed.phase === 'idle')) {
        speedChip = `TTFT ${core.formatDurationSec(liveTtft)}`;
      } else if (speed?.displayTps) {
        speedChip = `${speed.displayTps} tok/s`;
      } else if (isRunning) {
        speedChip = '生成中…';
      }
    }
    if (pillSpeed && pillSepSpeed) {
      pillSpeed.textContent = speedChip;
      pillSpeed.hidden = !speedChip;
      pillSepSpeed.hidden = !speedChip;
      pillSpeed.classList.toggle('live', isRunning);
    }

    const cachePct = latest?.cacheHitRate ?? sessionCache?.cacheReadPct ?? null;
    const pillCache = el('pill-cache');
    const pillSepCache = el('pill-sep-cache');
    const cacheChip = (state.settings.showCacheInPill && state.route && cachePct !== null && Number.isFinite(cachePct))
      ? `缓存 ${cachePct.toFixed(0)}%`
      : '';
    if (pillCache && pillSepCache) {
      pillCache.textContent = cacheChip;
      pillCache.hidden = !cacheChip;
      pillSepCache.hidden = !cacheChip;
    }

    if (el('panel')?.hidden) return;
    positionPanel();
    syncTabView();

    const dot = el('status-dot');
    if (dot) {
      dot.className = 'dot' + (state.error || latest?.error ? ' err' : (isRunning ? ' run' : (latest ? ' ok' : '')));
    }
    el('model-name').textContent = latest?.model || (state.route ? '等待模型响应' : '当前无活跃对话');
    el('conn-meta').textContent = `${state.transport || '—'} · v${METER_DISPLAY_VERSION}`;
    el('opt-speed').checked = state.settings.showSpeedInPill !== false;
    el('opt-cache').checked = state.settings.showCacheInPill !== false;

    if (state.activeTab === 'daily') {
      renderDaily();
      return;
    }

    const notice = el('notice');
    if (notice) {
      if (state.error) {
        notice.textContent = state.error;
        notice.className = 'notice err';
        notice.hidden = false;
      } else if (latest?.error) {
        notice.textContent = latest.exceeded
          ? `上下文已超限${latest.serviceLimit ? `（服务端上限 ${core.formatTokens(latest.serviceLimit)}）` : ''}：${latest.error}`
          : latest.error;
        notice.className = 'notice err';
        notice.hidden = false;
      } else if (latest?.compacted) {
        notice.textContent = `已完成压缩（第 ${latest.checkpointCount || 1} 次），当前为压缩后估算上下文`;
        notice.className = 'notice';
        notice.hidden = false;
      } else {
        notice.hidden = true;
      }
    }

    el('ctx-headline').textContent = `${used !== null ? core.formatTokens(used) : '—'} / ${budget ? core.formatTokens(budget) : '—'}`;
    el('ctx-pct').textContent = pctRaw !== null && Number.isFinite(pctRaw) ? `${pctRaw.toFixed(1)}%` : '—';
    const rem = (used !== null && budget > 0) ? Math.max(0, budget - used) : latest?.remaining;
    el('ctx-remaining').textContent = `剩余 ${rem != null ? core.formatTokens(rem) : '—'}`;
    const statusLabelMap = {
      reported: '服务端实报',
      estimated: '客户端估算',
      compacted: '压缩后估算',
      exceeded: '上下文超限',
      pending: '等待中'
    };
    el('ctx-status').textContent = statusLabelMap[latest?.status] || (state.loading ? '采集中…' : '未采集');

    const seg = core.computeContextSegments(latest || {}, budget || 0);
    el('seg-cache').style.width = `${seg.cacheReadPct}%`;
    el('seg-uncached').style.width = `${seg.uncachedInputPct}%`;
    el('seg-write').style.width = `${seg.cacheWritePct}%`;
    el('leg-cache').textContent = `缓存读 ${core.formatTokens(seg.cacheReadTokens)}`;
    el('leg-uncached').textContent = `新输入 ${core.formatTokens(seg.uncachedInputTokens)}`;
    el('leg-write').textContent = `写缓存 ${core.formatTokens(seg.cacheWriteTokens)}`;
    el('leg-output').textContent = `输出 ${core.formatTokens(seg.outputTokens)}`;
    el('seg-output').style.width = `${seg.outputPct}%`;

    // Session cumulative totals
    el('st-calls').textContent = sessionTotals?.callCount ? `${sessionTotals.callCount} 次请求` : '—';
    el('st-total').textContent = sessionTotals?.callCount ? core.formatTokens(sessionTotals.totalTokens) : '—';
    el('st-in').textContent = sessionTotals?.callCount ? core.formatTokens(sessionTotals.totalInput) : '—';
    el('st-cache').textContent = sessionTotals?.callCount ? core.formatTokens(sessionTotals.cacheRead) : '—';
    el('st-out').textContent = sessionTotals?.callCount ? core.formatTokens(sessionTotals.totalOutput) : '—';
    renderModelList(el('st-models'), null, data?.sessionModels || [], true);

    // Speed card
    const phaseLabel = isRunning
      ? (speed?.phase === 'warming' ? '预热中' : (liveTtft != null ? '等待首字' : '生成中'))
      : (speed?.phase === 'settled' ? '已就绪' : '');
    el('speed-phase').textContent = phaseLabel;
    el('sp-stream').textContent = speed?.displayTps != null
      ? `${speed.displayTps} tok/s`
      : (speed?.tps != null ? `${speed.tps} tok/s` : '—');
    const ttftVal = (isRunning && liveTtft != null && (!speed || speed.ttft == null)) ? liveTtft : speed?.ttft;
    el('sp-ttft').textContent = core.formatDurationSec(ttftVal);
    el('sp-dur').textContent = core.formatDurationSec(speed?.streamingSec ?? speed?.duration ?? timing?.wallDurationSec);
    el('sp-out').textContent = speed?.outputTokens != null
      ? `${core.formatTokens(speed.outputTokens)}${speed.thinkingTokens > 0 ? ` (思 ${core.formatTokens(speed.thinkingTokens)})` : ''}`
      : '—';
    el('sp-avg').textContent = sessionSpeed?.avgTps != null
      ? `${sessionSpeed.avgTps} tok/s (${sessionSpeed.count})`
      : '—';

    // Cache card
    el('cache-reqs').textContent = sessionCache?.evaluatedRequestCount
      ? `${sessionCache.cacheHitRequestCount}/${sessionCache.evaluatedRequestCount} 命中`
      : '';
    el('ca-last').textContent = latest?.cacheHitRate != null ? `${latest.cacheHitRate.toFixed(1)}%` : '—';
    el('ca-session').textContent = sessionCache?.cacheReadPct != null ? `${sessionCache.cacheReadPct.toFixed(1)}%` : '—';
    el('ca-read').textContent = latest?.cached != null ? core.formatTokens(latest.cached) : '—';
    el('ca-uncached').textContent = latest?.uncachedInput != null ? core.formatTokens(latest.uncachedInput) : '—';
    el('ca-total-in').textContent = sessionCache?.totalInput ? core.formatTokens(sessionCache.totalInput) : (latest?.input != null ? core.formatTokens(latest.input) : '—');

    // Composition
    const groups = data?.session?.groups || null;
    el('comp-steps').textContent = data?.session?.steps ? `${data.session.steps} 步` : '';
    el('cmp-sys').textContent = midTok(groups?.system);
    el('cmp-def').textContent = midTok(groups?.definitions);
    el('cmp-user').textContent = midTok(groups?.user);
    el('cmp-asst').textContent = midTok(groups?.assistant);
    el('cmp-think').textContent = midTok(groups?.thinking);
    el('cmp-tools').textContent = midTok(groups?.tools);

    // Recent calls
    const recent = Array.isArray(data?.recentCalls) ? data.recentCalls.slice(0, 5) : [];
    const recentCard = el('recent-card');
    const tbody = el('recent-tbody');
    if (recentCard && tbody) {
      recentCard.hidden = recent.length === 0;
      tbody.innerHTML = '';
      recent.forEach((c, idx) => {
        const tr = document.createElement('tr');
        const cells = [
          `#${idx + 1}`,
          c.totalInput != null ? core.formatTokens(c.totalInput) : '—',
          c.cacheReadPct != null ? `${c.cacheReadPct.toFixed(0)}%` : '—',
          c.outputTokens ? core.formatTokens(c.outputTokens) : '—',
          core.formatDurationSec(c.ttftSec),
          (c.streamingTps ?? c.tps) != null ? `${c.streamingTps ?? c.tps}` : '—'
        ];
        cells.forEach(txt => {
          const td = document.createElement('td');
          td.textContent = txt;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }
  }

  let scanInFlight = false;
  let lastScanAt = 0;

  async function refreshDaily(force = false) {
    if (state.disposed || state.dailyLoading) return;
    state.dailyLoading = true;
    render();
    try {
      const res = await callBackend('daily-usage', { force });
      if (res && res.ok !== false) {
        state.dailyUsage = res;
      }
    } catch {} finally {
      state.dailyLoading = false;
      render();
    }
  }

  async function refresh(force = false) {
    if (state.disposed) return;
    const route = extractRouteUuid();
    if (route !== state.route) {
      state.route = route;
      state.scan = null;
      state.turnState = null;
      state.error = null;
    }
    if (!route) {
      render();
      return;
    }
    if (scanInFlight && !force) return;
    scanInFlight = true;
    state.loading = true;
    render();
    try {
      const res = await callBackend('scan', { id: route, force });
      if (!res?.abortedStale && state.route === route) {
        state.scan = res;
        state.error = null;
        lastScanAt = Date.now();
      }
    } catch (err) {
      state.error = err?.message || '采集失败';
    } finally {
      scanInFlight = false;
      state.loading = false;
      render();
    }
  }

  async function pollTick() {
    if (state.disposed || document.hidden) return;
    mountHost();
    const route = extractRouteUuid();
    if (route !== state.route) {
      await refresh(true);
      return;
    }
    if (!route) return;

    const wasRunning = Boolean(state.turnState?.turnTiming?.isRunning || state.scan?.turnTiming?.isRunning);
    try {
      const ts = await callBackend('turn-state', { id: route });
      if (state.route === route) {
        state.turnState = ts;
        state.error = null;
      }
      const nowRunning = Boolean(ts?.turnTiming?.isRunning || ts?.cascadeStatus === 'CASCADE_RUN_STATUS_RUNNING');
      if ((wasRunning && !nowRunning) || (!state.scan && !scanInFlight) || (Date.now() - lastScanAt > 8000 && !nowRunning)) {
        await refresh(wasRunning && !nowRunning);
      } else {
        render();
      }
    } catch {
      if (!state.scan && !scanInFlight) await refresh(false);
    }
  }

  el('pill')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.open = !state.open;
    el('panel').hidden = !state.open;
    if (state.open) {
      render();
      if (state.activeTab === 'daily') void refreshDaily(false);
      else if (!state.scan) void refresh(false);
    }
  });

  el('tab-session')?.addEventListener('click', () => {
    state.activeTab = 'session';
    render();
    if (!state.scan) void refresh(false);
  });

  el('tab-daily')?.addEventListener('click', () => {
    state.activeTab = 'daily';
    render();
    void refreshDaily(false);
  });

  for (const sc of ['today', 'last7d', 'last30d', 'all']) {
    el(`dy-scope-${sc}`)?.addEventListener('click', () => {
      state.modelScope = sc;
      renderDaily();
    });
  }

  el('btn-close')?.addEventListener('click', () => {
    state.open = false;
    el('panel').hidden = true;
  });

  el('btn-refresh')?.addEventListener('click', () => {
    if (state.activeTab === 'daily') void refreshDaily(true);
    else void refresh(true);
  });

  const handleSettingChange = async () => {
    const patch = {
      showSpeedInPill: Boolean(el('opt-speed')?.checked),
      showCacheInPill: Boolean(el('opt-cache')?.checked)
    };
    Object.assign(state.settings, patch);
    render();
    try { await callBackend('save-settings', patch); } catch {}
  };
  el('opt-speed')?.addEventListener('change', handleSettingChange);
  el('opt-cache')?.addEventListener('change', handleSettingChange);

  const onDocClick = (e) => {
    if (!state.open) return;
    const pathNodes = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (!pathNodes.includes(host)) {
      state.open = false;
      el('panel').hidden = true;
    }
  };
  document.addEventListener('click', onDocClick);

  const onRouteChange = () => { void refresh(false); };
  window.addEventListener('popstate', onRouteChange);
  window.addEventListener('hashchange', onRouteChange);

  const onResize = () => {
    mountHost();
    positionPanel();
  };
  window.addEventListener('resize', onResize);

  let mountRetryTimer = null;
  const mo = new MutationObserver(() => {
    if (state.disposed) return;
    if (!host.isConnected) {
      mountHost();
    } else if (state.mountMode !== 'composer' && !mountRetryTimer) {
      mountRetryTimer = setTimeout(() => {
        mountRetryTimer = null;
        if (!state.disposed) mountHost();
      }, 100);
    }
  });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });

  const timer = setInterval(pollTick, 1200);

  mountHost();
  void callBackend('get-settings').then(res => {
    if (res?.ok && res.settings) {
      Object.assign(state.settings, res.settings);
      render();
    }
  }).catch(() => {});
  void refresh(false);

  globalThis.__AGContextMeter = {
    version: METER_VERSION,
    displayVersion: METER_DISPLAY_VERSION,
    buildId: BUILD_ID,
    refresh,
    refreshDaily,
    getState: () => ({ ...state }),
    dispose() {
      state.disposed = true;
      clearInterval(timer);
      if (mountRetryTimer) clearTimeout(mountRetryTimer);
      mo.disconnect();
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('popstate', onRouteChange);
      window.removeEventListener('hashchange', onRouteChange);
      window.removeEventListener('resize', onResize);
      host.remove();
    }
  };
})();
