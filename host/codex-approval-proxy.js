'use strict';

// Mirror native App Server requests on the ESP32 without changing Codex's UI.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { call, ensureDaemon, loadConfig, describeSession } = require('./agentreminder');

const approvalTypes = {
  'item/commandExecution/requestApproval': '执行命令',
  'item/fileChange/requestApproval': '修改文件',
};

function approvalCard(message) {
  const title = Object.hasOwn(approvalTypes, message.method) ? approvalTypes[message.method] : null;
  if (!title || (typeof message.id !== 'number' && typeof message.id !== 'string')) return null;
  const params = message.params || {};
  // The device has two choices. Leave prompts with other required choices in Codex.
  if (Array.isArray(params.availableDecisions) &&
      !['accept', 'decline'].every(decision => params.availableDecisions.includes(decision))) return null;
  const project = typeof params.cwd === 'string' ? path.basename(params.cwd) : '';
  const network = params.networkApprovalContext;
  const reason = params.reason || (network?.host ? `访问网络：${network.host}` : params.command);
  return {
    agent: 'codex', title, project,
    ...describeSession({ thread_id: params.threadId }, 'codex'),
    reason: typeof reason === 'string' ? reason.slice(0, 300) : '',
  };
}

class ApprovalBridge {
  constructor({ toDesktop, toServer, askDevice, makeCard = approvalCard }) {
    this.toDesktop = toDesktop;
    this.toServer = toServer;
    this.askDevice = askDevice;
    this.makeCard = makeCard;
    this.pending = new Map();
    this.answered = new Set();
  }

  stopMirroring(id) {
    this.pending.get(id)?.abort();
    this.pending.delete(id);
  }

  fromServer(line) {
    // Codex's original approval is sent immediately, even if the device is offline.
    this.toDesktop(line);
    const message = parse(line);
    if (!message) return;
    if (message.method === 'serverRequest/resolved') {
      this.stopMirroring(message.params?.requestId);
      return;
    }
    const id = message.id;
    if (this.pending.has(id)) return;
    const card = this.makeCard(message);
    if (!card) return;
    this.answered.delete(id);
    const controller = new AbortController();
    this.pending.set(id, controller);
    this.settleFromDevice(id, card, controller);
  }

  async settleFromDevice(id, card, controller) {
    try {
      const result = await this.askDevice(card, controller.signal);
      if (this.pending.get(id) !== controller) return;
      if (result?.decision !== 'allow' && result?.decision !== 'deny') return;
      this.answered.add(id);
      if (this.answered.size > 256) this.answered.delete(this.answered.values().next().value);
      this.toServer(JSON.stringify({
        id,
        result: { decision: result.decision === 'allow' ? 'accept' : 'decline' },
      }));
    } catch (_) {
      // The native approval stays available when the device goes offline.
    } finally {
      if (this.pending.get(id) === controller) this.pending.delete(id);
    }
  }

  fromDesktop(line) {
    const message = parse(line);
    if (message && !message.method && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      if (this.answered.has(message.id)) return;
      this.stopMirroring(message.id);
    }
    this.toServer(line);
  }

  close() {
    for (const id of this.pending.keys()) this.stopMirroring(id);
  }
}

function parse(line) {
  try { return JSON.parse(line); } catch (_) { return null; }
}

async function askDevice(info, signal) {
  if (signal.aborted || !(await ensureDaemon()) || signal.aborted) return null;
  const timeoutSec = loadConfig().approvalTimeoutSec;
  return call('POST', '/approval', { timeoutSec, info }, (timeoutSec + 10) * 1000, signal);
}

function run(args) {
  const realCli = process.env.AGENTREMINDER_CODEX_REAL_CLI;
  if (!realCli || !fs.existsSync(realCli)) throw new Error('Set AGENTREMINDER_CODEX_REAL_CLI to the Codex CLI executable.');
  const index = args.indexOf('app-server');
  const serverArgs = index < 0 ? [] : args.slice(index + 1);
  const management = new Set(['daemon', 'proxy', 'generate-ts', 'generate-json-schema', 'help', '-h', '--help', '--print-startup-config']);
  const mirror = index >= 0 && !serverArgs.some(arg => management.has(arg)) &&
    serverArgs.every((arg, position) => arg.startsWith('--listen=') ? arg === '--listen=stdio://' :
      arg !== '--listen' || serverArgs[position + 1] === 'stdio://');
  const env = { ...process.env };
  if (mirror) env.AGENTREMINDER_CODEX_DUAL_APPROVAL = '1';
  const child = spawn(realCli, args, { env, stdio: mirror ? ['pipe', 'pipe', 'inherit'] : 'inherit' });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('close', code => { process.exitCode = code ?? 1; });
  if (!mirror) return;

  const bridge = new ApprovalBridge({
    toDesktop: line => process.stdout.write(line + '\n'),
    toServer: line => { if (child.stdin.writable) child.stdin.write(line + '\n'); },
    askDevice,
  });
  const desktop = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const server = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  desktop.on('line', line => bridge.fromDesktop(line));
  server.on('line', line => bridge.fromServer(line));
  desktop.once('close', () => { bridge.close(); child.stdin.end(); });
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') console.error(error.message); });
  child.once('close', () => { bridge.close(); desktop.close(); process.stdin.unref?.(); });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { bridge.close(); child.kill(signal); });
  }
}

if (require.main === module) {
  try { run(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { ApprovalBridge, approvalCard };
