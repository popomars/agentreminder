'use strict';

const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { createMesh, validateConfig, discoverySnapshot } = require('../tailnet');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentreminder-tailnet-'));
process.env.AGENTREMINDER_HOME = home;
const { Hub, Link } = require('../agentreminder');
const key = 'a1'.repeat(32);
const listen = '127.0.0.1';

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('Tailnet configuration uses explicit IPv4 membership and a separate key', () => {
  const config = { listen: '100.85.2.1', peers: ['100.66.2.2', '100.66.2.2'], key };
  assert.deepEqual(validateConfig(config).peers, [{ address:'100.66.2.2', port:47323 }]);
  for (const override of [{ listen }, { peers: ['192.168.1.1'] }, { peers: [config.listen] }, { key: 'short' }]) {
    assert.throws(() => validateConfig({ ...config, ...override }), /invalid Tailnet configuration/);
  }
});

function attach(hub, name) {
  const messages = [];
  const link = new Link('usb', name, line => messages.push(JSON.parse(line)), () => {}, hub);
  hub.add(link);
  hub.onMessage(link, { t:'hello', app:'agentreminder', id:name, interaction:true });
  const last = type => messages.findLast(m => m.t === type);
  return { messages, link, last, decide: decision => hub.onMessage(link, { t:'decision', id:last('approval').id, decision }) };
}

async function until(check) {
  for (let i = 0; i < 120; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail('Timed out waiting for the mirrored card');
}

test('three identical meshes share cards, accept one decision, and clear mirrors when the origin disappears', { timeout:10000 }, async t => {
  const sockets = Array.from({ length:3 }, () => http.createServer());
  await Promise.all(sockets.map(socket => once(socket.listen(0, listen), 'listening')));
  const ports = sockets.map(socket => socket.address().port);
  await Promise.all(sockets.map(socket => new Promise(resolve => socket.close(resolve))));
  const hubs = ports.map(() => new Hub({}));
  const [a, b, c] = hubs.map(hub => attach(hub, 'physical-device'));
  t.after(() => [a, b, c].forEach(d => d.link.close()));
  const meshes = ports.map((port, i) => createMesh({
    listen, port, key, peers:ports.filter(p => p !== port).map(p => ({ address:listen, port:p })),
  }, hubs[i], () => {}));
  t.after(() => Promise.all(meshes.map(mesh => mesh.close())));
  await Promise.all(meshes.map(mesh => once(mesh.start(), 'listening')));

  const unauth = await fetch(`http://${listen}:${ports[0]}/v1/card`, { method:'POST', body:'{}' });
  assert.equal(unauth.status, 403);
  const inaccessible = await fetch(`http://${listen}:${ports[0]}/shutdown`, { method:'POST' });
  assert.equal(inaccessible.status, 404);

  const info = { agent:'codex', title:'确认部署', host:'source', project:'repo', sessionId:'chat' };
  assert.equal(await meshes[0].notify({ ...info, kind:'done' }), 3);
  assert.deepEqual(a.last('notify'), b.last('notify'));
  assert.deepEqual(b.last('notify'), c.last('notify'));
  for (const device of [a, b, c]) assert.equal(device.messages.filter(m => m.t === 'notify').length, 1);

  const approval = meshes[0].approval(info, 3000, new EventEmitter());
  await until(() => b.last('approval') && c.last('approval'));
  const first = a.last('approval');
  for (const device of [b, c]) {
    assert.equal(device.last('approval').id, first.id);
    assert.equal(device.last('approval').receivedTime, first.receivedTime);
  }
  b.decide('deny');
  assert.equal((await approval).decision, 'deny');
  await until(() => c.last('cancel')?.id === first.id);
  assert.equal(a.last('cancel').id, first.id);
  c.decide('allow');
  assert.equal(hubs[2].pending.size, 0);

  a.link.close();
  const request = meshes[0].approval({ ...info, interaction:true, choices:['A','B'] }, 3000, new EventEmitter());
  await until(() => b.last('approval').id !== first.id && c.last('approval').id !== first.id);
  const question = c.last('approval');
  assert.deepEqual(question.choices, ['A','B']);
  c.decide('skip');
  assert.equal((await request).decision, null);
  await until(() => b.last('cancel')?.id === question.id);

  const connection = new EventEmitter();
  const cancel = meshes[0].approval(info, 3000, connection);
  await until(() => c.last('approval').id !== question.id);
  const third = c.last('approval');
  connection.emit('close');
  assert.equal((await cancel).decision, null);
  await until(() => c.last('cancel')?.id === third.id);

  await meshes[2].close();
  const remoteOnly = meshes[0].approval(info, 3000, new EventEmitter());
  await until(() => b.last('approval').id !== third.id);
  b.decide('allow');
  assert.equal((await remoteOnly).decision, 'allow');
  assert.equal(await meshes[0].notify({ ...info, kind:'done' }), 1);
});


test('automatic discovery picks IPv4 peers and refreshes after a computer joins', async t => {
  assert.equal(validateConfig({ key }).peers, null);
  assert.deepEqual(discoverySnapshot({
    BackendState: 'Running', TailscaleIPs: ['fd7a::1', '100.80.1.1'],
    Peer: {
      a: { Online: true, TailscaleIPs: ['100.80.1.2', 'fd7a::2'] },
      b: { Online: false, TailscaleIPs: ['100.80.1.3'] },
      c: { TailscaleIPs: ['192.168.0.2'] },
    },
  }), { listen: '100.80.1.1', peers: ['100.80.1.2'] });
  assert.deepEqual(discoverySnapshot({ BackendState: 'Stopped', TailscaleIPs: ['100.80.1.1'] }),
    { listen: null, peers: [] });
  let addresses = [];
  const mesh = createMesh({ port: 0, key, peers: null }, new Hub({}), () => {}, async () => ({ listen, peers: addresses }));
  t.after(() => mesh.close());
  await mesh.start();
  await until(() => mesh.status().listening);
  assert.deepEqual(mesh.status().peers, []);
  addresses = ['100.80.1.2'];
  await mesh.refresh();
  assert.deepEqual(mesh.status().peers, addresses);
});

test('an unrecognized peer receives neither the card nor the shared key', async t => {
  const observed = [];
  const intruder = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    observed.push({ path: req.url, headers: req.headers, body });
    res.end(JSON.stringify({ challenge: 'b'.repeat(64), proof: 'c'.repeat(64) }));
  });
  await once(intruder.listen(0, listen), 'listening');
  t.after(() => new Promise(resolve => intruder.close(resolve)));
  const mesh = createMesh({ listen, key, peers: [{ address: listen, port: intruder.address().port }] }, new Hub({}), () => {});
  assert.equal(await mesh.notify({ title: 'private card', kind: 'done' }), 0);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].path, '/v1/peer');
  assert.equal(observed[0].body, '');
  assert(!JSON.stringify(observed[0].headers).includes(key));
});
