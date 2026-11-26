'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { shellQuote } = require('./agentreminder');

const label = 'com.agentreminder.codex-dock';
const domain = `gui/${process.getuid()}`;
const target = `${domain}/${label}`;
const home = os.homedir();
const agentDir = path.join(home, 'Library', 'LaunchAgents');
const plist = path.join(agentDir, `${label}.plist`);
const state = path.join(home, '.agentreminder');
const shim = path.join(state, 'dock-codex-cli');
const enabledFile = path.join(state, 'codex-dock-enabled');
const ownerMarker = '# Managed by AgentReminder Dock integration';
const proxy = path.join(__dirname, 'codex-approval-proxy.js');
const app = process.env.AGENTREMINDER_CODEX_APP || '/Applications/ChatGPT.app';
const cli = process.env.AGENTREMINDER_CODEX_REAL_CLI ||
  path.join(app, 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex');

function launchctl(...args) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
}

function mustRun(...args) {
  const result = launchctl(...args);
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || `launchctl ${args[0]} failed`);
}

function currentOverride() {
  // The invoking terminal can belong to a different bootstrap context.
  const gui = launchctl('print', domain);
  if (gui.status !== 0) throw new Error('无法读取当前用户的 macOS 图形会话。');
  const environment = gui.stdout.match(/^\s*environment = \{([\s\S]*?)^\s*\}/m)?.[1] || '';
  return environment.match(/^\s*CODEX_CLI_PATH\s*=>\s*(.+)$/m)?.[1].trim() || '';
}

function running() {
  return launchctl('print', target).status === 0;
}

function owned(file) {
  if (!fs.existsSync(file)) return false;
  if (!fs.lstatSync(file).isFile() || !fs.readFileSync(file, 'utf8').includes(ownerMarker)) {
    throw new Error(`已存在其他配置：${file}`);
  }
  return true;
}

function writePrivate(file, content, mode) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { mode, flag: 'wx' });
  try { fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}

function findNode() {
  // Prefer the PATH entry (often a stable symlink) to a versioned Homebrew Cellar path.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'node');
    try {
      if (fs.realpathSync(candidate) === fs.realpathSync(process.execPath)) return candidate;
    } catch (_) { /* no node in that PATH entry */ }
  }
  return process.execPath;
}

function saveEnabled() {
  writePrivate(enabledFile, ownerMarker + '\n', 0o600);
}

function editGuiEnvironment(...args) {
  mustRun('asuser', String(process.getuid()), '/bin/launchctl', ...args);
}

function applyOverride() {
  if (currentOverride()) return;
  editGuiEnvironment('setenv', 'CODEX_CLI_PATH', shim);
  if (currentOverride() !== shim) throw new Error('无法设置 Codex 的启动路径。');
}

function removeLegacyAgent(exists) {
  if (running()) {
    if (!exists) throw new Error(`发现同名登录项：${label}`);
    mustRun('bootout', target);
  }
  if (exists) fs.unlinkSync(plist);
}

function restore() {
  const enabled = owned(enabledFile);
  const legacy = owned(plist);
  if (!enabled && !legacy) return;
  const hasShim = owned(shim);
  if (legacy && !enabled && hasShim) {
    const disabled = launchctl('print-disabled', domain);
    if (disabled.status !== 0) throw new Error('无法读取旧版 Codex 登录项状态。');
    const explicitlyDisabled = /^\s*"com\.agentreminder\.codex-dock"\s*=>\s*(disabled|true)\b/m.test(disabled.stdout);
    if (!explicitlyDisabled && (running() || currentOverride() === shim)) saveEnabled();
  }
  if (hasShim && owned(enabledFile)) {
    const override = currentOverride();
    if ((!override || override === shim) && (process.env.AGENTREMINDER_CODEX_APP || process.env.AGENTREMINDER_CODEX_REAL_CLI)
        && fs.existsSync(cli)) {
      // Rebuild the shim if macOS found the app at a new location.
      install();
      return;
    }
    applyOverride();
  }
  if (legacy) removeLegacyAgent(legacy);
}

function install() {
  const override = currentOverride();
  if (override && override !== shim) {
    throw new Error(`CODEX_CLI_PATH 已有其他设置：${override}`);
  }
  fs.accessSync(cli, fs.constants.X_OK);
  fs.accessSync(proxy, fs.constants.R_OK);
  const shimExists = owned(shim);
  const legacy = owned(plist);
  const enabled = owned(enabledFile);
  if (!legacy && running()) throw new Error(`发现同名登录项：${label}`);
  const node = findNode();
  fs.mkdirSync(path.dirname(shim), { mode: 0o700, recursive: true });

  const shimBody = `#!/bin/sh
${ownerMarker}
set -eu
node=${shellQuote(node)}
proxy=${shellQuote(proxy)}
cli=${shellQuote(cli)}
if [ -x "$node" ] && [ -r "$proxy" ]; then
  export AGENTREMINDER_CODEX_REAL_CLI="$cli"
  exec "$node" "$proxy" "$@"
fi
exec "$cli" "$@"
`;
  try {
    if (!shimExists || fs.readFileSync(shim, 'utf8') !== shimBody) writePrivate(shim, shimBody, 0o700);
    applyOverride();
    if (currentOverride() !== shim) throw new Error('CODEX_CLI_PATH 已有其他设置。');
    if (!enabled) saveEnabled();
  } catch (error) {
    if (!enabled && override !== shim && currentOverride() === shim) {
      editGuiEnvironment('unsetenv', 'CODEX_CLI_PATH');
    }
    if (!shimExists) fs.rmSync(shim, { force: true });
    throw error;
  }
  if (legacy) removeLegacyAgent(legacy);
}

function uninstall() {
  const legacy = owned(plist);
  // Reject a file or job owned by something other than this script.
  owned(shim);
  const enabled = owned(enabledFile);
  removeLegacyAgent(legacy);
  if (currentOverride() === shim) editGuiEnvironment('unsetenv', 'CODEX_CLI_PATH');
  if (enabled) fs.unlinkSync(enabledFile);
  // Keep the shim available to any already-running ChatGPT process until it exits.
}

function uninstallIfInstalled() {
  if (process.platform !== 'darwin' || ![plist, shim, enabledFile].some(file => fs.existsSync(file))) return false;
  uninstall();
  return true;
}

function main() {
  if (process.platform !== 'darwin') throw new Error('Dock 集成仅支持 macOS。');
  switch (process.argv[2]) {
    case 'install':
      install();
      console.log('已配置。退出 ChatGPT 后，可从原来的 Dock 图标启动。');
      break;
    case 'status':
      console.log(JSON.stringify({
        loginAgentLoaded: running(),
        dockOverrideActive: currentOverride() === shim,
        shim,
      }, null, 2));
      break;
    case 'restore':
      restore();
      break;
    case 'uninstall':
      uninstall();
      console.log('已关闭。下次从 Dock 启动时会使用原来的配置。');
      break;
    default:
      throw new Error('用法：node host/configure-codex-dock.js install|status|restore|uninstall');
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { uninstallIfInstalled };
