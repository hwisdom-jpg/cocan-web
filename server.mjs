#!/usr/bin/env node
// 小电拼 Web 版的服务端。零依赖，只需要 Node 18 以上。
//
// 为什么要有这一层：浏览器直接 fetch 局域网里的 http://192.168.x.x/metrics.json 会被 CORS 拦掉
// （设备不返回 Access-Control-Allow-Origin），而且 https 页面请求 http 属于混合内容，也会被拦。
// 所以所有对设备的请求都由这个进程代发，页面只跟 127.0.0.1 说话。
//
// 职责：
//   1. 静态文件（public/）
//   2. 局域网读数代理：GET /metrics.json 和 GET /（取 window.__INFOZ）
//   3. MCP 中转：JSON-RPC over Streamable HTTP，会话由服务端维持，前端只发工具名和参数
//   4. 配置读写（config.json，MCP 地址含 token，只存在本机）
//   5. 网段扫描（先探 80 端口，只对通的发一次 HTTP，避免打满 ESP32 的 socket）

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const MCP_PROTOCOL = '2025-06-18';
const MCP_CLIENT = { name: 'CoCanWeb', version: '0.2.0' };

// ---------------------------------------------------------------- 配置

const DEFAULT_CONFIG = { port: 7788, theme: 'warm', devices: [] };

