#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=popomars/agentreminder
ref=main
use_checkout=true
pair=true
menu_bar=false
install_hooks=true
flash=false
board=
flash_port=
flash_baud=
lang=zh
agents=()
say() { if [[ "$lang" == en ]]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
usage() {
  say '用法：bash install.sh [--agent codex|claude|dsh] [--ref REF] [--flash [--board waveshare-amoled-2.16|folotoy-passport] [--port DEVICE] [--baud RATE]] [--menu-bar] [--skip-hooks] [--no-pair] [--lang zh|en]' \
      'Usage: bash install.sh [--agent codex|claude|dsh] [--ref REF] [--flash [--board waveshare-amoled-2.16|folotoy-passport] [--port DEVICE] [--baud RATE]] [--menu-bar] [--skip-hooks] [--no-pair] [--lang zh|en]'
}
while (( $# )); do
  case "$1" in
    --agent)
      case "${2:-}" in codex|claude|dsh) agents+=("$2");; *) usage >&2; exit 2;; esac
      shift 2;;
    --ref)
      if [[ ! ${2:-} =~ ^[A-Za-z0-9._/-]+$ ]]; then usage >&2; exit 2; fi
      ref=$2; use_checkout=false
      shift 2;;
    --flash) flash=true; shift;;
    --board)
      case "${2:-}" in waveshare-amoled-2.16|folotoy-passport) board=$2;; *) usage >&2; exit 2;; esac
      shift 2;;
    --port) [[ -n ${2:-} ]] || { usage >&2; exit 2; }; flash_port=$2; shift 2;;
    --baud) [[ ${2:-} =~ ^[0-9]+$ ]] || { usage >&2; exit 2; }; flash_baud=$2; shift 2;;
    --lang) case "${2:-}" in zh|en) lang=$2;; *) usage >&2; exit 2;; esac; shift 2;;
    --menu-bar) menu_bar=true; shift;;
    --skip-hooks) install_hooks=false; shift;;
    --no-pair) pair=false; shift;;
    -h|--help) usage; exit 0;;
    *) usage >&2; exit 2;;
  esac
done

case "$(uname -s)" in Darwin|Linux) ;; *) say '目前安装脚本支持 macOS 和 Linux。' 'The installer supports macOS and Linux.' >&2; exit 1;; esac
command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(".")[0] < 18 ? 1 : 0)' || {
  say '请先安装 Node.js 18 或更新版本。' 'Install Node.js 18 or newer first.' >&2
  exit 1
}
if "$menu_bar"; then
  if [[ "$(uname -s)" != Darwin ]] || (( $(sw_vers -productVersion | cut -d. -f1) < 13 )) ||
     ! xcrun --find swiftc >/dev/null 2>&1; then
    say '菜单栏应用需要 macOS 13 或更新版本及 Xcode 命令行工具。' 'The menu bar app requires macOS 13 or later and Xcode Command Line Tools.' >&2
    exit 1
  fi
fi
if "$flash"; then
  command -v python3 >/dev/null || { say '刷机需要 Python 3。' 'Flashing requires Python 3.' >&2; exit 1; }
elif [[ -n "$board$flash_port$flash_baud" ]]; then
  usage >&2
  exit 2
fi

