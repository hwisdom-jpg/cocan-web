// 共用部分：状态、请求、格式化、轮询、主题。
// 数据的来源有两个：局域网 /metrics.json（快，3 秒一次，只有读数和开关状态）
// 和官方 MCP（慢，15 秒一次，温度、电量、设备识别、可调的设置项都在这里）。

export const state = {
  config: { devices: [], theme: 'warm' },
  appearance: 'light',
  route: { name: 'overview', psn: null },
  devices: new Map(),
  history: new Map(),      // psn -> { portId: [[t, w, v, a], ...] }
  recorders: new Map(),    // psn -> { portId: {slot, w, v, a, n} }
  onUpdate: null,          // 渲染回调，由 app.js 注册
};

// ---------------------------------------------------------------- 常量

// 快充协议编号 → 名字（和小程序、macOS 版一致）
const PROTOCOLS = {
  [-1]: '其他协议', 0: 'USB 普通', 1: 'QC 2.0', 2: 'QC 3.0', 3: 'QC 3+', 4: 'SFCP', 5: 'AFC',
  6: 'FCP', 7: 'SCP', 8: 'VOOC 1.0', 9: 'VOOC 4.0', 10: 'SuperVOOC 2.0', 11: 'TFCP', 12: 'UFCS',
  13: 'PE 1.0', 14: 'PE 2.0', 15: 'PD 5V', 16: 'PD 固定高压', 17: 'PD SPR AVS', 18: 'PD PPS',
  19: 'PD EPR', 20: 'PD AVS', 21: 'PD 小米 PPS', 255: '未充电',
};

// 柱子上方的短名，太长了会把卡片撑开
const SHORT_PROTOCOLS = {
  [-1]: '其他', 0: 'USB', 1: 'QC2', 2: 'QC3', 3: 'QC3+', 4: 'SFCP', 5: 'AFC', 6: 'FCP', 7: 'SCP',
  8: 'VOOC', 9: 'VOOC4', 10: 'SuperVOOC', 11: 'TFCP', 12: 'UFCS', 13: 'PE1', 14: 'PE2',
  15: 'PD', 16: 'PD', 17: 'PD', 18: 'PD', 19: 'PD', 20: 'PD', 21: 'PD',
};

export const STRATEGIES = [
  { value: 0, key: 'standard', title: '自由流', detail: 'FluxAI 多设备按需分配', warning: '会重新分配功率，充电可能短暂中断。' },
  { value: 1, key: 'sleep', title: '睡眠充', detail: '夜间慢充，避免电池久满电', warning: '会重新分配功率，充电可能短暂中断。' },
  { value: 6, key: 'usba', title: '魔拟充', detail: '小家电用 C 口模拟 A 口', warning: 'C 口改成模拟 A 口给小家电供电，充电可能短暂中断。' },
  { value: 7, key: 'performance', title: '性能模式', detail: '按需分配，最大化效率', warning: '会重新分配功率，充电可能短暂中断。' },
  { value: 8, key: 'single', title: '极速单充', detail: '关闭其他口，C1 独享', warning: '会关闭其他端口，只给 C1 供电。' },
];

export const TEMP_MODES = [
  { value: 0, title: '性能温控', detail: '功率优先 · 更高效能' },
  { value: 1, title: '安心温控', detail: '温度优先 · 更少发热' },
];

export const DISPLAY_LEVELS = ['关', '低', '中', '高'];
export const STATUS_MODES = ['待机动画优先', '功率显示优先'];
export const IDLE_DISPLAYS = ['流星', '落花', '康威的生命游戏', '时间'];

export const TEMPERATURES = {
  cool: { label: '凉爽', level: 0 },
  moderate: { label: '温和', level: 1 },
  warm: { label: '偏热', level: 2 },
  hot: { label: '过热', level: 3 },
};

// ---------------------------------------------------------------- 工具

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, html = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  if (html) node.innerHTML = html;
  return node;
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function wattsText(w) {
  if (!Number.isFinite(w) || w <= 0) return '0';
  if (w >= 100) return String(Math.round(w));
  if (w >= 10) return w.toFixed(1).replace(/\.0$/, '');
  return w.toFixed(1);
}