async function loadConfig() {
  try {
    const text = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(text);
    return { ...DEFAULT_CONFIG, ...parsed, devices: Array.isArray(parsed.devices) ? parsed.devices : [] };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(config) {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// ---------------------------------------------------------------- 局域网代理

const hostCache = new Map(); // 主机名 -> { ip, at }

// 设备地址统一成 `http://<host><path>`。主机名先自己解析成 IPv4：
// Node 的 fetch 对 .local 这种走 mDNS 的名字会做 Happy Eyeballs（先试 IPv6 再回落），
// 实测一次要 5 秒；而 dns.lookup 走系统解析器是毫秒级。解析结果缓存 60 秒。
async function resolveHost(rawHost) {
  const cleaned = String(rawHost || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!cleaned) return '';
  const [name, port] = cleaned.split(':');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return cleaned;

  const entry = hostCache.get(name);
  if (entry && Date.now() - entry.at < 60_000) {
    return port ? `${entry.ip}:${port}` : entry.ip;
  }
  try {
    const { address } = await dns.lookup(name, { family: 4 });
    hostCache.set(name, { ip: address, at: Date.now() });
    return port ? `${address}:${port}` : address;
  } catch {
    return cleaned; // 解析不了就交给 fetch 自己试，失败时报错更直观
  }
}

async function getText(host, p, timeout = 6000) {
  const resolved = await resolveHost(host);
  if (!resolved) throw new Error('设备地址为空');
  const res = await fetch(`http://${resolved}${p}`, {
    signal: AbortSignal.timeout(timeout),
    redirect: 'manual',
    headers: { 'User-Agent': 'CoCanWeb/0.2' },
  });
  if (!res.ok) throw new Error(`设备返回 HTTP ${res.status}`);
  return await res.text();
}

// 从首页 HTML 里抠 window.__INFOZ 的 JSON。跳过字符串里的括号，和 app 的做法一样。
function extractInfoz(html) {
  const marker = html.indexOf('window.__INFOZ');
  if (marker < 0) return null;
  const start = html.indexOf('{', marker);
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- MCP 中转

// psn -> { sessionId, protocolVersion, initializing, nextId }
const mcpSessions = new Map();

function sessionFor(psn) {
  if (!mcpSessions.has(psn)) {
    mcpSessions.set(psn, { sessionId: null, protocolVersion: null, initializing: null, nextId: 1 });
  }
  return mcpSessions.get(psn);
}

// 一整个 POST 往返。返回 { message, sessionID }。message 是 id 对得上的那条 JSON-RPC 响应。
async function mcpPost(endpoint, { method, params, sessionId, protocolVersion, id, timeout = 25000 }) {
  const headers = {
    'Content-Type': 'application/json',
    // 服务端可能回 JSON 也可能回 SSE，两个都接受
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion || MCP_PROTOCOL,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (id !== undefined) body.id = id;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual', // 地址里有 token，不跟着跳转
    });

    if (res.status === 401 || res.status === 403) throw new Error('MCP token 无效或已失效，请重新复制地址');
    if (res.status === 404) { const e = new Error('MCP 会话过期'); e.code = 404; throw e; }
    if (!res.ok) throw new Error(`MCP 服务返回 HTTP ${res.status}`);

    const newSessionId = res.headers.get('mcp-session-id') || null;
    if (id === undefined) {
      // 通知类请求没有响应体，读完丢掉
      await res.text().catch(() => {});
      return { message: null, sessionID: newSessionId };
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    let message;
    if (contentType.includes('text/event-stream')) {
      message = await readEventStream(res, id);
    } else {
      const text = await res.text();
      const trimmed = text.trim();
      // 有的服务端回 SSE 却没标 Content-Type
      if (trimmed.startsWith('data:') || trimmed.startsWith('event:') || trimmed.startsWith(':')) {
        message = parseSSEText(trimmed).map(parseJsonSafe).filter(Boolean).map(m => matchId(m, id)).find(Boolean) || null;
      } else {
        message = matchId(parseJsonSafe(trimmed), id);
      }
    }
    return { message, sessionID: newSessionId };
  } finally {
    clearTimeout(timer);
  }
}

// 边收边解析 SSE，读到 id 对得上的那条就返回，不等连接关闭
async function readEventStream(res, id) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  let matched = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') {
          if (dataLines.length) {
            const payload = dataLines.join('\n');
            dataLines = [];
            const found = matchId(parseJsonSafe(payload), id);
            if (found) { matched = found; return matched; }
          }
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }
    if (dataLines.length) {
      const found = matchId(parseJsonSafe(dataLines.join('\n')), id);
      if (found) matched = found;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return matched;
}

function parseSSEText(text) {
  const events = [];
  let dataLines = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      if (dataLines.length) { events.push(dataLines.join('\n')); dataLines = []; }
      continue;
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length) events.push(dataLines.join('\n'));
  return events;
}

function parseJsonSafe(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// 在一条消息（或批量数组）里找 id 对得上的响应，不拿别的消息顶替
function matchId(value, id) {
  if (!value) return null;
  const messages = Array.isArray(value) ? value : [value];
  const exact = messages.find(m => m && (m.id === id || m.id === String(id)));
  if (exact) return exact;
  return messages.find(m => m && m.id === null && m.error) || null;
}

async function ensureInitialized(endpoint, psn) {
  const session = sessionFor(psn);
  if (session.sessionId) return session;
  if (session.initializing) return await session.initializing;

  session.initializing = (async () => {
    const reply = await mcpPost(endpoint, {
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL,
        capabilities: {},
        clientInfo: MCP_CLIENT,
      },
      id: session.nextId++,
    });
    if (!reply.message) throw new Error('initialize 没有返回内容');
    if (reply.message.error) throw new Error(`握手失败：${reply.message.error.message || '未知错误'}`);
    const negotiated = reply.message.result?.protocolVersion || MCP_PROTOCOL;

    await mcpPost(endpoint, {
      method: 'notifications/initialized',
      sessionId: reply.sessionID,
      protocolVersion: negotiated,
    });

    session.protocolVersion = negotiated;
    session.sessionId = reply.sessionID;
    return session;
  })();

  try {
    return await session.initializing;
  } finally {
    session.initializing = null;
  }
}

// 调一次工具。返回 { text, json }。会话过期（404）时重新握手一次。
async function callTool(endpoint, psn, name, args = {}) {
  const once = async () => {
    const session = await ensureInitialized(endpoint, psn);
    const reply = await mcpPost(endpoint, {
      method: 'tools/call',
      params: { name, arguments: args },
      sessionId: session.sessionId,
      protocolVersion: session.protocolVersion,
      id: session.nextId++,
    });
    if (!reply.message) throw new Error(`${name} 没有收到响应`);
    if (reply.message.error) {
      const err = reply.message.error;
      throw new Error(`MCP 错误 ${err.code || ''}：${err.message || '未知'}`.trim());
    }
    const result = reply.message.result;
    if (!result) throw new Error(`${name} 缺少 result`);
    const text = (result.content || [])
      .filter(c => c && c.type === 'text')
      .map(c => c.text)
      .join('\n');
    if (result.isError) throw new Error(text || '工具返回错误');
    // 有些工具用 {"success": false} 表示失败
    const parsed = parseJsonSafe(text);
    if (parsed && (parsed.success === false || parsed.ok === false)) throw new Error(text || '工具返回失败');
    return { text, json: parsed };
  };

  try {
    return await once();
  } catch (error) {
    if (error.code === 404) {
      const session = sessionFor(psn);
      session.sessionId = null;
      session.protocolVersion = null;
      return await once();
    }
    throw error;
  }
}

// ---------------------------------------------------------------- 网段扫描

// 本机所有 IPv4 网段的候选地址（假定 /24）。
function candidateAddresses() {
  const result = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const prefix = addr.address.split('.').slice(0, 3).join('.');
      for (let i = 1; i <= 254; i++) result.push(`${prefix}.${i}`);
    }
  }
  return [...new Set(result)];
}