if "$install_hooks" && (( ${#agents[@]} == 0 )); then
  if command -v codex >/dev/null || [[ -d ${CODEX_HOME:-"$HOME/.codex"} || -x "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" ]]; then agents+=(codex); fi
  if command -v claude >/dev/null || [[ -d "$HOME/.claude" ]]; then agents+=(claude); fi
  if command -v dsh >/dev/null; then agents+=(dsh); fi
fi
if "$install_hooks" && (( ${#agents[@]} == 0 )); then
  say '未找到 agent。请使用 --agent codex、--agent claude 或 --agent dsh。' \
      'No agent detected. Pass --agent codex, --agent claude, or --agent dsh.' >&2
  exit 1
fi

install_dir="${AGENTREMINDER_HOME:-"$HOME/.agentreminder"}/app"
mkdir -p "$install_dir/host/tools" "$install_dir/integrations/dsh"
stage="$(mktemp -d "$install_dir/.install.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sha=
files=(uninstall.sh host/uninstall.js host/agentreminder.js host/bluetooth.js host/codex-approval-proxy.js host/codex-approval-cli host/open-codex.sh host/configure-codex-dock.js
  host/tools/hardware-check.js integrations/dsh/cordis.patch.yml)
if "$flash"; then
  if [[ "$board" == folotoy-passport ]]; then
    firmware_dir=firmware/release/folotoy-ai-passport
    firmware_files=(AgentReminder-AI-Passport-app.bin AgentReminder-AI-Passport-full.bin)
    board_args=(--board "$board")
  else
    firmware_dir=firmware/release/waveshare-amoled-2.16
    firmware_files=(bootloader.bin partitions.bin boot_app0.bin firmware.bin)
    # The default also works with flash.sh from older refs.
    board_args=()
  fi
  files+=(flash.sh "$firmware_dir/SHA256SUMS")
  for file in "${firmware_files[@]}"; do files+=("$firmware_dir/$file"); done
  mkdir -p "$install_dir/$firmware_dir"
fi
if [[ "$(uname -s)" == Darwin ]]; then
  files+=(host/bluetooth/agentreminder-bluetooth)
  mkdir -p "$install_dir/host/bluetooth"
fi
if "$use_checkout" && [[ -f "$source_dir/host/agentreminder.js" && "$source_dir" != "$install_dir" ]]; then
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
    say '请设置有仓库读取权限的 GH_TOKEN，或通过 gh auth login 登录后重试。' \
        'Set GH_TOKEN with repository read access, or sign in with gh auth login and retry.' >&2
    exit 1
  }
  if [[ ! $sha =~ ^[a-f0-9]{40}$ ]]; then say 'GitHub 没有返回有效的提交 SHA。' 'GitHub did not return a valid commit SHA.' >&2; exit 1; fi
  for file in "${files[@]}"; do
    mkdir -p "$stage/$(dirname "$file")"
    github_get "contents/$file?ref=$sha" application/vnd.github.raw+json > "$stage/$file"
  done
fi
# Older refs predate the Tailnet module. Fetch it only when the selected runtime uses it.
if grep -Fq "require('./tailnet')" "$stage/host/agentreminder.js"; then
  tailnet_file=host/tailnet.js
  if [[ -n ${sha:-} ]]; then
    github_get "contents/$tailnet_file?ref=$sha" application/vnd.github.raw+json > "$stage/$tailnet_file"
  else
    cp "$source_dir/$tailnet_file" "$stage/$tailnet_file"
  fi
  node --check "$stage/$tailnet_file"
  files+=("$tailnet_file")
fi
if "$menu_bar"; then
  mkdir -p "$stage/menu-bar"
  for file in Main.swift Info.plist; do
    if [[ -n $sha ]]; then
      github_get "contents/host/menu-bar/$file?ref=$sha" application/vnd.github.raw+json > "$stage/menu-bar/$file"
    else
      cp "$source_dir/host/menu-bar/$file" "$stage/menu-bar/$file"
    fi
  done
  menu_app=AgentReminder.app
  menu_contents="$stage/$menu_app/Contents"
  mkdir -p "$menu_contents/MacOS" "$menu_contents/Resources"
  cp "$stage/menu-bar/Info.plist" "$menu_contents/Info.plist"
  xcrun swiftc -O -parse-as-library -target "$(uname -m)-apple-macos13" -module-cache-path "$stage/swift-cache" \
    "$stage/menu-bar/Main.swift" -o "$menu_contents/MacOS/AgentReminder"
  node - "$install_dir" "$lang" > "$menu_contents/Resources/Installation.json" <<'JS'
const path = require('node:path');
const [installDir, language] = process.argv.slice(2);
console.log(JSON.stringify({ node: process.execPath, statePath: path.resolve(installDir, '..'), language }));
JS
  codesign --sign - "$stage/$menu_app"
  files+=("$menu_app/Contents/Info.plist" "$menu_app/Contents/MacOS/AgentReminder"
    "$menu_app/Contents/Resources/Installation.json" "$menu_app/Contents/_CodeSignature/CodeResources")
fi
unset github_token
node --check "$stage/host/agentreminder.js"
node --check "$stage/host/uninstall.js"
node --check "$stage/host/bluetooth.js"
node --check "$stage/host/codex-approval-proxy.js"
node --check "$stage/host/configure-codex-dock.js"
node --check "$stage/host/tools/hardware-check.js"
if "$flash"; then
  AGENTREMINDER_LANG="$lang" bash "$stage/flash.sh" --check ${board_args[@]+"${board_args[@]}"}
fi
for file in "${files[@]}"; do
  mkdir -p "$install_dir/$(dirname "$file")"
  mv "$stage/$file" "$install_dir/$file"
done
chmod 700 "$install_dir/uninstall.sh" "$install_dir/host/codex-approval-cli" "$install_dir/host/open-codex.sh"
if [[ "$(uname -s)" == Darwin ]]; then chmod 700 "$install_dir/host/bluetooth/agentreminder-bluetooth"; fi

host="$install_dir/host/agentreminder.js"
if "$flash"; then
  set -- ${board_args[@]+"${board_args[@]}"}
  if [[ -n "$flash_port" ]]; then set -- "$@" --port "$flash_port"; fi
  if [[ -n "$flash_baud" ]]; then set -- "$@" --baud "$flash_baud"; fi
  AGENTREMINDER_LANG="$lang" bash "$install_dir/flash.sh" "$@"
fi

run_host() {
  if [[ "$lang" == en ]]; then
    local output
    if ! output="$(node "$host" "$@" 2>&1)"; then
      printf 'AgentReminder setup failed (%s).\n%s\n' "$1" "$output" >&2
      return 1
    fi
  else
    node "$host" "$@"
  fi
}

if "$install_hooks"; then
  for agent in "${agents[@]}"; do run_host install "$agent"; done
fi
if "$pair"; then
  run_host setup-usb
  if [[ "$lang" == en ]]; then echo 'Connect the board by USB. Follow the prompt on its screen to confirm.'; fi
fi

if "$menu_bar"; then
  menu_path="$(cd "$install_dir" && pwd)/$menu_app"
  if [[ -z ${AGENTREMINDER_HOME:-} ]]; then
    mkdir -p "$HOME/Applications"
    shortcut="$HOME/Applications/$menu_app"
    if [[ ! -e "$shortcut" && ! -L "$shortcut" ]]; then ln -s "$menu_path" "$shortcut"; fi
    if [[ -L "$shortcut" && "$(readlink "$shortcut")" == "$menu_path" ]]; then menu_path="$shortcut"; fi
  fi
  say "在访达双击 $menu_path 即可启动菜单栏服务。" "Open $menu_path in Finder to start AgentReminder."
fi

say "AgentReminder 已安装到 $install_dir" "AgentReminder is installed in $install_dir"
say "查看连接状态：node \"$host\" status" "Check connection: node \"$host\" status"
say "卸载主机服务：bash \"$install_dir/uninstall.sh\"" "Uninstall: bash \"$install_dir/uninstall.sh\" --lang en"
if ! "$pair"; then say "连接设备后配对：node \"$host\" pair" "Pair after connecting by USB: node \"$host\" pair"; fi
for agent in ${agents[@]+"${agents[@]}"}; do
  if [[ "$agent" == dsh ]]; then
    say "dsh 需安装 Claude Code hooks 桥接，并将示例合并到所用 profile：$install_dir/integrations/dsh/cordis.patch.yml" \
        "For dsh, install the Claude Code hooks bridge and merge this example into your profile: $install_dir/integrations/dsh/cordis.patch.yml"
  elif [[ "$agent" == codex && "$lang" == en ]]; then
    echo 'In Codex, use /hooks to review and trust AgentReminder hooks.'
  fi
done
