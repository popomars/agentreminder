'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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

function partitionTable(entries) {
  const table = Buffer.alloc(0x1000, 0xff);
  for (const [index, [kind, subtype, start, length]] of entries.entries()) {
    const offset = index * 32;
    table.fill(0, offset, offset + 32);
    table.writeUInt16LE(0x50aa, offset);
    table[offset + 2] = kind;
    table[offset + 3] = subtype;
    table.writeUInt32LE(start, offset + 4);
    table.writeUInt32LE(length, offset + 8);
  }
  const offset = entries.length * 32;
  table.writeUInt16LE(0xebeb, offset);
  createHash('md5').update(table.subarray(0, offset)).digest().copy(table, offset + 16);
  return table;
}

test('Passport installer writes only the compatible factory application and uninstalls its files', { timeout: 15000 }, async t => {
  const { home, state, env } = fixture(t);
  const tableFile = path.join(home, 'device-partitions.bin');
  const esptoolLog = path.join(home, 'esptool.log');
  const fakePython = path.join(home, 'fake-python');
  const entries = [[1, 2, 0x9000, 0x6000], [0, 0, 0x10000, 0x300000], [1, 2, 0x356000, 0x4000]];
  const table = partitionTable(entries);
  fs.writeFileSync(tableFile, table);
  fs.writeFileSync(fakePython, `#!/bin/sh
if [ "$1" = -c ]; then exit 0; fi
printf '%s\\n' "$@" >> "$PASSPORT_TEST_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    read_flash) cp "$PASSPORT_TEST_TABLE" "$4"; exit $?;;
    write_flash) printf '%s\\n' "$@" > "$PASSPORT_TEST_WRITE"; exit 0;;
  esac
  shift
done
exit 1
`, { mode: 0o700 });
  Object.assign(env, {
    AGENTREMINDER_FLASH_PYTHON: fakePython,
    PASSPORT_TEST_LOG: esptoolLog,
    PASSPORT_TEST_TABLE: tableFile,
    PASSPORT_TEST_WRITE: path.join(home, 'write.log'),
  });
  const { stdout } = await run('bash', ['install.sh', '--no-menu-bar', '--lang', 'en', '--flash', '--board', 'folotoy-passport',
    '--port', '/dev/null', '--no-pair', '--agent', 'dsh'], { cwd: root, env });
  assert.match(stdout, /Flashing the AI Passport application partition/);
  const app = path.join(state, 'app');
  const bundle = path.join(app, 'firmware/release/folotoy-ai-passport');
  const image = path.join(bundle, 'AgentReminder-AI-Passport-app.bin');
  assert(fs.existsSync(path.join(bundle, 'AgentReminder-AI-Passport-full.bin')));
  assert.deepEqual(fs.readFileSync(env.PASSPORT_TEST_WRITE, 'utf8').trimEnd().split('\n'), [
    'write_flash', '-z', '--flash_mode', 'keep', '--flash_freq', 'keep', '--flash_size', 'keep', '0x10000', image,
  ]);
  assert.match(fs.readFileSync(esptoolLog, 'utf8'), /--chip\nesp32c3\n/);
  assert.match(fs.readFileSync(esptoolLog, 'utf8'), /read_flash\n0x8000\n0x1000\n/);

  const corrupt = Buffer.from(table);
  corrupt[entries.length * 32 + 16] ^= 1;
  for (const invalid of [
    corrupt,
    partitionTable([[1, 2, 0x9000, 0x6000], [0, 0, 0x10000, 0x200000]]),
    partitionTable([...entries, [0, 0x10, 0x360000, 0x100000]]),
    partitionTable([...entries, [1, 2, 0x30f000, 0x3000]]),
  ]) {
    fs.writeFileSync(tableFile, invalid);
    fs.rmSync(env.PASSPORT_TEST_WRITE, { force: true });
    await assert.rejects(run('bash', [path.join(app, 'flash.sh'), '--board', 'folotoy-passport',
      '--port', '/dev/null', '--lang', 'en'], { env }), /Unsupported AI Passport partition layout/);
    assert(!fs.existsSync(env.PASSPORT_TEST_WRITE));
  }

  fs.writeFileSync(path.join(bundle, 'my-notes.txt'), 'keep');
  await run('bash', [path.join(app, 'uninstall.sh')], { env });
  assert.deepEqual(fs.readdirSync(bundle), ['my-notes.txt']);
});

