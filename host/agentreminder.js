#!/usr/bin/env node
/*
 * AgentReminder host: one zero-dependency file that is
 *   - the hook entry point called by Claude Code / Codex / dsh   (`hook ...`)
 *   - the background daemon that talks to the ESP32-S3           (`daemon`)
 *   - a small CLI                                                 (`status`, `test`, `wifi`, `install` ...)
 *
 * Device transports (both optional, used at the same time):
 *   USB  : /dev/cu.usbmodem* (macOS) or /dev/ttyACM* (Linux), newline-delimited JSON
 *   Wi-Fi: TCP client to <host>:47322 (default agentreminder.local), newline-delimited JSON
 * See docs/protocol.md.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const tty = require('tty');
const { StringDecoder } = require('string_decoder');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const VERSION = '0.3.0';
const HOME_DIR = process.env.AGENTREMINDER_HOME || path.join(os.homedir(), '.agentreminder');
const CONFIG_PATH = path.join(HOME_DIR, 'config.json');
const LOG_PATH = path.join(HOME_DIR, 'daemon.log');

const DEFAULT_CONFIG = {
  httpPort: 47321,              // daemon <-> hook (127.0.0.1 only)
  approvalTimeoutSec: 90,       // after this the agent falls back to its own prompt
  usb: { enabled: true, patterns: ['^cu\\.usbmodem', '^ttyACM'] },
  wifi: { enabled: false, hosts: ['agentreminder.local'], port: 47322 },
  notify: { stop: true, idle: true },
};

function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { /* defaults */ }
  return {
    ...DEFAULT_CONFIG, ...user,
    usb: { ...DEFAULT_CONFIG.usb, ...(user.usb || {}) },
    wifi: { ...DEFAULT_CONFIG.wifi, ...(user.wifi || {}) },
    notify: { ...DEFAULT_CONFIG.notify, ...(user.notify || {}) },
  };
}

function ensureHome() { fs.mkdirSync(HOME_DIR, { recursive: true }); }

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  if (process.env.AGENTREMINDER_FOREGROUND) process.stderr.write(line);
  try { ensureHome(); fs.appendFileSync(LOG_PATH, line); } catch (_) { /* ignore */ }
}

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/* ------------------------------------------------------------------ */
/* Device link: one NDJSON duplex (serial port or TCP socket)          */
/* ------------------------------------------------------------------ */

class Link {
  constructor(kind, name, writeFn, closeFn, hub, onClosed) {
    this.kind = kind; this.name = name; this.write = writeFn; this.closeFn = closeFn;
    this.hub = hub; this.onClosed = onClosed || (() => {});
    this.decoder = new StringDecoder('utf8');
    this.buf = ''; this.ready = false; this.info = null; this.closed = false;
  }
  feed(chunk) {
    this.buf += this.decoder.write(Buffer.from(chunk));
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line || line[0] !== '{') continue;          // ignore boot logs etc.
      let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
      this.hub.onMessage(this, msg);
    }
    if (this.buf.length > 65536) this.buf = '';
  }
  send(obj) {
    if (this.closed) return;
    try { this.write(JSON.stringify(obj) + '\n'); } catch (e) { log('write fail', this.name, e.message); this.close(); }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.closeFn(); } catch (_) { /* ignore */ }
    this.hub.onClose(this);
    this.onClosed(this);
  }
}

class Hub {
  constructor(cfg) {
    this.cfg = cfg;
    this.links = new Set();
    this.pending = new Map();   // id -> { payload, resolve, timer }
  }
  connectedLinks() { return [...this.links].filter(l => l.ready); }
  readyLinks() {
    const paired = this.cfg.usb?.pairedDeviceId;
    return this.connectedLinks().filter(l => !paired || (l.kind === 'usb' && l.info.id === paired));
  }
  broadcast(obj) { for (const l of this.readyLinks()) l.send(obj); }

