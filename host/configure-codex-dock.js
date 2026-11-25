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
const shim = path.join(home, '.agentreminder', 'dock-codex-cli');
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

function xml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function install() {
  const override = currentOverride();
  if (override && override !== shim) {
    throw new Error(`CODEX_CLI_PATH 已有其他设置：${override}`);
  }
  fs.accessSync(cli, fs.constants.X_OK);
  fs.accessSync(proxy, fs.constants.R_OK);
  const shimExists = owned(shim);
  const plistExists = owned(plist);
  if (!plistExists && running()) throw new Error(`发现同名登录项：${label}`);
  const node = findNode();
  fs.mkdirSync(path.dirname(shim), { mode: 0o700, recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const shimBody = `#!/bin/sh
${ownerMarker}
set -eu
if [ "\${1-}" = --agentreminder-set-dock-env ]; then
  current=$(/bin/launchctl getenv CODEX_CLI_PATH || true)
  if [ -z "$current" ] || [ "$current" = ${shellQuote(shim)} ]; then
    exec /bin/launchctl setenv CODEX_CLI_PATH ${shellQuote(shim)}
  fi
  exit 0
fi
node=${shellQuote(node)}
proxy=${shellQuote(proxy)}
cli=${shellQuote(cli)}
if [ -x "$node" ] && [ -r "$proxy" ]; then
  export AGENTREMINDER_CODEX_REAL_CLI="$cli"
  exec "$node" "$proxy" "$@"
fi
exec "$cli" "$@"
`;
  const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${ownerMarker} -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>${xml(shim)}</string><string>--agentreminder-set-dock-env</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;

  try {
    writePrivate(shim, shimBody, 0o700);
    if (!plistExists || fs.readFileSync(plist, 'utf8') !== plistBody) {
      if (running()) mustRun('bootout', target);
      writePrivate(plist, plistBody, 0o600);
    }
    if (!running()) mustRun('bootstrap', domain, plist);
    if (currentOverride() !== shim) mustRun('kickstart', target);
    for (let i = 0; i < 20 && currentOverride() !== shim; i++) {
      spawnSync('/bin/sleep', ['0.1']);
    }
    if (currentOverride() !== shim) {
      const info = launchctl('print', target).stdout?.match(/^\s*last exit code = .+$/m)?.[0].trim();
      throw new Error(`登录项没有设置 Codex 的启动路径。${info ? `（${info}）` : ''}`);
    }
  } catch (error) {
    // A failed first install should leave the ordinary Dock launch usable.
    if (!plistExists) {
      if (running()) launchctl('bootout', target);
      if (currentOverride() === shim) launchctl('asuser', String(process.getuid()), '/bin/launchctl', 'unsetenv', 'CODEX_CLI_PATH');
      fs.rmSync(plist, { force: true });
    }
    if (!shimExists) fs.rmSync(shim, { force: true });
    throw error;
  }
}

function uninstall() {
  const plistExists = owned(plist);
  // Reject a file or job owned by something other than this script.
  owned(shim);
  if (running()) {
    if (!plistExists) throw new Error(`发现同名登录项：${label}`);
    mustRun('bootout', target);
  }
  if (currentOverride() === shim) mustRun('asuser', String(process.getuid()), '/bin/launchctl', 'unsetenv', 'CODEX_CLI_PATH');
  fs.rmSync(plist, { force: true });
  // Keep the shim available to any already-running ChatGPT process until it exits.
}

function uninstallIfInstalled() {
  if (process.platform !== 'darwin' || (!fs.existsSync(plist) && !fs.existsSync(shim))) return false;
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
    case 'uninstall':
      uninstall();
      console.log('已关闭。下次从 Dock 启动时会使用原来的配置。');
      break;
    default:
      throw new Error('用法：node host/configure-codex-dock.js install|status|uninstall');
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { uninstallIfInstalled };