test('installer stages firmware, and its uninstaller removes only managed files and hooks', { timeout: 15000 }, async t => {
  const { home, state, codex, env } = fixture(t);
  const fakePython = path.join(home, 'fake-python');
  const flashLog = path.join(home, 'flash.log');
  fs.writeFileSync(fakePython, '#!/bin/sh\ncase "$1 $2" in -c\\ *) exit 0;; "-m esptool") printf "%s\\n" "$@" > "$FLASH_LOG";; *) exit 1;; esac\n', { mode: 0o700 });
  env.AGENTREMINDER_FLASH_PYTHON = fakePython;
  env.FLASH_LOG = flashLog;
  const { stdout } = await run('bash', ['install.sh', '--no-menu-bar', '--lang', 'en', '--flash', '--port', '/dev/null',
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

test('Claude setup enables the elicitation hook only on supported versions', async t => {
  const { home, env } = fixture(t);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const cli = path.join(bin, 'claude');
  env.PATH = bin + path.delimiter + env.PATH;
  const read = () => JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'))).hooks;
  const install = () => run(process.execPath, [path.join(root, 'host/agentreminder.js'), 'install', 'claude'], { env });
  fs.writeFileSync(cli, '#!/bin/sh\nprintf "2.1.76 (Claude Code)\\n"\n', { mode: 0o700 });
  await install();
  assert(read().Elicitation);
  fs.writeFileSync(cli, '#!/bin/sh\nprintf "2.0.76 (Claude Code)\\n"\n');
  await install();
  const legacy = read();
  assert(!legacy.Elicitation);
  assert.match(legacy.Notification[0].matcher, /elicitation_dialog/);
  assert.equal(legacy.PreToolUse[0].matcher, 'AskUserQuestion');
});


test('a custom installation uninstall preserves agent hooks from a different installation', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentreminder-custom-uninstall-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const customState = path.join(home, 'custom-state');
  const codex = path.join(home, '.codex');
  fs.mkdirSync(codex);
  const configPath = path.join(codex, 'hooks.json');
  const make = state => ({
    type: 'command', command: `'node' '${state}/app/host/agentreminder.js' hook --agent codex --event stop`,
  });
  const existing = make(path.join(home, '.agentreminder'));
  fs.writeFileSync(configPath, JSON.stringify({ hooks: { Stop: [{ hooks: [existing, make(customState)] }] } }));
  const env = { ...process.env, HOME: home, CODEX_HOME: codex, AGENTREMINDER_HOME: customState };
  await run('bash', ['uninstall.sh'], { cwd: root, env });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { hooks: { Stop: [{ hooks: [existing] }] } });
});


test('installing the runtime without hooks preserves the existing hook files', async t => {
  const { state, codex, env } = fixture(t);
  fs.mkdirSync(codex);
  const configPath = path.join(codex, 'hooks.json');
  const existing = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo existing"}]}]}}';
  fs.writeFileSync(configPath, existing);
  await run('bash', ['install.sh', '--no-menu-bar', '--skip-hooks', '--no-pair'], { cwd: root, env });
  assert.equal(fs.readFileSync(configPath, 'utf8'), existing);
  assert(fs.existsSync(path.join(state, 'app', 'host', 'agentreminder.js')));
  assert(!fs.existsSync(path.join(state, 'dsh-hooks.json')));
});


test('macOS installs and launches the menu bar app by default', { skip: process.platform !== 'darwin', timeout: 45000 }, async t => {
  const { home, state, env } = fixture(t);
  delete env.AGENTREMINDER_HOME;
  const applications = path.join(home, 'Applications');
  fs.mkdirSync(applications);
  const bundle = path.join(applications, 'AgentReminder.app');
  fs.symlinkSync(path.join(state, 'app', 'AgentReminder.app'), bundle);
  const open = path.join(home, 'open');
  const launched = path.join(home, 'launched');
  fs.writeFileSync(open, '#!/bin/sh\nprintf "%s\\n" "$@" > "$LAUNCH_LOG"\n', { mode: 0o700 });
  env.PATH = `${home}:${env.PATH}`;
  env.LAUNCH_LOG = launched;

  await run('bash', ['install.sh', '--skip-hooks', '--no-pair'], { cwd: root, env });

  const app = path.join(state, 'app');
  assert(fs.lstatSync(bundle).isDirectory());
  assert.deepEqual(fs.readFileSync(launched, 'utf8').trimEnd().split('\n'), ['-n', fs.realpathSync(bundle), '--args', '--replace-existing', '--register-login']);
  await run('codesign', ['--verify', '--strict', bundle]);
  assert(fs.existsSync(path.join(app, 'flash.sh')));
  assert(fs.existsSync(path.join(app, 'firmware/release/waveshare-amoled-2.16/firmware.bin')));
  await run('bash', [path.join(app, 'uninstall.sh')], { env });
  assert(!fs.existsSync(bundle));
});

test('downloaded macOS installer stages a single GitHub revision and launches setup', { skip: process.platform !== 'darwin', timeout: 45000 }, async t => {
  const { home, state, codex, env } = fixture(t);
  const downloaded = path.join(home, 'install.sh');
  fs.copyFileSync(path.join(root, 'install.sh'), downloaded);
  const revision = '0123456789abcdef0123456789abcdef01234567';
  const opened = path.join(home, 'open.log');
  const requests = path.join(home, 'requests.log');
  Object.assign(env, {
    PATH: `${home}:${env.PATH}`, GH_TOKEN: 'test-token', INSTALL_FIXTURE_ROOT: root,
    INSTALL_TEST_REV: revision, INSTALL_TEST_REQUESTS: requests, OPEN_LOG: opened,
  });
  fs.writeFileSync(path.join(home, 'open'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$OPEN_LOG"\n', { mode: 0o700 });
  fs.writeFileSync(path.join(home, 'curl'), `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const url = new URL(process.argv.at(-1));
const revision = process.env.INSTALL_TEST_REV;
assert.equal(url.origin, 'https://api.github.com');
assert.equal(fs.readFileSync(0, 'utf8').trim(), 'Authorization: Bearer test-token');
const endpoint = url.pathname.replace('/repos/popomars/agentreminder/', '');
fs.appendFileSync(process.env.INSTALL_TEST_REQUESTS, endpoint + '\\n');
if (endpoint === 'commits/' + revision) {
  assert(process.argv.includes('Accept: application/vnd.github.sha'));
  process.stdout.write(revision);
} else {
  assert(endpoint.startsWith('contents/'));
  assert(process.argv.includes('Accept: application/vnd.github.raw+json'));
  assert.equal(url.searchParams.get('ref'), revision);
  process.stdout.write(fs.readFileSync(require('node:path').join(process.env.INSTALL_FIXTURE_ROOT, endpoint.slice(9))));
}
`, { mode: 0o700 });

  await run('bash', [downloaded, '--ref', revision, '--agent', 'codex'], { cwd: home, env });
  const bundle = path.join(state, 'app', 'AgentReminder.app');
  assert.deepEqual(fs.readFileSync(opened, 'utf8').trimEnd().split('\n'),
    ['-n', fs.realpathSync(bundle), '--args', '--replace-existing', '--setup-usb']);
  const fetched = fs.readFileSync(requests, 'utf8').trimEnd().split('\n');
  assert.equal(fetched[0], 'commits/' + revision);
  assert(fetched.includes('contents/host/menu-bar/Main.swift'));
  assert(fetched.includes('contents/firmware/release/waveshare-amoled-2.16/firmware.bin'));
  assert(fetched.includes('contents/firmware/release/folotoy-ai-passport/AgentReminder-AI-Passport-app.bin'));
  assert(JSON.parse(fs.readFileSync(path.join(codex, 'hooks.json'), 'utf8')).hooks.Stop);
  const installation = JSON.parse(fs.readFileSync(path.join(bundle, 'Contents/Resources/Installation.json'), 'utf8'));
  assert(path.isAbsolute(installation.node));
  assert(path.isAbsolute(installation.python));
});

test('menu firmware flash works without a device handshake and keeps the daemon inbox', { timeout: 15000 }, async t => {
  const { home, state, env } = fixture(t);
  const portServer = http.createServer();
  const port = await listen(portServer);
  await new Promise(resolve => portServer.close(resolve));
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    httpPort: port, usb: { enabled: false }, bluetooth: { enabled: false },
  }));
  const flashMarker = path.join(home, 'flash-called');
  const simulator = path.join(home, 'mock-esptool');
  fs.writeFileSync(simulator, `#!/bin/sh
set -e
if [ "$1" = -c ]; then exit 0; fi
if [ "$1" = - ]; then echo /dev/null; exit 0; fi
test -s "$AGENTREMINDER_HOME/firmware-update.pid"
printf "%s\\n" "$@" > "$FLASH_MARKER"
`, { mode: 0o700 });
  env.AGENTREMINDER_FLASH_PYTHON = simulator;
  env.FLASH_MARKER = flashMarker;
  const daemon = spawn(process.execPath, [path.join(root, 'host/agentreminder.js'), 'daemon'], { env, stdio: 'ignore' });
  t.after(() => daemon.kill());
  const fromHost = (route, info) => fetch(`http://127.0.0.1:${port}${route}`, info ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(info),
  } : {});
  for (let i = 0; i < 60; i++) {
    if (await fromHost('/status').then(r => r.ok).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert((await fromHost('/notify', { info: { title: 'Keep this notification' } })).ok);
  await run('bash', ['flash.sh', '--menu-update', '--board', 'waveshare-amoled-2.16'], { cwd: root, env });
  const argumentsByLine = fs.readFileSync(flashMarker, 'utf8').trim().split('\n');
  assert(argumentsByLine.includes('write_flash'));
  assert(argumentsByLine.includes('/dev/null'));
  assert.deepEqual(argumentsByLine.filter(arg => /^0x/.test(arg)), ['0x0000', '0x8000', '0xe000', '0x10000']);
  assert.deepEqual(argumentsByLine.filter(arg => arg.endsWith('.bin')).map(arg => path.basename(arg)),
    ['bootloader.bin', 'partitions.bin', 'boot_app0.bin', 'firmware.bin']);
  assert.equal((await fromHost('/status').then(r => r.json())).pid, daemon.pid);
  assert.equal((await fromHost('/inbox').then(r => r.json())).notifications[0].title, 'Keep this notification');
  assert.equal(fs.readFileSync(path.join(state, 'firmware-update.pid'), 'utf8'), '');
});