export function energyText(mWh) {
  if (!Number.isFinite(mWh)) return '—';
  if (mWh < 999.5) return `${Math.round(Math.max(mWh, 0))} mWh`;
  if (mWh < 9_995) return `${(mWh / 1000).toFixed(2)} Wh`;
  if (mWh < 99_950) return `${(mWh / 1000).toFixed(1)} Wh`;
  if (mWh < 999_500) return `${Math.round(mWh / 1000)} Wh`;
  return `${(mWh / 1_000_000).toFixed(2)} kWh`;
}

export function durationText(seconds) {
  if (!seconds || seconds < 60) return `${seconds || 0} 秒`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  return `${m} 分`;
}

export function clockText(date) {
  return new Date(date).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function protocolName(code, text) {
  if (text) return text;
  return PROTOCOLS[code] ?? `协议 ${code}`;
}

export function shortProtocol(port) {
  const name = SHORT_PROTOCOLS[port.proto] ?? '';
  if (port.proto === 255 || port.proto === 0) return port.volts > 0 ? `${name} ${Math.round(port.volts)}V` : name;
  if ((port.proto >= 15 && port.proto <= 21) && port.volts > 0) return `PD ${Math.round(port.volts)}V`;
  return name;
}

// ---------------------------------------------------------------- 请求

export async function api(path, options = {}) {
  const res = await fetch(path, options);
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok || (data && data.error)) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

export function postJSON(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// 调一次 MCP 工具，返回 { text, json }
export function mcpCall(dev, tool, args = {}) {
  if (!dev.mcp) throw new Error('这台设备还没有配置 MCP 地址');
  return postJSON('/api/mcp', { psn: dev.psn, tool, arguments: args });
}

export function mcpBatch(dev, calls) {
  if (!dev.mcp) return Promise.resolve({});
  return postJSON('/api/mcp/batch', { psn: dev.psn, calls });
}

// ---------------------------------------------------------------- 配置

export async function loadConfig() {
  const config = await api('/api/config');
  state.config = config;
  state.devices.clear();
  for (const item of config.devices || []) {
    state.devices.set(item.psn, {
      psn: item.psn,
      name: item.name || `小电拼 ${item.psn.slice(-4)}`,
      host: item.host,
      mcp: item.mcp || '',
      online: false,
      failures: 0,
      metrics: null,
      info: null,
      details: null,
      identities: null,
      facts: null,
      temperatureMode: null,
      display: null,
      strategy: readStoredStrategy(item.psn),
      updatedAt: 0,
      error: null,
    });
  }
  // 主题
  const theme = config.theme === 'cool' ? 'cool' : 'warm';
  const appearance = localStorage.getItem('cocan.appearance')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(theme, appearance);
  return config;
}

export async function saveConfig(patch) {
  const next = await postJSON('/api/config', patch);
  state.config = next;
  return next;
}

export function readStoredStrategy(psn) {
  const raw = localStorage.getItem(`cocan.strategy.${psn}`);
  return raw ? Number(raw) : null;
}

export function storeStrategy(psn, value) {
  localStorage.setItem(`cocan.strategy.${psn}`, String(value));
  const dev = state.devices.get(psn);
  if (dev) dev.strategy = value;
  applyStrategyAttribute(value);
}

// ---------------------------------------------------------------- 主题

export function applyTheme(theme, appearance) {
  document.body.dataset.theme = theme;
  document.body.dataset.appearance = appearance;
  state.config.theme = theme;
  state.appearance = appearance;
  localStorage.setItem('cocan.appearance', appearance);
  applyStrategyAttribute(null);
}

export function toggleTheme() {
  const next = document.body.dataset.theme === 'cool' ? 'warm' : 'cool';
  applyTheme(next, document.body.dataset.appearance);
  saveConfig({ theme: next }).catch(() => {});
}

export function toggleAppearance() {
  const next = document.body.dataset.appearance === 'dark' ? 'light' : 'dark';
  applyTheme(document.body.dataset.theme, next);
}

// 五个口的颜色跟着策略换，用 body 上的 data-strategy 驱动 CSS 变量
function applyStrategyAttribute(strategy) {
  const key = strategy === null || strategy === undefined
    ? (state.route.psn ? state.devices.get(state.route.psn)?.strategy : null)
    : strategy;
  const found = STRATEGIES.find(s => s.value === key);
  document.body.dataset.strategy = found ? found.key : 'standard';
}

// ---------------------------------------------------------------- 提示

let toastTimer = null;
export function toast(message, isError = false) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), isError ? 4200 : 2400);
}

