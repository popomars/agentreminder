'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function fixture(t, settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentreminder-dock-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, '.agentreminder');
  const stateFile = path.join(home, 'simulated-launchd.json');
  const preload = path.join(home, 'launchctl.cjs');
  const cli = path.join(home, 'codex');
  const plist = path.join(home, 'Library/LaunchAgents/com.agentreminder.codex-dock.plist');
  const shim = path.join(state, 'dock-codex-cli');
  const enabled = path.join(state, 'codex-dock-enabled');
  fs.mkdirSync(state);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(cli, '#!/bin/sh\n', { mode: 0o700 });
  fs.writeFileSync(stateFile, JSON.stringify(settings));
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const childProcess = require('node:child_process');
    const launchd = process.env.DOCK_TEST_STATE;
    childProcess.spawnSync = (program, args) => {
      if (program !== '/bin/launchctl') throw new Error('unexpected executable');
      const [command, target] = args;
      const state = JSON.parse(fs.readFileSync(launchd));
      const success = stdout => ({ status: 0, stdout: stdout || '', stderr: '' });
      if (command === 'print' && target.includes('codex-dock')) {
        return state.loaded ? success() : { status: 1 };
      }
      if (command === 'print') {
        return success('environment = {\\n' + (state.override ? 'CODEX_CLI_PATH => ' + state.override + '\\n' : '') + '}\\n');
      }
      if (command === 'print-disabled') {
        return success(state.disabled ? '"com.agentreminder.codex-dock" => disabled\\n' : '');
      }
      if (command === 'bootout') state.loaded = false;
      else if (command === 'asuser' && args[3] === 'setenv') state.override = args[5];
      else if (command === 'asuser' && args[3] === 'unsetenv') delete state.override;
      else throw new Error('unexpected launchctl command: ' + args.join(' '));
      fs.writeFileSync(launchd, JSON.stringify(state));
      return success();
    };
  `);
  const existing = '# Managed by AgentReminder Dock integration\n';
  const status = () => JSON.parse(fs.readFileSync(stateFile));
  const resetEnvironment = (override = '') => fs.writeFileSync(stateFile, JSON.stringify({ ...status(), override }));
  const legacy = () => [plist, shim].forEach(file => fs.writeFileSync(file, existing, { mode: 0o700 }));
  const run = (command, overrideEnv = {}) => execFileSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../configure-codex-dock.js'), command], {
    env: { ...process.env, HOME: home, AGENTREMINDER_CODEX_REAL_CLI: cli, DOCK_TEST_STATE: stateFile, ...overrideEnv }, encoding: 'utf8',
  });
  return { plist, enabled, shim, status, resetEnvironment, legacy, run };
}

test('restoring an enabled Codex bridge uses the desktop app at its new location', { skip: process.platform !== 'darwin' }, t => {
  const { shim, run, status, resetEnvironment } = fixture(t, { loaded: false });
  run('install');
  const app = path.join(path.dirname(shim), 'Nonstandard apps/Codex.app');
  const executable = path.join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
  resetEnvironment();
  run('restore', { AGENTREMINDER_CODEX_APP: app, AGENTREMINDER_CODEX_REAL_CLI: '' });
  assert(fs.readFileSync(shim, 'utf8').includes(executable));
  assert.equal(status().override, shim);
});

test('the menu takes over the enabled legacy Codex login configuration and restores it after a login', { skip: process.platform !== 'darwin' }, t => {
  const { plist, enabled, shim, status, resetEnvironment, legacy, run } = fixture(t, { loaded: true });
  legacy();
  run('restore');
  assert(!fs.existsSync(plist));
  assert(fs.existsSync(enabled));
  assert.deepEqual(status(), { loaded: false, override: shim });
  resetEnvironment();
  run('restore');
  assert.equal(status().override, shim);
  resetEnvironment('/path/to/another-cli');
  run('restore');
  assert.equal(status().override, '/path/to/another-cli');
  run('uninstall');
  assert(!fs.existsSync(enabled));
  assert.equal(status().override, '/path/to/another-cli');
});

test('migration respects a disabled legacy item and a fresh opt-in creates no LaunchAgent', { skip: process.platform !== 'darwin' }, t => {
  const { plist, enabled, shim, status, legacy, run } = fixture(t, { loaded: false, disabled: true });
  legacy();
  run('restore');
  assert(!fs.existsSync(plist));
  assert(!fs.existsSync(enabled));
  assert.equal(status().override, undefined);
  run('install');
  assert(fs.existsSync(enabled));
  assert(!fs.existsSync(plist));
  assert.equal(status().override, shim);
  run('uninstall');
  assert(!fs.existsSync(enabled));
  assert.equal(status().override, undefined);
});
