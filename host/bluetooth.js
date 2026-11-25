'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const helper = path.join(__dirname, 'bluetooth', 'agentreminder-bluetooth');
const nonceSize = 16, tagSize = 16, maxMessage = 16384;

function available() {
  if (process.platform !== 'darwin') return false;
  try { fs.accessSync(helper, fs.constants.X_OK); return true; } catch (_) { return false; }
}

function frame(payload) {
  const header = Buffer.alloc(2);
  header.writeUInt16BE(payload.length);
  return Buffer.concat([header, payload]);
}

function cipherStream(root, direction, hostNonce, deviceNonce) {
  const key = crypto.createHmac('sha256', root).update(`agentreminder-ble-v1:${direction}:`)
    .update(hostNonce).update(deviceNonce).digest();
  let counter = 0n;
  const nextNonce = () => {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(counter++, 4);
    return nonce;
  };
  return {
    seal(message) {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nextNonce());
      return Buffer.concat([cipher.update(message), cipher.final(), cipher.getAuthTag()]);
    },
    open(message) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, nextNonce());
      cipher.setAuthTag(message.subarray(-tagSize));
      return Buffer.concat([cipher.update(message.subarray(0, -tagSize)), cipher.final()]);
    },
  };
}

class Session {
  constructor(key, write, onChallenge, onMessage) {
    this.key = Buffer.from(key, 'hex');
    this.write = write;
    this.onChallenge = onChallenge;
    this.onMessage = onMessage;
    this.hostNonce = crypto.randomBytes(nonceSize);
    this.input = Buffer.alloc(0);
  }
  start() { this.write(frame(this.hostNonce)); }
  send(line) {
    const message = Buffer.from(line);
    if (message.length > maxMessage) throw new Error('BLE message too large');
    this.write(frame(this.tx.seal(message)));
  }
  feed(chunk) {
    this.input = Buffer.concat([this.input, chunk]);
    while (this.input.length >= 2) {
      const size = this.input.readUInt16BE();
      if (this.rx ? size <= tagSize || size > maxMessage + tagSize : size !== nonceSize) {
        throw new Error('Invalid BLE frame');
      }
      if (this.input.length < size + 2) return;
      const payload = this.input.subarray(2, size + 2);
      this.input = this.input.subarray(size + 2);
      if (this.rx) this.onMessage(this.rx.open(payload));
      else {
        this.tx = cipherStream(this.key, 'c2d', this.hostNonce, payload);
        this.rx = cipherStream(this.key, 'd2c', this.hostNonce, payload);
        this.onChallenge();
      }
    }
  }
}

function startBluetooth(hub, Link, log) {
  const cfg = hub.cfg;
  if (!cfg.bluetooth.enabled || !available()) {
    return { tick() {}, status: () => cfg.bluetooth.enabled ? 'unavailable' : 'disabled' };
  }
  let active, retryAt = 0, state = 'unpaired';
  const update = (next) => { if (state !== next) { state = next; log('bluetooth', state); } };
  const tick = () => {
    const id = cfg.usb.pairedDeviceId, key = cfg.bluetooth.key;
    if (!/^[0-9a-f]{12}$/i.test(id || '') || !/^[0-9a-f]{64}$/.test(key || '')) {
      active?.stop(); update('unpaired'); return;
    }
    if (active) {
      if (active.id !== id || active.key !== key) active.stop();
      return;
    }
    if (Date.now() < retryAt) return;

    const child = spawn(helper, [id], { stdio: ['pipe', 'pipe', 'pipe'] });
    let link, started = false, authTimer, stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(authTimer);
      link?.close();
      child.kill();
    };
    active = { id, key, stop };
    const session = new Session(key, bytes => child.stdin.write(bytes), () => {
      link = new Link('ble', id, line => session.send(line), stop, hub);
      link.pairedDeviceId = id;
      hub.add(link);
    }, line => {
      link.feed(line);
      if (link.ready) { clearTimeout(authTimer); update('connected'); }
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      if (stopped || !/^[a-z-]{1,40}$/.test(line)) return;
      if (line === 'ready' && !started) {
        started = true;
        update('authenticating');
        authTimer = setTimeout(() => { update('authentication-timeout'); stop(); }, 5500);
        session.start();
      } else update(line);
    });
    child.stdout.on('data', bytes => {
      if (!started || stopped) return;
      try { session.feed(bytes); } catch (_) { update('authentication-failed'); stop(); }
    });
    child.stdin.on('error', stop);
    child.on('error', () => { update('helper-failed'); stop(); });
    child.on('close', (code, signal) => {
      if (!stopped) {
        if (signal) update('helper-failed');
        else if (!code || state === 'connected') update('disconnected');
      }
      stop();
      active = null;
      retryAt = Date.now() + (['bluetooth-permission', 'bluetooth-unavailable', 'helper-failed'].includes(state) ? 15000 : 1000);
    });
  };
  tick();
  setInterval(tick, 1000).unref();
  return { tick, status: () => state };
}

module.exports = { available, startBluetooth, Session, cipherStream, frame };
