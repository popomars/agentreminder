#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=popomars/agentreminder
ref=main
use_checkout=true
platform=$(uname -s)
pair=true
menu_bar=false
if [[ "$platform" == Darwin ]]; then menu_bar=true; fi
install_hooks=true
init_tailnet=false
autostart=true
flash=false
board=
flash_port=
flash_baud=
lang=zh
agents=()
auto_workbuddy=false
say() { if [[ "$lang" == en ]]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
usage() {
  say '用法：bash install.sh [--agent codex|claude|dsh|workbuddy] [--ref REF] [--flash [--board waveshare-amoled-2.16|folotoy-passport] [--port DEVICE] [--baud RATE]] [--menu-bar|--no-menu-bar] [--skip-hooks] [--no-pair] [--init-tailnet] [--no-autostart] [--lang zh|en]' \
      'Usage: bash install.sh [--agent codex|claude|dsh|workbuddy] [--ref REF] [--flash [--board waveshare-amoled-2.16|folotoy-passport] [--port DEVICE] [--baud RATE]] [--menu-bar|--no-menu-bar] [--skip-hooks] [--no-pair] [--init-tailnet] [--no-autostart] [--lang zh|en]'
}
while (( $# )); do
  case "$1" in
    --agent)
      case "${2:-}" in codex|claude|dsh|workbuddy) agents+=("$2");; *) usage >&2; exit 2;; esac
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
    --no-menu-bar) menu_bar=false; shift;;
    --skip-hooks) install_hooks=false; shift;;
    --no-pair) pair=false; shift;;
    --init-tailnet) init_tailnet=true; shift;;
    --no-autostart) autostart=false; shift;;
    -h|--help) usage; exit 0;;
    *) usage >&2; exit 2;;
  esac
done

case "$platform" in Darwin|Linux) ;; *) say '目前安装脚本支持 macOS 和 Linux。' 'The installer supports macOS and Linux.' >&2; exit 1;; esac
command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(".")[0] < 18 ? 1 : 0)' || {
  say '请先安装 Node.js 18 或更新版本。' 'Install Node.js 18 or newer first.' >&2
  exit 1
}
if "$menu_bar"; then
  if [[ "$platform" != Darwin ]] || (( $(sw_vers -productVersion | cut -d. -f1) < 13 )) ||
     ! xcrun --find swiftc >/dev/null 2>&1; then
    say '菜单栏应用需要 macOS 13 或更新版本及 Xcode 命令行工具。仅安装后台程序可加 --no-menu-bar。' \
        'The menu bar app requires macOS 13 or later and Xcode Command Line Tools. For a headless install, add --no-menu-bar.' >&2
    exit 1
  fi
fi
if "$init_tailnet" && ! "$menu_bar"; then
  say '--init-tailnet 需要 macOS 菜单栏应用。' '--init-tailnet requires the macOS menu bar app.' >&2
  exit 2
fi
if "$flash" || "$menu_bar"; then
  command -v python3 >/dev/null && python3 -c "import hashlib, venv" || { say '刷机需要 Python 3。' 'Flashing requires Python 3.' >&2; exit 1; }
fi
if ! "$flash" && [[ -n "$board$flash_port$flash_baud" ]]; then
  usage >&2
  exit 2
fi