  add(link) {
    this.links.add(link);
    log('link open', link.kind, link.name);
    link.send({ t: 'hello', host: os.hostname(), v: VERSION });
    // A port that never answers hello is not our device.
    link.helloTimer = setTimeout(() => { if (!link.ready) { log('no hello from', link.name); link.close(); } }, 6000);
  }
  onClose(link) {
    clearTimeout(link.helloTimer);
    this.links.delete(link);
    log('link closed', link.kind, link.name);
    for (const [id, pending] of this.pending) {
      if (pending.target ? pending.target === link : !this.readyLinks().length) this.cancel(id, 'device-disconnected');
    }
  }
  onMessage(link, msg) {
    if (!msg || typeof msg !== 'object') return;
    link.lastSeen = Date.now();
    switch (msg.t) {
      case 'hello':
        if (msg.app !== 'agentreminder') return;
        link.ready = true; link.info = msg; clearTimeout(link.helloTimer);
        log('device ready', link.kind, link.name, msg);
        if (this.readyLinks().includes(link)) {
          for (const p of this.pending.values()) {
            if (!p.target) link.send({ ...p.payload, timeout: Math.max(1, Math.ceil((p.deadline - Date.now()) / 1000)) });
          }
        }
        break;
      case 'decision':
        if (link.ready && this.pending.has(msg.id) &&
            (this.pending.get(msg.id).target ? this.pending.get(msg.id).target === link : this.readyLinks().includes(link)) &&
            ['allow', 'deny', 'skip'].includes(msg.decision))
          this.resolve(msg.id, msg.decision, `${link.kind}:${link.name}`);
        break;
      case 'pong': case 'ack': break;
      case 'log': log('device:', msg.msg); break;
      default: log('unknown msg', msg);
    }
  }

  /** Ask connected devices. promise -> { decision: 'allow'|'deny'|null } (null = let the agent ask normally). */
  requestApproval(info, timeoutMs, target = null) {
    const id = crypto.randomUUID();
    if (target ? !target.ready || target.closed : this.readyLinks().length === 0) {
      return { id, promise: Promise.resolve({ decision: null, reason: 'no-device' }) };
    }
    const promise = new Promise(resolve => {
      const payload = { ...info, t: 'approval', id, ts: Date.now(), timeout: Math.round(timeoutMs / 1000) };
      const timer = setTimeout(() => this.resolve(id, null, 'timeout'), timeoutMs);
      this.pending.set(id, { payload, resolve, timer, target, deadline: Date.now() + timeoutMs });
      if (target) target.send(payload); else this.broadcast(payload);
      log('approval ->', id, info.agent, info.title);
    });
    return { id, promise };
  }
  resolve(id, decision, by) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    const d = decision === 'allow' || decision === 'deny' ? decision : null;
    const result = { t: 'resolved', id, decision: d || 'skip', by };
    if (p.target) p.target.send(result); else this.broadcast(result);
    log('approval <-', id, d || 'skip', by);
    p.resolve({ decision: d, reason: by });
  }
  cancel(id, why) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id); clearTimeout(p.timer);
    const result = { t: 'cancel', id, why };
    if (p.target) p.target.send(result); else this.broadcast(result);
    log('approval cancelled', id, why);
    p.resolve({ decision: null, reason: why });
  }
  notify(info) {
    const payload = { ...info, t: 'notify', id: crypto.randomUUID(), ts: Date.now() };
    this.broadcast(payload);
    log('notify ->', info.agent, info.kind, info.title);
    return this.readyLinks().length;
  }
}

/* ---------------------------- USB serial ---------------------------- */

