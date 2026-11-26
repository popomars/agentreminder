'use strict';

// Mirror native App Server requests on the menu and ESP32 without changing Codex's UI.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { call, ensureDaemon, loadConfig, describeSession, questionCard, formCard } = require('./agentreminder');

const approvalTypes = {
  'item/commandExecution/requestApproval': '执行命令',
  'item/fileChange/requestApproval': '修改文件',
};

function approvalCard(message) {
  const title = Object.hasOwn(approvalTypes, message.method) ? approvalTypes[message.method] : null;
  if (!title || (typeof message.id !== 'number' && typeof message.id !== 'string')) return null;
  const params = message.params || {};
  // The device has two choices. Leave prompts with other required choices in Codex.
  if (!approvalChoices(message)) return null;
  const network = params.networkApprovalContext;
  const reason = params.reason || (network?.host ? `访问网络：${network.host}` : params.command);
  return {
    agent: 'codex', title,
    ...describeSession({ thread_id: params.threadId, cwd: params.cwd }, 'codex'),
    reason: typeof reason === 'string' ? reason.slice(0, 300) : '',
    ...(typeof params.command === 'string' && params.command !== reason ? { detail: params.command.slice(0, 500) } : {}),
  };
}

function approvalChoices(message) {
  const choices = message.params?.availableDecisions;
  if (!Array.isArray(choices) || !choices.length) return { allow: 'accept', deny: 'decline' };
  const deny = choices.includes('decline') ? 'decline' : choices.includes('cancel') ? 'cancel' : null;
  return choices.includes('accept') && deny ? { allow: 'accept', deny } : null;
}

function inputRequest(message) {
  const params = message.params || {};
  let request;
  let respond;
  switch (message.method) {
    case 'item/tool/requestUserInput': {
      const questionId = params.questions?.[0]?.id;
      // Codex adds an optional free-text choice alongside the provided options.
      request = questionCard(params.questions, typeof questionId === 'string' && !!questionId, { allowOptionalOther: true });
      if (request.choices) respond = decision => ({ answers: {
        [request.question.id]: { answers: [request.choices[decision === 'allow' ? 1 : 0]] },
      } });
      break;
    }
    case 'mcpServer/elicitation/request':
      request = formCard(params.mode, params.message, params.requestedSchema);
      if (request.content) respond = decision => ({ action: 'accept', content: request.content(decision) });
      break;
    case 'item/permissions/requestApproval':
    case 'applyPatchApproval':
    case 'execCommandApproval':
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      request = { card: { title: '请在电脑上审批', interaction: true,
        reason: typeof params.reason === 'string' ? params.reason.slice(0, 600) : '有一条审批需要在电脑上处理。' } };
      break;
    default: return null;
  }
  return { card: { agent: 'codex', ...describeSession({ thread_id: params.threadId, cwd: params.cwd }, 'codex'), ...request.card }, respond };
}

function report(event, details) {
  const home = process.env.AGENTREMINDER_HOME || path.join(os.homedir(), '.agentreminder');
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(path.join(home, 'codex-bridge.log'),
      JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n', { mode: 0o600 });
  } catch (_) { /* diagnostic logging must not interrupt approvals */ }
}

class ApprovalBridge {
  constructor({ toDesktop, toServer, askDevice, makeCard = approvalCard, trace = () => {} }) {
    this.toDesktop = toDesktop;
    this.toServer = toServer;
    this.askDevice = askDevice;
    this.makeCard = makeCard;
    this.trace = trace;
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
    if ((typeof id !== 'number' && typeof id !== 'string') || this.pending.has(id)) return;
    if (Object.hasOwn(approvalTypes, message.method)) {
      const choices = message.params?.availableDecisions;
      this.trace('native-request', { id, method: message.method,
        choices: Array.isArray(choices) ? choices.map(item => typeof item === 'string' ? item : 'structured') : null });
    }
    let card = this.makeCard(message);
    let respond;
    if (card) {
      const choices = approvalChoices(message);
      if (choices) respond = decision => ({ decision: choices[decision] });
    } else {
      const input = inputRequest(message);
      card = input?.card;
      respond = input?.respond;
    }
    if (!card) return;
    this.answered.delete(id);
    const controller = new AbortController();
    this.pending.set(id, controller);
    this.settleFromDevice(id, card, controller, respond);
  }

  async settleFromDevice(id, card, controller, respond) {
    try {
      const result = await this.askDevice(card, controller.signal);
      if (this.pending.get(id) !== controller) return;
      this.trace('device-response', { id, decision: result?.decision || null, reason: result?.reason || null });
      if (!respond || (result?.decision !== 'allow' && result?.decision !== 'deny')) return;
      this.answered.add(id);
      if (this.answered.size > 256) this.answered.delete(this.answered.values().next().value);
      this.toServer(JSON.stringify({
        id,
        result: respond(result.decision),
      }));
    } catch (error) {
      if (!controller.signal.aborted) this.trace('device-error', { id, code: error.code || error.name });
      // The native approval stays available when the device goes offline.
    } finally {
      if (this.pending.get(id) === controller) this.pending.delete(id);
    }
  }

  fromDesktop(line) {
    const message = parse(line);
    if (message && !message.method && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      if (this.answered.has(message.id)) return;
      if (this.pending.has(message.id)) this.trace('desktop-answer', { id: message.id });
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
  return call('POST', info.interaction ? '/interaction' : '/approval', { timeoutSec, info }, (timeoutSec + 10) * 1000, signal);
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
  report('started', { pid: process.pid });

  const bridge = new ApprovalBridge({
    toDesktop: line => process.stdout.write(line + '\n'),
    toServer: line => { if (child.stdin.writable) child.stdin.write(line + '\n'); },
    askDevice,
    trace: report,
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
