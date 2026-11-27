#!/usr/bin/env node
/*
 * AgentReminder host: one zero-dependency file that is
 *   - the hook entry point called by supported agents   (`hook ...`)
 *   - the background daemon that talks to the ESP32-S3           (`daemon`)
 *   - a small CLI                                                 (`status`, `test`, `wifi`, `install` ...)
 *
 * Device transports:
 *   USB  : /dev/cu.usbmodem* (macOS) or /dev/ttyACM* (Linux), newline-delimited JSON
 *   BLE  : authenticated macOS connection to a board enrolled over USB
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
const bluetooth = require('./bluetooth');
const tailnet = require('./tailnet');
const workbuddy = require('./workbuddy');
const codexHooks = require('./codex-hooks');
const { isDeepStrictEqual } = require('node:util');

const VERSION = '0.5.14';
const UNKNOWN_CONVERSATION = '未命名对话';
const HOME_DIR = process.env.AGENTREMINDER_HOME || path.join(os.homedir(), '.agentreminder');
const CONFIG_PATH = path.join(HOME_DIR, 'config.json');
const LOG_PATH = path.join(HOME_DIR, 'daemon.log');
const INTEGRATION_AGENTS = ['codex', 'claude', 'dsh', 'workbuddy'];
const AGENT_CONFIG_ENV = { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR' };
const WORKBUDDY_DIR = path.join(os.homedir(), '.workbuddy');
const INBOX_HANDOFF_PATH = path.join(HOME_DIR, 'inbox-upgrade.json');
const DEVICE_NOTIFICATION_LIMIT = 20;
const BLE_NOTIFICATION_REPLAY_INTERVAL_MS = 100;

const DEFAULT_CONFIG = {
  httpPort: 47321,              // daemon <-> hook (127.0.0.1 only)
  approvalTimeoutSec: 300,      // after this the agent falls back to its own prompt
  preventIdleSleep: true,
  usb: { enabled: true, patterns: ['^cu\\.usbmodem', '^ttyACM'] },
  bluetooth: { enabled: true },
  wifi: { enabled: false, hosts: ['agentreminder.local'], port: 47322 },
  notify: { stop: true, idle: true },
};

function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { /* defaults */ }
  return {
    ...DEFAULT_CONFIG, ...user,
    usb: { ...DEFAULT_CONFIG.usb, ...(user.usb || {}) },
    bluetooth: { ...DEFAULT_CONFIG.bluetooth, ...(user.bluetooth || {}) },
    wifi: { ...DEFAULT_CONFIG.wifi, ...(user.wifi || {}) },
    notify: { ...DEFAULT_CONFIG.notify, ...(user.notify || {}) },
  };
}

const validDeviceId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);

function registeredDevices(cfg) {
  const devices = new Map();
  const add = (id, key) => {
    if (!validDeviceId(id)) return;
    devices.set(id, { id, key: /^[0-9a-f]{64}$/.test(key || '') ? key : null });
  };
  add(cfg.usb?.pairedDeviceId, cfg.bluetooth?.key);
  if (Array.isArray(cfg.pairedDevices)) {
    for (const device of cfg.pairedDevices) add(device?.id, device?.key);
  }
  return devices;
}

function ensureHome() { fs.mkdirSync(HOME_DIR, { recursive: true }); }

