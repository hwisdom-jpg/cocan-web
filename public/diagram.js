// 功率分布图：五张端口卡排在顶上，每个口一根线弯到右下角机身上对应的槽位。
// 几何照 macOS 版 CoCanBar/PowerDiagram.swift（chipScale 1.05、chargerScale 1.9、线宽 5），
// 也就是 KangCharge 主窗口那张官方 App 的图。用 SVG 画，整块随卡片宽度等比例缩放。
import {
  escapeHtml, portName, portState, shortProtocol, totalWatts, wattsText,
} from './core.js';

const VIEW_W = 620;
const VIEW_H = 352;

const CHIP_W = 100.8;   // 96 × 1.05
const CHIP_GAP = 10.5;  // 10 × 1.05
const CHIP_TOP = 15.5;
const CHIP_BOX_H = 43;
const CABLE_START_Y = 61;

const CHARGER_W = 212.8;  // 112 × 1.9
const CHARGER_H = 110.2;  // 58  × 1.9
const CHARGER_X = VIEW_W - CHARGER_W - 4;
const CHARGER_Y = VIEW_H - CHARGER_H - 42;
const SLOT_Y = CHARGER_Y + 38 * 1.9;

// 机身上每个口的位置：局部坐标从 x=12 起排，A 口 14 宽、C 口 10 宽，间距 6
function slotCenters(types) {
  let x = 12;
  return types.map(type => {
    const width = type === 'A' ? 14 : 10;
    const center = { x: CHARGER_X + (x + width / 2) * 1.9, width: width * 1.9 };
    x += width + 6;
    return center;
  });
}