// ---------------------------------------------------------------- 对话框

// 通用对话框。actions 里每项 { label, class, onClick }，
// onClick 返回 true 表示不要关闭（比如校验没过）。
export function openDialog({ title, subtitle, bodyHtml, actions = [], onClose }) {
  const overlay = $('#overlay');
  let closed = false;

  const close = reason => {
    if (closed) return;
    closed = true;
    overlay.hidden = true;
    overlay.innerHTML = '';
    onClose?.(reason);
  };

  overlay.innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>${escapeHtml(title)}</h3>
      ${subtitle ? `<p class="dialog-sub">${escapeHtml(subtitle)}</p>` : ''}
      <div class="dialog-body">${bodyHtml}</div>
      <div class="dialog-actions">
        ${actions.map((a, i) => `<button class="btn ${a.class || ''}" data-action="${i}">${escapeHtml(a.label)}</button>`).join('')}
      </div>
    </div>`;
  overlay.hidden = false;
  overlay.onclick = event => { if (event.target === overlay) close('dismiss'); };

  actions.forEach((action, index) => {
    overlay.querySelector(`[data-action="${index}"]`)?.addEventListener('click', async () => {
      if (!action.onClick) return close('dismiss');
      const keep = await action.onClick(overlay);
      if (keep !== true) close('action');
    });
  });

  return { overlay, close };
}

export function closeDialog() {
  const overlay = $('#overlay');
  if (!overlay || overlay.hidden) return false;
  overlay.hidden = true;
  overlay.innerHTML = '';
  return true;
}

export function confirmDialog(title, message, confirmLabel = '确定') {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    openDialog({
      title,
      subtitle: message,
      bodyHtml: '',
      actions: [
        { label: '取消', onClick: () => done(false) },
        { label: confirmLabel, class: 'primary', onClick: () => done(true) },
      ],
      // 点遮罩或按 Esc 关掉，按取消算
      onClose: () => done(false),
    });
  });
}

// ---------------------------------------------------------------- 轮询

let lanTimer = null;
let mcpTimer = null;

export function startPolling() {
  stopPolling();
  pollLan();
  pollMcp();
  lanTimer = setInterval(pollLan, 3000);
  mcpTimer = setInterval(pollMcp, 15000);
}

export function stopPolling() {
  clearInterval(lanTimer);
  clearInterval(mcpTimer);
}

export async function pollLan() {
  const devices = [...state.devices.values()];
  await Promise.all(devices.map(async dev => {
    if (!dev.host) return;
    try {
      const raw = await api(`/api/lan?host=${encodeURIComponent(dev.host)}`);
      applyMetrics(dev, raw);
      dev.failures = 0;
      dev.error = null;
      if (!dev.online) { dev.online = true; ensureInfo(dev); }
    } catch (error) {
      dev.failures = (dev.failures || 0) + 1;
      if (dev.failures >= 2) dev.online = false;
      dev.error = error.message;
    }
  }));
  state.onUpdate?.('lan');
}

// 拿设备的首页信息（PSN、型号、固件版本），只成功一次就够
export async function ensureInfo(dev) {
  if (dev.info || dev.infoLoading) return;
  dev.infoLoading = true;
  try {
    dev.info = await api(`/api/info?host=${encodeURIComponent(dev.host)}`);
    state.onUpdate?.('info');
  } catch { /* 首页格式变了不影响读数 */ } finally {
    dev.infoLoading = false;
  }
}

export async function pollMcp() {
  const devices = [...state.devices.values()].filter(d => d.mcp && d.online);
  await Promise.all(devices.map(async dev => {
    try {
      const result = await mcpBatch(dev, [
        { tool: 'get_port_details' },
        { tool: 'get_port_pd_status' },
        { tool: 'get_temperature_mode' },
        { tool: 'get_display_config' },
        { tool: 'get_machine_facts' },
      ]);
      if (result.get_port_details && !result.get_port_details.error) {
        applyPortDetails(dev, result.get_port_details.json);
      }
      if (result.get_port_pd_status && !result.get_port_pd_status.error) {
        dev.identities = indexByPort(result.get_port_pd_status.json);
      }
      if (result.get_temperature_mode && !result.get_temperature_mode.error) {
        dev.temperatureMode = result.get_temperature_mode.json?.mode ?? null;
      }
      if (result.get_display_config && !result.get_display_config.error) {
        dev.display = result.get_display_config.json;
      }
      if (result.get_machine_facts && !result.get_machine_facts.error) {
        dev.facts = result.get_machine_facts.json;
      }
      dev.mcpError = null;
    } catch (error) {
      dev.mcpError = error.message;
    }
  }));
  state.onUpdate?.('mcp');
}

function indexByPort(value) {
  const out = {};
  for (const entry of value?.ports || []) {
    const port = Number(entry.port);
    if (Number.isFinite(port)) out[port] = entry;
  }
  return out;
}

// ---------------------------------------------------------------- 解码

function applyMetrics(dev, raw) {
  const ports = (raw.ports || []).map(p => {
    const mA = num(p.current);
    const mV = num(p.voltage);
    return {
      id: num(p.id),
      active: p.active !== false,
      state: p.state || '',
      portType: p.port_type || '',
      attached: !!p.attached,
      duration: num(p.charging_duration_seconds),
      proto: p.fc_protocol ?? 255,
      mA, mV,
      volts: mV / 1000,
      amps: mA / 1000,
      watts: (mA * mV) / 1_000_000,
      vin: num(p.vin_value),
      budget: num(p.power_budget),
      sessionId: p.session_id,
      sessionCharge: p.session_charge,
    };
  }).sort((a, b) => a.id - b.id);

  dev.metrics = { ports, system: raw.system || null };
  dev.updatedAt = Date.now();
  recordHistory(dev);
}

function applyPortDetails(dev, value) {
  const details = {};
  for (const entry of value?.ports || []) {
    const port = Number(entry.port);
    if (!Number.isFinite(port)) continue;
    details[port - 1] = {
      sessionId: entry.session_id ?? null,
      energyMWh: entry.session_charge_mwh ?? null,
      temperature: entry.die_temperature || null,
      connected: entry.connected,
      lanChargeAtLoad: dev.metrics?.ports?.[port - 1]?.sessionCharge ?? null,
      loadedAt: Date.now(),
    };
  }
  dev.details = details;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 端口状态：closed（关着）/ empty（空着）/ standby（接了但没取电）/ charging
export function portState(port) {
  if (!port) return 'empty';
  if (!port.active || String(port.state).toUpperCase() === 'INACTIVE') return 'closed';
  if (!port.attached) return 'empty';
  if (port.watts > 0.05) return 'charging';
  return 'standby';
}

export function totalWatts(dev) {
  return (dev.metrics?.ports || []).reduce((sum, p) => sum + (portState(p) === 'closed' ? 0 : p.watts), 0);
}

export function chargingCount(dev) {
  return (dev.metrics?.ports || []).filter(p => portState(p) === 'charging').length;
}

export function portName(dev, index) {
  const family = (dev.info?.product_family || '').toUpperCase();
  const names = family === 'PA768S' ? ['C1', 'C2', 'C3'] : ['A', 'C1', 'C2', 'C3', 'C4'];
  return names[index] || `P${index + 1}`;
}

// ---------------------------------------------------------------- 曲线记录

const SLOT = 10;          // 秒，一个点
const RETENTION = 7200;   // 2 小时

function slotOf(ms) {
  return Math.floor(ms / 1000 / SLOT) * SLOT;
}

function recordHistory(dev) {
  if (!dev.metrics) return;
  let recorder = state.recorders.get(dev.psn);
  if (!recorder) { recorder = {}; state.recorders.set(dev.psn, recorder); }
  let series = state.history.get(dev.psn);
  if (!series) { series = {}; state.history.set(dev.psn, series); }

  const now = Date.now();
  const currentSlot = slotOf(now);

  for (const port of dev.metrics.ports) {
    const state_ = portState(port);
    const watts = state_ === 'closed' ? 0 : port.watts;
    let slot = recorder[port.id];
    if (!slot) { slot = recorder[port.id] = { slot: currentSlot, w: 0, v: 0, a: 0, n: 0 }; }
    if (slot.slot !== currentSlot) {
      if (slot.n > 0) {
        pushSample(series, port.id, [slot.slot, round2(slot.w / slot.n), round3(slot.v / slot.n), round3(slot.a / slot.n)]);
      }
      slot.slot = currentSlot;
      slot.w = slot.v = slot.a = 0;
      slot.n = 0;
    }
    slot.w += watts;
    slot.v += port.volts;
    slot.a += port.amps;
    slot.n += 1;
  }
  pruneHistory(series, now);
  state.history.set(dev.psn, series);
}

function pushSample(series, portId, sample) {
  if (!series[portId]) series[portId] = [];
  const list = series[portId];
  const last = list[list.length - 1];
  if (last && last[0] >= sample[0]) return;
  list.push(sample);
}

function pruneHistory(series, now) {
  const cutoff = Math.floor(now / 1000) - RETENTION;
  for (const key of Object.keys(series)) {
    const list = series[key].filter(s => s[0] >= cutoff);
    if (list.length) series[key] = list;
    else delete series[key];
  }
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

export function samplesSince(psn, portId, seconds) {
  const series = state.history.get(psn);
  if (!series) return [];
  if (portId === 'total') {
    // 几个口按时间相加
    const sums = new Map();
    for (const list of Object.values(series)) {
      for (const [t, w] of list) sums.set(t, (sums.get(t) || 0) + w);
    }
    const cutoff = Math.floor(Date.now() / 1000) - seconds;
    return [...sums.entries()].filter(([t]) => t >= cutoff).sort((a, b) => a[0] - b[0]).map(([t, w]) => [t, w, 0, 0]);
  }
  const cutoff = Math.floor(Date.now() / 1000) - seconds;
  return (series[portId] || []).filter(s => s[0] >= cutoff);
}

// 存盘，重开页面曲线还在
export function persistHistory() {
  try {
    const payload = {};
    for (const [psn, series] of state.history) {
      const trimmed = {};
      for (const [portId, list] of Object.entries(series)) {
        if (list.length) trimmed[portId] = list;
      }
      if (Object.keys(trimmed).length) payload[psn] = trimmed;
    }
    localStorage.setItem('cocan.history', JSON.stringify(payload));
  } catch { /* 存不下就算了，不影响显示 */ }
}

export function restoreHistory() {
  try {
    const raw = localStorage.getItem('cocan.history');
    if (!raw) return;
    const payload = JSON.parse(raw);
    const cutoff = Math.floor(Date.now() / 1000) - RETENTION;
    for (const [psn, series] of Object.entries(payload)) {
      const clean = {};
      for (const [portId, list] of Object.entries(series)) {
        const kept = list.filter(s => Array.isArray(s) && s[0] >= cutoff);
        if (kept.length) clean[portId] = kept;
      }
      if (Object.keys(clean).length) state.history.set(psn, clean);
    }
  } catch { /* 格式变了就当没有 */ }
}

// 从小程序复制的一整段文字里挑出 MCP 地址
export function extractMcp(text) {
  if (!text) return '';
  const match = text.match(/https:\/\/mcp\.thecandysign\.com\/\d{8,24}\/[A-Za-z0-9_-]{4,128}\/(mcp|sse)/);
  return match ? match[0] : text;
}

export async function backfillPort(dev, portId) {
  if (!dev.mcp) return;
  try {
    const result = await mcpCall(dev, 'get_port_stats', { port: portId + 1 });
    const samples = result.json?.samples || [];
    if (!samples.length) return;
    let series = state.history.get(dev.psn);
    if (!series) { series = {}; state.history.set(dev.psn, series); }
    const end = slotOf(Date.now()) - SLOT;
    const points = samples.map((s, i) => {
      const mV = num(s.voltage_mv);
      const mA = num(s.current_ma);
      const mW = s.power_mw != null ? num(s.power_mw) : (mV * mA / 1000);
      return [end - (samples.length - 1 - i) * SLOT, round2(mW / 1000), round3(mV / 1000), round3(mA / 1000)];
    });
    const existing = new Map((series[portId] || []).map(s => [s[0], s]));
    for (const point of points) existing.set(point[0], point);
    series[portId] = [...existing.values()].sort((a, b) => a[0] - b[0]);
  } catch { /* 补不上就算了 */ }
}