function firmwareUpdateActive() {
  let pid;
  try { pid = Number(fs.readFileSync(path.join(HOME_DIR, 'firmware-update.pid'), 'utf8')); }
  catch (_) { return false; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  if (process.env.AGENTREMINDER_FOREGROUND) process.stderr.write(line);
  try { ensureHome(); fs.appendFileSync(LOG_PATH, line); } catch (_) { /* ignore */ }
}

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function inboxCard(payload) {
  const { id, title, detail, reason, host, project, conversation, receivedTime, kind } = payload;
  return { id, title: clip(title, 180) || 'AgentReminder',
    detail: clip(payload.t === 'approval' ? reason || detail : detail || reason, 500),
    host: clip(host, 120), project: clip(project, 120), conversation: clip(conversation, 180),
    receivedTime: clip(receivedTime, 24), kind: clip(kind, 24) };
}
function interactionChoices({ choices }) {
  return Array.isArray(choices) && choices.length === 2 && choices.every(choice => typeof choice === 'string')
    ? choices : undefined;
}
function cardTime(ts) {
  const date = new Date(ts);
  const two = n => String(n).padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
const hostName = (() => {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 300, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (name) return clip(name, 100);
    } catch (_) { /* use the system hostname */ }
  }
  return clip(os.hostname(), 100);
})();

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
  constructor(cfg, relayDismissals = () => {}, menuAvailable = () => false) {
    this.cfg = cfg;
    this.links = new Set();
    this.pending = new Map();   // id -> { payload, resolve, timer }
    this.notificationSequence = 0;
    this.notifications = new Map();
    this.dismissedNotifications = new Set();
    this.relayDismissals = relayDismissals;
    this.menuAvailable = menuAvailable;
  }
  connectedLinks() { return [...this.links].filter(l => l.ready); }
  pairings() { return registeredDevices(this.cfg); }
  readyLinks() {
    const paired = this.pairings();
    if (this.cfg.usb?.autoPair && !paired.size) return [];
    return this.connectedLinks().filter(link => {
      const pairing = paired.get(link.info.id);
      if (link.kind === 'ble') return !!pairing && link.pairedDeviceId === pairing.id;
      return !paired.size || (link.kind === 'usb' && !!pairing);
    });
  }
  broadcast(obj) { for (const l of this.readyLinks()) l.send(obj); }
  requestLinks(payload) { return this.readyLinks().filter(link => !payload.interaction || link.info.interaction === true); }

  add(link) {
    this.links.add(link);
    log('link open', link.kind, link.name);
    const hello = { t: 'hello', host: hostName, v: VERSION, notificationDismissals: true };
    link.helloRetry = setInterval(() => link.send(hello), 500);
    // A port that never answers hello is not our device.
    link.helloTimer = setTimeout(() => { if (!link.ready) { log('no hello from', link.name); link.close(); } }, 6000);
    link.send(hello);
  }
  onClose(link) {
    clearTimeout(link.helloTimer);
    clearInterval(link.helloRetry);
    clearTimeout(link.notificationReplay);
    this.links.delete(link);
    log('link closed', link.kind, link.name);
    for (const [id, pending] of this.pending) {
      if (pending.target === link) this.cancel(id, 'device-disconnected');
    }
    this.cancelUnreachableApprovals('device-disconnected');
  }
  cancelUnreachableApprovals(reason) {
    if (!this.pending.size || this.menuAvailable()) return;
    for (const [id, pending] of this.pending) {
      if (!pending.target && !this.requestLinks(pending.payload).length) this.cancel(id, reason);
    }
  }
  onMessage(link, msg) {
    if (!msg || typeof msg !== 'object') return;
    link.lastSeen = Date.now();
    switch (msg.t) {
      case 'hello':
        if (msg.app !== 'agentreminder') return;
        if (link.kind === 'ble' && msg.id !== link.pairedDeviceId) { link.close(); return; }
        if (link.ready) return;
        link.ready = true; link.info = msg; clearTimeout(link.helloTimer);
        clearInterval(link.helloRetry);
        log('device ready', link.kind, link.name, msg);
        if (this.readyLinks().includes(link)) {
          if (msg.notificationDismissals === true && this.dismissedNotifications.size) {
            link.send({ t: 'dismiss', ids: [...this.dismissedNotifications] });
          }
          for (const p of this.pending.values()) {
            const timeout = Math.ceil((p.deadline - Date.now()) / 1000);
            if (timeout > 0 && !p.target && this.requestLinks(p.payload).includes(link)) {
              link.send({ ...p.payload, timeout });
            }
          }
          if (link.kind === 'ble' && !link.closed) this.replayUnreadNotifications(link);
        }
        break;
      case 'decision': {
        const pending = this.pending.get(msg.id);
        if (link.ready && pending && (pending.target ? pending.target === link : this.requestLinks(pending.payload).includes(link)) &&
            (!pending.payload.interaction || interactionChoices(pending.payload) || msg.decision === 'skip') &&
            ['allow', 'deny', 'skip'].includes(msg.decision))
          this.resolve(msg.id, msg.decision, `${link.kind}:${link.name}`, msg.ble_paired === true);
        break;
      }
      case 'dismiss':
        if (this.readyLinks().includes(link)) this.dismissNotifications(msg.ids, { source: link });
        break;
      case 'pong': case 'ack': break;
      case 'log': log('device:', msg.msg); break;
      default: log('unknown msg', msg);
    }
  }

  approvalCard(info, timeoutMs) {
    const ts = Date.now();
    // An already-running desktop bridge may still send file approvals without a project.
    const project = info.project || (!info.host && info.agent === 'codex' ? clip(path.basename(codexThread(info.sessionId).cwd || ''), 80) : '');
    return { ...info, host: info.host || hostName, project, t: 'approval', id: crypto.randomUUID(), ts,
      receivedTime: cardTime(ts), timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) };
  }

  /** Ask connected devices and the menu bar. A null decision lets the agent ask normally. */
  requestApproval(info, timeoutMs, target = null, enrollmentKey = null, card = null) {
    const payload = card ? { ...card, timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) } : this.approvalCard(info, timeoutMs);
    const { id } = payload;
    const links = target ? [target] : this.requestLinks(info);
    if (!links.length && info.interaction && this.readyLinks().length) this.notify({ ...info, kind: 'input' });
    if (target ? !target.ready || target.closed : !links.length && !this.menuAvailable()) {
      return { id, promise: Promise.resolve({ decision: null, reason: 'no-device' }) };
    }
    const promise = new Promise(resolve => {
      const timer = setTimeout(() => this.resolve(id, null, 'timeout'), timeoutMs);
      this.pending.set(id, { payload, resolve, timer, target, mirrored: Boolean(card), deadline: Date.now() + timeoutMs });
      if (enrollmentKey) target.send({ ...payload, t: 'ble-pair', key: enrollmentKey });
      else for (const link of links) link.send(payload);
      log('approval ->', id, info.agent, info.title);
    });
    return { id, promise };
  }
  resolveFromMenu(id, decision) {
    const pending = this.pending.get(id);
    if (!pending || pending.target) return false;
    if (decision !== 'skip' && pending.payload.interaction && !interactionChoices(pending.payload)) return false;
    this.resolve(id, decision, 'menu-bar');
    return true;
  }
  resolve(id, decision, by, bluetoothPaired = false) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    const d = decision === 'allow' || decision === 'deny' ? decision : null;
    const result = { t: 'resolved', id, decision: d || 'skip', by };
    if (p.target) p.target.send(result); else this.broadcast(result);
    log('approval <-', id, d || 'skip', by);
    p.resolve({ decision: d, reason: by, ...(p.mirrored && decision === 'skip' ? { action: 'skip' } : {}),
      ...(p.target && bluetoothPaired ? { bluetoothPaired } : {}) });
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
  notificationCard(info) {
    const ts = Date.now();
    return { ...info, host: info.host || hostName, t: 'notify', id: crypto.randomUUID(), ts, receivedTime: cardTime(ts),
      sequence: ++this.notificationSequence };
  }
  storeNotification(note) {
    if (this.dismissedNotifications.has(note.id) || this.notifications.has(note.id)) return;
    const matching = [...this.notifications.values()].filter(candidate => {
      if (candidate.host !== note.host || candidate.project !== note.project) return false;
      if (candidate.sessionId && note.sessionId) return candidate.sessionId === note.sessionId;
      return Boolean(note.conversation) && note.conversation !== UNKNOWN_CONVERSATION &&
        candidate.conversation === note.conversation;
    });
    const previous = matching.find(candidate => candidate.sessionId === note.sessionId)
      || (matching.length === 1 ? matching[0] : null);
    if (previous) {
      if ((previous.ts ?? 0) > (note.ts ?? 0) ||
          (previous.ts === note.ts && (previous.sequence ?? 0) > (note.sequence ?? 0))) return;
      this.notifications.delete(previous.id);
    }
    this.notifications.set(note.id, note);
    if (this.notifications.size > 100) this.notifications.delete(this.notifications.keys().next().value);
  }
  notify(info, payload = this.notificationCard(info)) {
    if (this.dismissedNotifications.has(payload.id)) return 0;
    const { ts, sequence, agent, reason } = payload;
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId || undefined : undefined;
    this.storeNotification({ ...inboxCard(payload), sessionId, ts, sequence, unread: true,
      agent: agent ? clip(agent, 80) : undefined, reason: reason ? clip(reason, 500) : undefined });
    const links = this.readyLinks();
    for (const link of links) this.sendNotification(link, payload);
    log('notify ->', info.agent, info.kind, info.kind === 'input' ? 'awaiting input' : info.title);
    return links.length;
  }

  sendNotification(link, payload) {
    if (payload.kind === 'input' && payload.reason && link.info.interaction !== true) {
      link.send({ ...payload, title: clip(`${payload.title} · ${payload.reason}`, 240), reason: '' });
    } else link.send(payload);
  }

  replayUnreadNotifications(link) {
    const ids = [...this.notifications.values()].filter(note => note.unread)
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.sequence ?? 0) - (b.sequence ?? 0))
      .slice(-DEVICE_NOTIFICATION_LIMIT).map(note => note.id);
    const next = () => {
      if (link.closed || !this.readyLinks().includes(link)) return;
      const { unread, ...payload } = this.notifications.get(ids.shift()) || {};
      // A menu read, group replacement, or device dismissal may arrive during replay.
      if (unread) {
        const reason = payload.kind === 'input' ? payload.reason || payload.detail : payload.reason;
        this.sendNotification(link, { ...payload, reason, t: 'notify' });
      }
      if (ids.length && !link.closed) {
        link.notificationReplay = setTimeout(next, BLE_NOTIFICATION_REPLAY_INTERVAL_MS).unref();
      }
    };
    // Give the board time to upload offline dismissals and pace the GATT write queue.
    if (ids.length) link.notificationReplay = setTimeout(next, BLE_NOTIFICATION_REPLAY_INTERVAL_MS).unref();
  }

  dismissNotifications(ids, { source, relay = true } = {}) {
    const accepted = tailnet.notificationIds(ids);
    const added = accepted.filter(id => !this.dismissedNotifications.has(id));
    for (const id of added) {
      this.notifications.delete(id);
      this.dismissedNotifications.add(id);
      if (this.dismissedNotifications.size > tailnet.DISMISSAL_LIMIT) {
        this.dismissedNotifications.delete(this.dismissedNotifications.values().next().value);
      }
    }
    for (const link of this.readyLinks()) {
      const dismissals = link === source ? accepted : added;
      if (link.info.notificationDismissals === true && dismissals.length) link.send({ t: 'dismiss', ids: dismissals });
    }
    if (relay && added.length) this.relayDismissals(added);
  }
}

/* ---------------------------- USB serial ---------------------------- */