function startUsb(hub, cfg) {
  if (!cfg.usb.enabled) return;
  const open = new Map();                // path -> Link
  const cooldown = new Map();            // path -> until (ms)
  const res = cfg.usb.patterns.map(p => new RegExp(p));

  const scan = () => {
    let names = [];
    try { names = fs.readdirSync('/dev'); } catch (_) { return; }
    for (const n of names) {
      if (!res.some(r => r.test(n))) continue;
      const p = '/dev/' + n;
      if (open.has(p) || (cooldown.get(p) || 0) > Date.now()) continue;
      openPort(p);
    }
  };

  const openPort = (p) => {
    try {
      // raw mode, no echo; baud is ignored by USB CDC but set anyway.
      const flag = process.platform === 'darwin' ? '-f' : '-F';
      execFileSync('stty', [flag, p, '115200', 'raw', '-echo', '-echoe', '-echok', '-hupcl', 'clocal'], { stdio: 'ignore', timeout: 1500 });
    } catch (e) { cooldown.set(p, Date.now() + 15000); return; }
    let fd;
    try { fd = fs.openSync(p, fs.constants.O_RDWR | fs.constants.O_NOCTTY); }
    catch (e) { cooldown.set(p, Date.now() + 15000); return; }
    // tty.ReadStream gives event-driven, non-blocking reads on a serial fd.
    const rs = new tty.ReadStream(fd);
    try { rs.setRawMode(true); } catch (_) { /* stty already did it */ }
    const write = (str) => {
      const buf = Buffer.from(str);
      let off = 0, tries = 0;
      while (off < buf.length) {
        try { off += fs.writeSync(fd, buf, off); }
        catch (e) { if (e.code === 'EAGAIN' && tries++ < 200) continue; throw e; }
      }
    };
    const link = new Link('usb', path.basename(p), write,
      () => { open.delete(p); rs.destroy(); },
      hub,
      (l) => { if (!l.ready) cooldown.set(p, Date.now() + 30000); });
    rs.on('data', d => link.feed(d));
    rs.on('error', () => link.close());
    rs.on('end', () => link.close());
    rs.on('close', () => link.close());
    open.set(p, link);
    hub.add(link);
  };

  scan();
  setInterval(scan, 3000).unref?.();
  // Detect unplug: device file disappears.
  setInterval(() => { for (const [p, l] of open) if (!fs.existsSync(p)) l.close(); }, 2000).unref?.();
}

/* ----------------------------- Wi-Fi TCP ---------------------------- */

function startWifi(hub, cfg) {
  if (!cfg.wifi.enabled) return;
  for (const host of cfg.wifi.hosts) {
    let link = null, connecting = false;
    const connect = () => {
      if (link || connecting) return;
      connecting = true;
      const sock = net.connect({ host, port: cfg.wifi.port, timeout: 4000 });
      sock.setNoDelay(true);
      sock.once('connect', () => {
        connecting = false;
        sock.setTimeout(0);
        sock.setKeepAlive(true, 5000);
        link = new Link('wifi', `${host}:${cfg.wifi.port}`, s => sock.write(s), () => sock.destroy(), hub,
          () => { link = null; });
        sock.on('data', d => link && link.feed(d));
        hub.add(link);
      });
      const fail = () => { connecting = false; sock.destroy(); if (link) link.close(); };
      sock.once('timeout', fail);
      sock.once('error', fail);
      sock.once('close', fail);
    };
    connect();
    setInterval(connect, 5000).unref?.();
  }
}

/* ------------------------------ Daemon ------------------------------ */

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
  });
}

