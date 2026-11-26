'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');

const run = promisify(execFile);
const PEER_PATH = '/v1/peer';
const hex = /^[0-9a-f]{64}$/;
const CARD_PATH = '/v1/card';
const MAX_BODY = 64 * 1024;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function isTailnetAddress(address) {
  if (!net.isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 100 && second >= 64 && second < 128;
}

function validateConfig(config) {
  const { listen, peers, key, port = 47323 } = config;
  const manual = listen !== undefined || peers !== undefined;
  if (!hex.test(typeof key === 'string' ? key : '') || !Number.isInteger(port) || port < 1024 || port > 65535 ||
      (manual && (!isTailnetAddress(listen) || !Array.isArray(peers) || peers.length < 1 || peers.length > 32 ||
        peers.some(peer => peer === listen || !isTailnetAddress(peer))))) {
    throw new Error('invalid Tailnet configuration: expected a 64-hex key and optional port or explicit listen and peers');
  }
  return { listen, peers: manual ? [...new Set(peers)].map(address => ({ address, port })) : null, key, port };
}

function discoverySnapshot(status) {
  if (status.BackendState !== 'Running') return { listen: null, peers: [] };
  const local = (status.TailscaleIPs || []).find(isTailnetAddress);
  const addresses = Object.values(status.Peer || {}).filter(peer => peer.Online !== false)
    .flatMap(peer => (peer.TailscaleIPs || []).filter(isTailnetAddress));
  return { listen: local || null, peers: local ? [...new Set(addresses)].filter(address => address !== local) : [] };
}

async function discoverPeers() {
  const commands = process.platform === 'darwin' ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'] : ['tailscale'];
  let failure;
  for (const command of commands) {
    try {
      const { stdout } = await run(command, ['status', '--json'], {
        timeout: 3000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TAILSCALE_BE_CLI: '1' },
      });
      return discoverySnapshot(JSON.parse(stdout));
    } catch (error) { failure = error; }
  }
  throw new Error(failure?.code === 'ENOENT' ? 'Tailscale CLI not found' : 'Could not read Tailscale status');
}

