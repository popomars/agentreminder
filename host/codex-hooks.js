'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

function findExecutable(name, accept = () => true) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      if (accept(candidate)) return candidate;
    } catch (_) { /* try the next entry */ }
  }
}

function realPath(file) {
  try { return fs.realpathSync(file); }
  catch (_) { return path.resolve(file); }
}

function listHooks(binary, codexHome) {
  return new Promise(resolve => {
    const cwd = os.homedir();
    const child = spawn(binary, ['app-server'], {
      cwd, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = hooks => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const forced = setTimeout(() => child.kill('SIGKILL'), 500);
        forced.unref();
        child.once('exit', () => clearTimeout(forced));
      }
      resolve(hooks);
    };
    const timer = setTimeout(finish, 4000);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.once('error', () => finish());
    child.once('close', () => finish());
    child.stdin.on('error', () => finish());
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch (_) { return; }
      if (message.id === 1) {
        if (message.error) return finish();
        send({ method: 'initialized' });
        send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
      }
      if (message.id === 2) {
        const entries = message.result?.data;
        finish(Array.isArray(entries) ? entries.flatMap(entry => entry.hooks || []) : undefined);
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'agentreminder', version: '1' }, capabilities: { experimentalApi: true },
    } });
  });
}

async function trustStatus(file, positions, desktopApp) {
  const desktop = desktopApp && path.join(desktopApp, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const binary = desktop || findExecutable('codex');
  const hooks = binary && Object.values(positions).some(indices => indices.length) && await listHooks(binary, path.dirname(file));
  const sourcePath = realPath(file);
  const result = { source: desktop ? 'desktop' : binary ? 'cli' : undefined };
  for (const [event, indices] of Object.entries(positions)) {
    if (!indices.length) result[event] = 'missing';
    else if (!hooks) result[event] = 'unavailable';
    else {
      const eventKey = event === 'permissionRequest' ? 'permission_request' : 'stop';
      const entries = hooks.filter(hook => typeof hook.sourcePath === 'string' &&
        realPath(hook.sourcePath) === sourcePath && indices.some(index =>
          hook.key === `${hook.sourcePath}:${eventKey}:${index}`));
      result[event] = ['modified', 'untrusted'].find(state => entries.some(hook => hook.enabled && hook.trustStatus === state))
        || (entries.length !== indices.length ? 'unavailable' :
          entries.some(hook => !hook.enabled) ? 'disabled' :
            entries.every(hook => ['trusted', 'managed'].includes(hook.trustStatus)) ? 'trusted' : 'unavailable');
    }
  }
  return result;
}

module.exports = { findExecutable, realPath, trustStatus };