function runDaemon() {
  ensureHome();
  const cfg = loadConfig();
  const hub = new Hub(cfg);

  const server = http.createServer(async (req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (req.headers.origin) return reply(403, { error: 'browser requests are not supported' });
      if (req.method === 'GET' && req.url === '/status') {
        return reply(200, {
          version: VERSION, pid: process.pid, pairedDeviceId: cfg.usb.pairedDeviceId || null,
          devices: hub.readyLinks().map(l => ({ kind: l.kind, name: l.name, info: l.info })),
          pending: [...hub.pending.values()].map(p => ({ id: p.payload.id, agent: p.payload.agent, title: p.payload.title })),
        });
      }
      if (req.method !== 'POST') return reply(404, { error: 'not found' });
      const body = await readBody(req);
      if (req.url === '/pair') {
        const usb = hub.connectedLinks().filter(link => link.kind === 'usb' && link.info.id);
        if (!usb.length) return reply(409, { error: 'no-usb' });
        if (usb.length !== 1) return reply(409, { error: 'multiple-usb' });
        const target = usb[0];
        const deviceId = target.info.id;
        if (cfg.usb.pairedDeviceId === deviceId) return reply(200, { deviceId });
        if (hub.pending.size) return reply(409, { error: 'approval-pending' });
        const { id, promise } = hub.requestApproval({
          agent: 'setup', conversation: 'AgentReminder', title: '配对这台电脑',
          detail: `主机：${clip(os.hostname(), 100)}\n请按右键同意配对，或按左键拒绝。`,
        }, 60000, target);
        res.on('close', () => { if (!res.writableEnded) hub.cancel(id, 'pairing-client-gone'); });
        const result = await promise;
        if (result.decision !== 'allow') return reply(409, { error: result.decision || result.reason });
        if (target.closed) return reply(409, { error: 'device-disconnected' });
        const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
        config.usb = { ...config.usb, pairedDeviceId: deviceId };
        const tmp = `${CONFIG_PATH}.${crypto.randomUUID()}.tmp`;
        try {
          fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
          fs.renameSync(tmp, CONFIG_PATH);
        } finally { fs.rmSync(tmp, { force: true }); }
        cfg.usb.pairedDeviceId = deviceId;
        return reply(200, { deviceId });
      }
      if (req.url === '/approval') {
        if ([...hub.pending.values()].some(pending => pending.target)) {
          return reply(200, { decision: null, reason: 'pairing-in-progress' });
        }
        const timeoutMs = Math.max(5, Math.min(body.timeoutSec || cfg.approvalTimeoutSec, 3600)) * 1000;
        const { id, promise } = hub.requestApproval(body.info || {}, timeoutMs);
        // If the hook process dies (agent cancelled / user hit Esc), clear the card on the device.
        res.on('close', () => { if (!res.writableEnded) hub.cancel(id, 'hook-gone'); });
        return reply(200, await promise);
      }
      if (req.url === '/notify') return reply(200, { delivered: hub.notify(body.info || {}) });
      if (req.url === '/raw') { hub.broadcast(body); return reply(200, { delivered: hub.readyLinks().length }); }
      if (req.url === '/shutdown') { reply(200, { ok: true }); log('shutdown'); setTimeout(() => process.exit(0), 100); return; }
      return reply(404, { error: 'not found' });
    } catch (e) { log('http error', e.stack || e.message); reply(500, { error: e.message }); }
  });

  server.on('error', (e) => { log('http listen error', e.message); process.exit(e.code === 'EADDRINUSE' ? 0 : 1); });
  server.listen(cfg.httpPort, '127.0.0.1', () => {
    log(`daemon ${VERSION} listening on 127.0.0.1:${cfg.httpPort} pid=${process.pid}`);
    try { fs.writeFileSync(path.join(HOME_DIR, 'daemon.pid'), String(process.pid)); } catch (_) { /* ignore */ }
  });
  startUsb(hub, cfg);
  startWifi(hub, cfg);
  // Heartbeat: lets the device show link status and lets us notice dead links.
  setInterval(() => {
    for (const link of hub.connectedLinks()) {
      if (Date.now() - link.lastSeen > 40000) link.close();
      else link.send({ t: 'ping', ts: Date.now() });
    }
  }, 15000);
  process.on('SIGTERM', () => process.exit(0));
}

/* --------------------------- HTTP client ---------------------------- */

function call(method, urlPath, body, timeoutMs) {
  const cfg = loadConfig();
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: cfg.httpPort, method, path: urlPath,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      timeout: timeoutMs,
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function spawnDaemon() {
  ensureHome();
  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [__filename, 'daemon'], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.closeSync(out);
}

async function ensureDaemon() {
  try { await call('GET', '/status', null, 800); return true; } catch (_) { /* start it */ }
  spawnDaemon();
  // Give USB/Wi-Fi a moment to come up so the very first request can reach the device.
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const s = await call('GET', '/status', null, 500);
      if (s.devices.length || i > 15) return true;
    } catch (_) { /* not yet */ }
  }
  return false;
}

