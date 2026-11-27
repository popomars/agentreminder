'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const host = path.join(__dirname, '..', 'agentreminder.js');

test('Codex hook status uses App Server trust for the managed local entries', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentreminder-hook-status-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, AGENTREMINDER_HOME: path.join(home, 'state'),
    AGENTREMINDER_CODEX_APP: path.join(home, 'ChatGPT.app') };
  await run(process.execPath, [host, 'install', 'codex'], { env });

  const binary = path.join(env.AGENTREMINDER_CODEX_APP, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const fixture = path.join(home, 'app-server.js');
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(fixture, `
const file = require('node:path').join(process.env.CODEX_HOME, 'hooks.json');
const hook = (key, trustStatus, enabled = true) => ({ key: file + ':' + key, sourcePath: file, trustStatus, enabled });
const write = payload => console.log(JSON.stringify(payload));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') write({ id: request.id, result: {} });
  if (request.method !== 'hooks/list') return;
  write({ id: request.id, result: { data: [{ hooks: [
    hook('stop:0:0', process.env.TEST_STOP_TRUST),
    hook('permission_request:0:0', 'modified', false),
    hook('permission_request:0:1', 'trusted'),
  ] }] } });
});
`);
  const file = path.join(codexHome, 'hooks.json');
  const settings = JSON.parse(fs.readFileSync(file));
  settings.hooks.PermissionRequest[0].hooks.unshift({ type: 'command', command: 'echo unrelated' });
  fs.writeFileSync(file, JSON.stringify(settings));
  const status = async state => JSON.parse((await run(process.execPath, [host, 'codex-hook-status'],
    { env: { ...env, TEST_STOP_TRUST: state } })).stdout);
  assert.deepEqual(await status('modified'), { source: 'desktop', stop: 'modified', permissionRequest: 'trusted' });
  assert.deepEqual(await status('trusted'), { source: 'desktop', stop: 'trusted', permissionRequest: 'trusted' });
  fs.unlinkSync(binary);
  assert.deepEqual(await status('trusted'), { source: 'desktop', stop: 'unavailable', permissionRequest: 'unavailable' });
});
