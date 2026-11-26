# AgentReminder

[English](README.en.md)

在微雪 ESP32-S3-Touch-AMOLED-2.16 或 FoloToy AI Passport 上查看 agent 的审批、问题和完成消息。卡片显示标题、来源对话、主机和项目，空闲页显示连接状态。微雪版支持触屏，面向屏幕且 USB 口朝下时，左键拒绝、右键同意。Passport 的按键提示对齐设备的三个功能键。

## 安装并配对

适用于 macOS 和 Linux，需要 Node.js 18 或更新版本。刷机需准备 Python 3 和 USB 数据线。两种系统均支持 USB，蓝牙支持 macOS 13 及更新版本（Apple 芯片和 Intel）。已有固件时可以先安装主机程序，再插入设备配对。

仓库目前是私有的。用有仓库读取权限的 GitHub 令牌设置 `GH_TOKEN`。如果已用 GitHub CLI 登录，可以执行 `export GH_TOKEN="$(gh auth token)"`。然后用 curl 下载并运行：

```bash
printf 'Authorization: Bearer %s\n' "${GH_TOKEN:?请先设置 GH_TOKEN}" |
  curl -fsS -H @- -H 'Accept: application/vnd.github.raw+json' \
    'https://api.github.com/repos/popomars/agentreminder/contents/install.sh?ref=main' \
    -o agentreminder-install.sh &&
  bash agentreminder-install.sh --flash
```