async function pairDevice() {
  let status = await call('GET', '/status', null, 800).catch(() => null);
  if (status && status.version !== VERSION) {
    let localPid;
    try { localPid = Number(fs.readFileSync(path.join(HOME_DIR, 'daemon.pid'), 'utf8')); } catch (_) { /* remote daemon */ }
    if (!localPid || localPid !== status.pid || !Array.isArray(status.pending)) {
      throw new Error('请在设备连接的电脑更新 AgentReminder 守护进程后再配对。');
    }
    if (status.pending.length) throw new Error('请先处理当前审批，再重新运行配对。');
    const shutdown = await call('POST', '/shutdown', {}, 1000);
    if (!shutdown.ok) throw new Error('无法重启本机 AgentReminder 守护进程。');
    for (let attempt = 0; attempt < 20 && status; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      status = await call('GET', '/status', null, 500).catch(() => null);
    }
    if (status) throw new Error('旧版守护进程仍在运行，请停止后重试。');
  }
  if (!(await ensureDaemon())) throw new Error(`无法启动 AgentReminder。日志：${LOG_PATH}`);
  console.log('请连接一台已烧录 AgentReminder 的 USB 设备。出现配对卡片后，按右键同意。');
  let result;
  for (let attempt = 0; attempt < 40; attempt++) {
    result = await call('POST', '/pair', {}, 65000);
    if (result.error !== 'no-usb') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (result?.deviceId) {
    console.log(`USB 配对完成：${result.deviceId}`);
    return;
  }
  const message = {
    'no-usb': '未收到设备握手。请检查 USB 数据线、设备固件和本机串口权限，再运行 pair。',
    'multiple-usb': '检测到多个设备。请只保留要配对的设备，再运行 pair。',
    'approval-pending': '有待处理的审批。请结束后再配对。',
    'device-disconnected': '设备已断开，请重新连接再配对。',
  };
  throw new Error(message[result?.error] || `配对未完成：${result?.error || '未知错误'}`);
}

/* ------------------------------- Hook ------------------------------- */

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let b = '';
    process.stdin.on('data', c => b += c);
    process.stdin.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
    setTimeout(() => resolve({}), 3000).unref();
  });
}

