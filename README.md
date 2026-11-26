# AgentReminder

[English](README.en.md)

从 Mac 菜单栏查看 agent 的通知和待审批事项。配对微雪 ESP32-S3-Touch-AMOLED-2.16 或 FoloToy AI Passport 后，也可以在设备上收卡、审批和回答二选一问题。

## macOS 快速开始

### 1. 运行安装脚本

需要 macOS 13 或更新版本、Node.js 18 或更新版本、Python 3 和 Xcode 命令行工具。在已经登录桌面的 Mac 上打开终端，从项目根目录运行：

```bash
bash install.sh
```

也可以直接从 GitHub 下载并安装。下面的命令用同一个提交安装脚本、主机程序和两套固件。

```bash
api=https://api.github.com/repos/popomars/agentreminder
revision="$(curl -fsS -H 'Accept: application/vnd.github.sha' "$api/commits/main")" &&
curl -fsS -H 'Accept: application/vnd.github.raw+json' \
  "$api/contents/install.sh?ref=$revision" -o agentreminder-install.sh &&
  bash agentreminder-install.sh --ref "$revision"
```

安装完成后，点击菜单栏的 **AgentReminder 铃铛**。安装器把完整的 `AgentReminder.app` 放在用户的「应用程序」文件夹（`~/Applications`），并通过 macOS 启动。现在可以关掉终端。安装器默认注册 macOS 登录启动，可在铃铛的「登录时启动」查看或更改。退出应用后，可从访达选择「前往 → 前往文件夹」，输入 `~/Applications`，双击 **AgentReminder**。

### 2. 从铃铛配对设备

1. 用 USB 数据线接入一台设备。已刷好 AgentReminder 时直接配对，否则在铃铛里选 **安装或更新固件… → 设备型号**，确认并等设备重启。
2. 如果设备已经显示「配对这台电脑」，直接在设备上确认。否则选择铃铛里的 **配对新设备…**，再在设备上确认。微雪面向屏幕、USB 朝下时按右键；Passport 竖放时按三个功能键的中键。
3. 在铃铛里选择 **发送测试通知**。在 **通知** 子菜单查看，也可以到设备上确认收到了同一条卡片。这个测试只发到本机和本机已连接的设备。
4. 如需拔线使用，请允许 macOS 的蓝牙权限，并等设备显示 **蓝牙已连接**。用电池或 USB 电源给设备供电。以后也可以插回 USB 使用。

换电脑时用 USB 连到新 Mac，再从新 Mac 的铃铛配对。设备会保存最新的蓝牙配对。添加另一块板时，同一台 Mac 会保留已配对的其他设备。

### 3. 接入你的 agent

安装器会为检测到的 Codex、Claude Code、dsh 和 WorkBuddy 写入对应 hooks，保留其他 hooks。如果先装了 AgentReminder，再安装 WorkBuddy，可在铃铛里选择 **Agent 接入 → WorkBuddy → 启用**，或运行 `bash install.sh --agent workbuddy`。

| Agent | 安装后要做什么 |
| --- | --- |
| Codex CLI | 重开 Codex，用 `/hooks` 审核并信任 AgentReminder 的 hooks。 |
| Codex 桌面端 | 从铃铛选择 **Codex 桌面双端审批 → 启用…**，完全退出 ChatGPT，再从原来的 Dock 图标打开。需要审批时用手动审批，审核人设为用户。 |
| Claude Code | 开启新会话。支持 `AskUserQuestion`，2.1.76 及更新版本还支持 `Elicitation`。 |
| dsh | 在 profile 中安装 Claude Code hooks 桥接，合并 Cordis 示例，并将 `configPath` 指向 `~/.agentreminder/dsh-hooks.json` 的绝对路径。 [Cordis 配置示例](integrations/dsh/cordis.patch.yml) |
| WorkBuddy（macOS） | 重开 WorkBuddy。任务完成自动通知；命令触发 WorkBuddy 本地安全审批时，设备会提醒回 WorkBuddy 确认。审批提醒显示在「通知」。 |

真实任务完成后，打开铃铛查看通知。遇到审批时，在原 agent 或设备上处理。Codex 双端审批支持原生命令和文件修改，先处理的一端生效。设备断线、超时或选择「回电脑继续」时，在原对话里继续操作。

## 铃铛菜单怎么用

| 入口 | 功能 |
| --- | --- |
| **通知** | 按主机、项目、对话分组，每组保留最新一条，显示接收时间，例如 `11-26 12:09`。打开一组会标为已读，铃铛上的数字是未读组数。子菜单可以清除通知。 |
| **待审批** | 查看待审批和等待回答的卡片；在设备或 agent 里提交决定。**清除所有审批和通知** 会清除菜单中的项目，并把待审批事项交回原客户端。 |
| **配对新设备…** | 通过 USB 添加或重新配对设备。 |
| **安装或更新固件…** | 选择板型，从安装包写入固件。写入时保持 USB 连接。已经配对的设备重启后会重连。 |
| **发送测试通知** | 快速验证菜单栏和本机设备是否能收卡。 |
| **Agent 接入** | 从菜单独立启用或停用 WorkBuddy。停用会暂停该 Agent 的新任务通知和审批提醒。 |
| **登录时启动** | 在 macOS「登录项与扩展」中显示为 AgentReminder。它启动铃铛和后台服务，并恢复已启用的 Codex Dock 配置。 |
| **Codex 桌面双端审批** | 检测到支持的 ChatGPT 桌面安装时显示。可启用或停用转接，用原来的 Dock 图标重开即可生效。如果登录时 ChatGPT 比铃铛先打开，请重开 ChatGPT。 |