async function readText(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Tailnet message too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(stream) {
  return JSON.parse(await readText(stream));
}

function firstDecision(requests) {
  return new Promise(resolve => {
    let remaining = requests.length;
    for (const request of requests) {
      request.then(result => {
        if (result.decision || result.action === 'skip' || --remaining === 0) resolve(result);
      });
    }
  });
}

function createMesh(config, hub, log, discover = discoverPeers) {
  const { port, key } = config;
  const automatic = config.peers === null;
  let listen = config.listen;
  let peers = config.peers || [];
  const outgoing = new Map();
  const challenges = new Map();
  let listening = false, closed = false, refreshing = false, timer, discoveryError;
  const secret = Buffer.from(key, 'hex');
  const mac = (scope, from, to, data) => crypto.createHmac('sha256', secret)
    .update(`${scope}:${from}:${to}:`).update(data).digest('hex');
  const matches = (actual, expected) => typeof actual === 'string' && hex.test(actual) &&
    crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  const nonce = () => crypto.randomBytes(32).toString('hex');

  function request({ address, port: peerPort }, path, data, headers, signal) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: address, port: peerPort, localAddress: listen, path, method: 'POST', signal, agent: false,
        headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      }, async res => {
        try {
          const result = await readJson(res);
          if (res.statusCode !== 200 || !result || typeof result !== 'object') throw new Error(`HTTP ${res.statusCode}`);
          resolve(result);
        } catch (error) { reject(error); }
      });
      req.on('error', reject);
      req.end(data);
    });
  }

  async function post(peer, card, timeoutMs, signal) {
    try {
      const probe = nonce();
      const { challenge, proof } = await request(peer, PEER_PATH, '', {
        'x-agentreminder-probe': probe,
        'x-agentreminder-proof': mac('probe', listen, peer.address, probe),
      }, AbortSignal.timeout(1000));
      if (signal.aborted || typeof challenge !== 'string' || !hex.test(challenge) ||
          !matches(proof, mac('peer', listen, peer.address, probe + challenge))) return {};
      const data = JSON.stringify({ card, timeoutMs });
      return await request(peer, CARD_PATH, data, {
        'x-agentreminder-challenge': challenge, 'x-agentreminder-proof': mac('card', listen, peer.address, challenge + data),
      }, signal);
    } catch (error) {
      if (!automatic && !signal.aborted) log('Tailnet peer unavailable', peer.address, error.code || error.message);
      return {};
    }
  }

  const server = http.createServer(async (req, res) => {
    const reply = (code, result) => {
      if (res.destroyed) return;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    };
    if (req.method !== 'POST' || ![CARD_PATH, PEER_PATH].includes(req.url)) return reply(404, {});
    const address = req.socket.remoteAddress;
    if (req.headers.origin || !peers.some(peer => peer.address === address)) return reply(403, {});
    const local = req.socket.localAddress;
    const proof = req.headers['x-agentreminder-proof'];
    if (req.url === PEER_PATH) {
      const probe = req.headers['x-agentreminder-probe'];
      if (typeof probe !== 'string' || !hex.test(probe) || !matches(proof, mac('probe', address, local, probe))) return reply(403, {});
      const now = Date.now();
      for (const [challenge, issued] of challenges) if (issued.expires <= now) challenges.delete(challenge);
      if (challenges.size >= 4096) return reply(429, {});
      const challenge = nonce();
      challenges.set(challenge, { address, expires: now + 5000 });
      return reply(200, { challenge, proof: mac('peer', address, local, probe + challenge) });
    }
    try {
      const challenge = req.headers['x-agentreminder-challenge'];
      const issued = challenges.get(challenge);
      if (issued?.address !== address || issued.expires <= Date.now()) return reply(403, {});
      const data = await readText(req);
      if (!challenges.has(challenge) || issued.expires <= Date.now() || !matches(proof, mac('card', address, local, challenge + data))) return reply(403, {});
      challenges.delete(challenge);
      const { card, timeoutMs } = JSON.parse(data);
      if (res.destroyed) return;
      if (!card || !uuid.test(card.id) || !['approval', 'notify'].includes(card.t) ||
          typeof card.host !== 'string' || typeof card.receivedTime !== 'string' ||
          !Number.isSafeInteger(card.ts)) return reply(400, {});
      if (card.t === 'notify') return reply(200, { delivered: hub.notify(card, card) });
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) return reply(400, {});
      if (hub.pending.has(card.id) || [...hub.pending.values()].some(pending => pending.target)) {
        return reply(200, { decision: null, reason: 'busy' });
      }
      const { id, promise } = hub.requestApproval(card, timeoutMs, null, null, card);
      res.on('close', () => { if (!res.writableEnded) hub.cancel(id, 'origin-gone'); });
      reply(200, await promise);
    } catch (_) { reply(400, {}); }
  });
  server.on('error', error => log('Tailnet listener error', error.code || error.message));
  server.on('listening', () => { listening = true; log('Tailnet listener ready', listen, port); });
  server.on('close', () => { listening = false; });

  function stopListener() {
    return new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }

  async function refresh() {
    if (refreshing || closed) return;
    refreshing = true;
    try {
      const next = await discover();
      if (closed) return;
      if (next.listen !== listen && server.listening) await stopListener();
      if (closed) return;
      listen = next.listen;
      peers = next.peers.map(address => ({ address, port }));
      discoveryError = undefined;
      if (listen && !server.listening) server.listen(port, listen);
    } catch (error) {
      if (error.message !== discoveryError) log('Tailnet discovery error', error.message);
      discoveryError = error.message;
    } finally { refreshing = false; }
  }

  return {
    start() {
      if (!automatic) return server.listen(port, listen);
      timer = setInterval(refresh, 10000);
      timer.unref();
      return refresh();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await stopListener();
    },
    refresh,
    status: () => ({ listen, port, peers: peers.map(peer => peer.address), listening, automatic,
      ...(discoveryError ? { error: discoveryError } : {}) }),
    outgoing,
    async approval(info, timeoutMs, res) {
      const card = hub.approvalCard(info, timeoutMs);
      const controller = new AbortController();
      const { signal } = controller;
      function cancel(reason) {
        controller.abort();
        hub.cancel(card.id, reason);
      }
      const close = () => { if (!res.writableEnded) cancel('hook-gone'); };
      res.on('close', close);
      const timer = setTimeout(() => cancel('timeout'), timeoutMs);
      let handoff;
      const handedOff = new Promise(resolve => {
        handoff = () => resolve({ decision: null, reason: 'menu-bar' });
      });
      outgoing.set(card.id, { card, handoff });
      try {
        const local = hub.requestApproval(info, timeoutMs, null, null, card).promise;
        const remote = peers.map(async peer => {
          const result = await post(peer, card, timeoutMs, signal);
          if (result.decision !== 'allow' && result.decision !== 'deny' && result.action !== 'skip') {
            return { decision: null, reason: 'no-device' };
          }
          return { decision: result.action === 'skip' ? null : result.decision, action: result.action, reason: `tailnet:${peer.address}` };
        });
        const result = await Promise.race([firstDecision([local, ...remote]), handedOff]);
        return { decision: result.decision, reason: result.reason };
      } finally {
        cancel('settled');
        clearTimeout(timer);
        res.off('close', close);
        outgoing.delete(card.id);
      }
    },
    async notify(info) {
      const card = hub.notificationCard(info);
      const local = hub.notify(info, card);
      const results = await Promise.all(peers.map(peer => post(peer, card, 0, AbortSignal.timeout(2000))));
      return local + results.reduce((total, result) => total + (Number.isSafeInteger(result.delivered) && result.delivered > 0 ? result.delivered : 0), 0);
    },
  };
}

module.exports = { createMesh, validateConfig, discoverySnapshot };