if "$install_hooks" && (( ${#agents[@]} == 0 )); then
  if command -v codex >/dev/null || [[ -d ${CODEX_HOME:-"$HOME/.codex"} ||
    -x "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" ||
    -x "$HOME/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" ]]; then agents+=(codex); fi
  if command -v claude >/dev/null || [[ -d "$HOME/.claude" ]]; then agents+=(claude); fi
  if command -v dsh >/dev/null; then agents+=(dsh); fi
  if [[ -d "$HOME/.workbuddy" || -d /Applications/WorkBuddy.app || -d "$HOME/Applications/WorkBuddy.app" ]]; then
    auto_workbuddy=true
  fi
fi

install_dir="${AGENTREMINDER_HOME:-"$HOME/.agentreminder"}/app"
mkdir -p "$install_dir/host/tools" "$install_dir/integrations/dsh"
stage="$(mktemp -d "$install_dir/.install.XXXXXXXX")"
menu_stage=
trap 'rm -rf "$stage"; if [[ -n "$menu_stage" && ! -e "$menu_stage/previous.app" && ! -L "$menu_stage/previous.app" ]]; then rm -rf "$menu_stage"; fi' EXIT
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sha=
files=(uninstall.sh host/uninstall.js host/agentreminder.js host/bluetooth.js host/codex-approval-proxy.js host/codex-approval-cli host/open-codex.sh host/configure-codex-dock.js
  host/tools/hardware-check.js integrations/dsh/cordis.patch.yml)
add_firmware() {
  local firmware_id=$1
  shift
  local firmware_dir="firmware/release/$firmware_id"
  files+=("$firmware_dir/SHA256SUMS")
  local image
  for image in "$@"; do files+=("$firmware_dir/$image"); done
}
if "$flash" || "$menu_bar"; then
  files+=(flash.sh)
  if "$menu_bar" || [[ "$board" != folotoy-passport ]]; then
    add_firmware waveshare-amoled-2.16 bootloader.bin partitions.bin boot_app0.bin firmware.bin
  fi
  if "$menu_bar" || [[ "$board" == folotoy-passport ]]; then
    add_firmware folotoy-ai-passport AgentReminder-AI-Passport-app.bin AgentReminder-AI-Passport-full.bin
  fi
fi
if [[ "$board" == folotoy-passport ]]; then
  board_args=(--board "$board")
else
  # The default also works with flash.sh from older refs.
  board_args=()
fi
if [[ "$platform" == Darwin ]]; then
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
    if [[ -z "$github_token" ]] && command -v gh >/dev/null; then
      github_token="$(gh auth token 2>/dev/null || true)"
    fi
    if [[ -z "$github_token" ]] || ! sha="$(github_get "commits/$ref" application/vnd.github.sha)"; then
      say '无法读取 GitHub 提交。请检查网络和版本号。需要认证时，设置 GH_TOKEN 后重试。' \
          'Could not read the GitHub revision. Check the network and ref, or set GH_TOKEN if authentication is required.' >&2
      exit 1
    fi
  }
  if [[ ! $sha =~ ^[a-f0-9]{40}$ ]]; then say 'GitHub 没有返回有效的提交 SHA。' 'GitHub did not return a valid commit SHA.' >&2; exit 1; fi
  for file in "${files[@]}"; do
    mkdir -p "$stage/$(dirname "$file")"
    github_get "contents/$file?ref=$sha" application/vnd.github.raw+json > "$stage/$file"
  done
fi
# Fetch runtime modules only when the selected revision uses them.
for module in tailnet workbuddy; do
  if grep -Fq "require('./$module')" "$stage/host/agentreminder.js"; then
    file="host/$module.js"
    if [[ -n ${sha:-} ]]; then
      github_get "contents/$file?ref=$sha" application/vnd.github.raw+json > "$stage/$file"
    else
      cp "$source_dir/$file" "$stage/$file"
    fi
    node --check "$stage/$file"
    files+=("$file")
  fi
done
if "$auto_workbuddy" && [[ -f "$stage/host/workbuddy.js" ]]; then agents+=(workbuddy); fi
if "$install_hooks"; then
  for agent in "${agents[@]+"${agents[@]}"}"; do
    if [[ "$agent" == workbuddy && ! -f "$stage/host/workbuddy.js" ]]; then
      say '所选版本不支持 WorkBuddy。' 'The selected revision does not support WorkBuddy.' >&2
      exit 2
    fi
  done
  if (( ${#agents[@]} == 0 )); then
    say '未找到 agent。安装 agent 后可用 --agent 选项配置 hooks。' \
        'No agent detected. After installing one, rerun with the --agent option to configure hooks.' >&2
    if ! "$menu_bar"; then exit 1; fi
  fi
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
  if "$init_tailnet" && ! grep -Fq -- '--init-tailnet' "$stage/menu-bar/Main.swift"; then
    say '所选版本不支持 --init-tailnet。' 'The selected revision does not support --init-tailnet.' >&2
    exit 2
  fi
  menu_app=AgentReminder.app
  legacy_menu="$(cd "$install_dir" && pwd -P)/$menu_app"
  menu_path="$legacy_menu"
  if [[ -z ${AGENTREMINDER_HOME:-} ]]; then
    mkdir -p "$HOME/Applications"
    menu_path="$(cd "$HOME/Applications" && pwd -P)/$menu_app"
  fi
  if [[ -L "$menu_path" ]]; then
    node -e '
      const fs = require("node:fs"), path = require("node:path");
      const [link, expected] = process.argv.slice(1);
      const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
      const canonical = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
      if (canonical !== expected) process.exit(1);
    ' "$menu_path" "$legacy_menu" 2>/dev/null || {
      say "已有其他应用程序链接：$menu_path" "Another app link already exists at $menu_path." >&2
      exit 1
    }
  elif [[ -e "$menu_path" ]]; then
    if [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$menu_path/Contents/Info.plist" 2>/dev/null || true)" != io.github.popomars.agentreminder.menu ]] ||
       ! node -e 'const c = require(process.argv[1]); if (c.statePath !== process.argv[2]) process.exit(1)' \
         "$menu_path/Contents/Resources/Installation.json" "$(cd "$install_dir/.." && pwd -P)" 2>/dev/null; then
      say "已有其他应用程序：$menu_path" "Another app already exists at $menu_path." >&2
      exit 1
    fi
  fi
  menu_contents="$stage/$menu_app/Contents"
  mkdir -p "$menu_contents/MacOS" "$menu_contents/Resources"
  cp "$stage/menu-bar/Info.plist" "$menu_contents/Info.plist"
  xcrun swiftc -O -parse-as-library -target "$(uname -m)-apple-macos13" -module-cache-path "$stage/swift-cache" \
    "$stage/menu-bar/Main.swift" -o "$menu_contents/MacOS/AgentReminder"
  installed_revision="$sha"
  if [[ -z "$installed_revision" && -e "$source_dir/.git" ]] &&
     checkout_changes="$(git -C "$source_dir" status --porcelain 2>/dev/null)" &&
     [[ -z "$checkout_changes" ]]; then
    installed_revision="$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)"
  fi
  node - "$(cd "$install_dir" && pwd -P)" "$lang" "$(command -v node)" "$(command -v python3)" "$installed_revision" > "$menu_contents/Resources/Installation.json" <<'JS'
const path = require('node:path');
const [installDir, language, node, python, revision] = process.argv.slice(2);
console.log(JSON.stringify({
  node: path.resolve(node), python: path.resolve(python), statePath: path.resolve(installDir, '..'), language,
  ...(/^[a-f0-9]{40}$/.test(revision) ? { revision } : {}),
}));
JS
  codesign --sign - "$stage/$menu_app"
  codesign --verify --strict "$stage/$menu_app"
fi
unset github_token
node --check "$stage/host/agentreminder.js"
node --check "$stage/host/uninstall.js"
node --check "$stage/host/bluetooth.js"
node --check "$stage/host/codex-approval-proxy.js"
node --check "$stage/host/configure-codex-dock.js"
node --check "$stage/host/tools/hardware-check.js"
if "$menu_bar"; then
  AGENTREMINDER_LANG="$lang" bash "$stage/flash.sh" --check --board waveshare-amoled-2.16
  AGENTREMINDER_LANG="$lang" bash "$stage/flash.sh" --check --board folotoy-passport
elif "$flash"; then
  AGENTREMINDER_LANG="$lang" bash "$stage/flash.sh" --check ${board_args[@]+"${board_args[@]}"}
fi
for file in "${files[@]}"; do
  mkdir -p "$install_dir/$(dirname "$file")"
  mv "$stage/$file" "$install_dir/$file"
done
chmod 700 "$install_dir/uninstall.sh" "$install_dir/host/codex-approval-cli" "$install_dir/host/open-codex.sh"
if [[ "$platform" == Darwin ]]; then chmod 700 "$install_dir/host/bluetooth/agentreminder-bluetooth"; fi

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
if "$pair" && ! "$menu_bar"; then
  run_host setup-usb
  if [[ "$lang" == en ]]; then echo 'Connect the board by USB. Follow the prompt on its screen to confirm.'; fi
fi

if "$menu_bar"; then
  menu_stage="$(mktemp -d "$(dirname "$menu_path")/.agentreminder-install.XXXXXXXX")"
  /usr/bin/ditto "$stage/$menu_app" "$menu_stage/$menu_app"
  codesign --verify --strict "$menu_stage/$menu_app"
  if [[ -e "$menu_path" || -L "$menu_path" ]]; then mv "$menu_path" "$menu_stage/previous.app"; fi
  if ! mv "$menu_stage/$menu_app" "$menu_path"; then
    if [[ -e "$menu_stage/previous.app" || -L "$menu_stage/previous.app" ]]; then
      mv "$menu_stage/previous.app" "$menu_path"
    fi
    exit 1
  fi
  rm -rf "$menu_stage/previous.app"
  launch_args=(--replace-existing)
  if "$autostart" && [[ -z ${AGENTREMINDER_HOME:-} ]]; then launch_args+=(--register-login); fi
  if "$pair"; then launch_args+=(--setup-usb); fi
  if "$init_tailnet"; then launch_args+=(--init-tailnet); fi
  if open -n "$menu_path" --args "${launch_args[@]}"; then
    say '请从菜单栏的 AgentReminder 铃铛开始配对或发送测试通知。' 'Open the AgentReminder bell in the menu bar to pair a device or send a test notification.'
    say "应用程序：$menu_path" "Application: $menu_path"
  else
    say "未能自动启动菜单栏应用。登录 macOS 桌面后打开 $menu_path。" \
        "The menu bar app could not open automatically. After signing in to macOS, open $menu_path." >&2
    exit 1
  fi
fi

say "AgentReminder 已安装到 $install_dir" "AgentReminder is installed in $install_dir"
if ! "$menu_bar"; then
  say "查看连接状态：node \"$host\" status" "Check connection: node \"$host\" status"
  if ! "$pair"; then say "连接设备后配对：node \"$host\" pair" "Pair after connecting by USB: node \"$host\" pair"; fi
fi
say "卸载主机服务：bash \"$install_dir/uninstall.sh\"" "Uninstall: bash \"$install_dir/uninstall.sh\" --lang en"
if "$install_hooks"; then
  for agent in ${agents[@]+"${agents[@]}"}; do
    if [[ "$agent" == dsh ]]; then
      say "dsh 需安装 Claude Code hooks 桥接，并将示例合并到所用 profile：$install_dir/integrations/dsh/cordis.patch.yml" \
          "For dsh, install the Claude Code hooks bridge and merge this example into your profile: $install_dir/integrations/dsh/cordis.patch.yml"
    elif [[ "$agent" == codex ]]; then
      say '重开 Codex，并用 /hooks 审核及信任 AgentReminder 的 hooks。' \
          'Reopen Codex and use /hooks to review and trust AgentReminder hooks.'
    elif [[ "$agent" == workbuddy ]]; then
      say '请重开 WorkBuddy，以加载任务完成通知。命令审批仍在 WorkBuddy 确认。' \
          'Reopen WorkBuddy to load completion notifications. Confirm command approvals in WorkBuddy.'
    fi
  done
fi
