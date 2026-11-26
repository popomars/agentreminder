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
  let acceptDevices = true;
  const device = net.createServer(sock => {
    if (!acceptDevices) { sock.destroy(); return; }
    sockets.add(sock); sock.on('close', () => sockets.delete(sock)); let buf = '';
    sock.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); received.push(m);
        if (m.t === 'hello') sock.write('{"t":"hello","app":"agentreminder","id":"flow-test","interaction":true,"notificationDismissals":true}\n');
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
  const inbox = () => fetch(`http://127.0.0.1:${httpPort}/inbox`).then(r => r.json());
  const markRead = ids => fetch(`http://127.0.0.1:${httpPort}/inbox/read`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
  }).then(r => r.json());
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

  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: httpPort, path: '/inbox', headers: { Host: 'example.test' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  const notifications = await inbox();
  assert.equal(notifications.unread, 3);
  assert.equal(notifications.notifications[0].detail, '完成');
  assert.equal(notifications.devices, 1);
  assert.deepEqual(await markRead([notifications.notifications[0].id]), { ok: true });
  assert.equal((await inbox()).unread, 2);

  const question = { question: '请选择部署环境', options: [{ label: '预览' }, { label: '正式' }] };
  decision = 'deny';
  const answer = await hook('claude', 'question', { tool_input: { questions: [question] } });
  assert.deepEqual(JSON.parse(answer).hookSpecificOutput.updatedInput.answers, { [question.question]: '预览' });
  assert.deepEqual(received.filter(m => m.t === 'approval').at(-1).choices, ['预览', '正式']);
  assert.equal(await hook('claude', 'question', { tool_input: { questions: [{ ...question, multiSelect: true }] } }), '');
  assert.equal(received.filter(m => m.t === 'notify').at(-1).kind, 'input');
  assert.equal(await hook('claude', 'question', { tool_input: { questions: [{ ...question, isOther: true }] } }), '');
  assert.equal(received.filter(m => m.t === 'notify').at(-1).kind, 'input');
  assert.equal(await hook('dsh', 'question', { tool_input: { questions: [question] } }), '');
  assert.equal(received.filter(m => m.t === 'notify').at(-1).kind, 'input');
  decision = 'allow';
  const form = await hook('claude', 'elicitation', { mode: 'form', message: '继续吗？', requested_schema: {
    type: 'object', properties: { proceed: { type: 'boolean' } },
  } });
  assert.deepEqual(JSON.parse(form).hookSpecificOutput.content, { proceed: true });

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
  } else if (message.method === 'fixture/trigger-question') {
    send({ id: message.params.requestId, method: 'item/tool/requestUserInput', params: { questions: [{
      id: 'environment', question: '请选择部署环境', isOther: true, options: [{ label: '预览' }, { label: '正式' }],
    }] } });
  } else if (message.result) {
    send({ method: 'serverRequest/resolved', params: { requestId: message.id } });
    send({ method: 'fixture/received', params: { ...message.result, requestId: message.id } });
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
  const [visibleApproval] = (await inbox()).approvals;
  assert.equal(visibleApproval.id, card.id);
  assert.equal(visibleApproval.detail, '双端测试');
  send({ id: 100, result: { decision: 'decline' } });
  await until(() => received.some(m => m.t === 'cancel' && m.id === card.id));
  assert.equal((await inbox()).approvals.length, 0);

  decision = 'allow';
  send({ method: 'fixture/trigger', params: { requestId: 101 } });
  await until(() => desktop.some(m => m.method === 'serverRequest/resolved' && m.params.requestId === 101));
  assert(desktop.some(m => m.method === 'fixture/received' && m.params.decision === 'accept'));

  send({ method: 'fixture/trigger-question', params: { requestId: 102 } });
  await until(() => desktop.some(m => m.method === 'serverRequest/resolved' && m.params.requestId === 102));
  assert.deepEqual(received.filter(m => m.t === 'approval').at(-1).choices, ['预览', '正式']);
  assert(desktop.some(m => m.method === 'fixture/received' && m.params.answers?.environment?.answers[0] === '正式'));
  const sendInbox = (route, data) => fetch(`http://127.0.0.1:${httpPort}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  }).then(r => r.json());
  const clearInbox = (notifications, approvals = []) => sendInbox('/inbox/clear', { notifications, approvals });
  decision = null;
  const waiting = sendInbox('/approval', { info: { title: '清除测试' } });
  await until(() => received.some(message => message.t === 'approval' && message.title === '清除测试'));
  const replacementGroup = { project: '独立项目', conversation: '正在更新的对话', sessionId: 'group-clear-test' };
  await sendInbox('/notify', { info: { ...replacementGroup, title: '打开菜单时的旧通知', kind: 'done' } });
  const snapshot = await inbox();
  assert.equal(snapshot.groupsNotifications, true);
  assert.equal(snapshot.canClear, true);
  assert.equal(snapshot.canUpdateFirmware, true);
  assert.deepEqual(await sendInbox('/firmware/prepare', {}), { error: 'firmware-update-inactive' });
  const updateLock = path.join(home, 'firmware-update.pid');
  fs.writeFileSync(updateLock, String(process.pid));
  assert.deepEqual(await sendInbox('/firmware/prepare', {}), { error: 'approval-pending' });
  const completion = snapshot.notifications.find(note => note.kind === 'done' && note.project === '项目');
  assert(completion);
  assert.equal(completion.host, relayHost);
  const approvalToClear = snapshot.approvals.find(approval => approval.title === '清除测试');
  assert(approvalToClear);

  await sendInbox('/notify', { info: { title: '稍后到达', kind: 'done', conversation: '新对话' } });
  await sendInbox('/notify', { info: { ...replacementGroup, title: '同组的新通知', kind: 'done' } });
  const grouped = await inbox();
  const sameGroup = grouped.notifications.filter(note => note.conversation === replacementGroup.conversation);
  assert.equal(sameGroup.length, 1);
  assert.equal(sameGroup[0].title, '同组的新通知');
  assert.match(sameGroup[0].receivedTime, /^\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual(await clearInbox(snapshot.notifications.map(note => note.id)), { ok: true });
  await until(() => received.some(message => message.t === 'dismiss' && message.ids.includes(completion.id)));
  const remaining = await inbox();
  assert.deepEqual(remaining.notifications.map(note => note.conversation), ['正在更新的对话', '新对话']);
  assert(remaining.approvals.some(approval => approval.id === approvalToClear.id));
  assert.deepEqual(await clearInbox(remaining.notifications.map(note => note.id), [approvalToClear.id]), { ok: true });
  assert.deepEqual(await waiting, { decision: null, reason: 'menu-bar' });
  await until(() => received.some(message => message.t === 'resolved' &&
    message.id === approvalToClear.id && message.decision === 'skip'));
  const cleared = await inbox();
  assert.equal(cleared.unread, 0);
  assert.equal(cleared.approvals.length, 0);
  assert.deepEqual(await sendInbox('/firmware/prepare', {}), { ok: true });
  fs.unlinkSync(updateLock);
  assert.equal((await inbox()).notifications.length, 0);

  assert.deepEqual(await sendInbox('/inbox/test', { lang: 'zh' }), { delivered: 1 });
  assert.equal((await inbox()).notifications[0].title, '测试通知');
  await until(() => received.some(message => message.t === 'notify' && message.title === '测试通知'));
  assert.deepEqual(await sendInbox('/inbox/test', { lang: 'en' }), { delivered: 1 });
  const menuTest = await inbox();
  assert.equal(menuTest.canSendTest, true);
  assert.equal(menuTest.unread, 1);
  assert.deepEqual(menuTest.notifications.map(note => note.title), ['Test notification']);
  const id = menuTest.notifications[0].id;
  for (const sock of sockets) sock.write(JSON.stringify({ t: 'dismiss', ids: [id] }) + '\n');
  await until(() => received.some(message => message.t === 'dismiss' && message.ids.includes(id)));
  const dismissed = await inbox();
  assert.equal(dismissed.unread, 0);
  assert.deepEqual(dismissed.notifications, []);

  const menuURL = `http://127.0.0.1:${httpPort}/inbox`;
  const setup = fs.readFileSync(path.join(home, 'menu-setup.token'), 'utf8').trim();
  const presence = { 'x-agentreminder-menu-pid': String(process.pid) };
  const menuHeaders = { ...presence, 'x-agentreminder-setup': setup };
  const menuInbox = () => fetch(menuURL, { headers: menuHeaders }).then(response => response.json());
  const menuDecision = (id, decision, headers = menuHeaders) => fetch(menuURL + '/decision', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ id, decision }),
  });
  assert.equal((await menuInbox()).canResolveApprovals, true);
  send({ method: 'fixture/trigger', params: { requestId: 103 } });
  const beforeDisconnect = await approvalInMenu();
  await until(() => received.some(message => message.t === 'approval' && message.id === beforeDisconnect.id));
  assert.equal((await menuDecision(beforeDisconnect.id, 'allow', {})).status, 403);
  assert.equal((await menuDecision(beforeDisconnect.id, 'allow', { ...menuHeaders, Origin: 'https://example.test' })).status, 403);
  assert.equal((await menuDecision(beforeDisconnect.id, 'invalid')).status, 400);

  acceptDevices = false;
  for (const socket of sockets) socket.destroy();
  for (let i = 0; i < 100 && (await inbox()).devices !== 0; i++) await sleep(20);
  const disconnected = await menuInbox();
  assert.equal(disconnected.devices, 0);
  assert.equal(disconnected.approvals[0]?.id, beforeDisconnect.id);
  assert.deepEqual(await (await menuDecision(beforeDisconnect.id, 'allow')).json(), { ok: true });
  await until(() => desktop.some(m => m.method === 'fixture/received' && m.params.requestId === 103 && m.params.decision === 'accept'));
  assert.deepEqual(await (await menuDecision(beforeDisconnect.id, 'deny')).json(), { ok: false });

  send({ method: 'fixture/trigger', params: { requestId: 104 } });
  const nativeApproval = await approvalInMenu();
  assert.equal(nativeApproval.actionable, true);
  assert.equal(nativeApproval.interaction, false);
  send({ id: 104, result: { decision: 'decline' } });
  await until(() => desktop.some(m => m.method === 'fixture/received' && m.params.requestId === 104 && m.params.decision === 'decline'));
  for (let i = 0; i < 100 && (await inbox()).approvals.length; i++) await sleep(20);
  assert.deepEqual((await menuInbox()).approvals, []);

  send({ method: 'fixture/trigger-question', params: { requestId: 105 } });
  const questionFromMenu = await approvalInMenu();
  assert.deepEqual(questionFromMenu.choices, ['预览', '正式']);
  assert.deepEqual(await (await menuDecision(questionFromMenu.id, 'deny')).json(), { ok: true });
  await until(() => desktop.some(m => m.method === 'fixture/received' && m.params.requestId === 105 &&
    m.params.answers?.environment?.answers[0] === '预览'));

  async function approvalInMenu() {
    for (let i = 0; i < 100; i++) {
      const approval = (await menuInbox()).approvals[0];
      if (approval) return approval;
      await sleep(20);
    }
    assert.fail('Approval did not arrive in the menu');
  }

  proxy.stdin.end();
});
