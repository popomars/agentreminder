'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_TAIL_BYTES = 128 * 1024;
const MAX_EVENT_AGE = 60_000;
const ASK = 'command-safety.ask-matched';
const RESOLVED = new Set(['command-safety.approved', 'command-safety.rejected']);

function auditFiles(directory, now) {
  const day = new Date(now);
  const localDay = [day.getFullYear(), day.getMonth() + 1, day.getDate()]
    .map(value => String(value).padStart(2, '0')).join('-');
  // WorkBuddy writes a live per-worker spool, then consolidates it into the daily file.
  const dates = new Set([localDay, day.toISOString().slice(0, 10)]);
  const yesterday = new Date(day);
  yesterday.setDate(day.getDate() - 1);
  if (day.getHours() === 0) {
    dates.add([yesterday.getFullYear(), yesterday.getMonth() + 1, yesterday.getDate()]
      .map(value => String(value).padStart(2, '0')).join('-'));
  }
  const spool = path.join(directory, 'spool');
  let names = [];
  try { names = fs.readdirSync(spool); } catch (_) { /* spool may not exist yet */ }
  const live = names.filter(name => {
    const match = name.match(/^audit-spool-\d+-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    return match && dates.has(match[1]);
  });
  return [...[...dates].map(date => path.join(directory, date + '.jsonl')),
    ...live.map(name => path.join(spool, name))];
}

function changedRecords(file, signatures) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile()) return [];
  const signature = `${info.ino}/${info.size}/${info.mtimeMs}`;
  if (signatures.get(file) === signature) return [];
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const start = Math.max(0, info.size - MAX_TAIL_BYTES);
    const bytes = Buffer.alloc(info.size - start);
    const length = fs.readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.toString('utf8', 0, length).split('\n');
    // A file can start mid-record in the bounded tail or end in a concurrent partial write.
    if (start) lines.shift();
    lines.pop();
    signatures.set(file, signature);
    return lines.flatMap(line => {
      try { return [JSON.parse(line)]; } catch (_) { return []; }
    });
  } finally { fs.closeSync(fd); }
}

function createApprovalMonitor(directory, notify, log, clock = Date.now) {
  const signatures = new Map();
  const seen = new Map();
  let activeSince;
  let timer;

  function poll() {
    if (activeSince === undefined) return;
    const now = clock();
    const cutoff = Math.max(activeSince, now - MAX_EVENT_AGE);
    for (const [key, timestamp] of seen) {
      if (timestamp < now - MAX_EVENT_AGE) seen.delete(key);
    }
    const files = auditFiles(directory, now);
    for (const file of signatures.keys()) {
      if (!files.includes(file)) signatures.delete(file);
    }
    const asks = new Map();
    for (const file of files) {
      let records;
      try { records = changedRecords(file, signatures); }
      catch (_) { continue; } // WorkBuddy can rotate its spool between listing and reading it.
      for (const record of records) {
        const type = record?.eventType;
        if (type !== ASK && !RESOLVED.has(type)) continue;
        const { timestamp, sessionId, requestId, toolCallId } = record;
        if (!Number.isSafeInteger(timestamp) || timestamp < cutoff || timestamp > now + 5000 ||
            ![sessionId, requestId, toolCallId].every(id => typeof id === 'string' && id.length && id.length <= 128)) continue;
        const key = JSON.stringify([sessionId, requestId, toolCallId]);
        if (RESOLVED.has(type)) seen.set(key, timestamp);
        else asks.set(key, record);
      }
    }
    for (const [key, { sessionId, timestamp }] of asks) {
      if (seen.has(key)) continue;
      seen.set(key, timestamp);
      // Only send the action needed. Audit records can contain command arguments and secrets.
      const reason = '请回到 WorkBuddy 确认';
      Promise.resolve(notify({
        agent: 'workbuddy', project: 'WorkBuddy', sessionId, kind: 'input',
        title: 'WorkBuddy 命令待确认', reason, detail: reason,
      })).catch(() => log('WorkBuddy approval reminder delivery failed'));
    }
  }

  return {
    setEnabled(enabled) {
      if (enabled === (timer !== undefined)) return;
      clearInterval(timer);
      timer = undefined;
      signatures.clear();
      seen.clear();
      activeSince = enabled ? clock() : undefined;
      if (enabled) timer = setInterval(poll, 1000).unref();
    },
    poll,
  };
}

module.exports = { createApprovalMonitor };