/* Read only the current session's title, never forward its transcript. */
function transcriptTitle(file, sessionId) {
  if (!file) return '';
  try {
    const index = path.join(path.dirname(file), 'sessions-index.json');
    if (fs.statSync(index).size < 2e6) {
      const entry = JSON.parse(fs.readFileSync(index, 'utf8')).entries?.find(e => e.sessionId === sessionId);
      if (entry?.customTitle || entry?.summary) return entry.customTitle || entry.summary;
    }
  } catch (_) { /* no index: inspect bounded transcript slices */ }
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const read = (start, length) => { const b = Buffer.alloc(length); fs.readSync(fd, b, 0, length, start); return b.toString('utf8'); };
    const head = read(0, Math.min(size, 32768));
    const tail = size > 32768 ? read(Math.max(0, size - 65536), Math.min(size, 65536)) : '';
    let named = '', firstPrompt = '';
    for (const line of (head + '\n' + tail).split('\n')) {
      let row; try { row = JSON.parse(line); } catch (_) { continue; }
      if (row.type === 'custom-title' && typeof row.customTitle === 'string') named = row.customTitle;
      if (row.type === 'session_meta') named = row.payload?.title || named;
      if (!firstPrompt && row.type === 'user' && !row.isMeta) {
        const content = row.message?.content;
        const txt = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '';
        if (txt && !txt.trimStart().startsWith('<')) firstPrompt = txt;
      }
    }
    return named || firstPrompt;
  } catch (_) { return ''; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function codexTitle(sessionId) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId || '')) return '';
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    const dbs = fs.readdirSync(home).filter(f => /^state_\d+\.sqlite$/.test(f)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    for (const db of dbs) {
      // Prefer the desktop's renamed chat name, then its generated title.
      const query = `SELECT COALESCE(NULLIF(name, ''), title) FROM threads WHERE id='${sessionId}' LIMIT 1;`;
      const bin = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3';
      try {
        const result = execFileSync(bin, ['-readonly', path.join(home, db), query], { encoding: 'utf8', timeout: 400, maxBuffer: 32768, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (result) return result;
      } catch (_) {
        // Older Codex databases do not have the optional `name` column.
        try {
          const result = execFileSync(bin, ['-readonly', path.join(home, db), `SELECT title FROM threads WHERE id='${sessionId}' LIMIT 1;`], { encoding: 'utf8', timeout: 400, maxBuffer: 32768, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          if (result) return result;
        } catch (_) { /* unavailable: use hook/transcript metadata */ }
      }
    }
  } catch (_) { /* optional local metadata */ }
  return '';
}

function describeSession(input, agent) {
  const sessionId = input.session_id || input.thread_id || '';
  const explicit = input.conversation_title || input.session_title || input.thread_title || input.session_name;
  const title = explicit || (agent === 'codex' ? codexTitle(sessionId) : '') || transcriptTitle(input.transcript_path, sessionId);
  return { sessionId: clip(sessionId, 128), conversation: clip(String(title || (sessionId ? `对话 ${sessionId.slice(0, 8)}` : '未命名对话')).replace(/\s+/g, ' ').trim(), 100) };
}

function describeTool(input) {
  const name = input.tool_name || 'tool';
  const ti = input.tool_input || {};
  let detail = ti.command || ti.file_path || ti.path || ti.url || ti.pattern || ti.description || '';
  if (!detail && Object.keys(ti).length) detail = JSON.stringify(ti);
  const reason = input.permission_message || input.approval_message || ti.description || input.message || '';
  return { title: name, detail: clip(detail, 900), reason: clip(reason, 300) };
}

function arg(argv, name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

async function runHook(argv) {
  const agent = arg(argv, 'agent', 'agent');          // claude | codex | dsh
  const event = arg(argv, 'event', 'permission');     // permission | pretool | stop | notification
  const input = await readStdin();
  const cfg = loadConfig();
  const project = clip(path.basename(input.cwd || process.cwd()), 80);
  const session = describeSession(input, agent);
  const out = (obj) => { if (obj) process.stdout.write(JSON.stringify(obj)); };

  try {
    if (event === 'permission' || event === 'pretool') {
      if (!(await ensureDaemon())) return;
      const { title, detail, reason } = describeTool(input);
      const timeoutSec = cfg.approvalTimeoutSec;
      const r = await call('POST', '/approval', { timeoutSec, info: { agent, project, ...session, title, detail, reason } }, (timeoutSec + 10) * 1000);
      if (!r.decision) return;                         // no device / timeout / "use terminal": normal flow
      const msg = r.decision === 'deny' ? 'Denied from AgentReminder device' : 'Approved from AgentReminder device';
      if (event === 'permission') {
        out({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
          decision: r.decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: msg } } });
      } else {
        out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: msg } });
      }
      return;
    }

    if (event === 'stop') {
      if (!cfg.notify.stop || input.stop_hook_active) return;
      if (!(await ensureDaemon())) return;
      await call('POST', '/notify', { info: { agent, project, ...session, kind: 'done', title: '任务完成',
        detail: clip(input.last_assistant_message || '', 400) } }, 3000);
      return;                                          // never block stopping
    }

    if (event === 'notification') {
      const type = input.notification_type || input.matcher || '';
      if (type === 'permission_prompt') return;        // covered by PermissionRequest
      if (!cfg.notify.idle) return;
      if (!(await ensureDaemon())) return;
      await call('POST', '/notify', { info: { agent, project, ...session, kind: type === 'idle_prompt' ? 'idle' : 'info',
        title: type === 'idle_prompt' ? '等待你的输入' : (input.title || '通知'), detail: clip(input.message || '', 400) } }, 3000);
    }
  } catch (e) {
    log('hook error', agent, event, e.message);       // never break the agent
  }
}

/* -------------------------------- CLI ------------------------------- */

function mergeHooks(file, hooks) {
  let cur = {};
  if (fs.existsSync(file)) cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) throw new Error('Invalid settings: ' + file);
  cur.hooks = cur.hooks || {};
  for (const [ev, groups] of Object.entries(hooks)) {
    const keep = (cur.hooks[ev] || []).filter(g => !JSON.stringify(g).includes('agentreminder.js'));
    cur.hooks[ev] = [...keep, ...groups];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n');
  return file;
}

function shellQuote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
function hookCmd(agent, event) { return `${shellQuote(process.execPath)} ${shellQuote(__filename)} hook --agent ${agent} --event ${event}`; }

