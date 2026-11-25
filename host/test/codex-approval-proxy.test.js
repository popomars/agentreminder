'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
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

test('does not mirror unsupported decisions and does not intercept desktop requests with the same ID', () => {
  const { bridge, server, device } = fixture();
  const body = JSON.parse(request());
  body.params.availableDecisions = ['decline', 'acceptForSession'];
  assert.equal(approvalCard(body), null);
  bridge.fromServer(JSON.stringify(body));
  assert.equal(device.length, 0);
  bridge.fromServer(request());
  const clientRequest = JSON.stringify({ id: 7, method: 'thread/list', params: {} });
  bridge.fromDesktop(clientRequest);
  assert.equal(server[0], clientRequest);
  assert.equal(device[0].signal.aborted, false);
  bridge.close();
  assert.equal(device[0].signal.aborted, true);
});
