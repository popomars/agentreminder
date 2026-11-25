'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentreminder 'install'-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, '.agentreminder');
  const codex = path.join(home, '.codex-custom');
  fs.mkdirSync(state);
  return { home, state, codex, env: { ...process.env, HOME: home, CODEX_HOME: codex, AGENTREMINDER_HOME: state } };
}

async function listen(server) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('installer stages firmware, and its uninstaller removes only managed files and hooks', { timeout: 15000 }, async t => {
  const { home, state, codex, env } = fixture(t);
  const fakePython = path.join(home, 'fake-python');
  const flashLog = path.join(home, 'flash.log');
  fs.writeFileSync(fakePython, '#!/bin/sh\ncase "$1 $2" in -c\\ *) exit 0;; "-m esptool") printf "%s\\n" "$@" > "$FLASH_LOG";; *) exit 1;; esac\n', { mode: 0o700 });
  env.AGENTREMINDER_FLASH_PYTHON = fakePython;
  env.FLASH_LOG = flashLog;
  const { stdout } = await run('bash', ['install.sh', '--lang', 'en', '--flash', '--port', '/dev/null',
    '--no-pair', '--agent', 'codex', '--agent', 'claude', '--agent', 'dsh'], { cwd: root, env });
  assert.match(stdout, /Firmware SHA-256 verification passed/);
  assert.match(stdout, /AgentReminder is installed/);
  const app = path.join(state, 'app');
  const firmware = path.join(app, 'firmware/release/waveshare-amoled-2.16/firmware.bin');
  assert(fs.statSync(firmware).size > 1_000_000);
  assert(fs.readFileSync(flashLog, 'utf8').split('\n').includes(firmware));
  assert(!fs.existsSync(path.join(state, 'daemon.pid')));

  const hookFile = path.join(codex, 'hooks.json');
  const original = JSON.parse(fs.readFileSync(hookFile));
  const unrelated = { type: 'command', command: 'echo agentreminder.js' };
  assert.equal(original.hooks.PermissionRequest[0].hooks[0].timeout, 330);
  original.foo = 'keep';
  original.hooks.PermissionRequest[0].hooks.push(unrelated);
  fs.writeFileSync(hookFile, JSON.stringify(original));
  fs.writeFileSync(path.join(app, 'mine.txt'), 'keep');

  const reserve = http.createServer();
  const httpPort = await listen(reserve);
  await new Promise(resolve => reserve.close(resolve));
  const config = JSON.stringify({ httpPort, usb: { enabled: false }, bluetooth: { enabled: false } });
  const configPath = path.join(state, 'config.json');
  fs.writeFileSync(configPath, config);
  const daemon = spawn(process.execPath, [path.join(app, 'host/agentreminder.js'), 'daemon'], { env, stdio: 'ignore' });
  t.after(() => daemon.kill());
  const exited = new Promise(resolve => daemon.once('exit', resolve));
  const pidFile = path.join(state, 'daemon.pid');
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(Number(fs.readFileSync(pidFile)), daemon.pid);

  const removal = await run('bash', [path.join(app, 'uninstall.sh'), '--lang', 'en'], { env });
  assert.match(removal.stdout, /Stopped the local AgentReminder daemon/);
  assert.equal(await exited, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(hookFile)), { hooks: { PermissionRequest: [{ hooks: [unrelated] }] }, foo: 'keep' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'))), { hooks: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'dsh-hooks.json'))), { hooks: {} });
  assert.equal(fs.readFileSync(configPath, 'utf8'), config);
  assert(fs.existsSync(path.join(state, 'daemon.log')));
  assert.deepEqual(fs.readdirSync(app), ['mine.txt']);
  await run('bash', ['uninstall.sh'], { cwd: root, env });
});

test('uninstall leaves an SSH-forwarded daemon alone', async t => {
  const { state, env } = fixture(t);
  const seen = [];
  const remote = http.createServer((req, res) => {
    seen.push(req.method);
    res.end(JSON.stringify({ pid: 1234, pending: [] }));
  });
  t.after(() => remote.close());
  const httpPort = await listen(remote);
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ httpPort }));
  fs.writeFileSync(path.join(state, 'daemon.pid'), '4321');
  await run('bash', ['uninstall.sh'], { cwd: root, env });
  assert.deepEqual(seen, ['GET']);
});
