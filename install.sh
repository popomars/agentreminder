#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=popomars/agentreminder
ref=main
pair=true
agents=()
while (( $# )); do
  case "$1" in
    --agent)
      case "${2:-}" in codex|claude|dsh) agents+=("$2");; *) echo '用法：--agent codex|claude|dsh' >&2; exit 2;; esac
      shift 2;;
    --ref)
      if [[ ! ${2:-} =~ ^[A-Za-z0-9._-]+$ ]]; then echo '请指定分支、标签或提交 SHA。' >&2; exit 2; fi
      ref=$2
      shift 2;;
    --no-pair) pair=false; shift;;
    -h|--help) echo '用法：bash install.sh [--agent codex|claude|dsh] [--ref REF] [--no-pair]'; exit 0;;
    *) echo "未知选项：$1" >&2; exit 2;;
  esac
done

case "$(uname -s)" in Darwin|Linux) ;; *) echo '目前安装脚本支持 macOS 和 Linux。' >&2; exit 1;; esac
command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(".")[0] < 18 ? 1 : 0)' || {
  echo '请先安装 Node.js 18 或更新版本。' >&2
  exit 1
}

if (( ${#agents[@]} == 0 )); then
  if command -v codex >/dev/null || [[ -d ${CODEX_HOME:-"$HOME/.codex"} || -x "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" ]]; then agents+=(codex); fi
  if command -v claude >/dev/null || [[ -d "$HOME/.claude" ]]; then agents+=(claude); fi
  if command -v dsh >/dev/null; then agents+=(dsh); fi
fi
if (( ${#agents[@]} == 0 )); then
  echo '未找到 agent。请用 --agent codex、--agent claude 或 --agent dsh 指定。' >&2
  exit 1
fi

install_dir="${AGENTREMINDER_HOME:-"$HOME/.agentreminder"}/app"
mkdir -p "$install_dir/host/tools" "$install_dir/integrations/dsh"
stage="$(mktemp -d "$install_dir/.install.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
files=(host/agentreminder.js host/codex-approval-proxy.js host/codex-approval-cli host/open-codex.sh
  host/tools/hardware-check.js integrations/dsh/cordis.patch.yml)
if [[ -f "$source_dir/host/agentreminder.js" && "$source_dir" != "$install_dir" ]]; then
  for file in "${files[@]}"; do
    mkdir -p "$stage/$(dirname "$file")"
    cp "$source_dir/$file" "$stage/$file"
  done
else
  github_token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [[ -z "$github_token" ]] && command -v gh >/dev/null; then
    github_token="$(gh auth token 2>/dev/null || true)"
  fi
  github_get() {
    local endpoint=$1 media=$2
    if [[ -n "$github_token" ]]; then
      printf 'Authorization: Bearer %s\n' "$github_token" | curl -fsS --retry 2 -H @- \
        -H "Accept: $media" "https://api.github.com/repos/$repo/$endpoint"
    else
      curl -fsS --retry 2 -H "Accept: $media" "https://api.github.com/repos/$repo/$endpoint"
    fi
  }
  sha="$(github_get "commits/$ref" application/vnd.github.sha)" || {
    echo "请设置有仓库读取权限的 GH_TOKEN，或通过 gh auth login 登录后重试。" >&2
    exit 1
  }
  if [[ ! $sha =~ ^[a-f0-9]{40}$ ]]; then echo 'GitHub 没有返回有效的提交 SHA。' >&2; exit 1; fi
  for file in "${files[@]}"; do
    mkdir -p "$stage/$(dirname "$file")"
    github_get "contents/$file?ref=$sha" application/vnd.github.raw+json > "$stage/$file"
  done
  unset github_token

fi
node --check "$stage/host/agentreminder.js"
node --check "$stage/host/codex-approval-proxy.js"
node --check "$stage/host/tools/hardware-check.js"
for file in "${files[@]}"; do
  mv "$stage/$file" "$install_dir/$file"
done
chmod 700 "$install_dir/host/codex-approval-cli" "$install_dir/host/open-codex.sh"

host="$install_dir/host/agentreminder.js"
for agent in "${agents[@]}"; do node "$host" install "$agent"; done
if "$pair"; then node "$host" setup-usb; fi

echo "AgentReminder 已安装到 $install_dir"
printf '查看连接状态：node "%s" status\n' "$host"
if ! "$pair"; then printf '连接设备后配对：node "%s" pair\n' "$host"; fi
for agent in "${agents[@]}"; do
  if [[ "$agent" == dsh ]]; then
    printf 'dsh 需安装 Claude Code hooks 桥接，并将配置合并到所用 profile：%s/integrations/dsh/cordis.patch.yml\n' "$install_dir"
  fi
done
