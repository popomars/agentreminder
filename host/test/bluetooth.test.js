'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Session, cipherStream, frame } = require('../bluetooth');
process.env.AGENTREMINDER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentreminder-ble-'));
const { Hub, Link } = require('../agentreminder');

const id = 'A0123456789F';
const key = 'aa'.repeat(32);

test('BLE framing handles split messages; fresh directional keys reject replay and tampering', () => {
  const written = [], received = [];
  const session = new Session(key, bytes => written.push(bytes), () => session.send('{"t":"hello"}\n'),
    bytes => received.push(bytes.toString()));
  session.start();
  const hostNonce = written[0].subarray(2);
  const deviceNonce = Buffer.alloc(16, 1);
  const outgoing = cipherStream(Buffer.from(key, 'hex'), 'c2d', hostNonce, deviceNonce);
  const incoming = cipherStream(Buffer.from(key, 'hex'), 'd2c', hostNonce, deviceNonce);
  const answer = '{"title":"蓝牙审批"}\n';
  const ciphertext = incoming.seal(Buffer.from(answer));
  for (const byte of Buffer.concat([frame(deviceNonce), frame(ciphertext)])) session.feed(Buffer.from([byte]));
  assert.deepEqual(received, [answer]);
  assert.equal(outgoing.open(written[1].subarray(2)).toString(), '{"t":"hello"}\n');
  assert.throws(() => session.feed(frame(ciphertext)));
  const otherSession = cipherStream(Buffer.from(key, 'hex'), 'd2c', hostNonce, Buffer.alloc(16, 2));
  assert.throws(() => otherSession.open(ciphertext));
  const wrongHost = cipherStream(Buffer.alloc(32, 0), 'd2c', hostNonce, deviceNonce);
  assert.throws(() => wrongHost.open(ciphertext));
  const tampered = Buffer.from(ciphertext);
  tampered[0] ^= 1;
  const matchingSession = cipherStream(Buffer.from(key, 'hex'), 'd2c', hostNonce, deviceNonce);
  assert.throws(() => matchingSession.open(tampered));
});

test('USB confirmation enrolls only the selected board; its BLE link owns pending approvals after unplug', async t => {
  const cfg = { usb: { pairedDeviceId: id } };
  const hub = new Hub(cfg);
  const make = (kind, deviceId, pairedId) => {
    const sent = [];
    const link = new Link(kind, deviceId, line => sent.push(JSON.parse(line)), () => {}, hub);
    link.pairedDeviceId = pairedId;
    hub.add(link);
    t.after(() => link.close());
    hub.onMessage(link, { t: 'hello', app: 'agentreminder', id: deviceId });
    return { link, sent };
  };
  const usb = make('usb', id);
  const ble = make('ble', id, id);
  const impostor = make('ble', 'AABBCCDDEEFF', id);
  const pairing = hub.requestApproval({ title: '配对这台电脑' }, 1000, usb.link, key);
  assert.equal(usb.sent.at(-1).key, key);
  assert(ble.sent.every(message => !('key' in message)));
  hub.onMessage(ble.link, { t: 'decision', id: pairing.id, decision: 'allow', ble_paired: true });
  assert(hub.pending.has(pairing.id));
  hub.onMessage(usb.link, { t: 'decision', id: pairing.id, decision: 'allow', ble_paired: true });
  assert.equal((await pairing.promise).bluetoothPaired, true);
  assert(impostor.link.closed);

  const request = hub.requestApproval({ title: '确认审批' }, 1000);
  assert.equal(usb.sent.at(-1).id, request.id);
  assert.equal(ble.sent.at(-1).id, request.id);
  usb.link.close();
  assert(hub.pending.has(request.id));
  hub.onMessage(ble.link, { t: 'decision', id: request.id, decision: 'deny' });
  assert.equal((await request.promise).decision, 'deny');
  assert.equal(hub.notify({ title: '任务完成', kind: 'done' }), 1);
  assert.equal(ble.sent.at(-1).t, 'notify');
});

test('card times survive approval replay and notifications in the same millisecond have a stable order', async t => {
  const hub = new Hub({ usb: { pairedDeviceId: id } });
  const connect = kind => {
    const sent = [];
    const link = new Link(kind, id, line => sent.push(JSON.parse(line)), () => {}, hub);
    link.pairedDeviceId = kind === 'ble' ? id : undefined;
    t.after(() => link.close());
    hub.add(link);
    hub.onMessage(link, { t: 'hello', app: 'agentreminder', id, interaction: true });
    return sent;
  };
  const start = new Date(2026, 0, 2, 3, 4).getTime();
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const usb = connect('usb');
  const question = hub.requestApproval({ title: '等待回答', interaction: true, choices: ['一', '二'] }, 300000);
  t.after(() => hub.cancel(question.id, 'test cleanup'));
  assert.equal(usb.at(-1).receivedTime, '01-02 03:04');
  now += 60000;
  const ble = connect('ble');
  assert.equal(ble.at(-1).id, question.id);
  assert.equal(ble.at(-1).ts, start);
  assert.equal(ble.at(-1).receivedTime, usb.at(-1).receivedTime);

  hub.notify({ kind: 'done', title: '第一次完成' });
  hub.notify({ kind: 'done', title: '第二次完成' });
  const [first, second] = ble.slice(-2);
  assert.deepEqual(usb.slice(-2), [first, second]);
  assert.equal(first.ts, second.ts);
  assert.equal(second.receivedTime, '01-02 03:05');
  assert(second.sequence > first.sequence);
});
