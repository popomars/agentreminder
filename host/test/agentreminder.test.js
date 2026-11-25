'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.AGENTREMINDER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentreminder-test-'));
const { Hub, Link, loadConfig, mergeHooks, shellQuote } = require('../agentreminder');
function device(hub, name = 'test') {
  const messages = [];
  const link = new Link('usb', name, s => messages.push(JSON.parse(s)), () => {}, hub);
  hub.add(link);
  link.feed(Buffer.from('{"t":"hello","app":"agentreminder"}\n'));
  return { link, messages };
}
for (const decision of ['allow', 'deny', 'skip']) {
  test(`device ${decision} settles exactly one pending approval on both links`, async () => {
    const hub = new Hub({}); const a = device(hub); const b = device(hub, 'second');
    const r = hub.requestApproval({ agent: 'claude' }, 1000);
    a.link.feed(Buffer.from(JSON.stringify({ t: 'decision', id: r.id, decision }) + '\n'));
    assert.equal((await r.promise).decision, decision === 'skip' ? null : decision);
    b.link.feed(Buffer.from(JSON.stringify({ t: 'decision', id: r.id, decision: 'deny' }) + '\n'));
    assert.equal(hub.pending.size, 0);
    assert.equal(b.messages.filter(m => m.t === 'resolved').length, 1);
    a.link.close(); b.link.close();
  });
}
test('unidentified device cannot approve; UTF-8 survives split USB reads', async () => {
  const hub = new Hub({}); const a = device(hub);
  const bad = new Link('wifi', 'unknown', () => {}, () => {}, hub);
  const r = hub.requestApproval({}, 1000);
  hub.onMessage(bad, { t: 'decision', id: r.id, decision: 'allow' });
  assert.equal(hub.pending.size, 1);
  hub.onMessage(a.link, { t: 'decision', id: r.id, decision: 'invalid' });
  assert.equal(hub.pending.size, 1);
  let received; bad.hub = { onMessage: (_l, m) => { received = m; } };
  const bytes = Buffer.from('{"msg":"审批完成"}\n');
  for (const byte of bytes) bad.feed(Buffer.from([byte]));
  assert.equal(received.msg, '审批完成');
  a.link.close(); assert.equal((await r.promise).reason, 'device-disconnected');
});
test('no device, timeout and cancelled hook return control to terminal', async () => {
  const hub = new Hub({});
  assert.equal((await hub.requestApproval({}, 100).promise).reason, 'no-device');
  const a = device(hub);
  assert.equal((await hub.requestApproval({}, 5).promise).reason, 'timeout');
  const r = hub.requestApproval({}, 1000); hub.cancel(r.id, 'hook-gone');
  assert.equal((await r.promise).decision, null);
  assert(a.messages.some(m => m.t === 'cancel'));
  a.link.close();
});

test('concurrent approvals keep separate deadlines and finish independently', async t => {
  const hub = new Hub({});
  const a = device(hub);
  t.after(() => a.link.close());
  const timeoutSec = loadConfig().approvalTimeoutSec;
  assert.equal(timeoutSec, 300);
  const first = hub.requestApproval({ title: 'first' }, 10);
  const next = hub.requestApproval({ title: 'second' }, timeoutSec * 1000);
  assert.deepEqual([...hub.pending.keys()], [first.id, next.id]);
  assert.equal(a.messages.at(-1).timeout, 300);
  assert.equal((await first.promise).reason, 'timeout');
  assert.deepEqual([...hub.pending.keys()], [next.id]);
  hub.onMessage(a.link, { t: 'decision', id: next.id, decision: 'allow' });
  assert.equal((await next.promise).decision, 'allow');
});
test('install preserves unrelated settings and refuses malformed config', () => {
  const file = path.join(process.env.AGENTREMINDER_HOME, 'settings.json');
  const original = { model: 'existing', hooks: { Stop: [{ hooks: [{ command: 'other' }] }] } };
  fs.writeFileSync(file, JSON.stringify(original));
  const hooks = { Stop: [{ hooks: [{ command: 'node agentreminder.js hook' }] }] };
  mergeHooks(file, hooks); mergeHooks(file, hooks);
  const result = JSON.parse(fs.readFileSync(file));
  assert.equal(result.model, 'existing'); assert.equal(result.hooks.Stop.length, 2);
  fs.writeFileSync(file, '{broken'); assert.throws(() => mergeHooks(file, hooks));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('cards carry conversation names and the actual approval reason', () => {
  const { describeSession, describeTool, transcriptTitle } = require('../agentreminder');
  assert.equal(describeSession({ session_id: 'abc', conversation_title: '修复审批设备' }, 'claude').conversation, '修复审批设备');
  const file = path.join(process.env.AGENTREMINDER_HOME, 'conversation.jsonl');
  fs.writeFileSync(file, [
    { type: 'user', message: { content: [{ type: 'text', text: '最初的用户请求' }] } },
    { type: 'custom-title', customTitle: '用户重命名后的对话' },
  ].map(row => JSON.stringify(row)).join('\n'));
  assert.equal(transcriptTitle(file), '用户重命名后的对话');
  assert.equal(describeSession({ session_id: 'abc', transcript_path: file }, 'claude').conversation, '用户重命名后的对话');
  const tool = describeTool({ tool_name: 'Bash', tool_input: { command: 'pio run -t upload', description: '将修复后的中文字库烧录到设备' } });
  assert.equal(tool.reason, '将修复后的中文字库烧录到设备');
  assert.equal(tool.detail, 'pio run -t upload');
});

test('when the agent runs on a remote host, card metadata preserves its source', async () => {
  const hub = new Hub({});
  const a = device(hub);
  const info = { host: 'remote-agent', project: '远程项目' };
  const request = hub.requestApproval(info, 1000);
  assert.equal(a.messages.at(-1).host, info.host);
  assert.equal(a.messages.at(-1).project, info.project);
  hub.notify(info);
  assert.equal(a.messages.at(-1).host, info.host);
  assert.equal(a.messages.at(-1).project, info.project);
  a.link.close();
  await request.promise;
});

test('USB pairing confirmation reaches only the selected link and locks future cards to that device', async () => {
  const cfg = { usb: {} };
  const hub = new Hub(cfg);
  const selected = device(hub, 'selected');
  const other = device(hub, 'other');
  selected.link.info.id = 'paired-board';
  other.link.info.id = 'another-board';
  const pairing = hub.requestApproval({ title: 'Pair' }, 1000, selected.link);
  assert(!other.messages.some(message => message.id === pairing.id));
  hub.onMessage(other.link, { t: 'decision', id: pairing.id, decision: 'allow' });
  assert(hub.pending.has(pairing.id));
  hub.onMessage(selected.link, { t: 'decision', id: pairing.id, decision: 'allow' });
  assert.equal((await pairing.promise).decision, 'allow');
  cfg.usb.pairedDeviceId = 'paired-board';

  const approval = hub.requestApproval({ title: 'Check' }, 1000);
  assert(selected.messages.some(message => message.id === approval.id));
  assert(!other.messages.some(message => message.id === approval.id));
  hub.onMessage(other.link, { t: 'decision', id: approval.id, decision: 'allow' });
  assert(hub.pending.has(approval.id));
  selected.link.close();
  assert.equal((await approval.promise).reason, 'device-disconnected');
  other.link.close();
});
