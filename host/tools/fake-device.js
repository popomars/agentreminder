#!/usr/bin/env node
// Terminal simulator of the ESP32 device (Wi-Fi/TCP side). Speaks docs/protocol.md.
//   node fake-device.js [port] [--auto allow|deny]
// Set ~/.agentreminder/config.json -> "wifi": { "hosts": ["127.0.0.1"] } to point the daemon at it.
'use strict';
const net = require('net');
const readline = require('readline');
const port = Number(process.argv[2]) || 47322;
const auto = process.argv.includes('--auto') ? process.argv[process.argv.indexOf('--auto') + 1] : null;
const pending = [];
let client = null;

const send = (o) => client && client.write(JSON.stringify(o) + '\n');
const show = () => {
  if (!pending.length) return;
  const a = pending[0];
  console.log(`\n[审批 ${a.id}] ${a.agent} · ${a.project}\n  ${a.title}: ${a.detail}\n  y=同意 n=拒绝 s=终端处理`);
};

net.createServer((sock) => {
  if (client) client.destroy();
  client = sock; let buf = '';
  console.log('host connected');
  sock.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.t === 'hello') send({ t: 'hello', app: 'agentreminder', fw: 'sim', id: 'sim-1', link: 'wifi' });
      else if (m.t === 'ping') send({ t: 'pong', ts: m.ts });
      else if (m.t === 'notify') console.log(`\n[${m.kind}] ${m.agent} · ${m.project}: ${m.title}\n  ${m.detail}`);
      else if (m.t === 'approval') {
        if (pending.some(p => p.id === m.id)) continue;
        pending.push(m);
        if (auto) setTimeout(() => { send({ t: 'decision', id: m.id, decision: auto }); }, 300);
        else if (pending.length === 1) show();
      } else if (m.t === 'resolved' || m.t === 'cancel') {
        const k = pending.findIndex(p => p.id === m.id);
        if (k >= 0) { pending.splice(k, 1); console.log(`  -> ${m.id} ${m.t} ${m.decision || m.why || ''}`); show(); }
      }
    }
  });
  sock.on('close', () => { if (client === sock) client = null; console.log('host disconnected'); });
}).listen(port, () => console.log(`fake device on :${port}${auto ? ' auto=' + auto : ''}`));

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const a = pending[0]; if (!a) return;
  const d = { y: 'allow', n: 'deny', s: 'skip' }[l.trim()];
  if (d) send({ t: 'decision', id: a.id, decision: d });
});