// 只探 80 端口通不通。对 ESP32 来说这比发 HTTP 轻得多。
function probePort(host, port = 80, timeout = 350) {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function scanNetwork() {
  const candidates = candidateAddresses();
  const open = [];
  const batch = 64;
  for (let i = 0; i < candidates.length; i += batch) {
    const slice = candidates.slice(i, i + batch);
    const results = await Promise.all(slice.map(ip => probePort(ip).then(ok => (ok ? ip : null))));
    for (const ip of results) if (ip) open.push(ip);
  }

  // 只对开了 80 端口的发一次请求，确认是不是小电拼
  const found = [];
  await Promise.all(open.map(async ip => {
    try {
      const html = await getText(ip, '/', 3000);
      const info = extractInfoz(html);
      if (info && (info.product_family || '').toUpperCase().startsWith('CP02')) {
        found.push({ host: ip, psn: info.psn, model: info.device_model, family: info.product_family });
      }
    } catch { /* 不是设备就算了 */ }
  }));
  return found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

// MCP 地址里带着令牌，等于设备控制权。前端其实用不到它（服务端按 psn 自己查），
// 所以对外只给一个哨兵值：既能当「已配置」的布尔用，又不会把令牌送到浏览器里。
const MCP_MASK = '***';

function maskConfig(config) {
  return {
    ...config,
    devices: (config.devices || []).map(d => ({ ...d, mcp: d.mcp ? MCP_MASK : '' })),
  };
}

// 前端原样把 *** 传回来，表示「这台的 MCP 地址不动」。这里把它换回真值。
function unmaskConfig(incoming, current) {
  const byPsn = new Map((current.devices || []).map(d => [d.psn, d]));
  return {
    ...incoming,
    devices: (incoming.devices || []).map(d => {
      if (d.mcp !== MCP_MASK) return d;
      return { ...d, mcp: byPsn.get(d.psn)?.mcp || '' };
    }),
  };
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  // 防目录穿越
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('Forbidden'); return; }
  if (!existsSync(file)) { res.writeHead(404).end('Not found'); return; }
  const data = await readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const { pathname, searchParams } = url;

  if (!pathname.startsWith('/api/')) return await serveStatic(res, pathname);

  // 配置
  if (pathname === '/api/config') {
    if (req.method === 'GET') return sendJson(res, 200, maskConfig(await loadConfig()));
    if (req.method === 'POST') {
      const body = await readBody(req);
      const current = await loadConfig();
      const next = unmaskConfig({ ...current, ...body }, current);
      await saveConfig(next);
      return sendJson(res, 200, maskConfig(next));
    }
  }

  // 局域网读数
  if (pathname === '/api/lan') {
    const host = searchParams.get('host');
    try {
      const text = await getText(host, '/metrics.json');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(text);
    } catch (error) {
      return sendJson(res, 502, { error: describeError(error) });
    }
  }

  // 设备信息
  if (pathname === '/api/info') {
    const host = searchParams.get('host');
    try {
      const html = await getText(host, '/');
      const info = extractInfoz(html);
      if (!info) return sendJson(res, 502, { error: '首页里没有 window.__INFOZ' });
      return sendJson(res, 200, info);
    } catch (error) {
      return sendJson(res, 502, { error: describeError(error) });
    }
  }

  // 扫描
  if (pathname === '/api/scan') {
    try {
      return sendJson(res, 200, { devices: await scanNetwork() });
    } catch (error) {
      return sendJson(res, 500, { error: describeError(error) });
    }
  }

  // MCP：单个工具调用
  if (pathname === '/api/mcp' && req.method === 'POST') {
    const body = await readBody(req);
    const config = await loadConfig();
    const device = config.devices.find(d => d.psn === body.psn);
    if (!device || !device.mcp) return sendJson(res, 400, { error: '这台设备没有配置 MCP 地址' });
    try {
      const result = await callTool(device.mcp, device.psn, body.tool, body.arguments || {});
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 502, { error: describeError(error) });
    }
  }

  // MCP：一次读多个工具（前端刷新详情时用，省掉来回）
  if (pathname === '/api/mcp/batch' && req.method === 'POST') {
    const body = await readBody(req);
    const config = await loadConfig();
    const device = config.devices.find(d => d.psn === body.psn);
    if (!device || !device.mcp) return sendJson(res, 400, { error: '这台设备没有配置 MCP 地址' });
    const out = {};
    for (const call of body.calls || []) {
      try {
        out[call.tool] = await callTool(device.mcp, device.psn, call.tool, call.arguments || {});
      } catch (error) {
        out[call.tool] = { error: describeError(error) };
      }
    }
    return sendJson(res, 200, out);
  }

  return sendJson(res, 404, { error: '没有这个接口' });
}

