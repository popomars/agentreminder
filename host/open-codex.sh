#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="${AGENTREMINDER_CODEX_APP:-/Applications/ChatGPT.app}"
cli="${AGENTREMINDER_CODEX_REAL_CLI:-"$app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"}"
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" || ! -x "$cli" || ! -x "$root/codex-approval-cli" ]]; then
  echo '需要 Node.js、Codex 桌面版和可执行的 AgentReminder 转接脚本。' >&2
  exit 1
fi
if pgrep -x "$(basename "$app" .app)" >/dev/null; then
  echo '请保存当前工作并完全退出 ChatGPT 桌面应用，再用本脚本打开。' >&2
  exit 1
fi
open -a "$app" \
  --env "CODEX_CLI_PATH=$root/codex-approval-cli" \
  --env "AGENTREMINDER_CODEX_REAL_CLI=$cli" \
  --env "AGENTREMINDER_NODE=$node_bin"
