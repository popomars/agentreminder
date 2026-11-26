'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApprovalMonitor } = require('../workbuddy');

test('WorkBuddy monitors live audit events, deduplicates consolidation, and skips completed or old requests', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'spool'));
  let now = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);
  const daily = path.join(dir, date + '.jsonl');
  const spool = path.join(dir, 'spool', 'audit-spool-1-' + date + '.jsonl');
  const delivered = [];
  const monitor = createApprovalMonitor(dir, info => delivered.push(info), () => {}, () => now);
  t.after(() => monitor.setEnabled(false));
  const event = (toolCallId, type = 'ask-matched', timestamp = now) => JSON.stringify({
    eventType: 'command-safety.' + type, sessionId: 'session', requestId: 'request', toolCallId, timestamp,
    commandPreview: 'private command', messageParams: { hidden: 'secret' },
  });

  fs.writeFileSync(daily, event('old', 'ask-matched', now - 1) + '\n');
  monitor.setEnabled(true);
  fs.writeFileSync(spool, event('live') + '\n' + event('partial'));
  monitor.poll();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].kind, 'input');
  assert.equal(delivered[0].sessionId, 'session');
  assert.doesNotMatch(JSON.stringify(delivered[0]), /private command|secret/);
  fs.appendFileSync(spool, '\n');
  fs.appendFileSync(daily, event('live') + '\n' + event('rejected') + '\n' + event('rejected', 'rejected') + '\n');
  monitor.poll();
  assert.equal(delivered.length, 2);
  fs.rmSync(spool);
  fs.appendFileSync(daily, event('partial') + '\n');
  monitor.poll();
  assert.equal(delivered.length, 2);

  monitor.setEnabled(false);
  ++now;
  fs.appendFileSync(daily, event('disabled') + '\n');
  monitor.poll();
  ++now;
  monitor.setEnabled(true);
  fs.appendFileSync(daily, event('new') + '\n');
  monitor.poll();
  assert.equal(delivered.length, 3);
});
