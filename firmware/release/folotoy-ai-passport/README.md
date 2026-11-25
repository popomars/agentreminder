# AgentReminder · FoloToy AI Passport

适用于 FoloToy AI Passport（ESP32-C3，8 MB Flash，240 × 320 屏）。电脑端继续使用 AgentReminder。通行证通过 USB 配对，之后可在 macOS 上用蓝牙接收审批、二选一和完成通知。卡片保留接收时间，完成通知按主机、项目和对话分组。

| 场景 | 上键 | 中键 | 下键 |
| --- | --- | --- | --- |
| 审批 / USB 配对 | 拒绝 | 同意 | 交回电脑 |
| 二选一 | 第一项 | 第二项 | 交回电脑 |
| 仅电脑可回答的问题 | 向上滚动 | 向下滚动 | 交回电脑 |
| 通知列表 | 上一张 | 下一张 | 清除当前通知 |
| 空闲页 | — | 长按切换横竖屏 | 长按切换提示音 |

长按中键约半秒可在任意页面切换横竖屏，重启后保留方向。横屏时把有三个键的一边转到上方，提示从左到右对应三个实体键。竖屏时提示沿右侧竖排。短按在松键后生效。

较长的二选一选项显示在正文区。审批和问题的长正文会自动滚动。长按上键可往下翻，到末尾后再次长按上键可回到开头。上键、中键、下键按设备竖放时右侧从上到下命名。[FoloToy 正面按键示意](https://ai-passport.folotoy.cn/guides/getting-started/)

Hold the middle button for about half a second on any screen to switch between portrait and landscape. The orientation survives a restart. In landscape, turn the three-button edge to the top so the labels line up from left to right. In portrait, the labels line up along the right side. Hold the button nearest the upper-right corner in portrait to scroll through long cards.

横屏空闲页用大字显示主机名，蓝牙和 USB 状态并排，下一行靠左显示「提示音：开」或「提示音：关」。横屏通知页也显示提示音状态，消息卡片上的主机名和项目名各占一行。

收到新审批、问题或通知时，屏幕点亮并显示卡片。默认播放约 70 毫秒的单音提示，一秒内连续到达的卡片只响一次。在空闲页或通知页，长按下键约半秒可切换提示音。空闲页显示当前状态，重启后保留设置。通知页短按下键会清除当前通知。

The landscape idle screen shows Bluetooth and USB status side by side. The idle and notification screens show whether sound is on. Incoming cards play a single tone of about 70 milliseconds by default. On the idle or notification screen, hold the lower of the three buttons on the right for about half a second to toggle sound. The setting survives a restart. A short press clears the selected notification.

## 安装与恢复

1. 用 [FoloToy 官方桌面工具](https://ai-passport.folotoy.cn/tools/desktop-app/) 备份通行证当前的完整 Flash。备份可能包含设备身份及私有配置，请保存在本机。
2. 保留现有布局时，先读取设备分区表。只有确认设备使用位于 `0x10000` 的工厂应用分区、分区至少 3 MiB，且没有更优先的 OTA 启动槽时，才用 esptool 将 `AgentReminder-AI-Passport-app.bin` 写到 `0x10000`。写入前用 `SHA256SUMS` 校验。要用 [官方本地玩法安装工具](https://ai-passport.folotoy.cn/tools/web-flasher/) 安装完整玩法，请选 `AgentReminder-AI-Passport-full.bin`，并提前确认原设备的身份和素材分区位于镜像写入范围之外。
3. 启动 AgentReminder 主机服务，接入通行证并在配对卡出现后按中键确认。要从已配对的另一块板子切换，可只接入通行证并执行 `node ~/.agentreminder/app/host/agentreminder.js pair`。

完整玩法镜像写入起始地址为 `0x0`，范围止于 `0x310000` 前，并会写入新的分区表和空白 NVS。这台实测设备的素材区从 `0x310000` 开始，`cardid` 位于 `0x356000`。不同玩法可能使用不同分区布局。应用镜像仅替换原有应用区。蓝牙配对时，AgentReminder 用独立的 `ar` 命名空间保存配对信息。

## 从源码构建

安装 PlatformIO 和 esptool 4.9.0 后，在仓库根目录运行：

```sh
bash firmware/build-passport.sh
```

脚本生成合并镜像、应用镜像和 SHA-256 校验值。

已实测在原分区表上仅刷应用后启动，设备通过 USB 握手及字库自检。右侧中间键可确认配对。关闭主机测试服务的 USB 数据链路并重启服务后，设备通过蓝牙重新连接，完成了一次实体键审批和完成通知显示。