// 错误信息里可能带 MCP 地址（含 token），先脱敏
function describeError(error) {
  let text = String(error?.message || error || '未知错误');
  text = text.replace(/https:\/\/mcp\.thecandysign\.com\/(\d{8,24})\/[A-Za-z0-9_-]{4,128}\/(mcp|sse)/g, 'https://mcp.thecandysign.com/$1/••••/$2');
  if (error?.name === 'AbortError' || /aborted/i.test(text)) return '请求超时（设备没响应）';
  if (/fetch failed/i.test(text)) return '连不上设备，检查地址和网络';
  return text;
}

// ---------------------------------------------------------------- 启动

const config = await loadConfig();
const PORT = Number(process.env.PORT || config.port || 7788);
// 默认只听本机。想让手机也能打开，用 --lan 启动（会把配置文件交给局域网可见的服务）
const HOST = process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1';

createServer((req, res) => {
  handle(req, res).catch(error => {
    if (!res.headersSent) sendJson(res, 500, { error: describeError(error) });
    else res.end();
  });
}).listen(PORT, HOST, async () => {
  await mkdir(PUBLIC, { recursive: true });
  console.log('');
  console.log('  小电拼 Web 版已启动');
  console.log(`  → http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    const lan = Object.values(os.networkInterfaces()).flat()
      .filter(a => a && a.family === 'IPv4' && !a.internal)
      .map(a => `http://${a.address}:${PORT}`);
    if (lan.length) console.log(`  局域网也可以访问（手机同网段可用）：${lan.join('  ')}`);
  }
  if (config.devices.length) {
    console.log(`  已配置 ${config.devices.length} 台设备：${config.devices.map(d => d.name || d.psn).join('、')}`);
  } else {
    console.log('  还没有设备，打开页面点「添加设备」');
  }
  console.log('');
});
