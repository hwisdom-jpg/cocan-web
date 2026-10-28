// 详情页：当前状态、模式、端口开关、温控、状态屏、功率分配、充电曲线、在充设备。

import {
  state, $, escapeHtml, wattsText, energyText, durationText, clockText,
  mcpCall, toast, persistHistory, backfillPort, confirmDialog,
  pollLan, pollMcp, ensureInfo,
  portState, totalWatts, chargingCount, portName, protocolName,
  samplesSince, TEMPERATURES, STRATEGIES, TEMP_MODES,
  DISPLAY_LEVELS, STATUS_MODES, IDLE_DISPLAYS,
} from './core.js';

// 详情页自己的界面状态，不进 core
const view = {
  psn: null,
  chartPort: 'total',
  chartSeconds: 1800,
  lastMetrics: null,
};

export function destroyDetail() {
  view.psn = null;
  view.lastMetrics = null;
}

// ---------------------------------------------------------------- 渲染

export function renderDetail(container, dev) {
  const fresh = view.psn !== dev.psn;
  view.psn = dev.psn;
  // 只有换了设备才重置图表的选中项，增量重建（数据晚到）时保留用户的选择
  if (fresh) {
    view.chartPort = 'total';
    view.chartSeconds = 1800;
  }
  lastSignature = dataSignature(dev);

  const ports = dev.metrics?.ports || [];
  const info = dev.info || {};
  const subtitle = [
    info.product_family || '',
    dev.host,
    dev.updatedAt ? `更新于 ${clockText(dev.updatedAt)}` : '还没读到',
  ].filter(Boolean).join(' · ');

  const others = [...state.devices.values()].filter(d => d.psn !== dev.psn);

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">${escapeHtml(dev.name)}</h1>
        <p class="page-sub">${escapeHtml(subtitle)}</p>
      </div>
      <div class="page-actions">
        ${others.map(d => `<a class="btn ghost" href="#/d/${escapeHtml(d.psn)}">${escapeHtml(d.name)}</a>`).join('')}
        <a class="btn ghost" href="#/">返回</a>
      </div>
    </div>

    <div class="detail-grid">
      <div class="detail-main">
        ${strategyPanel(dev)}
        ${portsPanel(dev, ports)}
        ${thermalPanel(dev)}
        ${displayPanel(dev)}
        ${allocationPanel(dev)}
      </div>
      <div class="detail-side">
        ${factsPanel(dev, info)}
        ${chartPanel(dev, ports)}
        ${devicesOnPortsPanel(dev, ports)}
      </div>
    </div>`;

  bindEvents(dev, container);
  drawChart(dev);
  view.lastMetrics = dev.metrics;
  if (fresh) {
    refreshDetail(dev);   // 补一次曲线（设备内存里的最近 30 分钟）
    ensureInfo(dev);      // 首页信息：PSN、型号、固件
    pollMcp();            // 立刻拉一次温控、亮度、识别，别等那 15 秒
  }
}

function strategyPanel(dev) {
  const current = dev.strategy;
  return `
    <section class="panel">
      <h2 class="panel-title">模式
        <span class="aside">${dev.mcp ? '' : '需要 MCP'}</span>
      </h2>
      <div class="segments" id="strategy-segments">
        ${STRATEGIES.map(s => `
          <button class="segment" data-strategy="${s.value}" aria-pressed="${current === s.value}"
                  ${dev.mcp ? '' : 'disabled'} title="${escapeHtml(s.detail)}">${escapeHtml(s.title)}</button>
        `).join('')}
      </div>
      <p class="chart-note" id="strategy-note">${
        current === null || current === undefined
          ? '还没在这里切换过，当前策略以设备为准。'
          : escapeHtml(STRATEGIES.find(s => s.value === current)?.detail || '')
      }</p>
    </section>`;
}

function portsPanel(dev, ports) {
  return `
    <section class="panel">
      <h2 class="panel-title">端口
        <span class="aside">${chargingCount(dev)} 口在充 · 合计 ${wattsText(totalWatts(dev))} W</span>
      </h2>
      <div id="port-rows">
        ${ports.map((port, index) => portRow(dev, port, index)).join('')}
      </div>
    </section>`;
}

function portRow(dev, port, index) {
  const status = portState(port);
  const name = portName(dev, index);
  const detail = dev.details?.[port.id];
  const identity = dev.identities?.[port.id + 1]; // pd_status 的 port 从 1 开始
  const device = identityName(identity);

  let meta = [];
  if (status === 'closed') meta.push('已关闭');
  else if (status === 'empty') meta.push('空着');
  else {
    meta.push(protocolName(port.proto, port.protocolText));
    if (port.volts > 0) meta.push(`${port.volts.toFixed(2)}V`);
    if (port.amps > 0) meta.push(`${port.amps.toFixed(2)}A`);
    if (port.budget > 0) meta.push(`上限 ${port.budget}W`);
  }
  const temp = TEMPERATURES[detail?.temperature];
  if (temp) meta.push(temp.label);
  if (detail?.energyMWh != null) meta.push(energyText(detail.energyMWh));
  if (port.sessionId && port.duration > 60) meta.push(durationText(port.duration));

  const canSwitch = !!dev.mcp;
  return `
    <div class="port-row ${status === 'closed' ? 'is-off' : ''}" data-port-row="${index}" style="--port:var(--port-${index + 1})">
      <span class="port-tag">${escapeHtml(name)}</span>
      <div class="port-main">
        <div class="port-device">${escapeHtml(device || (status === 'empty' ? '没接设备' : status === 'closed' ? '端口已关闭' : '正在供电'))}</div>
        <div class="port-meta">${meta.map(m => `<span>${escapeHtml(m)}</span>`).join('')}</div>
      </div>
      <div class="port-watts">${status === 'closed' ? '—' : wattsText(port.watts)}<small>W</small></div>
      <button class="switch" role="switch" aria-checked="${status !== 'closed'}"
              data-switch="${index}" ${canSwitch ? '' : 'disabled'}
              title="${canSwitch ? '开关这个端口' : '需要配置 MCP'}"></button>
    </div>`;
}

function thermalPanel(dev) {
  return `
    <section class="panel">
      <h2 class="panel-title">温控</h2>
      <div class="option-list" id="thermal-options">
        ${TEMP_MODES.map(mode => `
          <button class="option" data-temp="${mode.value}" aria-checked="${dev.temperatureMode === mode.value}"
                  ${dev.mcp ? '' : 'disabled'}>
            <span class="option-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M12 3v10M12 21a4 4 0 0 0 1.5-7.7V5a1.5 1.5 0 1 0-3 0v8.3A4 4 0 0 0 12 21z"/>
              </svg>
            </span>
            <span class="option-body"><strong>${escapeHtml(mode.title)}</strong><span>${escapeHtml(mode.detail)}</span></span>
            <svg class="option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12.5l5 5 9-11"/></svg>
          </button>`).join('')}
      </div>
    </section>`;
}

function displayPanel(dev) {
  const display = dev.display || {};
  const level = display.level ?? null;
  // 设备报的是 display_mode，早先的版本叫 status_mode，两个都认
  const statusMode = display.display_mode ?? display.status_mode ?? null;
  const idleDisplay = display.idle_display ?? null;
  const chime = typeof display.hourly_chime === 'boolean' ? display.hourly_chime : null;
  const supportsExtended = statusMode !== null || idleDisplay !== null || chime !== null;

  return `
    <section class="panel">
      <h2 class="panel-title">状态屏</h2>
      <div class="field" style="margin-bottom:16px">
        <label>亮度</label>
        <div class="level-picker" id="level-picker">
          ${DISPLAY_LEVELS.map(l => `
            <button class="level-btn" data-level="${escapeHtml(l)}" aria-pressed="${level === l}"
                    ${dev.mcp ? '' : 'disabled'}>${escapeHtml(l)}</button>`).join('')}
        </div>
      </div>
      ${supportsExtended ? `
        <div class="field">
          <label>屏显模式</label>
          <div class="segments" id="status-mode">
            ${STATUS_MODES.map(m => `<button class="segment" data-status-mode="${escapeHtml(m)}"
              aria-pressed="${statusMode === m}">${escapeHtml(m)}</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>待机显示</label>
          <div class="segments" id="idle-display">
            ${IDLE_DISPLAYS.map(m => `<button class="segment" data-idle="${escapeHtml(m)}"
              aria-pressed="${idleDisplay === m}">${escapeHtml(m)}</button>`).join('')}
          </div>
        </div>
        <div class="field" style="margin-bottom:0">
          <label>整点报时</label>
          <button class="switch" role="switch" aria-checked="${chime === true}"
                  data-chime ${dev.mcp ? '' : 'disabled'}></button>
        </div>` : `
        <p class="chart-note">屏显模式、待机显示和整点报时只有 CP02S 支持，这台设备没有报这几项。</p>`}
    </section>`;
}

function allocationPanel(dev) {
  const limits = dev.facts?.ports?.map(p => Number(p.power) || 0) || [60, 140, 140, 140, 140];
  const total = dev.facts?.max_power_budget || 160;
  return `
    <section class="panel">
      <h2 class="panel-title">临时功率分配
        <span class="aside">整机 ${total} W</span>
      </h2>
      <div class="alloc-grid" id="alloc-grid">
        ${['A', 'C1', 'C2', 'C3', 'C4'].map((name, i) => `
          <div class="alloc-field">
            <label>${name}</label>
            <input type="number" inputmode="numeric" min="0" max="${limits[i] || 140}" placeholder="0" data-alloc="${i}">
          </div>`).join('')}
      </div>
      <p class="chart-note">0 表示按策略默认；填了数字就在 15 W 到各口上限之间。应用后所有口会重新握手，之后插拔设备会回到策略分配。</p>
      <button class="btn primary" id="apply-alloc" style="width:100%;margin-top:10px" ${dev.mcp ? '' : 'disabled'}>调整分配</button>
    </section>`;
}

function factsPanel(dev, info) {
  const facts = dev.facts;
  const factsHtml = facts ? `
    <div class="fact"><dt>各口上限</dt><dd>${(facts.ports || []).map(p => `${p.power}W`).join(' · ')}</dd></div>` : '';
  return `
    <section class="panel">
      <h2 class="panel-title">设备信息</h2>
      <dl class="facts">
        <div class="fact"><dt>序列号</dt><dd>${escapeHtml(info.psn || dev.psn)}</dd></div>
        <div class="fact"><dt>型号</dt><dd>${escapeHtml([info.device_model, info.product_family].filter(Boolean).join(' / ') || '—')}</dd></div>
        <div class="fact"><dt>主机</dt><dd>${escapeHtml(info.mdns_hostname ? `${info.mdns_hostname}.local` : dev.host)}</dd></div>
        <div class="fact"><dt>固件</dt><dd>${escapeHtml([info.esp32_version && `esp32 ${info.esp32_version}`, info.mcu_version && `mcu ${info.mcu_version}`, info.fpga_version && `fpga ${info.fpga_version}`].filter(Boolean).join(' · ') || '—')}</dd></div>
        <div class="fact"><dt>读数</dt><dd>局域网每 3 秒</dd></div>
        ${factsHtml}
        <div class="fact"><dt>MCP 地址</dt><dd>${dev.mcp ? '已配置' : '未配置'}</dd></div>
      </dl>
    </section>`;
}

function chartPanel(dev, ports) {
  return `
    <section class="panel">
      <h2 class="panel-title">充电曲线
        <span class="aside">每 10 秒一个点</span>
      </h2>
      <div class="segments" id="chart-ports" style="margin-bottom:10px">
        <button class="segment" data-chart-port="total" aria-pressed="${view.chartPort === 'total'}">合计</button>
        ${ports.map((port, i) => `<button class="segment" data-chart-port="${port.id}"
          aria-pressed="${view.chartPort === port.id}">${escapeHtml(portName(dev, i))}</button>`).join('')}
      </div>
      <div class="segments" id="chart-range" style="margin-bottom:8px">
        <button class="segment" data-range="1800" aria-pressed="${view.chartSeconds === 1800}">30 分钟</button>
        <button class="segment" data-range="7200" aria-pressed="${view.chartSeconds === 7200}">2 小时</button>
      </div>
      <div class="chart-wrap" id="chart-wrap">
        <svg class="chart" id="chart" viewBox="0 0 640 190" preserveAspectRatio="xMidYMid meet"></svg>
        <div class="chart-tooltip" id="chart-tooltip"></div>
      </div>
      <div class="chart-stats" id="chart-stats"></div>
      <p class="chart-note">最近 30 分钟用小电拼内存里存的读数（每 10 秒一个点，断电清空）；其余是这个页面记录的，最多 2 小时，重开浏览器后接着显示。</p>
    </section>`;
}

function devicesOnPortsPanel(dev, ports) {
  const rows = ports
    .map((port, index) => ({ port, index, identity: dev.identities?.[port.id + 1], detail: dev.details?.[port.id] }))
    .filter(r => r.identity || r.detail?.connected);

  if (!rows.length) {
    return `
      <section class="panel">
        <h2 class="panel-title">在充设备</h2>
        <p class="chart-note">没有接设备，或者还没配 MCP 读不到识别信息。</p>
      </section>`;
  }

  return `
    <section class="panel">
      <h2 class="panel-title">在充设备</h2>
      <div class="option-list">
        ${rows.map(({ port, index, identity, detail }) => {
          const battery = batteryText(identity);
          return `
            <div class="option" style="cursor:default">
              <span class="port-tag" style="--port:var(--port-${index + 1})">${escapeHtml(portName(dev, index))}</span>
              <span class="option-body">
                <strong>${escapeHtml(identityName(identity) || '未识别的设备')}</strong>
                <span>${escapeHtml(pdSummary(identity) || protocolName(port.proto, port.protocolText))}${battery ? ' · ' + escapeHtml(battery) : ''}</span>
              </span>
            </div>`;
        }).join('')}
      </div>
    </section>`;
}

function identityName(identity) {
  if (!identity) return '';
  const brand = identity.device_brand_zh || identity.device_brand_en;
  const model = identity.device_name_zh || identity.device_name_en;
  if (model) return brand && !model.includes(brand) ? `${brand} ${model}` : model;
  if (brand) return `${brand} 设备`;
  // 设备没报身份时厂商号是 0 或 0xFFFF，不算认出来
  const vid = Number(identity.manufacturer_vid);
  if (Number.isFinite(vid) && vid > 0 && vid !== 0xFFFF) {
    return `厂商 0x${vid.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return '';
}

function pdSummary(identity) {
  if (!identity) return '';
  const parts = [];
  if (identity.pd_revision) parts.push(identity.pd_revision);
  const volts = Number(identity.operating_voltage) / 100;
  const amps = Number(identity.operating_current) / 100;
  if (Number.isFinite(volts) && volts > 0) parts.push(`请求 ${volts}V ${amps.toFixed(2)}A`);
  const maxW = Number(identity.sink_maximum_pdp);
  if (Number.isFinite(maxW) && maxW > 0) parts.push(`设备最高 ${maxW}W`);
  if (identity.request_epr_mode_capable) parts.push('支持 EPR');
  else if (identity.pps_charging_supported) parts.push('支持 PPS');
  return parts.join(' · ');
}

function batteryText(identity) {
  if (!identity || identity.battery_present === false || identity.battery_invalid === true) return '';
  const design = Number(identity.battery_design_capacity);
  const full = Number(identity.battery_last_full_charge_capacity);
  const present = Number(identity.battery_present_capacity);
  if (!Number.isFinite(design) || !Number.isFinite(present) || design <= 0) return '';
  const percent = Math.round((present / (full || design)) * 100);
  const health = full && design ? Math.round((full / design) * 100) : null;
  return `电量 ${percent}%${health ? ` · 健康 ${health}%` : ''}`;
}

// ---------------------------------------------------------------- 事件

function bindEvents(dev, container) {
  // 模式
  container.querySelectorAll('[data-strategy]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const value = Number(btn.dataset.strategy);
      const strategy = STRATEGIES.find(s => s.value === value);
      const ok = await confirmDialog(`切换到「${strategy.title}」`, strategy.warning, '切换');
      if (!ok) return;
      try {
        if (value === 6) await mcpCall(dev, 'set_usba_charging_mode');
        else await mcpCall(dev, 'set_charging_strategy', { strategy: value });
        localStorage.setItem(`cocan.strategy.${dev.psn}`, String(value));
        dev.strategy = value;
        document.body.dataset.strategy = strategy.key;
        container.querySelectorAll('[data-strategy]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.strategy) === value)));
        const note = $('#strategy-note');
        if (note) note.textContent = strategy.detail;
        toast(`已切换到${strategy.title}`);
        setTimeout(() => pollMcp(), 1200);
      } catch (error) {
        toast(error.message, true);
      }
    });
  });

  // 端口开关
  container.querySelectorAll('[data-switch]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const index = Number(btn.dataset.switch);
      const port = dev.metrics?.ports?.[index];
      if (!port) return;
      const turnOn = portState(port) === 'closed';
      const name = portName(dev, index);
      if (!turnOn && port.attached && port.watts > 0) {
        const ok = await confirmDialog(`关闭 ${name}`, `这个口正在给设备供电（${wattsText(port.watts)} W），关掉会让设备断电。`, '关闭端口');
        if (!ok) return;
      }
      btn.disabled = true;
      try {
        await mcpCall(dev, turnOn ? 'turn_on_port' : 'turn_off_port', { ports: [index + 1] });
        toast(`${name} 已${turnOn ? '打开' : '关闭'}`);
        setTimeout(() => pollLan(), 900);
      } catch (error) {
        toast(error.message, true);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // 温控
  container.querySelectorAll('[data-temp]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = Number(btn.dataset.temp);
      try {
        await mcpCall(dev, 'set_temperature_mode', { mode });
        dev.temperatureMode = mode;
        container.querySelectorAll('[data-temp]').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.temp) === mode)));
        toast(`已切换到${TEMP_MODES.find(m => m.value === mode).title}`);
      } catch (error) {
        toast(error.message, true);
      }
    });
  });

  // 亮度
  container.querySelectorAll('[data-level]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const level = btn.dataset.level;
      try {
        await mcpCall(dev, 'set_display_intensity', { level });
        container.querySelectorAll('[data-level]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.level === level)));
        toast(`亮度已设为${level}`);
      } catch (error) {
        toast(error.message, true);
      }
    });
  });

  // 屏显模式
  container.querySelectorAll('[data-status-mode]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.statusMode;
      try {
        await mcpCall(dev, 'set_status_display_mode', { mode });
        container.querySelectorAll('[data-status-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.statusMode === mode)));
        toast(`屏显模式：${mode}`);
      } catch (error) {
        toast(error.message, true);
      }
    });
  });

  // 待机显示
  container.querySelectorAll('[data-idle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idle = btn.dataset.idle;
      try {
        await mcpCall(dev, 'set_idle_display', { idle_display: idle });
        container.querySelectorAll('[data-idle]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.idle === idle)));
        toast(`待机显示：${idle}`);
      } catch (error) {
        toast(error.message, true);
      }
    });
  });

  // 整点报时
  const chime = container.querySelector('[data-chime]');
  chime?.addEventListener('click', async () => {
    const next = chime.getAttribute('aria-checked') !== 'true';
    try {
      await mcpCall(dev, 'set_hourly_chime', { enabled: next });
      chime.setAttribute('aria-checked', String(next));
      toast(`整点报时已${next ? '打开' : '关闭'}`);
    } catch (error) {
      toast(error.message, true);
    }
  });

  // 功率分配
  $('#apply-alloc')?.addEventListener('click', async () => {
    const inputs = [...container.querySelectorAll('[data-alloc]')];
    const allocation = inputs.map(input => {
      const value = Number(input.value);
      return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    });
    const limits = dev.facts?.ports?.map(p => Number(p.power) || 0) || [60, 140, 140, 140, 140];
    const total = dev.facts?.max_power_budget || 160;

    for (let i = 0; i < allocation.length; i++) {
      const value = allocation[i];
      if (value === 0) continue;
      if (value < 15) { toast(`${['A', 'C1', 'C2', 'C3', 'C4'][i]} 最少 15 W，或者填 0`, true); return; }
      if (limits[i] && value > limits[i]) { toast(`${['A', 'C1', 'C2', 'C3', 'C4'][i]} 最多 ${limits[i]} W`, true); return; }
    }
    const sum = allocation.reduce((a, b) => a + b, 0);
    if (sum > total) { toast(`合计 ${sum} W，超过整机上限 ${total} W`, true); return; }

    const ok = await confirmDialog('调整功率分配', '应用后所有端口会重新握手，充电会短暂中断。插拔设备或开关端口后会回到策略分配。', '应用');
    if (!ok) return;

    try {
      await mcpCall(dev, 'set_port_power_allocation', { power_allocation: allocation });
      toast('已应用分配');
    } catch (error) {
      toast(error.message, true);
    }
  });

  // 曲线：切端口
  container.querySelectorAll('[data-chart-port]').forEach(btn => {
    btn.addEventListener('click', () => {
      view.chartPort = btn.dataset.chartPort === 'total' ? 'total' : Number(btn.dataset.chartPort);
      container.querySelectorAll('[data-chart-port]').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.chartPort === btn.dataset.chartPort)));
      drawChart(dev);
    });
  });

  // 曲线：切时间范围
  container.querySelectorAll('[data-range]').forEach(btn => {
    btn.addEventListener('click', () => {
      view.chartSeconds = Number(btn.dataset.range);
      container.querySelectorAll('[data-range]').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.range === btn.dataset.range)));
      drawChart(dev);
    });
  });
}

// ---------------------------------------------------------------- 轮询时只改数值

// 数据是分批到的：局域网读数 3 秒一次、MCP 15 秒一次。每次到新的那批就整体重建一次，
// 没到的面板那时还是空的。重建几次之后数据齐了，就只做数值更新，免得打字打到一半被清掉。
let lastSignature = '';

function dataSignature(dev) {
  return [
    dev.metrics?.ports?.length || 0,
    dev.info ? 1 : 0,
    dev.display ? 1 : 0,
    dev.identities ? 1 : 0,
    dev.facts ? 1 : 0,
    dev.temperatureMode === null || dev.temperatureMode === undefined ? 0 : 1,
  ].join('|');
}

export function updateDetail(dev) {
  if (!dev || view.psn !== dev.psn) return;

  const signature = dataSignature(dev);
  if (signature !== lastSignature) {
    lastSignature = signature;
    const container = $('#app');
    if (container) { renderDetail(container, dev); return; }
  }

  // 端口行
  const ports = dev.metrics?.ports || [];
  for (let index = 0; index < ports.length; index++) {
    const row = document.querySelector(`[data-port-row="${index}"]`);
    if (!row) continue;
    const port = ports[index];
    const status = portState(port);
    row.classList.toggle('is-off', status === 'closed');
    const watts = row.querySelector('.port-watts');
    if (watts) watts.innerHTML = `${status === 'closed' ? '—' : wattsText(port.watts)}<small>W</small>`;

    const sw = row.querySelector('[data-switch]');
    if (sw) sw.setAttribute('aria-checked', String(status !== 'closed'));

    const device = row.querySelector('.port-device');
    const identity = dev.identities?.[port.id + 1];
    const name = identityName(identity);
    if (device) {
      device.textContent = name || (status === 'empty' ? '没接设备' : status === 'closed' ? '端口已关闭' : '正在供电');
    }

    const metaBox = row.querySelector('.port-meta');
    if (metaBox) {
      const detail = dev.details?.[port.id];
      const meta = [];
      if (status === 'closed') meta.push('已关闭');
      else if (status === 'empty') meta.push('空着');
      else {
        meta.push(protocolName(port.proto, port.protocolText));
        if (port.volts > 0) meta.push(`${port.volts.toFixed(2)}V`);
        if (port.amps > 0) meta.push(`${port.amps.toFixed(2)}A`);
        if (port.budget > 0) meta.push(`上限 ${port.budget}W`);
      }
      const temp = TEMPERATURES[detail?.temperature];
      if (temp) meta.push(temp.label);
      if (detail?.energyMWh != null) meta.push(energyText(detail.energyMWh));
      if (port.sessionId && port.duration > 60) meta.push(durationText(port.duration));
      metaBox.innerHTML = meta.map(m => `<span>${escapeHtml(m)}</span>`).join('');
    }
  }

  // 端口面板标题上的合计
  const portsTitle = document.querySelector('.detail-main .panel .aside');
  document.querySelectorAll('.panel-title .aside').forEach(node => {
    if (node.textContent.includes('口在充')) {
      node.textContent = `${chargingCount(dev)} 口在充 · 合计 ${wattsText(totalWatts(dev))} W`;
    }
  });

  // 温控与亮度：MCP 那边每 15 秒更新一次
  if (dev.temperatureMode !== null && dev.temperatureMode !== undefined) {
    document.querySelectorAll('[data-temp]').forEach(b =>
      b.setAttribute('aria-checked', String(Number(b.dataset.temp) === dev.temperatureMode)));
  }
  const level = dev.display?.level;
  if (level) {
    document.querySelectorAll('[data-level]').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.level === level)));
  }

  // 页面副标题的时间
  const sub = document.querySelector('.page-sub');
  if (sub && dev.updatedAt) {
    sub.textContent = [
      dev.info?.product_family || '',
      dev.host,
      `更新于 ${clockText(dev.updatedAt)}`,
    ].filter(Boolean).join(' · ');
  }

  drawChart(dev);
  void portsTitle;
}

// ---------------------------------------------------------------- 曲线

function drawChart(dev) {
  const svg = document.getElementById('chart');
  if (!svg) return;

  const samples = samplesSince(dev.psn, view.chartPort, view.chartSeconds);
  const stats = document.getElementById('chart-stats');

  const index = view.chartPort === 'total' ? null : Number(view.chartPort);
  const color = view.chartPort === 'total'
    ? 'var(--brand)'
    : `var(--port-${(index ?? 0) + 1})`;

  if (!samples.length) {
    svg.innerHTML = `<text x="320" y="95" text-anchor="middle" class="axis-text" style="font-size:12px">还没有数据，读几秒就有了</text>`;
    if (stats) stats.innerHTML = '';
    return;
  }

  const W = 640, H = 190;
  const pad = { left: 42, right: 10, top: 12, bottom: 24 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - view.chartSeconds;
  const maxW = Math.max(10, ...samples.map(s => s[1]));
  const top = niceCeil(maxW * 1.1);

  const x = t => pad.left + ((t - startSec) / view.chartSeconds) * innerW;
  const y = w => pad.top + innerH - (w / top) * innerH;

  // 网格与 y 轴刻度
  const gridCount = 4;
  let grid = '';
  for (let i = 0; i <= gridCount; i++) {
    const value = (top / gridCount) * i;
    const yy = y(value);
    grid += `<line class="grid-line" x1="${pad.left}" y1="${yy}" x2="${W - pad.right}" y2="${yy}"/>`;
    grid += `<text class="axis-text" x="${pad.left - 8}" y="${yy + 3}" text-anchor="end">${Math.round(value)} W</text>`;
  }

  // x 轴时间刻度
  const tickCount = 3;
  let ticks = '';
  for (let i = 0; i <= tickCount; i++) {
    const t = startSec + (view.chartSeconds / tickCount) * i;
    const xx = x(t);
    const label = new Date(t * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const anchor = i === 0 ? 'start' : i === tickCount ? 'end' : 'middle';
    ticks += `<text class="axis-text" x="${xx}" y="${H - 6}" text-anchor="${anchor}">${label}</text>`;
  }

  // 分段：相邻两点隔得太久就断开，不连成斜线
  const segments = [];
  let current = [];
  let prev = null;
  for (const sample of samples) {
    if (prev && sample[0] - prev > 30) {
      if (current.length) segments.push(current);
      current = [];
    }
    current.push(sample);
    prev = sample[0];
  }
  if (current.length) segments.push(current);

  let paths = '';
  let areas = '';
  for (const seg of segments) {
    if (seg.length === 1) {
      const [t, w] = seg[0];
      paths += `<circle cx="${x(t)}" cy="${y(w)}" r="2" fill="${color}"/>`;
      continue;
    }
    let d = '';
    seg.forEach(([t, w], i) => { d += `${i === 0 ? 'M' : 'L'}${x(t).toFixed(1)} ${y(w).toFixed(1)} `; });
    paths += `<path class="series-line" d="${d}" stroke="${color}"/>`;
    const first = seg[0], last = seg[seg.length - 1];
    areas += `<path class="series-area" d="${d}L${x(last[0]).toFixed(1)} ${y(0)} L${x(first[0]).toFixed(1)} ${y(0)} Z" fill="url(#chart-gradient)" opacity="0.18"/>`;
  }

  svg.innerHTML = `
    <defs>
      <linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="1"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}${ticks}${areas}${paths}`;

  // 统计
  if (stats) {
    const watts = samples.map(s => s[1]);
    const avg = watts.reduce((a, b) => a + b, 0) / watts.length;
    const peak = Math.max(...watts);
    const last = samples[samples.length - 1];
    const port = index === null ? null : dev.metrics?.ports?.find(p => p.id === index);
    const detail = index === null ? null : dev.details?.[index];

    const items = [
      ['平均', `${wattsText(avg)} W`],
      ['峰值', `${wattsText(peak)} W`],
    ];
    if (port) items.push(['电压', port.volts > 0 ? `${port.volts.toFixed(2)} V` : '—']);
    if (detail?.energyMWh != null) items.push(['本次已充', energyText(detail.energyMWh)]);
    else if (last) items.push(['当前', `${wattsText(last[1])} W`]);

    stats.innerHTML = items.map(([label, value]) =>
      `<div class="chart-stat">${escapeHtml(label)}<b>${escapeHtml(value)}</b></div>`).join('');
  }

  // 鼠标悬停显示数值
  bindChartHover(svg, samples, x, y, color);
}

function bindChartHover(svg, samples, x, y, color) {
  const tooltip = document.getElementById('chart-tooltip');
  const wrap = document.getElementById('chart-wrap');
  if (!tooltip || !wrap) return;

  const move = event => {
    const rect = svg.getBoundingClientRect();
    const ratio = 640 / rect.width;
    const px = (event.clientX - rect.left) * ratio;
    let best = null;
    let bestDist = Infinity;
    for (const sample of samples) {
      const dist = Math.abs(x(sample[0]) - px);
      if (dist < bestDist) { bestDist = dist; best = sample; }
    }
    if (!best || bestDist > 40) { tooltip.classList.remove('is-visible'); return; }
    const time = new Date(best[0] * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    tooltip.innerHTML = `${time} · <b>${wattsText(best[1])} W</b>${best[2] ? ` · ${best[2].toFixed(2)} V` : ''}${best[3] ? ` · ${best[3].toFixed(2)} A` : ''}`;
    const left = (x(best[0]) * rect.width) / 640;
    const top = (y(best[1]) * rect.height) / 190;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top - 8}px`;
    tooltip.classList.add('is-visible');
  };

  svg.addEventListener('mousemove', move);
  svg.addEventListener('mouseleave', () => tooltip.classList.remove('is-visible'));
  wrap.addEventListener('mouseleave', () => tooltip.classList.remove('is-visible'));
}

function niceCeil(value) {
  if (value <= 10) return 10;
  if (value <= 25) return 25;
  if (value <= 50) return 50;
  if (value <= 100) return 100;
  if (value <= 150) return 150;
  if (value <= 200) return 200;
  return Math.ceil(value / 50) * 50;
}

// ---------------------------------------------------------------- 拉详情

// 进详情页时补一次曲线（设备内存里最近 30 分钟），并把工具调一遍
export async function refreshDetail(dev) {
  if (!dev || !dev.mcp) return;
  const ports = dev.metrics?.ports || [];
  await Promise.all(ports.map(port => backfillPort(dev, port.id)));
  persistHistory();
  drawChart(dev);
}
