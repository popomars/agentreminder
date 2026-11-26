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

安装器会自动检测 Codex CLI、Claude Code CLI、dsh 和 WorkBuddy，并合并所需 hooks。CLI 装在自定义位置时，从能运行对应命令的终端执行安装。如果命令只在别名里可用，可以先把实际可执行文件所在目录加到 `PATH`，或用 `--agent codex`、`--agent claude`、`--agent dsh` 显式写入 hooks。安装器会记住找到的 Claude 可执行文件，菜单服务登录后也能用它检查版本。

Codex CLI 默认使用 `~/.codex/hooks.json`，Claude Code 默认使用 `~/.claude/settings.json`。如果客户端使用自定义配置目录，按上面的 GitHub 下载步骤取得脚本，再把最后一行替换为下面的命令。菜单服务会记住这些目录。只改了一个客户端的目录，就只传相应变量。

```bash
CODEX_HOME="$HOME/自定义目录/codex" \
CLAUDE_CONFIG_DIR="$HOME/自定义目录/claude" \
bash agentreminder-install.sh --ref "$revision"
```

从仓库安装时，保留相同的环境变量，把最后一行改为 `bash install.sh`。后来才安装的 Agent 可以从 **Agent 接入** 启用。

Codex 桌面端移到其他文件夹后，铃铛会从正在运行的应用和 macOS 注册的应用中查找。如果有多个副本或未找到，在 **Agent 接入 → Codex 双端审批（桌面端）→ 选择桌面应用…** 中选实际使用的 `.app`。WorkBuddy 搬动后，可先打开一次，再从 **Agent 接入** 启用。dsh 按表中的方法配置实际使用的 profile。

| Agent | 安装后要做什么 |
| --- | --- |
| Codex CLI | 重开终端会话，输入 `/hooks`，审核并信任 AgentReminder 的 `PermissionRequest` 和 `Stop`。菜单里的「Hooks 已配置」表示配置已写入。 |
| Codex 桌面端 | 从铃铛选择 **Agent 接入 → Codex 双端审批（桌面端）→ 启用**，再选择「现在重启」或「稍后重开」。需要审批时用手动审批，审核人设为用户。 |
| Claude Code CLI | 开启新的 `claude` 会话。支持 `AskUserQuestion`，2.1.76 及更新版本还支持 `Elicitation`。 |
| dsh | 在 profile 中安装 Claude Code hooks 桥接，合并 Cordis 示例，并将 `configPath` 指向 `~/.agentreminder/dsh-hooks.json` 的绝对路径。 [Cordis 配置示例](integrations/dsh/cordis.patch.yml) |
| WorkBuddy（macOS） | 重开 WorkBuddy。任务完成自动通知；命令触发 WorkBuddy 本地安全审批时，设备会提醒回 WorkBuddy 确认。审批提醒显示在「通知」。 |

### 4. 在 CLI 处理审批

1. 配对设备后，从铃铛发送测试通知。也可以运行 `node ~/.agentreminder/app/host/agentreminder.js test`，向设备发送一张模拟审批卡。
2. 在项目目录打开新会话。Codex CLI 可用 `codex --sandbox read-only --ask-for-approval on-request` 测试，先在 `/hooks` 完成信任。Claude Code CLI 可用 `claude --permission-mode default`。请 Agent 执行一个需要批准的无害操作，例如创建临时测试文件。当前权限已允许的操作会直接执行。
3. 收到真实审批卡后，按设备屏幕标示的「同意」或「拒绝」。选「回电脑继续」、设备离线或等待超时后，可回原终端处理提示。CLI 先等审批 hook 返回，再显示原生确认；同一时间可在两端处理的功能由桌面端双端审批提供。
4. 任务结束后，在铃铛的「通知」查看完成卡。若 Codex 启动失败或没有 `/hooks`，先用 `codex --version` 检查 CLI，再安装支持 hooks 的版本。

