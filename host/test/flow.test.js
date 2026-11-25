'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const host = path.resolve(__dirname, '../agentreminder.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
function childResult(child, input) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(input));
  });
}
test('real hook processes → daemon → TCP device → agent-compatible JSON', { timeout: 20000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentreminder-flow-'));
  const sockets = new Set(), received = [];
  let decision = 'allow';
  const device = net.createServer(sock => {
    sockets.add(sock); sock.on('close', () => sockets.delete(sock)); let buf = '';
    sock.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); received.push(m);
        if (m.t === 'hello') sock.write('{"t":"hello","app":"agentreminder","id":"flow-test"}\n');
        if (m.t === 'approval' && decision) sock.write(JSON.stringify({ t: 'decision', id: m.id, decision }) + '\n');
      }
    });
  });
  const wifiPort = await listen(device);
  const temp = net.createServer(); const httpPort = await listen(temp); await new Promise(r => temp.close(r));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ httpPort, usb: { enabled: false }, wifi: { enabled: true, hosts: ['127.0.0.1'], port: wifiPort } }));
  const env = { ...process.env, AGENTREMINDER_HOME: home };
  delete env.AGENTREMINDER_CODEX_DUAL_APPROVAL;
  const daemon = spawn(process.execPath, [host, 'daemon'], { env, stdio: 'ignore' });
  t.after(() => { daemon.kill(); for (const sock of sockets) sock.destroy(); device.close(); fs.rmSync(home, { recursive: true, force: true }); });
  for (let i = 0; i < 100 && !received.some(m => m.t === 'hello'); i++) await sleep(30);
  assert(received.some(m => m.t === 'hello')); await sleep(30);
  const relayHost = received.find(m => m.t === 'hello').host;
  assert(relayHost);
  const hook = (agent, event, input) => childResult(spawn(process.execPath, [host, 'hook', '--agent', agent, '--event', event], { env }), input);
  for (const agent of ['claude', 'codex', 'dsh']) {
    for (decision of ['allow', 'deny', 'skip']) {
      const event = agent === 'dsh' ? 'pretool' : 'permission';
      const out = await hook(agent, event, { conversation_title: '实际对话名称：设备验证', cwd: '/tmp/项目', tool_name: agent === 'dsh' ? 'bash' : 'Bash', tool_input: { command: 'echo test审批' } });
      if (decision === 'skip') { assert.equal(out, ''); continue; }
      const result = JSON.parse(out).hookSpecificOutput;
      assert.equal(agent === 'dsh' ? result.permissionDecision : result.decision.behavior, decision);
      assert.equal(received.filter(m => m.t === 'approval').at(-1).detail, 'echo test审批');
      assert.equal(received.filter(m => m.t === 'approval').at(-1).conversation, '实际对话名称：设备验证');
      assert.equal(received.filter(m => m.t === 'approval').at(-1).project, '项目');
      assert.equal(received.filter(m => m.t === 'approval').at(-1).host, relayHost);
    }
    assert.equal(await hook(agent, 'stop', { last_assistant_message: '完成', cwd: '/tmp/项目' }), '');
    assert.equal(received.filter(m => m.t === 'notify').at(-1).detail, '完成');
    assert.equal(received.filter(m => m.t === 'notify').at(-1).project, '项目');
    assert.equal(received.filter(m => m.t === 'notify').at(-1).host, relayHost);
  }

  // A simulated App Server gives the actual stdio wrapper and device daemon a shared request.
  const appServer = path.join(home, 'app-server-fixture');
  fs.writeFileSync(appServer, `#!${process.execPath}
const readline = require('node:readline');
const send = message => console.log(JSON.stringify(message));
if (process.env.AGENTREMINDER_CODEX_DUAL_APPROVAL !== '1') process.exit(3);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'fixture/trigger') {
    send({ id: message.params.requestId, method: 'item/commandExecution/requestApproval', params: { reason: '双端测试' } });
  } else if (message.result) {
    send({ method: 'serverRequest/resolved', params: { requestId: message.id } });
    send({ method: 'fixture/received', params: message.result });
  }
});`, { mode: 0o700 });
  const proxy = spawn(process.execPath, [path.resolve(__dirname, '../codex-approval-proxy.js'), 'app-server'], {
    env: { ...env, AGENTREMINDER_CODEX_REAL_CLI: appServer },
  });
  t.after(() => proxy.kill());
  const desktop = [];
  readline.createInterface({ input: proxy.stdout }).on('line', line => desktop.push(JSON.parse(line)));
  const send = message => proxy.stdin.write(JSON.stringify(message) + '\n');
  async function until(check) {
    for (let i = 0; i < 150 && !check(); i++) await sleep(20);
    assert(check());
  }

  decision = null;
  const before = received.length;
  send({ method: 'fixture/trigger', params: { requestId: 100 } });
  await until(() => desktop.some(m => m.id === 100) && received.slice(before).some(m => m.t === 'approval'));
  const card = received.slice(before).find(m => m.t === 'approval');
  send({ id: 100, result: { decision: 'decline' } });
  await until(() => received.some(m => m.t === 'cancel' && m.id === card.id));

  decision = 'allow';
  send({ method: 'fixture/trigger', params: { requestId: 101 } });
  await until(() => desktop.some(m => m.method === 'serverRequest/resolved' && m.params.requestId === 101));
  assert(desktop.some(m => m.method === 'fixture/received' && m.params.decision === 'accept'));
  proxy.stdin.end();
});