function cablePath(x1, y1, x2, y2) {
  const dy = y2 - y1;
  return `M${x1.toFixed(1)},${y1.toFixed(1)} C${x1.toFixed(1)},${(y1 + dy * 0.62).toFixed(1)} `
    + `${x2.toFixed(1)},${(y2 - dy * 0.55).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

// 端口卡里的三行：功率、分隔线下的协议（关着时显示该口上限）
function chipText(port, limit) {
  const state = portState(port);
  if (state === 'closed') return { power: 'OFF', detail: limit ? `${limit}W` : '—', on: false };
  if (state === 'empty') return { power: '—', detail: limit ? `${limit}W` : '—', on: false };
  const detail = port.attached
    ? (shortProtocol(port) || (state === 'charging' ? '—' : '未取电'))
    : '空闲';
  return { power: `${wattsText(port.watts)}W`, detail, on: true };
}

export function powerDiagram(dev) {
  const ports = dev.metrics?.ports || [];
  const facts = dev.facts?.ports || [];
  // 还没读到机器参数时先按 CP-02S 的出厂上限显示，别把「—」当成没有上限
  const limits = facts.length
    ? facts.map(p => Number(p.power) || 0)
    : [60, 140, 140, 140, 140];
  const types = (ports.length
    ? ports.map((p, index) => p.portType || (index === 0 ? 'A' : 'C'))
    : (facts.length ? facts.map(f => f.connector_type || 'C') : ['A', 'C', 'C', 'C', 'C']));

  const count = Math.max(types.length, 1);
  const chipW = Math.min((VIEW_W - CHIP_GAP * (count - 1)) / count, CHIP_W);
  const rowWidth = chipW * count + CHIP_GAP * (count - 1);
  const rowLeft = (VIEW_W - rowWidth) / 2;
  const slots = slotCenters(types);

  const uid = String(dev.psn || 'dev').replace(/[^\w-]/g, '');
  const live = !!dev.online;

  // 线：开着是主题色（充电时不透明，通了电但没在取电时淡一点），关着是灰的
  const cables = types.map((_, index) => {
    const port = ports[index];
    const state = portState(port);
    const x1 = rowLeft + index * (chipW + CHIP_GAP) + chipW / 2;
    const target = slots[index] || slots[slots.length - 1] || { x: CHARGER_X + 40 };
    const path = cablePath(x1, CABLE_START_Y, target.x, SLOT_Y);
    const className = state === 'closed' || state === 'empty' ? 'pd-cable is-off' : 'pd-cable is-on';
    const dash = live && state === 'charging'
      ? `<path class="pd-cable-dash" d="${path}"/>`
      : '';
    return `<path class="${className}" d="${path}"/>${dash}`;
  }).join('');

  // 端口卡
  const chips = types.map((_, index) => {
    const port = ports[index];
    const text = chipText(port, limits[index]);
    const x = rowLeft + index * (chipW + CHIP_GAP);
    const cx = x + chipW / 2;
    const tone = text.on && live ? 'is-on' : 'is-off';
    const label = index === 0 ? 'USB-A' : portName(dev, index);
    return `
      <g class="pd-chip">
        <text class="pd-chip-name ${tone}" x="${cx.toFixed(1)}" y="12">${escapeHtml(label)}</text>
        <rect class="pd-chip-box ${tone}" x="${x.toFixed(1)}" y="${CHIP_TOP}" width="${chipW.toFixed(1)}"
              height="${CHIP_BOX_H}" rx="7.35"/>
        <text class="pd-chip-power ${tone}" x="${cx.toFixed(1)}" y="34">${escapeHtml(text.power)}</text>
        <line class="pd-chip-rule ${tone}" x1="${(x + 7).toFixed(1)}" y1="40.5"
              x2="${(x + chipW - 7).toFixed(1)}" y2="40.5"/>
        <text class="pd-chip-detail ${tone}" x="${cx.toFixed(1)}" y="52">${escapeHtml(text.detail)}</text>
      </g>`;
  }).join('');

  // 机身上的槽位（A 口宽一点、圆角小一点）
  const slotsSvg = types.map((type, index) => {
    const slot = slots[index];
    if (!slot) return '';
    const h = 9.5;
    return `<rect class="pd-slot" x="${(slot.x - slot.width / 2).toFixed(1)}"
            y="${(SLOT_Y - h / 2).toFixed(1)}" width="${slot.width.toFixed(1)}" height="${h}"
            rx="${type === 'A' ? 1.9 : 4.75}"/>`;
  }).join('');

  const total = totalWatts(dev);
  const budget = Number(dev.facts?.max_power_budget) || 160;
  const used = budget > 0 ? Math.round((total / budget) * 100) : 0;

  return `
    <div class="power-diagram${live ? '' : ' is-stale'}">
      <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMid meet"
           role="img" aria-label="五路端口的功率分布">
        <defs>
          <linearGradient id="pd-body-${uid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style="stop-color:var(--device-top)"/>
            <stop offset="100%" style="stop-color:var(--device-bottom)"/>
          </linearGradient>
          <filter id="pd-shadow-${uid}" x="-40%" y="-40%" width="180%" height="200%">
            <feDropShadow dx="0" dy="7" stdDeviation="6" flood-color="#000" flood-opacity="0.16"/>
          </filter>
        </defs>

        <g class="pd-cables">${cables}</g>

        <g class="pd-charger" filter="url(#pd-shadow-${uid})">
          <rect class="pd-body" x="${CHARGER_X}" y="${CHARGER_Y}" width="${CHARGER_W}"
                height="${CHARGER_H}" rx="20.9" fill="url(#pd-body-${uid})"/>
          <rect class="pd-screen" x="${CHARGER_X + 22.8}" y="${CHARGER_Y + 22.8}" width="57"
                height="24.7" rx="5.7"/>
          <text class="pd-screen-text" x="${CHARGER_X + 22.8 + 28.5}" y="${CHARGER_Y + 39}">
            ${live ? `${Math.round(total)}W` : '—'}
          </text>
          ${slotsSvg}
        </g>

        <g class="pd-chips">${chips}</g>

        <text class="pd-caption" x="0" y="300">实时充电功率</text>
        <text class="pd-total" x="0" y="344">${live ? wattsText(total) : '—'}<tspan
              class="pd-total-unit" dx="3">W</tspan></text>

        <g class="pd-budget">
          <rect class="pd-budget-box" x="520" y="296" width="92" height="52" rx="7"/>
          <text class="pd-budget-total" x="566" y="317">${budget}W</text>
          <line class="pd-budget-rule" x1="520" y1="323" x2="612" y2="323"/>
          <text class="pd-budget-note" x="566" y="339">已使用 ${used}%</text>
        </g>
      </svg>
    </div>`;
}