function startUsb(hub, cfg) {
  if (!cfg.usb.enabled) return;
  const open = new Map();                // path -> Link
  const serialStreams = new Set();
  const cooldown = new Map();            // path -> until (ms)
  const res = cfg.usb.patterns.map(p => new RegExp(p));

  const scan = () => {
    if (firmwareUpdateActive()) return;
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
    let rs;
    try { rs = new tty.ReadStream(fd); }
    catch (_) { fs.closeSync(fd); cooldown.set(p, Date.now() + 15000); return; }
    // libuv may reopen the terminal and leave the original write fd to us.
    const closeWriteFd = rs._handle.fd !== fd;
    serialStreams.add(rs);
    rs.once('close', () => {
      if (closeWriteFd) fs.closeSync(fd);
      serialStreams.delete(rs);
    });
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
  return {
    async pauseForFirmware() {
      const closed = [...serialStreams].map(stream =>
        new Promise(resolve => stream.once('close', resolve)));
      for (const link of open.values()) link.close();
      cooldown.clear();
      await Promise.all(closed);
    },
  };
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

function readSavedConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function writePrivateFile(file, contents) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

function savePairingConfig(usb, device) {
  ensureHome();
  const config = readSavedConfig();
  config.usb = { ...config.usb, ...usb };
  if (device) {
    const devices = registeredDevices(config);
    devices.set(device.id, device);
    config.pairedDevices = [...devices.values()];
    // Preserve the first enrollment in the legacy fields for older hosts.
    if (!config.usb.pairedDeviceId || config.usb.pairedDeviceId === device.id) {
      config.usb.pairedDeviceId = device.id;
      config.bluetooth = { ...config.bluetooth, key: device.key };
    }
  }
  writePrivateFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  return config;
}

function createSleepPrevention() {
  const supported = process.platform === 'darwin';
  let enabled = false;
  let holder;

  function ensureActive() {
    if (!enabled || holder) return;
    // Tie the assertion to the daemon even if it exits without running cleanup.
    const candidate = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    holder = candidate;
    candidate.unref();
    const stopped = reason => {
      if (holder !== candidate) return;
      holder = undefined;
      if (!enabled) return;
      if (candidate.killed) ensureActive();  // The switch was turned back on before the old helper exited.
      else log('sleep prevention stopped', reason);
    };
    candidate.once('error', error => stopped(error.code || error.message));
    candidate.once('exit', (code, signal) => stopped(signal || code));
  }

  return {
    supported,
    status: () => ({
      supported, enabled,
      active: Boolean(holder?.pid && !holder.killed && holder.exitCode === null && holder.signalCode === null),
    }),
    ensureActive,
    setEnabled(value) {
      enabled = supported && value === true;
      if (enabled) ensureActive();
      else if (holder && !holder.killed) holder.kill();
    },
  };
}

function runDaemon() {
  if (firmwareUpdateActive()) throw new Error("A firmware update is already in progress.");
  ensureHome();
  const cfg = loadConfig();
  let mesh, meshConfigError, setupToken, menuPid;
  const menuAvailable = () => {
    if (!menuPid) return false;
    try { return process.kill(menuPid, 0); }
    catch (_) { return false; }
  };
  const hub = new Hub(cfg, ids => mesh?.broadcastDismissals(ids), menuAvailable);
  const notify = async info => mesh ? await mesh.notify(info) : hub.notify(info);
  const workbuddyApprovals = workbuddy.createApprovalMonitor(path.join(WORKBUDDY_DIR, 'audit-log'), notify, log);
  const sleepPrevention = createSleepPrevention();
  const authorizedSetup = req => {
    const token = req.headers['x-agentreminder-setup'];
    return setupToken && typeof token === 'string' && /^[0-9a-f]{64}$/.test(token) &&
      crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(setupToken, 'hex'));
  };
  if (cfg.tailnet?.enabled) {
    try { mesh = tailnet.createMesh(tailnet.validateConfig(cfg.tailnet), hub, log); }
    catch (error) { meshConfigError = error.message; log(meshConfigError); }
  }
  let ble, usb;

  const prompted = new WeakSet();
  async function pairUsb(response, selected) {
    const usb = hub.connectedLinks().filter(link => link.kind === 'usb' && validDeviceId(link.info.id));
    if (!usb.length) return { error: 'no-usb' };
    const devices = hub.pairings();
    const unpaired = usb.filter(link => !devices.has(link.info.id));
    const candidates = selected ? usb.filter(link => link === selected) : unpaired.length ? unpaired : usb;
    if (!candidates.length) return { error: 'no-usb' };
    if (candidates.length !== 1) return { error: 'multiple-usb' };
    const target = candidates[0];
    const deviceId = target.info.id;
    const canPairBluetooth = cfg.bluetooth.enabled && bluetooth.available() && target.info.ble === 1 && /^[0-9A-Fa-f]{12}$/.test(deviceId);
    const known = devices.get(deviceId);
    if (known && (!canPairBluetooth || (!response && known.key && target.info.ble_paired))) {
      return { deviceId, bluetoothPaired: !!known.key };
    }
    if (hub.pending.size || mesh?.outgoing.size) return { error: 'approval-pending' };
    if (!response && prompted.has(target)) return { error: 'already-prompted' };
    prompted.add(target);
    const key = canPairBluetooth ? crypto.randomBytes(32).toString('hex') : null;
    const { id, promise } = hub.requestApproval({
      agent: 'setup', conversation: hostName, title: '配对这台电脑',
      detail: `主机：${hostName}\n请按屏幕「同意」或「拒绝」对应的按键。`,
    }, 60000, target, key);
    response?.on('close', () => { if (!response.writableEnded) hub.cancel(id, 'pairing-client-gone'); });
    const result = await promise;
    if (result.decision !== 'allow') return { error: result.decision || result.reason };
    if (target.closed) return { error: 'device-disconnected' };
    if (key && !result.bluetoothPaired) return { error: 'bluetooth-pairing-not-saved' };
    const saved = savePairingConfig({ autoPair: false }, { id: deviceId, key });
    cfg.pairedDevices = saved.pairedDevices;
    cfg.usb.autoPair = false;
    if (key) target.info.ble_paired = true;
    ble.tick();
    return { deviceId, bluetoothPaired: !!key };
  }

  const server = http.createServer(async (req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (req.headers.origin) return reply(403, { error: 'browser requests are not supported' });
      if (req.url === '/inbox' || req.url === '/inbox/read' || req.url === '/inbox/clear' || req.url === '/inbox/test' || req.url === '/inbox/decision' || req.url === '/firmware/prepare' || req.url === '/tailnet/setup' || req.url === '/agent-integrations' || req.url === '/sleep-prevention') {
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || '')) {
          return reply(403, { error: 'endpoint requires a loopback host' });
        }
        res.setHeader('Cache-Control', 'no-store');
      }
      if (req.method === 'GET' && req.url === '/inbox') {
        const menuRequest = authorizedSetup(req);
        const pid = Number(req.headers['x-agentreminder-menu-pid']);
        // Registration lasts while the GUI process is alive, including when macOS throttles its polling.
        if (menuRequest && Number.isInteger(pid) && pid > 1 && pid <= 0x7fffffff) menuPid = pid;
        const notifications = [...hub.notifications.values()].reverse().sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
        const approvals = new Map();
        for (const [id, { card }] of mesh?.outgoing || []) approvals.set(id, card);
        for (const { payload, target } of hub.pending.values()) {
          if (!target) approvals.set(payload.id, payload);
        }
        return reply(200, {
          canClear: true, canUpdateFirmware: true, canSendTest: true, groupsNotifications: true,
          canResolveApprovals: !!menuRequest,
          canInitializeTailnet: !!setupToken, tailnetConfigured: !!mesh, tailnetListening: mesh?.status().listening ?? false,
          canManageIntegrations: !!setupToken,
          canManageSleepPrevention: !!setupToken && sleepPrevention.supported,
          sleepPrevention: sleepPrevention.status(),
          agentIntegrations: Object.fromEntries(INTEGRATION_AGENTS.map(agent => [agent, integrationStatus(cfg, agent)])),
          notifications, unread: notifications.filter(note => note.unread).length,
          approvals: [...approvals.values()].map(payload => ({
            ...inboxCard(payload), interaction: payload.interaction === true,
            operation: payload.reason && payload.detail && payload.reason !== payload.detail ? clip(payload.detail, 500) : undefined,
            choices: payload.interaction ? interactionChoices(payload) : undefined,
            actionable: hub.pending.has(payload.id),
          })),
          devices: new Set(hub.readyLinks().map(link => link.info.id)).size });
      }
      if (req.method === 'GET' && req.url === '/status') {
        const pairedDeviceIds = [...hub.pairings().keys()];
        return reply(200, {
          version: VERSION, pid: process.pid, pairedDeviceId: pairedDeviceIds[0] ?? null, pairedDeviceIds,
          waitingForUsbPairing: !!(cfg.usb.autoPair && !pairedDeviceIds.length),
          bluetooth: ble.status(), bluetoothDevices: ble.states(),
          sleepPrevention: sleepPrevention.status(),
          devices: hub.readyLinks().map(l => ({ kind: l.kind, name: l.name, info: l.info })),
          pending: [...new Map([
            ...[...hub.pending].map(([id, pending]) => [id, pending.payload]),
            ...[...(mesh?.outgoing || [])].map(([id, { card }]) => [id, card]),
          ]).values()].map(({ id, agent, title }) => ({ id, agent, title })),
          ...(mesh ? { tailnet: mesh.status() } : meshConfigError ? { tailnet: { listening: false, error: meshConfigError } } : {}),
        });
      }
      if (req.method !== 'POST') return reply(404, { error: 'not found' });
      const body = await readBody(req);
      if (req.url === '/inbox/read') {
        for (const id of Array.isArray(body?.ids) ? body.ids : []) {
          const notification = hub.notifications.get(id);
          if (notification) notification.unread = false;
        }
        return reply(200, { ok: true });
      }
      if (req.url === '/inbox/decision') {
        if (!authorizedSetup(req)) return reply(403, { error: 'unauthorized' });
        const { id, decision } = body || {};
        if (typeof id !== 'string' || !['allow', 'deny', 'skip'].includes(decision)) {
          return reply(400, { error: 'invalid-decision' });
        }
        return reply(200, { ok: hub.resolveFromMenu(id, decision) });
      }
      if (req.url === '/inbox/clear') {
        hub.dismissNotifications(body?.notifications);
        for (const id of Array.isArray(body?.approvals) ? body.approvals : []) {
          const outgoing = mesh?.outgoing.get(id);
          if (outgoing) outgoing.handoff();
          else hub.resolveFromMenu(id, 'skip');
        }
        return reply(200, { ok: true });
      }
      if (req.url === '/inbox/test') {
        const english = body.lang === 'en';
        const delivered = hub.notify({ agent: 'test', kind: 'test', project: 'AgentReminder',
          sessionId: 'agentreminder-menu-test', conversation: english ? 'Connection test' : '连接测试',
          title: english ? 'Test notification' : '测试通知',
          detail: english ? 'AgentReminder received your test notification.' : 'AgentReminder 已收到测试通知。' });
        return reply(200, { delivered });
      }
      if (req.url === '/tailnet/setup') {
        if (!authorizedSetup(req)) return reply(403, { error: 'unauthorized' });
        if (mesh) return reply(409, { error: 'already-configured' });
        const key = body?.mode === 'create' ? crypto.randomBytes(32).toString('hex')
          : body?.mode === 'join' && typeof body.key === 'string' ? body.key.trim().toLowerCase() : '';
        if (!/^[0-9a-f]{64}$/.test(key)) return reply(400, { error: 'invalid-key' });
        const config = readSavedConfig();
        const settings = { ...config.tailnet, enabled: true, key };
        const verified = tailnet.validateConfig(settings);
        writePrivateFile(CONFIG_PATH, JSON.stringify({ ...config, tailnet: settings }, null, 2) + '\n');
        mesh = tailnet.createMesh(verified, hub, log);
        meshConfigError = undefined;
        mesh.start();
        return reply(200, { ok: true });
      }
      if (req.url === '/agent-integrations') {
        if (!authorizedSetup(req)) return reply(403, { error: 'unauthorized' });
        const { agent, enabled } = body || {};
        if (!INTEGRATION_AGENTS.includes(agent) || typeof enabled !== 'boolean') {
          return reply(400, { error: 'invalid-integration' });
        }
        const config = readSavedConfig();
        const installedHooks = enabled && !integrationHasHooks(agent);
        if (installedHooks) install(agent, () => {});
        const agentIntegrations = { ...config.agentIntegrations, [agent]: enabled };
        writePrivateFile(CONFIG_PATH, JSON.stringify({ ...config, agentIntegrations }, null, 2) + '\n');
        cfg.agentIntegrations = agentIntegrations;
        if (agent === 'workbuddy') workbuddyApprovals.setEnabled(enabled);
        return reply(200, { status: integrationStatus(cfg, agent), ...(installedHooks ? { installedHooks } : {}) });
      }
      if (req.url === '/sleep-prevention') {
        if (!authorizedSetup(req)) return reply(403, { error: 'unauthorized' });
        if (!sleepPrevention.supported) return reply(409, { error: 'unsupported-platform' });
        const enabled = body?.enabled;
        if (typeof enabled !== 'boolean') return reply(400, { error: 'invalid-setting' });
        const config = readSavedConfig();
        writePrivateFile(CONFIG_PATH, JSON.stringify({ ...config, preventIdleSleep: enabled }, null, 2) + '\n');
        sleepPrevention.setEnabled(enabled);
        return reply(200, { ok: true });
      }
      if (req.url === '/firmware/prepare') {
        if (!firmwareUpdateActive()) return reply(409, { error: 'firmware-update-inactive' });
        if (hub.pending.size || mesh?.outgoing.size) return reply(409, { error: 'approval-pending' });
        await usb?.pauseForFirmware();
        return reply(200, { ok: true });
      }
      if (req.url === '/pair' || req.url === '/setup-usb') {
        if (req.url === '/setup-usb') {
          if (!hub.pairings().size) {
            savePairingConfig({ enabled: true, autoPair: true });
            if (!cfg.usb.enabled) {
              cfg.usb.enabled = true;
              usb = startUsb(hub, cfg);
            }
            cfg.usb.autoPair = true;
          }
          return reply(200, { ok: true });
        }
        const result = await pairUsb(res);
        return reply(result.deviceId ? 200 : 409, result);
      }
      if (req.url === '/approval' || req.url === '/interaction') {
        if (res.destroyed) return;
        if ([...hub.pending.values()].some(pending => pending.target)) {
          return reply(200, { decision: null, reason: 'pairing-in-progress' });
        }
        const seconds = Number(body.timeoutSec || cfg.approvalTimeoutSec);
        const timeoutMs = Math.round(Math.max(5, Math.min(Number.isFinite(seconds) ? seconds : 300, 3600)) * 1000);
        const info = { ...body.info, interaction: req.url === '/interaction' };
        // The Codex CLI switch is checked by its hook. Desktop proxy requests share the same agent name.
        if (info.agent !== 'codex' && !integrationAllowed(cfg, info.agent)) {
          return reply(200, { decision: null, reason: 'agent-disabled' });
        }
        if (mesh) return reply(200, await mesh.approval(info, timeoutMs, res));
        const { id, promise } = hub.requestApproval(info, timeoutMs);
        // If the hook process dies (agent cancelled / user hit Esc), clear the card on the device.
        res.on('close', () => { if (!res.writableEnded) hub.cancel(id, 'hook-gone'); });
        return reply(200, await promise);
      }
      if (req.url === '/notify') {
        const info = body.info || {};
        if (info.agent !== 'codex' && !integrationAllowed(cfg, info.agent)) return reply(200, { delivered: 0 });
        return reply(200, { delivered: await notify(info) });
      }
      if (req.url === '/raw') {
        if (body.t === 'ble-pair') return reply(409, { error: 'use USB pairing' });
        const links = hub.readyLinks().filter(link => body.t !== 'wifi' || link.kind === 'usb');
        for (const link of links) link.send(body);
        return reply(200, { delivered: links.length });
      }
      if (req.url === '/shutdown') { reply(200, { ok: true }); log('shutdown'); setTimeout(() => process.exit(0), 100); return; }
      return reply(404, { error: 'not found' });
    } catch (e) { log('http error', e.stack || e.message); reply(500, { error: e.message }); }
  });

  server.on('error', (e) => { log('http listen error', e.message); process.exit(e.code === 'EADDRINUSE' ? 0 : 1); });
  server.listen(cfg.httpPort, '127.0.0.1', () => {
    log(`daemon ${VERSION} listening on 127.0.0.1:${cfg.httpPort} pid=${process.pid}`);
    try { fs.writeFileSync(path.join(HOME_DIR, 'daemon.pid'), String(process.pid)); } catch (_) { /* ignore */ }
    try {
      const notifications = JSON.parse(fs.readFileSync(INBOX_HANDOFF_PATH, 'utf8'));
      for (const note of notifications.slice(0, 100).reverse()) hub.storeNotification(note);
      fs.unlinkSync(INBOX_HANDOFF_PATH);
    } catch (error) {
      if (error.code !== 'ENOENT') log('could not restore inbox after upgrade', error.message);
    }
    try {
      const token = crypto.randomBytes(32).toString('hex');
      writePrivateFile(path.join(HOME_DIR, 'menu-setup.token'), token + '\n');
      setupToken = token;
    } catch (error) { log('could not create local menu setup token', error.code || 'write failed'); }
    // Only the process that owns the HTTP port may open the device transports.
    ble = bluetooth.startBluetooth(hub, Link, log);
    usb = startUsb(hub, cfg);
    startWifi(hub, cfg);
    mesh?.start();
    workbuddyApprovals.setEnabled(integrationStatus(cfg, 'workbuddy') === 'enabled');
    sleepPrevention.setEnabled(cfg.preventIdleSleep);
    setInterval(() => {
      if (menuPid && !menuAvailable()) {
        menuPid = undefined;
        hub.cancelUnreachableApprovals('menu-closed');
      }
      const devices = hub.pairings();
      const upgrade = cfg.bluetooth.enabled && bluetooth.available() &&
        hub.connectedLinks().find(link => link.kind === 'usb' && link.info.ble === 1 && devices.has(link.info.id) &&
          (!devices.get(link.info.id).key || !link.info.ble_paired) && !prompted.has(link));
      if ((cfg.usb.autoPair && !devices.size) || upgrade) {
        pairUsb(undefined, upgrade || undefined).catch(error => log('USB pairing failed', error.message));
      }
    }, 1000).unref();
    setInterval(() => {
      sleepPrevention.ensureActive();
      for (const link of hub.connectedLinks()) {
        if (Date.now() - link.lastSeen > 40000) link.close();
        else link.send({ t: 'ping', ts: Date.now() });
      }
    }, 15000).unref();
  });
  process.once('exit', () => sleepPrevention.setEnabled(false));
  process.on('SIGTERM', () => process.exit(0));
}

