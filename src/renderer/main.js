(function () {
  const METER_VERSION = '1.0.0';
  const METER_DISPLAY_VERSION = '1.0.0';
  const BUILD_ID = '__AG_RENDER_BUILD_ID__';
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

  /* @INSERT_STYLES_AND_TEMPLATE */

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