function install(target) {
  const t = (cfg) => ({ type: 'command', command: cfg.cmd, timeout: cfg.timeout });
  const appr = loadConfig().approvalTimeoutSec + 30;
  if (target === 'codex') {
    const f = mergeHooks(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'), {
      PermissionRequest: [{ hooks: [t({ cmd: hookCmd('codex', 'permission'), timeout: appr })] }],
      Stop: [{ hooks: [t({ cmd: hookCmd('codex', 'stop'), timeout: 10 })] }],
    });
    console.log(`已写入 ${f}\n在 Codex 里运行 /hooks 审核并信任这些 hook。`);
  } else if (target === 'dsh') {
    const f = mergeHooks(path.join(HOME_DIR, 'dsh-hooks.json'), {
      PreToolUse: [{ matcher: loadConfig().dshMatcher || 'bash|shell|write|edit|apply_patch|Bash|Shell|Write|Edit|MultiEdit',
        hooks: [t({ cmd: hookCmd('dsh', 'pretool'), timeout: appr })] }],
      Stop: [{ hooks: [t({ cmd: hookCmd('dsh', 'stop'), timeout: 10 })] }],
    });
    console.log(`已写入 ${f}\n把 integrations/dsh/cordis.patch.yml 里的 configPath 指向它（见 README）。`);
  } else if (target === 'claude') {
    const f = mergeHooks(path.join(os.homedir(), '.claude', 'settings.json'), {
      PermissionRequest: [{ hooks: [t({ cmd: hookCmd('claude', 'permission'), timeout: appr })] }],
      Notification: [{ hooks: [t({ cmd: hookCmd('claude', 'notification'), timeout: 10 })] }],
      Stop: [{ hooks: [t({ cmd: hookCmd('claude', 'stop'), timeout: 10 })] }],
    });
    console.log(`已写入 ${f}（推荐改用插件方式安装，见 README）`);
  } else {
    console.log('用法: agentreminder install codex|dsh|claude');
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'hook': return runHook(rest);
    case 'daemon': return runDaemon();
    case 'pair': return pairDevice();
    case 'start': { const ok = await ensureDaemon(); console.log(ok ? 'daemon running' : 'daemon failed, see ' + LOG_PATH); return; }
    case 'stop': try { await call('POST', '/shutdown', {}, 1000); console.log('stopped'); } catch (_) { console.log('not running'); } return;
    case 'status': try { console.log(JSON.stringify(await call('GET', '/status', null, 1000), null, 2)); } catch (_) { console.log('daemon not running'); } return;
    case 'test': {
      await ensureDaemon();
      await call('POST', '/notify', { info: { agent: 'test', project: 'agentreminder', kind: 'done', title: '测试通知', detail: 'Hello from AgentReminder' } }, 3000);
      console.log('已发送测试通知；现在发一个测试审批，请在设备上点 同意/拒绝 …');
      const r = await call('POST', '/approval', { timeoutSec: 60, info: { agent: 'test', project: 'agentreminder', title: 'Bash', detail: 'rm -rf ./build && npm run build' } }, 70000);
      console.log('结果:', r.decision || `无 (${r.reason})`);
      return;
    }
    case 'wifi': {
      const [ssid, pass] = rest;
      if (!ssid) return console.log('用法: agentreminder wifi <SSID> <密码>   （设备需先用 USB 连着）');
      await ensureDaemon();
      const r = await call('POST', '/raw', { t: 'wifi', ssid, pass: pass || '' }, 3000);
      console.log(r.delivered ? '已发送 Wi-Fi 配置，设备会自动重连。' : '没有连接的设备，请先插上 USB。');
      return;
    }
    case 'install': return install(rest[0]);
    case 'log': process.stdout.write(fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').split('\n').slice(-60).join('\n') + '\n' : ''); return;
    case '-v': case 'version': console.log(VERSION); return;
    default:
      console.log(`agentreminder ${VERSION}
  start | stop | status | log      守护进程
  pair                              通过 USB 配对，需在设备上确认
  test                              向设备发测试通知和审批
  wifi <SSID> <密码>                通过 USB 给设备配 Wi-Fi
  install codex|dsh|claude          手动写入 hook 配置
  hook --agent <a> --event <e>      (由 agent 调用)`);
  }
}

if (require.main === module) {
  if (process.argv[2] === 'daemon') process.env.AGENTREMINDER_FOREGROUND = process.stdout.isTTY ? '1' : '';
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}

module.exports = { Hub, Link, mergeHooks, describeTool, describeSession, transcriptTitle, shellQuote };
