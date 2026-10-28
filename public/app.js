// 路由、概览页、设置对话框。

import {
  state, $, escapeHtml, wattsText,
  api, loadConfig, saveConfig, toast,
  toggleTheme, toggleAppearance, openDialog, closeDialog, confirmDialog, extractMcp,
  startPolling, pollLan, pollMcp, persistHistory, restoreHistory,
  totalWatts, chargingCount,
  STRATEGIES,
} from './core.js';

import { renderDetail, updateDetail, destroyDetail, refreshDetail } from './detail.js';
import { powerDiagram } from './diagram.js';

// ---------------------------------------------------------------- 路由

function parseHash() {
  const hash = location.hash.replace(/^#/, '');
  const match = hash.match(/^\/d\/([\w-]+)$/);
  if (match && state.devices.has(match[1])) return { name: 'detail', psn: match[1] };
  return { name: 'overview', psn: null };
}

function navigate() {
  const next = parseHash();
  const changed = next.name !== state.route.name || next.psn !== state.route.psn;
  state.route = next;
  document.body.dataset.strategy = STRATEGIES.find(
    s => s.value === (next.psn ? state.devices.get(next.psn)?.strategy : null)
  )?.key || 'standard';
  if (changed) render();
}

export function render() {
  const app = $('#app');
  if (!app) return;
  if (state.route.name === 'detail') {
    const dev = state.devices.get(state.route.psn);
    if (!dev) { location.hash = '#/'; return; }
    app.classList.add('is-detail');
    renderDetail(app, dev);
  } else {
    app.classList.remove('is-detail');
    destroyDetail();
    renderOverview(app);
  }
  updateHeadline();
}

function updateHeadline() {
  const devices = [...state.devices.values()];
  const online = devices.filter(d => d.online);
  const total = online.reduce((sum, dev) => sum + totalWatts(dev), 0);
  $('#total-watts').textContent = online.length ? wattsText(total) : '—';
}

// ---------------------------------------------------------------- 概览

function renderOverview(app) {
  const devices = [...state.devices.values()];

  if (!devices.length) {
    app.innerHTML = `
      <div class="empty">
        <h3>还没有添加设备</h3>
        <p>小电拼和这台电脑在同一个局域网里，就能读数和控制。</p>
        <button class="btn primary" id="empty-add">添加设备</button>
      </div>`;
    $('#empty-add')?.addEventListener('click', () => openAddDevice());
    return;
  }

  app.innerHTML = devices.map(deviceCard).join('') +
    `<button class="add-card" id="overview-add">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>
      添加设备
    </button>`;

  $('#overview-add')?.addEventListener('click', () => openAddDevice());

  for (const card of app.querySelectorAll('.device-card')) {
    card.addEventListener('click', event => {
      if (event.target.closest('a,button')) return;
      location.hash = `#/d/${card.dataset.psn}`;
    });
  }
}

function deviceCard(dev) {
  const charging = chargingCount(dev);
  const strip = stripItems(dev);

  return `
    <article class="device-card ${dev.online ? '' : 'is-offline'}" data-psn="${escapeHtml(dev.psn)}">
      <div class="card-head">
        <h2>${escapeHtml(dev.name)}</h2>
        <span class="badge ${dev.online ? 'online' : 'offline'}">${dev.online ? '在线' : '离线'}</span>
        <span class="spacer"></span>
        <span class="count">${charging ? `${charging} 口在充` : (dev.online ? '未在充电' : (dev.error || '读不到'))}</span>
        <a class="card-link" href="#/d/${escapeHtml(dev.psn)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2"/><circle cx="10" cy="16" r="2"/></svg>
          调节
        </a>
      </div>

      ${powerDiagram(dev)}

      <div class="card-strip">${strip}</div>
    </article>`;
}

// 卡片底部那条：温控、亮度（都要 MCP 才读得到）
function stripItems(dev) {
  const items = [];

  if (!dev.online) {
    return `<span class="item"><span class="dot" style="background:var(--light-gray)"></span>读不到设备，检查是否同一个局域网</span>`;
  }

  if (!dev.mcp) {
    items.push(`<span class="item"><span class="dot" style="background:var(--light-gray)"></span>没有配置 MCP，只能看读数</span>`);
  } else if (dev.mcpError) {
    items.push(`<span class="item" style="color:var(--danger)"><span class="dot"></span>${escapeHtml(dev.mcpError)}</span>`);
  } else {
    const mode = dev.temperatureMode;
    if (mode !== null && mode !== undefined) {
      items.push(`<span class="item">${mode === 1 ? '安心温控' : '性能温控'}</span>`);
    }
    const level = dev.display?.level;
    if (level) {
      items.push(`<span class="item">亮度 ${escapeHtml(level)}</span>`);
    }
    if (!items.length) {
      items.push(`<span class="item"><span class="dot" style="background:var(--online)"></span>正在读取温控和亮度</span>`);
    }
  }

  items.push(`<span class="hint">点端口看详情</span>`);
  return items.join('');
}

// ---------------------------------------------------------------- 详情刷新

function onDataUpdate(kind) {
  if (state.route.name === 'detail') {
    updateDetail(state.devices.get(state.route.psn));
  } else if (kind === 'lan' || kind === 'info') {
    render();
  }
  updateHeadline();
}

// ---------------------------------------------------------------- 设置

function openSettings() {
  const devices = [...state.devices.values()];
  const bodyHtml = `
    <div class="device-list">
      ${devices.length ? devices.map(dev => `
        <div class="device-item">
          <div>
            <div class="name">${escapeHtml(dev.name)}</div>
            <div class="sub">${escapeHtml(dev.host)}${dev.mcp ? ' · 已配 MCP' : ' · 未配 MCP'}</div>
          </div>
          <div class="actions">
            <button class="btn ghost" data-edit="${escapeHtml(dev.psn)}">编辑</button>
            <button class="btn ghost" data-remove="${escapeHtml(dev.psn)}">移除</button>
          </div>
        </div>`).join('') : '<p class="dialog-sub" style="margin:0">还没有设备。</p>'}
    </div>
    <button class="btn primary" id="settings-add" style="width:100%">添加设备</button>
    <p class="field hint" style="margin-top:14px">
      配置文件在 config.json，MCP 地址（含 token）只存在本机，不会上传。
      这个页面只监听 127.0.0.1，别的机器访问不到。
    </p>`;

  openDialog({
    title: '设置',
    bodyHtml,
    actions: [{ label: '完成', class: 'primary' }],
  });

  $('#settings-add')?.addEventListener('click', () => openAddDevice());

  for (const btn of document.querySelectorAll('[data-edit]')) {
    btn.addEventListener('click', () => openDeviceEditor(state.devices.get(btn.dataset.edit)));
  }
  for (const btn of document.querySelectorAll('[data-remove]')) {
    btn.addEventListener('click', async () => {
      const dev = state.devices.get(btn.dataset.remove);
      const ok = await confirmDialog('移除设备', `「${dev.name}」会从列表里删掉，MCP 地址也一起删。`, '移除');
      if (!ok) return;
      const config = await api('/api/config');
      const next = (config.devices || []).filter(d => d.psn !== dev.psn);
      await saveConfig({ devices: next });
      await loadConfig();
      render();
      closeDialog();
      toast('已移除');
    });
  }
}

// 添加 / 编辑设备
function openAddDevice() {
  openDeviceEditor(null);
}

function openDeviceEditor(existing = null) {
  const isEdit = !!existing;
  const hasMcp = !!existing?.mcp;
  const bodyHtml = `
    <div class="field">
      <label>设备地址</label>
      <input id="dev-host" placeholder="192.168.0.144 或 cp02s-xxxx.local" value="${escapeHtml(existing?.host || '')}">
      <div class="hint">局域网里的 IP 或 mDNS 主机名都行。填好后点「检测」。</div>
    </div>
    <div class="field">
      <label>名称</label>
      <input id="dev-name" placeholder="桌子" value="${escapeHtml(existing?.name || '')}">
    </div>
    <div class="field">
      <label>MCP 地址（可选，控制端口和读温度要用）</label>
      <textarea id="dev-mcp" placeholder="${hasMcp ? '已配置。留空表示不修改，粘贴新地址则替换' : 'https://mcp.thecandysign.com/…/mcp'}"></textarea>
      <div class="hint">在小程序「龙虾服务」里复制，整段粘进来也行，会自动挑出地址。令牌只存在本机的 config.json 里，不会发到浏览器。</div>
    </div>
    <div class="scan-result" id="scan-result"></div>`;

  openDialog({
    title: isEdit ? '编辑设备' : '添加设备',
    subtitle: isEdit ? '' : '先填地址检测一下，认出是小电拼再保存。',
    bodyHtml,
    actions: [
      { label: '扫描局域网', onClick: () => runScan() },
      { label: '取消' },
      {
        label: isEdit ? '保存' : '添加',
        class: 'primary',
        onClick: async () => {
          const host = $('#dev-host').value.trim();
          const name = $('#dev-name').value.trim();
          const mcp = extractMcp($('#dev-mcp').value.trim());
          if (!host) { toast('先填设备地址', true); return true; }

          let info;
          try {
            info = await api(`/api/info?host=${encodeURIComponent(host)}`);
          } catch (error) {
            toast(`检测失败：${error.message}`, true);
            return true;
          }
          const psn = info.psn;
          if (!psn) { toast('这个地址上没有小电拼', true); return true; }

          const config = await api('/api/config');
          const devices = (config.devices || []).filter(d => d.psn !== (isEdit ? existing.psn : psn));
          devices.push({
            psn,
            name: name || `小电拼 ${psn.slice(-4)}`,
            host,
            mcp: mcp || existing?.mcp || '',
          });
          await saveConfig({ devices });
          await loadConfig();
          render();
          startPolling();
          pollMcp();
          toast(isEdit ? '已保存' : `已添加 ${info.device_model || ''} ${psn.slice(-4)}`.trim());
        },
      },
    ],
  });
}

async function runScan() {
  const box = $('#scan-result');
  if (!box) return;
  box.innerHTML = '<div class="scan-item">正在扫描本网段…</div>';
  try {
    const { devices } = await api('/api/scan');
    if (!devices.length) {
      box.innerHTML = '<div class="scan-item">没扫到。确认小电拼和电脑在同一个 Wi-Fi，或者手动填 IP。</div>';
      return;
    }
    box.innerHTML = devices.map(d => `
      <div class="scan-item">
        <span>${escapeHtml(d.host)}</span>
        <span style="color:var(--heading)">${escapeHtml(d.family || '')} · ${escapeHtml(String(d.psn || '').slice(-4))}</span>
        <button class="btn ghost" data-use="${escapeHtml(d.host)}">用这个</button>
      </div>`).join('');
    for (const btn of box.querySelectorAll('[data-use]')) {
      btn.addEventListener('click', () => {
        $('#dev-host').value = btn.dataset.use;
        toast('地址已填入，点「添加」保存');
      });
    }
  } catch (error) {
    box.innerHTML = `<div class="scan-item" style="color:var(--danger)">扫描失败：${escapeHtml(error.message)}</div>`;
  }
}

// ---------------------------------------------------------------- 启动

async function boot() {
  restoreHistory();

  $('#theme-btn')?.addEventListener('click', toggleTheme);
  $('#appearance-btn')?.addEventListener('click', toggleAppearance);
  $('#settings-btn')?.addEventListener('click', openSettings);

  window.addEventListener('hashchange', navigate);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeDialog();
  });

  state.onUpdate = onDataUpdate;

  try {
    await loadConfig();
  } catch (error) {
    $('#app').innerHTML = `<div class="empty"><h3>连不上本地服务</h3><p>${escapeHtml(error.message)}</p></div>`;
    return;
  }

  navigate();
  startPolling();

  // 曲线：先用设备内存里的补一次，之后每 30 秒存一次盘
  setTimeout(async () => {
    for (const dev of state.devices.values()) {
      if (dev.online && dev.mcp) await refreshDetailData(dev);
    }
  }, 4000);
  setInterval(persistHistory, 30000);
  window.addEventListener('beforeunload', persistHistory);

  // 标签页切回来时立刻刷新一次，别显示过期数据
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { pollLan(); }
  });
}

async function refreshDetailData(dev) {
  try { await refreshDetail(dev); } catch { /* 忽略 */ }
}

boot();
