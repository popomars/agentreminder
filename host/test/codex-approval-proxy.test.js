'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ApprovalBridge, approvalCard } = require('../codex-approval-proxy');
const request = (id = 7) => JSON.stringify({
  id, method: 'item/commandExecution/requestApproval',
  params: { threadId: 'thread', command: 'printf test', reason: '验证双端审批' },
});
const response = (id, decision) => JSON.stringify({ id, result: { decision } });
const resolved = id => JSON.stringify({ method: 'serverRequest/resolved', params: { requestId: id } });
const nextTick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const desktop = [], server = [], device = [];
  const bridge = new ApprovalBridge({
    toDesktop: line => desktop.push(line),
    toServer: line => server.push(line),
    askDevice: (card, signal) => new Promise(resolve => device.push({ card, signal, resolve })),
  });
  return { bridge, desktop, server, device };
}

test('native request is visible immediately; desktop answer cancels its device card and wins the race', async () => {
  const { bridge, desktop, server, device } = fixture();
  bridge.fromServer(request());
  assert.deepEqual(desktop, [request()]);
  assert.equal(device[0].card.reason, '验证双端审批');
  bridge.fromDesktop(response(7, 'decline'));
  assert.equal(device[0].signal.aborted, true);
  device[0].resolve({ decision: 'allow' });
  await nextTick();
  assert.deepEqual(server, [response(7, 'decline')]);
});

test('right/left device outcomes send a one-shot native decision and desktop receives resolution', async () => {
  for (const [deviceChoice, nativeChoice] of [['allow', 'accept'], ['deny', 'decline']]) {
    const { bridge, desktop, server, device } = fixture();
    bridge.fromServer(request());
    device[0].resolve({ decision: deviceChoice });
    await nextTick();
    bridge.fromServer(resolved(7));
    bridge.fromDesktop(response(7, 'acceptForSession'));
    assert.deepEqual(server, [response(7, nativeChoice)]);
    assert.deepEqual(desktop, [request(), resolved(7)]);
  }
});

test('native cancellation aborts the matching card only; device skip leaves desktop available', async () => {
  const { bridge, desktop, server, device } = fixture();
  bridge.fromServer(request(1));
  bridge.fromServer(request(2));
  bridge.fromServer(resolved(1));
  assert.equal(device[0].signal.aborted, true);
  assert.equal(device[1].signal.aborted, false);
  device[1].resolve({ decision: null });
  await nextTick();
  assert.deepEqual(server, []);
  bridge.fromDesktop(response(2, 'accept'));
  assert.deepEqual(server, [response(2, 'accept')]);
  assert.equal(desktop.length, 3);
});

test('unsupported approval decisions are display-only; desktop requests keep their IDs', () => {
  const { bridge, server, device } = fixture();
  const body = JSON.parse(request());
  body.params.availableDecisions = ['decline', 'acceptForSession'];
  assert.equal(approvalCard(body), null);
  bridge.fromServer(JSON.stringify(body));
  assert.equal(device.length, 1);
  assert.equal(device[0].card.interaction, true);
  assert.equal(device[0].card.choices, undefined);
  bridge.fromServer(request(8));
  const clientRequest = JSON.stringify({ id: 8, method: 'thread/list', params: {} });
  bridge.fromDesktop(clientRequest);
  assert.equal(server[0], clientRequest);
  assert.equal(device[0].signal.aborted, false);
  bridge.close();
  assert.equal(device[0].signal.aborted, true);
  assert.equal(device[1].signal.aborted, true);
});

function questionRequest(options, extra = {}) {
  return JSON.stringify({ id: 14, method: 'item/tool/requestUserInput', params: { threadId: 'thread', questions: [{
    id: 'choice', question: '选择目标', options: options.map(label => ({ label })), ...extra,
  }] } });
}

test('binary questions with the optional Other choice send exact labels in the native Codex answer', async () => {
  const { bridge, server, device } = fixture();
  bridge.fromServer(questionRequest(['第一项', '第二项'], { isOther: true }));
  assert.deepEqual(device[0].card.choices, ['第一项', '第二项']);
  device[0].resolve({ decision: 'allow' });
  await nextTick();
  assert.deepEqual(JSON.parse(server[0]), { id: 14, result: { answers: { choice: { answers: ['第二项'] } } } });
  bridge.fromDesktop(JSON.stringify({ id: 14, result: {} }));
  assert.equal(server.length, 1);
});

test('handing off a binary question leaves the custom answer in Codex', async () => {
  const { bridge, server, device } = fixture();
  bridge.fromServer(questionRequest(['A', 'B'], { isOther: true }));
  assert.deepEqual(device[0].card.choices, ['A', 'B']);
  device[0].resolve({ decision: null });
  await nextTick();
  assert.deepEqual(server, []);
  const line = JSON.stringify({ id: 14, result: { answers: { choice: { answers: ['自定义答案'] } } } });
  bridge.fromDesktop(line);
  assert.deepEqual(server, [line]);
});

test('questions requiring the computer never submit a device answer', async () => {
  for (const [options, extra, multiple] of [
    [['A', 'B', 'C'], { isOther: true }], [[], { isOther: true }],
    [['A', 'B'], { isOther: true, isSecret: true }], [['A', 'B'], { multiSelect: true }],
    [['A', 'B'], { isOther: true }, true],
  ]) {
    const { bridge, server, device } = fixture();
    const prompt = JSON.parse(questionRequest(options, extra));
    if (multiple) prompt.params.questions.push({ ...prompt.params.questions[0], id: 'second' });
    bridge.fromServer(JSON.stringify(prompt));
    assert.equal(device[0].card.choices, undefined);
    if (extra.isSecret) assert.doesNotMatch(device[0].card.reason, /选择目标/);
    device[0].resolve({ decision: 'allow' });
    await nextTick();
    assert.equal(server.length, 0);
    bridge.fromDesktop(JSON.stringify({ id: 14, result: { answers: {} } }));
    assert.equal(server.length, 1);
  }
});

test('a prompt that offers cancel instead of decline can be rejected on the device', async () => {
  const { bridge, server, device } = fixture();
  const body = JSON.parse(request());
  body.params.availableDecisions = ['accept', 'cancel'];
  bridge.fromServer(JSON.stringify(body));
  device[0].resolve({ decision: 'deny' });
  await nextTick();
  assert.deepEqual(server, [response(7, 'cancel')]);
});

test('native file approval uses the chat working directory when the request has none', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentreminder-codex-thread-'));
  const original = process.env.CODEX_HOME;
  t.after(() => {
    if (original === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const db = path.join(home, 'state_1.sqlite');
  try {
    execFileSync('sqlite3', [db, "CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT); INSERT INTO threads VALUES ('test-thread', '项目聊天', '/tmp/项目一');"]);
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('sqlite3 is unavailable'); return; }
    throw error;
  }
  process.env.CODEX_HOME = home;
  const request = { id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'test-thread' } };
  const card = approvalCard(request);
  assert.equal(card.project, '项目一');
  assert.equal(card.conversation, '项目聊天');
  assert(card.host);
  assert.equal(approvalCard({ ...request, params: { ...request.params, cwd: '/tmp/项目二' } }).project, '项目二');
});