在已克隆的项目里，微雪运行 `bash install.sh --flash`，Passport 运行 `bash install.sh --flash --board folotoy-passport`。从 GitHub 下载的安装脚本也使用同样的参数。Passport 会先检查板上的分区表，再更新兼容的应用分区。[Passport 兼容布局与备份说明](firmware/release/folotoy-ai-passport/README.md#安装与恢复)

设备已刷好时，直接运行安装脚本即可。GitHub 下载模式会从同一个提交获取主机程序和所选设备的固件。

默认检测本机的 agent，也可以加 `--agent codex --agent claude` 明确指定。多台板子同时接入时，用 `--flash --port DEVICE` 指定串口。`--no-pair` 跳过自动启动和配对，`--lang en` 切换英文提示。安装目录为 `~/.agentreminder/app`。

1. 用 USB 数据线接入一台已烧录的设备。屏幕出现 **「配对这台电脑」** 后按「同意」对应的实体键。微雪竖放时是右键，Passport 是三个功能键的中键。
2. Codex 在 `/hooks` 中审核并信任 AgentReminder 的 hooks。Claude Code 开启新会话即可加载。安装脚本已写入这些 hook 配置。
3. 查看连接状态及测试卡片：

   ```bash
   node ~/.agentreminder/app/host/agentreminder.js status
   node ~/.agentreminder/app/host/tools/hardware-check.js
   ```

如果配对卡片超时或被拒绝，拔插后重试。添加新板子时，通过 USB 接入并执行 `node ~/.agentreminder/app/host/agentreminder.js pair`。主机会保留已有配对。连上的已配对设备会同时收到通知和适用的审批卡。先处理的一台回传后，其余设备会撤下同一张审批卡。Linux 若检测不到设备，请检查当前用户是否有 `/dev/ttyACM*` 的串口访问权限。

### Codex 桌面端和设备同时审批

在 macOS 上，可以配置一次，从原来的 Dock 图标启动时也启用双端审批。

```bash
node ~/.agentreminder/app/host/configure-codex-dock.js install
```

如果直接使用仓库里的脚本，从仓库根目录运行 `node host/configure-codex-dock.js install`。
配置后完全退出 ChatGPT，再点原来的 Dock 图标。安装会加一个当前用户的登录项，
在登录时设置 `CODEX_CLI_PATH`。把末尾的 `install` 换成 `status` 可查看状态，
换成 `uninstall` 可撤销配置。每次切换都在下一次完全重开应用时生效。

如果只想为一次启动启用双端审批，保存工作并完全退出 ChatGPT 桌面应用，再运行：

```bash
bash ~/.agentreminder/app/host/open-codex.sh
```

如果 hook 使用的是仓库中的脚本，可从仓库根目录运行 `bash host/open-codex.sh`。如果 hook 使用的是以前安装的副本，先重新运行 `bash install.sh --agent codex` 更新它。

要看到双端弹窗，当前聊天的审批需要由你手动处理。在输入框下方的权限菜单使用「默认权限」，并将审批审核人设为用户。启用「替我审批」时，自动审核的请求不会在任何一端弹窗。

转接器会处理 Codex 的原生命令和文件修改审批。两端看到同一个请求，先处理的一端生效。设备按「终端」、断线或超时时，可继续在 Codex 中处理。其他审批类型由 Codex 原生界面处理。

### 多条审批与完成消息

设备按收到顺序一次显示一张审批。页首的「待审批 N 项」包含当前这条。每条从收到时起独立计时，默认等待 **5 分钟**。超时后设备撤下卡片，审批交回客户端。

完成通知按主机、项目和对话分组，每组只显示最新一条。对话有 ID 时按 ID 区分，同名对话也可各自保留一条。审批队列清空后显示通知列表，最新在前，总计最多保留 20 张通知卡。

审批、问题和通知卡显示主机服务首次收到事件的本地时间，例如 `11-25 14:08`。换用 USB 或蓝牙传输时，同一张卡保留原时间。已有安装可用对应设备的 `install.sh --flash` 命令，同时更新主机服务和固件。

`~/.agentreminder/config.json` 中的 `approvalTimeoutSec` 可调整等待时间。升级以前安装的 hooks，或调整等待时间后，可用原来的 `--agent` 参数重跑安装脚本并重开 agent。dsh 需同步更新其 profile 中的桥接超时。

### 回答问题与继续任务

单个二选一问题可用屏幕提示对应的实体键回答。微雪支持触屏选择，短按 **PWR** 键可交回电脑。Passport 可短按竖放时的下键交回电脑。多选项、多道题、自由输入和登录验证等会在设备上显示提示，答案在电脑上提交。需要密码或其他保密输入时，设备只提示回电脑。审批和等待回答共用待处理队列。

Codex 桌面端通过上述双端配置接入原生问题、MCP 表单及需要在电脑上处理的权限请求。单个原生问题有两个预设答案时，设备会显示这两个选项。要填写可选的「其他」答案，按屏幕提示交回电脑即可。重开 Codex 后加载更新。Claude Code 通过 `AskUserQuestion` 接入，2.1.76 及更新版本还支持 `Elicitation` hook。使用 Claude 插件包时请使用 2.1.76 或更新版本。二选一时先等设备选择或交回电脑，其他表单会直接在电脑上打开。dsh 通过已配置的桥接接收问题或等待通知，电脑负责提交答案。云端交互需要对应服务提供事件接口。

### dsh

`bash install.sh --agent dsh` 会生成 dsh 的 hook 文件。dsh 还需要在你的 profile 中安装并配置 Claude Code hooks 桥接。将安装目录内 [Cordis 配置示例](integrations/dsh/cordis.patch.yml) 合并到对应 profile，并把 `configPath` 指向 `~/.agentreminder/dsh-hooks.json` 的绝对路径。桥接使用 `PreToolUse`，其同意行为还受 dsh 自身权限策略约束。

## macOS 菜单栏

在此仓库运行 `bash install.sh --menu-bar`。菜单栏应用需要 macOS 13 或更新版本及 Xcode 命令行工具。安装后，在访达打开「应用程序」中的用户应用目录（`~/Applications`），双击 **AgentReminder**。应用会自动连接或启动本机服务。首次使用蓝牙时，请允许 macOS 的蓝牙访问提示。已有安装可运行 `bash install.sh --menu-bar --skip-hooks --no-pair`，保留现有 hooks 和配对设置。

顶部铃铛旁显示未读通知和待审批数量。点击铃铛可打开通知与审批列表，点开一条通知即标为已读，也可一次标记全部。记录保留在本次服务运行期间，最多 100 条。要添加设备，用 USB 数据线接入已刷固件的设备，在菜单里选择「配对新设备」，再按设备屏幕上的提示确认。

## FoloToy AI Passport

AI Passport 版是单独的社区玩法，使用右侧三个功能键。它复用同一个电脑端服务，已实测 USB 配对和 macOS 蓝牙收发。和微雪版一样，审批、问题和通知卡显示接收时间，完成通知按主机、项目和对话只保留每组最新一条。安装会替换当前玩法。[玩法镜像、按键和安装说明](firmware/release/folotoy-ai-passport/README.md)

## 刷机

从仓库根目录按设备选择一条命令。

- 微雪 ESP32-S3-Touch-AMOLED-2.16（16 MB Flash / 8 MB PSRAM）运行 `bash flash.sh`。
- FoloToy AI Passport 运行 `bash flash.sh --board folotoy-passport`。

脚本校验固件，首次运行时按需安装 esptool。接了多台设备时加 `--port DEVICE` 指定串口。加 `--check` 可只校验下载的文件。微雪无法进入刷机模式时，按住 BOOT 键接入 USB 后重试。刷机完成后会恢复刷机前已运行的本机服务。[微雪固件](firmware/release/waveshare-amoled-2.16) · [Passport 固件](firmware/release/folotoy-ai-passport)

## 拔掉 USB 后还能用吗？

macOS 上首次用 USB 配对后，打开系统蓝牙。如果 macOS 询问蓝牙权限，请允许。AgentReminder 会在后台连接设备，`status` 的 `bluetooth` 显示 `connected` 后，就可以拔掉连接电脑的 USB 数据线。设备上仍可看审批和任务完成卡，也可以用实体键或触屏处理审批。下次开机进入蓝牙范围内会自动重连，插回原来的 USB 数据线也可以继续使用。

设备需要保持供电。可以用已安装的电池，或把设备的 USB 线改接充电宝或 USB 电源。仅用电脑 USB 供电时拔线会关机。[微雪供电说明](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-2.16)

如果 `status` 显示 `bluetooth-permission`，到「系统设置 → 隐私与安全性 → 蓝牙」允许系统提示中对应的程序。Linux 目前继续使用 USB。仓库里还有实验性的 Wi-Fi TCP 传输，需要单独配置。

### 换电脑

1. 将设备用 USB 数据线接入新电脑，按上方步骤安装 AgentReminder。如果新电脑已经装过，运行 `node ~/.agentreminder/app/host/agentreminder.js pair`，也可在项目根目录运行 `node host/agentreminder.js pair`。
2. 设备显示「配对这台电脑」时核对电脑名，按「同意」对应的实体键。macOS 如询问蓝牙权限，请允许。空闲页显示新主机名和「蓝牙已连接」后可以拔线，设备须保持供电。

设备保存一台电脑的蓝牙配对，新配对会替换旧配对。换机时可以先关闭旧电脑的蓝牙，避免它同时尝试重连。

## 多台电脑与多个设备

在每台电脑上从这个分支运行相同的 `bash install.sh`。各自绑定的 USB 或蓝牙设备继续使用现有固件。纯发起端可以用 `--no-pair` 安装，并单独启动服务。

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

配置后，每台电脑运行下面的命令。重启电脑后需重新启动服务。看到 `tailnet.listening: true` 后，可从任意成员运行 `node ~/.agentreminder/app/host/agentreminder.js test` 发测试卡。

```bash
node ~/.agentreminder/app/host/agentreminder.js stop
node ~/.agentreminder/app/host/agentreminder.js start
node ~/.agentreminder/app/host/agentreminder.js status
```

服务会将它收到的通知、审批和可交互问题推送到所有在线成员的已绑定设备，发起电脑自己可以没有设备。最先到达发起服务的有效答复生效，其余设备撤下卡片。设备上的「回电脑继续」交回原对话。离线期间的通知不会补发，agent 仍遵循各自的 hook 和权限能力。每台电脑可绑定多块板。

## 停用或卸载主机服务

```bash
bash ~/.agentreminder/app/uninstall.sh
```

旧版没有安装这个脚本时，从新版仓库根目录运行 `bash uninstall.sh`。脚本移除安装器写入的 hooks、Dock 配置、主机程序和下载到电脑的固件文件，并停止本机服务。配对、日志和其他 hooks 会保留。执行后重新打开正在运行的 agent。通过插件管理器安装的插件在各自的管理器里停用。dsh 手动合并的 profile 配置可以自行移除。

临时停用可运行 `node ~/.agentreminder/app/host/agentreminder.js stop`。后续 hook 可以重新启动服务。

## 运行时进程

AgentReminder 主机端只保留一个监听 `127.0.0.1` 的 Node.js 守护进程。macOS 为每台已配对的蓝牙设备启动一个 CoreBluetooth 子进程。Codex 双端审批的转接器随 Codex 会话运行，Dock 登录项设置启动路径后即退出。USB 模式直接由守护进程读写串口。

## 开发和远程接入

- 回归测试：`node --test host/test/*.test.js`。
- 从源码构建微雪固件可运行 `pio run -d firmware`。Passport 使用 `bash firmware/build-passport.sh` 生成固件和校验文件。
- 设备留在本机、agent 跑在 SSH 主机时，可在远端用 `bash install.sh --no-pair` 只装 hooks，然后用 SSH 反向转发把远端回环端口接到本机守护进程。具体地址见 [协议说明](docs/protocol.md)。
