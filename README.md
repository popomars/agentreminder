# AgentReminder

在微雪 ESP32-S3-Touch-AMOLED-2.16 上查看 agent 的审批和完成消息。审批卡片用醒目的大字显示审批理由，下方保留对话名称和可滚动的操作详情。按**左键拒绝**、**右键同意**，也可以点屏幕上的按钮。

## 安装并配对

适用于 macOS 和 Linux。准备 Node.js 18 或更新版本，以及一台已刷入本项目固件的设备。设备可以在安装完成后再插入。

仓库目前是私有的。用有仓库读取权限的 GitHub 令牌设置 `GH_TOKEN`。如果已用 GitHub CLI 登录，可以执行 `export GH_TOKEN="$(gh auth token)"`。然后用 curl 下载并运行：

```bash
printf 'Authorization: Bearer %s\n' "${GH_TOKEN:?请先设置 GH_TOKEN}" |
  curl -fsS -H @- -H 'Accept: application/vnd.github.raw+json' \
    'https://api.github.com/repos/popomars/agentreminder/contents/install.sh?ref=main' \
    -o agentreminder-install.sh &&
  bash agentreminder-install.sh
```

也可以在已克隆的项目里运行 `bash install.sh`。默认检测本机的 agent，也可以指定 `bash install.sh --agent codex --agent claude`。安装目录为 `~/.agentreminder/app`。

1. 用 USB 数据线接入一台已烧录的设备。屏幕出现 **「配对这台电脑」** 后按最右侧实体键。首次安装会在后台等待设备。以后插回同一台设备会自动连接。
2. Codex 在 `/hooks` 中审核并信任 AgentReminder 的 hooks。Claude Code 开启新会话即可加载。安装脚本已写入这些 hook 配置。
3. 查看连接状态及测试卡片：

   ```bash
   node ~/.agentreminder/app/host/agentreminder.js status
   node ~/.agentreminder/app/host/tools/hardware-check.js
   ```

如果配对卡片超时或被拒绝，拔插后重试。换板子时只插入要配对的设备，再执行 `node ~/.agentreminder/app/host/agentreminder.js pair`。Linux 若检测不到设备，请检查当前用户是否有 `/dev/ttyACM*` 的串口访问权限。

### dsh

`bash install.sh --agent dsh` 会生成 dsh 的 hook 文件。dsh 还需要在你的 profile 中安装并配置 Claude Code hooks 桥接。将安装目录内 [Cordis 配置示例](integrations/dsh/cordis.patch.yml) 合并到对应 profile，并把 `configPath` 指向 `~/.agentreminder/dsh-hooks.json` 的绝对路径。桥接使用 `PreToolUse`，其同意行为还受 dsh 自身权限策略约束。

## 刷机

预编译固件保存在 [firmware/release/waveshare-amoled-2.16](firmware/release/waveshare-amoled-2.16)。它只适用于**微雪 ESP32-S3-Touch-AMOLED-2.16（16 MB Flash / 8 MB PSRAM）**。

在 macOS 或 Linux 上克隆仓库，准备 Python 3，插上开发板，然后运行：

```bash
git clone git@github.com:popomars/agentreminder.git
cd agentreminder
bash flash.sh
```

脚本校验仓库内的固件文件，首次运行时安装 esptool，自动选择唯一的 Espressif USB 串口，写入固件并重启。已有固件会被覆盖。接了多台设备时用 `bash flash.sh --port /dev/cu.usbmodem2101` 指定串口。只校验文件可运行 `bash flash.sh --check`。如果连不上刷机模式，按住 BOOT 键接入 USB，再重新运行脚本。

## 拔掉 USB 后还能用吗？

当前安装流程使用 USB。**BLE 尚未实现**，所以按上面的步骤安装配对后，拔掉 USB 就无法接收新消息或提交审批。仓库里另有实验性的 Wi-Fi TCP 传输，需要单独配置，也还没有在这块板上实测。

## 开发和远程接入

- 回归测试：`node --test host/test/*.test.js`。
- 从源码构建：`pio run -d firmware`。预编译文件与偏移见 [固件说明](firmware/release/waveshare-amoled-2.16/README.md)。
- 设备留在本机、agent 跑在 SSH 主机时，可在远端用 `bash install.sh --no-pair` 只装 hooks，然后用 SSH 反向转发把远端回环端口接到本机守护进程。具体地址见 [协议说明](docs/protocol.md)。