设备一次显示一张审批，默认等待 5 分钟。两个预设选项可以在设备上选择。多选项、文字输入和登录验证可回原对话完成。微雪短按 PWR、Passport 竖放时短按下键，可把问题交回电脑。

刷机时只接一块板。微雪串口若未出现，按住 **BOOT/−** 接入 USB，再松开。Passport 首刷前先备份原固件，刷机脚本会检查原有分区表。首次刷机时脚本会按需安装 esptool。 [微雪刷机说明](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-2.16/Instructions-For-Use) · [Passport 备份和恢复](firmware/release/folotoy-ai-passport/README.md#安装与恢复)

## 设备按键

微雪空闲时显示主机、蓝牙和 USB 状态。通知页短按左键上一张、中键清除、右键下一张，触屏也可操作。空闲或通知页长按右键切换提示音，长按左键切换方向，两个设置都会在重启后保留。审批页长按左键滚动、长按右键旋转。短按左键拒绝、中键回电脑、右键同意。按键位置以 USB 口朝下为准。 [微雪固件说明](firmware/release/waveshare-amoled-2.16/README.md) · [Passport 按键](firmware/release/folotoy-ai-passport/README.md)

## 更新或卸载

- **更新 Mac 应用和 hooks**。重新运行同一个安装脚本，会保留配对并打开新版铃铛。更新完成后重开 agent 以加载新 hooks。用 `--no-autostart` 安装时可跳过注册登录启动。
- **更新设备固件**。从铃铛选择「安装或更新固件…」。
- **卸载**。执行 `bash ~/.agentreminder/app/uninstall.sh`，移除应用、主机程序和安装器管理的 hooks，保留配对记录、日志及其他 hooks。

## Linux、SSH 与命令行

Linux 运行同一安装脚本，通过 USB 使用。macOS 无图形会话或纯转发的场合可加 `--no-menu-bar`。远端只装 hooks 并转发至本机时，加 `--no-menu-bar --no-pair`。 [SSH 接入说明](docs/protocol.md#ssh-远程-agent)

- `node ~/.agentreminder/app/host/agentreminder.js pair` 通过 USB 手动配对。
- `node ~/.agentreminder/app/host/agentreminder.js status` 检查连接。可在 `~/.agentreminder/config.json` 中调整 `approvalTimeoutSec`，再重跑对应 agent 的安装并重开 agent。
- 从仓库运行 `bash flash.sh` 刷微雪或 `bash flash.sh --board folotoy-passport` 刷 Passport。加 `--check` 只校验镜像，加 `--port DEVICE` 指定串口。

## 多台电脑与多个设备

在每台电脑上运行相同的 `bash install.sh`。各自绑定的 USB 或蓝牙设备继续使用现有固件。纯发起端可以用 `--no-menu-bar --no-pair` 安装，并单独启动服务。

在每台电脑的 `~/.agentreminder/config.json` 中合并以下字段，保留原有配对配置。所有参加的电脑使用同一把密钥。服务会通过 `tailscale status --json` 自动读取本机地址和在线对端，每 10 秒刷新。新增电脑后不需要修改其他电脑的配置。成员之间需能访问 TCP `47323`。 [Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli)

```json
{
  "tailnet": {
    "enabled": true,
    "key": "替换为这组电脑共享的 64 个小写十六进制字符"
  }
}
```

在一台可信电脑上运行 `node -p "require('node:crypto').randomBytes(32).toString('hex')"` 生成一次密钥。通过私密渠道给参加的电脑配置相同的值，并将配置文件权限设为 `600`。服务先验证对端也持有密钥，再发送卡片。已有手动配置可删除 `listen` 和 `peers`，重启服务后切换为自动发现。

配置后，每台电脑运行下面的命令。macOS 重启后可从「应用程序」重新打开 AgentReminder。看到 `tailnet.listening: true` 后，可从任意成员运行 `node ~/.agentreminder/app/host/agentreminder.js test` 发测试卡。

```bash
node ~/.agentreminder/app/host/agentreminder.js stop
node ~/.agentreminder/app/host/agentreminder.js start
node ~/.agentreminder/app/host/agentreminder.js status
```

服务会将它收到的通知、审批和可交互问题推送到所有在线成员的已绑定设备，发起电脑自己可以没有设备。最先到达发起服务的有效答复生效，其余设备撤下卡片。设备上的「回电脑继续」交回原对话。离线期间的通知不会补发，agent 仍遵循各自的 hook 和权限能力。每台电脑可绑定多块板。

## 开发

运行 `node --test host/test/*.test.js`。微雪固件可用 `pio run -d firmware` 构建；Passport 用 `bash firmware/build-passport.sh` 生成固件和校验文件。 [协议与远程接入](docs/protocol.md)
