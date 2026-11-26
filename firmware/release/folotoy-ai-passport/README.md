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
2. 从仓库根目录运行 `bash install.sh --flash --board folotoy-passport` 安装主机服务并刷机。已安装主机服务时，也可用 `bash flash.sh --board folotoy-passport` 只刷设备。脚本先校验镜像，再读取现有分区表。通过校验后，仅写入位于 `0x10000`、至少 3 MiB 的唯一工厂应用分区。
3. 首次安装后，在配对卡出现时按中键确认。把 Passport 添加到已配对其他设备的主机时，接入通行证并执行 `node ~/.agentreminder/app/host/agentreminder.js pair`。

需要用 [官方本地玩法安装工具](https://ai-passport.folotoy.cn/tools/web-flasher/) 安装完整玩法时，选择 `AgentReminder-AI-Passport-full.bin`。它从 `0x0` 写入，范围止于 `0x310000` 前，并会写入新的分区表。首次启动会初始化 NVS。完整安装前，请根据当前玩法的实际分区表核对身份、配置和素材的存放位置。实测设备的素材区从 `0x310000` 开始，`cardid` 位于 `0x356000`。

For a compatible Passport, run `bash install.sh --lang en --flash --board folotoy-passport`, or use `bash flash.sh --lang en --board folotoy-passport` to flash only. The script verifies the images and the on-device partition table before writing the single factory app at `0x10000`. Back up the current board with the official desktop tool before replacing its app. The full image is available for the official community-play installer and includes a replacement partition table.

## 从源码构建

安装 PlatformIO 和 esptool 4.9.0 后，在仓库根目录运行：

```sh
bash firmware/build-passport.sh
```

脚本生成合并镜像、应用镜像和 SHA-256 校验值。

已实测在原分区表上仅刷应用后启动，设备通过 USB 握手及字库自检。右侧中间键可确认配对。关闭主机测试服务的 USB 数据链路并重启服务后，设备通过蓝牙重新连接，完成了一次实体键审批和完成通知显示。