/* --------------------------- HTTP client ---------------------------- */

function call(method, urlPath, body, timeoutMs, signal) {
  const cfg = loadConfig();
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: cfg.httpPort, method, path: urlPath,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      timeout: timeoutMs, signal,
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

async function stopLocalDaemon() {
  let pid;
  try { pid = Number(fs.readFileSync(path.join(HOME_DIR, 'daemon.pid'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const status = async () => {
    try { return await call('GET', '/status', null, 1000); }
    catch (error) { if (error.code === 'ECONNREFUSED') return null; throw error; }
  };
  // A localhost port may be forwarded to another host over SSH.
  const running = await status();
  if (running?.pid !== pid || !Array.isArray(running.pending)) return false;
  const result = await call('POST', '/shutdown', {}, 1000);
  if (!result.ok) throw new Error('The local AgentReminder daemon did not accept the shutdown request.');
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      if ((await status())?.pid !== pid) return true;
    } catch (error) {
      if (error.code !== 'ECONNRESET') throw error;
    }
  }
  throw new Error('The local AgentReminder daemon is still running.');
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
  if (firmwareUpdateActive()) return false;
  spawnDaemon();
  // Give the paired board time to reconnect on the first request after startup.
  const hasBluetoothPairing = [...registeredDevices(loadConfig()).values()].some(device => device.key);
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const s = await call('GET', '/status', null, 500);
      if (s.devices.length || (i > 15 && !hasBluetoothPairing) || i === 24) return true;
    } catch (_) { /* not yet */ }
  }
  return false;
}

async function preparePairing(autoSetup = false) {
  let status = await call('GET', '/status', null, 800).catch(() => null);
  if (status && status.version !== VERSION) {
    let localPid;
    try { localPid = Number(fs.readFileSync(path.join(HOME_DIR, 'daemon.pid'), 'utf8')); } catch (_) { /* remote daemon */ }
    if (!localPid || localPid !== status.pid || !Array.isArray(status.pending)) {
      throw new Error('请在设备连接的电脑更新 AgentReminder 守护进程后再配对。');
    }
    if (status.pending.length) throw new Error('请先处理当前审批，再重新运行配对。');
    const inbox = await call('GET', '/inbox', null, 800);
    let saved = false;
    if (inbox.notifications?.length) {
      const temporary = INBOX_HANDOFF_PATH + '.' + process.pid;
      fs.writeFileSync(temporary, JSON.stringify(inbox.notifications), { mode: 0o600 });
      fs.renameSync(temporary, INBOX_HANDOFF_PATH);
      saved = true;
    }
    const shutdown = await call('POST', '/shutdown', {}, 1000);
    if (!shutdown.ok) {
      if (saved) fs.unlinkSync(INBOX_HANDOFF_PATH);
      throw new Error('无法重启本机 AgentReminder 守护进程。');
    }
    for (let attempt = 0; attempt < 20 && status; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      status = await call('GET', '/status', null, 500).catch(() => null);
    }
    if (status) throw new Error('旧版守护进程仍在运行，请停止后重试。');
  }
  if (!(await ensureDaemon())) throw new Error(`无法启动 AgentReminder。日志：${LOG_PATH}`);
  if (autoSetup) {
    const result = await call('POST', '/setup-usb', {}, 2000);
    if (!result.ok) throw new Error(result.error || '无法启用自动配对。');
  }
}

async function setupUsb() {
  if (!registeredDevices(loadConfig()).size) savePairingConfig({ enabled: true, autoPair: true });
  await preparePairing(true);
  console.log('插入已烧录的设备，出现配对卡片后按屏幕提示同意。');
}

async function pairDevice() {
  await preparePairing();
  console.log('请连接一台已烧录 AgentReminder 的 USB 设备。出现配对卡片后，按屏幕提示同意。');
  let result;
  for (let attempt = 0; attempt < 40; attempt++) {
    result = await call('POST', '/pair', {}, 65000);
    if (result.error !== 'no-usb') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (result?.deviceId) {
    console.log(`${result.bluetoothPaired ? '蓝牙配对完成，请等待 status 显示 connected 再拔线' : 'USB 配对完成'}：${result.deviceId}`);
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

function codexThread(sessionId) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId || '')) return {};
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    const dbs = fs.readdirSync(home).filter(f => /^state_\d+\.sqlite$/.test(f)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    const bin = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3';
    for (const db of dbs) {
      // Prefer the desktop's renamed chat name, then its generated title.
      for (const title of ["COALESCE(NULLIF(name, ''), title)", 'title']) {
        const query = `SELECT ${title} AS title, cwd FROM threads WHERE id='${sessionId}' LIMIT 1;`;
        try {
          const result = execFileSync(bin, ['-readonly', '-json', path.join(home, db), query], { encoding: 'utf8', timeout: 400, maxBuffer: 32768, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          if (result) return JSON.parse(result)[0] || {};
          break;
        } catch (_) { /* older databases may lack the name column */ }
      }
    }
  } catch (_) { /* optional local metadata */ }
  return {};
}

function describeSession(input, agent, fallbackCwd = '') {
  const sessionId = input.session_id || input.thread_id || (agent === 'workbuddy' && input.sessionId) || '';
  const explicit = input.conversation_title || input.session_title || input.thread_title || input.session_name ||
    (agent === 'workbuddy' && (input.conversationTitle || input.sessionTitle));
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  const thread = agent === 'codex' && (!explicit || !cwd) ? codexThread(sessionId) : {};
  const title = explicit || thread.title || transcriptTitle(input.transcript_path, sessionId);
  return {
    sessionId: clip(sessionId, 128),
    conversation: clip(String(title || (sessionId ? `对话 ${sessionId.slice(0, 8)}` : UNKNOWN_CONVERSATION)).replace(/\s+/g, ' ').trim(), 100),
    host: hostName,
    project: clip(path.basename(cwd || thread.cwd || fallbackCwd), 80),
  };
}

function describeTool(input) {
  const name = input.tool_name || 'tool';
  const ti = input.tool_input || {};
  let detail = ti.command || ti.file_path || ti.path || ti.url || ti.pattern || ti.description || '';
  if (!detail && Object.keys(ti).length) detail = JSON.stringify(ti);
  const reason = input.permission_message || input.approval_message || ti.description || input.message || '';
  return { title: name, detail: clip(detail, 900), reason: clip(reason, 300) };
}

function questionCard(questions, canAnswer = true, { allowOptionalOther = false } = {}) {
  const list = Array.isArray(questions) ? questions.filter(q => q && typeof q.question === 'string') : [];
  const first = list[0];
  const options = Array.isArray(first?.options) ? first.options.map(option => option?.label) : [];
  const choices = canAnswer && list.length === 1 && questions.length === 1 &&
    (allowOptionalOther || !first.isOther) && !first.isSecret && !first.multiSelect &&
    options.length === 2 && options.every(label => typeof label === 'string' && label.trim()) && options[0] !== options[1]
    ? options : null;
  const reason = list.map(q => {
    if (q.isSecret) return '请在电脑上安全输入答案。';
    const labels = Array.isArray(q.options) ? q.options.filter(option => typeof option?.label === 'string') : [];
    return [q.question, ...labels.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` · ${option.description}` : ''}`)].join('\n');
  }).join('\n\n');
  return { card: { title: '等待回答', reason: clip(reason || '请在电脑上查看问题。', 1200), interaction: true,
    ...(choices ? { choices: choices.map(label => clip(label, 80)) } : {}) }, question: first, choices };
}

function formCard(mode, message, schema) {
  const card = { title: '等待填写', interaction: true,
    reason: mode === 'url' ? '请在电脑上打开浏览器完成验证。' : clip(message || '请在电脑上查看表单。', 700) };
  if (mode !== 'form' || schema?.type !== 'object' || !schema.properties) return { card };
  const fields = Object.entries(schema.properties);
  const details = fields.map(([name, field]) => `${field?.title || name}${field?.description ? ` · ${field.description}` : ''}`);
  card.reason = clip([card.reason, ...details].join('\n'), 900);
  if (fields.length !== 1) return { card };
  const [name, field] = fields[0];
  if (Array.isArray(schema.required) && schema.required.some(required => required !== name)) return { card };
  // Only an ordinary boolean or a two-value enum can be reproduced without a desktop form.
  const titled = Array.isArray(field?.oneOf) ? field.oneOf : [];
  const binaryBoolean = field?.type === 'boolean';
  const values = binaryBoolean ? [false, true] : field?.type === 'string' ? (field.enum || titled.map(option => option?.const)) : null;
  if (!Array.isArray(values) || values.length !== 2 || values[0] === values[1] ||
      !values.every(value => binaryBoolean || (typeof value === 'string' && value.trim()))) return { card };
  const labels = binaryBoolean ? ['否', '是'] : values.map((value, index) =>
    String(field.enum ? field.enumNames?.[index] || value : titled[index]?.title || value));
  if (!labels.every(label => label.trim()) || labels[0] === labels[1]) return { card };
  card.choices = labels.map(label => clip(label, 80));
  card.reason = clip(`${card.reason}\n1. ${labels[0]}\n2. ${labels[1]}`, 1000);
  return { card, content: decision => ({ [name]: values[decision === 'allow' ? 1 : 0] }) };
}

function arg(argv, name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

async function runHook(argv) {
  const agent = arg(argv, 'agent', 'agent');
  const event = arg(argv, 'event', 'permission');     // permission | pretool | stop | notification
  if (agent === 'workbuddy' && event !== 'stop') return;
  const desktopCodex = agent === 'codex' && process.env.AGENTREMINDER_CODEX_DUAL_APPROVAL === '1';
  if (desktopCodex && event === 'permission') {
    // The app-server proxy mirrors the native request after Codex creates it.
    return;
  }
  const input = await readStdin();
  const cfg = loadConfig();
  if (!desktopCodex && !integrationAllowed(cfg, agent)) return;
  const session = describeSession(input, agent, process.cwd());
  const out = (obj) => { if (obj) process.stdout.write(JSON.stringify(obj)); };

  try {
    if (event === 'question' || event === 'elicitation') {
      if (!(await ensureDaemon())) return;
      const form = event === 'elicitation';
      const request = form ? formCard(input.mode, input.message, input.requested_schema) :
        questionCard(input.tool_input?.questions, agent === 'claude');
      if (!form && input.tool_input?.answers && Object.keys(input.tool_input.answers).length) return;
      const info = { agent, ...session, ...request.card };
      if (!info.choices) {
        await call('POST', '/notify', { info: { ...info, kind: 'input' } }, 3000);
        return;
      }
      const timeoutSec = cfg.approvalTimeoutSec;
      const { decision } = await call('POST', '/interaction', { timeoutSec, info }, (timeoutSec + 10) * 1000);
      if (!decision) return;
      if (form) out({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: request.content(decision) } });
      else out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: {
        ...input.tool_input, answers: { [request.question.question]: request.choices[decision === 'allow' ? 1 : 0] },
      } } });
      return;
    }

    if (event === 'permission' || event === 'pretool') {
      if (!(await ensureDaemon())) return;
      const { title, detail, reason } = describeTool(input);
      const timeoutSec = cfg.approvalTimeoutSec;
      const r = await call('POST', '/approval', { timeoutSec, info: { agent, ...session, title, detail, reason } }, (timeoutSec + 10) * 1000);
      if (!r.decision) return;                         // no device / timeout / "use terminal": normal flow
      const msg = r.decision === 'deny' ? 'Denied from AgentReminder' : 'Approved from AgentReminder';
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
      await call('POST', '/notify', { info: { agent, ...session, kind: 'done', title: '任务完成',
        detail: clip(input.last_assistant_message || '', 400) } }, 3000);
      return;                                          // never block stopping
    }

    if (event === 'notification') {
      const type = input.notification_type || input.matcher || '';
      if (type === 'permission_prompt') return;        // covered by PermissionRequest
      if (!cfg.notify.idle) return;
      if (!(await ensureDaemon())) return;
      const needsInput = ['agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog', 'auth_storage_failure', 'quota_auto_resume_disabled'].includes(type);
      const detail = type === 'elicitation_url_dialog' ? '请在电脑上打开浏览器完成验证。' : clip(input.message || '', 400);
      await call('POST', '/notify', { info: { agent, ...session, kind: needsInput ? 'input' : type === 'idle_prompt' ? 'idle' : 'info',
        title: type === 'idle_prompt' ? '等待你的输入' : (input.title || '通知'), detail, ...(needsInput ? { reason: detail } : {}) } }, 3000);
    }
  } catch (e) {
    log('hook error', agent, event, e.message);       // never break the agent
  }
}

/* -------------------------------- CLI ------------------------------- */

function integrationAllowed(config, agent) {
  return !INTEGRATION_AGENTS.includes(agent) || config.agentIntegrations?.[agent] !== false;
}

function readHookSettings(file) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings: ' + file);
  return settings;
}

function mergeHooks(file, hooks, agent) {
  const cur = readHookSettings(file);
  cur.hooks = cur.hooks || {};
  for (const [ev, groups] of Object.entries(hooks)) {
    const newCommands = new Set(groups.flatMap(group => group.hooks.map(hook => hook.command)).filter(command => typeof command === 'string'));
    const keep = (cur.hooks[ev] || []).flatMap(group => {
      if (!Array.isArray(group?.hooks)) return [group];
      const rules = group.hooks.filter(hook =>
        !newCommands.has(hook?.command) && !(agent && managedHookAgent(hook) === agent));
      if (rules.length === group.hooks.length) return [group];
      return rules.length ? [{ ...group, hooks: rules }] : [];
    });
    if (keep.length || groups.length) cur.hooks[ev] = [...keep, ...groups];
    else delete cur.hooks[ev];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n');
  return file;
}

function shellQuote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
function hookCmd(agent, event) { return `${shellQuote(process.execPath)} ${shellQuote(__filename)} hook --agent ${agent} --event ${event}`; }

function agentConfigDirectory(agent) {
  return path.resolve(process.env[AGENT_CONFIG_ENV[agent]] ||
    loadConfig().agentConfigDirs?.[agent] || path.join(os.homedir(), '.' + agent));
}

const hookSettings = {
  get codex() { return path.join(agentConfigDirectory('codex'), 'hooks.json'); },
  get claude() { return path.join(agentConfigDirectory('claude'), 'settings.json'); },
  dsh: path.join(HOME_DIR, 'dsh-hooks.json'),
  workbuddy: path.join(WORKBUDDY_DIR, 'settings.json'),
};

// Match the hook command generated by install, including installations from a checkout.
const managedCommand = /^'(?:[^']|'\\'')+' '(?:[^']|'\\'')*\/host\/agentreminder\.js' hook --agent (codex|claude|dsh|workbuddy) --event (permission|pretool|stop|notification|question|elicitation)$/;

function managedHookAgent(hook) {
  return hook?.type === 'command' && typeof hook.command === 'string' ? hook.command.match(managedCommand)?.[1] : undefined;
}

const codexEvents = { Stop: 'stop', PermissionRequest: 'permission' };

function codexHookPositions(settings) {
  return Object.fromEntries(Object.entries(codexEvents).map(([event, kind]) => {
    const groups = settings.hooks?.[event] || [];
    const indices = groups.flatMap((group, i) => Array.isArray(group?.hooks)
      ? group.hooks.flatMap((hook, j) => managedHookAgent(hook) === 'codex' ? [`${i}:${j}`] : []) : []);
    return [kind === 'permission' ? 'permissionRequest' : kind, indices];
  }));
}

function installCodexHooks(file, approvalTimeout, existingOnly) {
  const previous = readHookSettings(file);
  if (existingOnly && !Object.values(codexHookPositions(previous)).some(indices => indices.length)) return null;
  const hooks = { ...previous.hooks };
  const runningNode = codexHooks.realPath(process.execPath);
  const stableNode = codexHooks.findExecutable('node', candidate => codexHooks.realPath(candidate) === runningNode)
    || process.execPath;
  const changed = [];

  for (const [event, kind] of Object.entries(codexEvents)) {
    const timeout = event === 'Stop' ? 10 : approvalTimeout;
    const suffix = ` ${shellQuote(__filename)} hook --agent codex --event ${kind}`;
    const desired = { type: 'command', command: shellQuote(stableNode) + suffix, timeout };
    const before = hooks[event] || [];
    let retained = false;
    const after = before.flatMap(group => {
      if (!Array.isArray(group?.hooks)) return [group];
      const unfiltered = group.matcher == null || group.matcher === '' || group.matcher === '*';
      const rules = group.hooks.flatMap(hook => {
        if (managedHookAgent(hook) !== 'codex') return [hook];
        if (retained || !unfiltered) return [];
        retained = true;
        // A legacy absolute Node path can remain trusted while it resolves to this runtime.
        const interpreter = hook.command.endsWith(suffix)
          ? hook.command.slice(0, -suffix.length).slice(1, -1).replaceAll("'\\''", "'") : '';
        const sameCommand = path.isAbsolute(interpreter) && codexHooks.realPath(interpreter) === runningNode;
        return [sameCommand && hook.timeout === timeout ? hook : { ...hook, ...desired }];
      });
      if (rules.length === group.hooks.length && rules.every((rule, i) => rule === group.hooks[i])) return [group];
      return rules.length ? [{ ...group, hooks: rules }] : [];
    });
    if (!retained) after.push({ hooks: [desired] });
    if (!isDeepStrictEqual(before, after)) {
      hooks[event] = after;
      changed.push(event);
    }
  }
  if (changed.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
    writePrivateFile(codexHooks.realPath(file), JSON.stringify({ ...previous, hooks }, null, 2) + '\n');
  }
  return changed;
}

function reportCodexInstall(changed, report) {
  if (!changed) return;
  const english = process.env.AGENTREMINDER_LANG === 'en';
  if (!changed.length) {
    report(english ? 'Codex hooks are unchanged. Existing trust settings are preserved.'
      : 'Codex hooks 定义未变，保留现有信任。');
    return;
  }
  const events = changed.join(', ');
  report(english
    ? `Codex hooks configured or changed (${events}). In desktop Settings → Hooks or CLI /hooks, review and trust the AgentReminder PermissionRequest and Stop hooks marked for review.`
    : `Codex hooks 已配置或变更（${events}）。请在桌面端「设置 → Hooks」或 CLI /hooks 审核并信任待审核的 AgentReminder hooks。`);
}

function integrationHasHooks(agent) {
  let file;
  try { file = JSON.parse(fs.readFileSync(hookSettings[agent], 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const requiredEvents = agent === 'workbuddy' ? ['Stop'] : ['Stop', agent === 'dsh' ? 'PreToolUse' : 'PermissionRequest'];
  return requiredEvents.every(event => {
    const groups = file?.hooks?.[event];
    return Array.isArray(groups) && groups.some(group =>
      Array.isArray(group?.hooks) && group.hooks.some(hook => managedHookAgent(hook) === agent));
  });
}

function integrationStatus(config, agent) {
  if (!integrationAllowed(config, agent)) return 'disabled';
  try { return integrationHasHooks(agent) ? 'enabled' : 'unconfigured'; }
  catch (_) { return 'unavailable'; }
}

function claudeExecutableOnPath() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'claude');
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* try the next PATH entry */ }
  }
}

function claudeElicitationSupported(executable) {
  if (!executable) return false;
  try {
    const output = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const version = output.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!version) return false;
    const [, major, minor, patch] = version.map(Number);
    return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 76)));
  } catch (_) { return false; }
}

function install(target, report = console.log, claudeExecutable) {
  const t = (cfg) => ({ type: 'command', command: cfg.cmd, timeout: cfg.timeout });
  const appr = loadConfig().approvalTimeoutSec + 30;
  if (target === 'codex') {
    reportCodexInstall(installCodexHooks(hookSettings.codex, appr, false), report);
  } else if (target === 'dsh') {
    const f = mergeHooks(hookSettings.dsh, {
      PreToolUse: [{ matcher: loadConfig().dshMatcher || 'bash|shell|write|edit|apply_patch|Bash|Shell|Write|Edit|MultiEdit',
        hooks: [t({ cmd: hookCmd('dsh', 'pretool'), timeout: appr })] },
        { matcher: 'AskUserQuestion|ask_user_question', hooks: [t({ cmd: hookCmd('dsh', 'question'), timeout: 10 })] }],
      Notification: [{ matcher: 'agent_needs_input|elicitation_dialog|elicitation_url_dialog', hooks: [t({ cmd: hookCmd('dsh', 'notification'), timeout: 10 })] }],
      Stop: [{ hooks: [t({ cmd: hookCmd('dsh', 'stop'), timeout: 10 })] }],
    }, target);
    report(`已写入 ${f}\n把 integrations/dsh/cordis.patch.yml 里的 configPath 指向它（见 README）。`);
  } else if (target === 'claude') {
    const savedExecutable = loadConfig().claudeExecutable;
    const executable = claudeExecutable || (typeof savedExecutable === 'string' && path.isAbsolute(savedExecutable)
      && fs.existsSync(savedExecutable) ? savedExecutable : claudeExecutableOnPath());
    const elicitation = claudeElicitationSupported(executable);
    const notifications = 'idle_prompt|agent_needs_input|auth_storage_failure|quota_auto_resume_disabled';
    const f = mergeHooks(hookSettings.claude, {
      PermissionRequest: [{ hooks: [t({ cmd: hookCmd('claude', 'permission'), timeout: appr })] }],
      PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [t({ cmd: hookCmd('claude', 'question'), timeout: appr })] }],
      Elicitation: elicitation ? [{ hooks: [t({ cmd: hookCmd('claude', 'elicitation'), timeout: appr })] }] : [],
      Notification: [{ matcher: elicitation ? notifications : `${notifications}|elicitation_dialog|elicitation_url_dialog`,
        hooks: [t({ cmd: hookCmd('claude', 'notification'), timeout: 10 })] }],
      Stop: [{ hooks: [t({ cmd: hookCmd('claude', 'stop'), timeout: 10 })] }],
    }, target);
    report(`已写入 ${f}（推荐改用插件方式安装，见 README）`);
  } else if (target === 'workbuddy') {
    const f = mergeHooks(hookSettings.workbuddy, {
      Stop: [{ hooks: [t({ cmd: hookCmd(target, 'stop'), timeout: 10 })] }],
    }, target);
    report(`已写入 ${f}。请重开 WorkBuddy。`);
  } else {
    report('用法: agentreminder install codex|dsh|claude|workbuddy');
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'hook': return runHook(rest);
    case 'daemon': return runDaemon();
    case 'pair': return pairDevice();
    case 'setup-usb': return setupUsb();
    case 'menu-start': return preparePairing();
    case 'firmware-prepare': {
      const result = await call('POST', '/firmware/prepare', {}, 2000);
      if (result.error === 'approval-pending') {
        throw new Error(rest.includes('en') ? 'Finish pending approvals or pairing before updating firmware.' : '请先处理待审批或配对请求，再更新固件。');
      }
      if (!result.ok) throw new Error(rest.includes('en') ? 'The service could not release USB.' : '服务未能释放 USB 串口。');
      return;
    }
    case 'start': {
      const ok = await ensureDaemon();
      console.log(ok ? 'daemon running' : 'daemon failed, see ' + LOG_PATH);
      if (!ok) process.exitCode = 1;
      return;
    }
    case 'stop': {
      const stopped = await stopLocalDaemon();
      if (!stopped && rest[0] === '--if-running') process.exitCode = 3;
      console.log(stopped ? 'stopped' : 'local daemon not running');
      return;
    }
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
    case 'codex-hook-status': {
      const file = hookSettings.codex;
      const positions = codexHookPositions(readHookSettings(file));
      console.log(JSON.stringify(await codexHooks.trustStatus(file, positions, process.env.AGENTREMINDER_CODEX_APP)));
      return;
    }
    case 'refresh-codex-hooks':
      return reportCodexInstall(installCodexHooks(hookSettings.codex, loadConfig().approvalTimeoutSec + 30, true), console.log);
    case 'install': {
      const agent = rest[0];
      const claudeExecutable = agent === 'claude' ? claudeExecutableOnPath() : undefined;
      install(agent, console.log, claudeExecutable);
      // Menu daemons launched at login do not inherit the installer's shell variables.
      const directory = Object.hasOwn(AGENT_CONFIG_ENV, agent) && process.env[AGENT_CONFIG_ENV[agent]]
        ? agentConfigDirectory(agent) : undefined;
      if (!directory && !claudeExecutable) return;
      const settings = readSavedConfig();
      if (directory) settings.agentConfigDirs = { ...settings.agentConfigDirs, [agent]: directory };
      if (claudeExecutable) settings.claudeExecutable = claudeExecutable;
      ensureHome();
      writePrivateFile(CONFIG_PATH, JSON.stringify(settings, null, 2) + '\n');
      return;
    }
    case 'log': process.stdout.write(fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').split('\n').slice(-60).join('\n') + '\n' : ''); return;
    case '-v': case 'version': console.log(VERSION); return;
    default:
      console.log(`agentreminder ${VERSION}
  start | stop | status | log      守护进程
  pair                              通过 USB 配对，需在设备上确认
  test                              向设备发测试通知和审批
  wifi <SSID> <密码>                通过 USB 给设备配 Wi-Fi
  install codex|dsh|claude|workbuddy 手动写入 hook 配置
  hook --agent <a> --event <e>      (由 agent 调用)`);
  }
}

if (require.main === module) {
  if (process.argv[2] === 'daemon') process.env.AGENTREMINDER_FOREGROUND = process.stdout.isTTY ? '1' : '';
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}

module.exports = { Hub, Link, mergeHooks, describeTool, describeSession, transcriptTitle, questionCard, formCard, shellQuote, call, ensureDaemon, stopLocalDaemon, loadConfig, HOME_DIR, hookSettings, managedHookAgent };
