#!/usr/bin/env node
// Run against the real daemon/device. Never executes the operation shown on screen.
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { describeSession } = require('../agentreminder');
const sessionId = process.env.AGENTREMINDER_TEST_SESSION_ID || '';
const conversation = describeSession({ session_id: sessionId }, 'codex').conversation;
const host = path.resolve(__dirname, '../agentreminder.js');
const env = { ...process.env };
delete env.AGENTREMINDER_CODEX_DUAL_APPROVAL;
function hook(agent, event, data) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [host, 'hook', '--agent', agent, '--event', event], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.once('error', reject);
    child.once('exit', code => code ? reject(new Error(stderr || `exit ${code}`)) : resolve(stdout));
    child.stdin.end(JSON.stringify(data));
  });
}
(async () => {
  const results = [];
  for (const [agent, expected] of [['codex', 'deny'], ['claude', 'allow']]) {
    console.log(`请按设备${expected === 'allow' ? '最右侧物理键（同意）' : '最左侧物理键（拒绝）'}：${agent} 测试卡片。`);
    const stdout = await hook(agent, 'permission', { session_id: sessionId, conversation_title: conversation, cwd: process.cwd(), tool_name: '固件与实体按键验证',
      tool_input: { command: '设备连接 → 审批消息 → 实体按键 → 回传结果', description: `${agent}：请按${expected === 'allow' ? '右键同意' : '左键拒绝'}。检查汉字：审批、拒绝、终端、任务完成。仅测试，不执行命令。` } });
    const decision = stdout ? JSON.parse(stdout).hookSpecificOutput.decision.behavior : 'fallback';
    results.push({ agent, expected, decision, passed: decision === expected, at: new Date().toISOString() });
    console.log('Hook 返回:', stdout || '(交回终端)');
    if (decision !== expected) break;
  }
  await hook('claude', 'stop', { session_id: sessionId, conversation_title: conversation, cwd: process.cwd(), last_assistant_message: '设备测试结束。点击此通知可清除。' });
  const dir = path.resolve(__dirname, '../../.runtime'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hardware-check.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
  if (results.length !== 2 || results.some(r => !r.passed)) process.exitCode = 1;
})().catch(e => { console.error(e.message); process.exitCode = 1; });