[Codex hooks 官方说明](https://learn.chatgpt.com/docs/hooks) · [Claude Code hooks 官方说明](https://code.claude.com/docs/en/hooks)

## 铃铛菜单怎么用

| 入口 | 功能 |
| --- | --- |
| **通知** | 按主机、项目、对话分组，每组保留最新一条并显示接收时间。打开通知会标为已读，铃铛显示未读组数。在设备上清除一条通知，会把它从菜单栏和其他设备一并移除。子菜单的「清除所有通知」也会同步。 |
| **待审批** | 查看待审批和等待回答的卡片；在设备或 agent 里提交决定。**清除所有审批和通知** 会清除菜单中的项目，并把待审批事项交回原客户端。 |
| **配对新设备…** | 通过 USB 添加或重新配对设备。 |
| **安装或更新固件…** | 选择板型，从安装包写入固件。写入时保持 USB 连接。已经配对的设备重启后会重连。 |
| **发送测试通知** | 快速验证菜单栏和本机设备是否能收卡。 |
| **联机服务** | **初始化**生成并复制新组密钥，**加入联机服务**使用现有组密钥，**查看联机密钥**可查看或复制本机已保存的密钥。 |
| **Agent 接入** | 查看 Codex CLI、Codex 桌面双端审批、Claude Code CLI、dsh 和 WorkBuddy 的状态并分别启停。Codex 桌面设置在重开 ChatGPT 后生效。 |
| **登录时启动** | 在 macOS「登录项与扩展」中显示为 AgentReminder。它启动铃铛和后台服务，并恢复已启用的 Codex Dock 配置。 |
| **阻止闲置睡眠** | 让后台服务在 Mac 锁屏或熄屏时保持系统唤醒。默认关闭，选择后会记住设置。 |
| **检查更新…** | 检查 GitHub `main` 的版本。发现新版后可选择「安装更新」，完成后铃铛自动重开，保留配对、联机设置和 hooks。 |

设备一次显示一张审批，默认等待 5 分钟。两个预设选项可以在设备上选择。多选项、文字输入和登录验证可回原对话完成。微雪短按 PWR、Passport 竖放时短按下键，可把问题交回电脑。

同步清除需将各台主机升级到 0.5.11、微雪升级到 0.3.17、Passport 升级到 0.3.21 或更新版本。启用了 Tailnet 的电脑也会同步清除。

关闭「阻止闲置睡眠」或停止后台服务会释放防睡眠状态。合盖、手动睡眠和低电量时仍遵循 macOS 的电源管理。无菜单栏的 Mac 可在 `~/.agentreminder/config.json` 中设置 `"preventIdleSleep": true`，再重启服务。

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

先让各台 Mac 登录同一个 Tailnet。

1. 在第一台 Mac 选择 **联机服务 → 初始化**。AgentReminder 生成并保存共享密钥，复制到剪贴板。
2. 在其他 Mac 选择 **联机服务 → 加入联机服务**，粘贴同一把密钥。
3. 任意已配置的 Mac 都可以选择 **联机服务 → 查看联机密钥**，查看或重新复制。配置完成后，「初始化」和「加入联机服务」会停用，以保留当前组。

运行 `bash install.sh --init-tailnet` 可在安装时直接打开初始化。使用 GitHub 下载方式时，在执行脚本的那一行加上 `--init-tailnet`。这个选项需要 0.5.8 或更新的 macOS 菜单栏版本。如果本机已经配置，则打开密钥查看。

联机服务启用后，Tailscale 自动发现电脑地址。各机器通过共享密钥认证后才转发卡片，组内需要允许访问 TCP `47323`。启用联机服务时会保留现有通知、审批和设备配对。 [Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli)

### 无菜单栏的主机

纯发起端可以用 `--no-menu-bar --no-pair` 安装，并单独启动服务。

在每台电脑的 `~/.agentreminder/config.json` 中合并以下字段，保留原有配对配置。所有参加的电脑使用同一把密钥。服务会通过 `tailscale status --json` 自动读取本机地址和在线对端，每 10 秒刷新。新增电脑后不需要修改其他电脑的配置。

```json
{
  "tailnet": {
    "enabled": true,
    "key": "替换为这组电脑共享的 64 个小写十六进制字符"
  }
}
```

在一台可信电脑上运行 `node -p "require('node:crypto').randomBytes(32).toString('hex')"` 生成一次密钥。通过私密渠道给参加的电脑配置相同的值，并将配置文件权限设为 `600`。服务先验证对端也持有密钥，再发送卡片。已有手动配置可删除 `listen` 和 `peers`，重启服务后切换为自动发现。

手动配置后，运行下面的命令。看到 `tailnet.listening: true` 后，可从任意成员运行 `node ~/.agentreminder/app/host/agentreminder.js test` 发测试卡。

```bash
node ~/.agentreminder/app/host/agentreminder.js stop
node ~/.agentreminder/app/host/agentreminder.js start
node ~/.agentreminder/app/host/agentreminder.js status
```

服务会将它收到的通知、审批和可交互问题推送到所有在线成员的已绑定设备，发起电脑自己可以没有设备。最先到达发起服务的有效答复生效，其余设备撤下卡片。设备上的「回电脑继续」交回原对话。离线期间的通知不会补发，agent 仍遵循各自的 hook 和权限能力。每台电脑可绑定多块板。

## 开发

运行 `node --test host/test/*.test.js`。微雪固件可用 `pio run -d firmware` 构建；Passport 用 `bash firmware/build-passport.sh` 生成固件和校验文件。 [协议与远程接入](docs/protocol.md)
