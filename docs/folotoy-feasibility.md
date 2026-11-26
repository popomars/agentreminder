# FoloToy AI Passport 接入调研

已确认目标是运行社区玩法的 AI Passport。AgentReminder 以独立社区玩法构建，沿用电脑端服务。安装镜像和按键说明见 [AI Passport 固件目录](../firmware/release/folotoy-ai-passport/README.md)。

| 入口 | 已确认的能力 | 对 AgentReminder 的影响 |
| --- | --- | --- |
| AI Passport 原厂固件 | 微信小程序可经本地蓝牙同步身份资料和全屏图片。 | 可以先用合成测试卡验证显示。尚未找到公开的自动更新接口、后台唤醒接口或按键回传接口。 |
| AI Passport 社区玩法 | 官方从 USB 安装合并固件并覆盖当前内容。无线玩法安装器也需要先刷入安装器固件。 | 可参考现有 Codex Buddy 的做法评估硬件能力。原厂固件不变时无法走此安装流程。 |
| FoloToy AI 玩具自建服务 | MQTT 支持语音播报并提供语音转写事件。 | 已支持自建服务的型号可以评估语音提醒。AI Passport 原厂身份卡固件的兼容性未证实。 |

社区玩法安装会更换正在运行的应用和镜像覆盖范围内的数据。设备身份区可以独立保留，旧玩法的设置、存档及自行编辑的名片内容取决于各自的存储位置。本机完整备份显示，素材区从 `0x310000` 开始，设备身份区位于 `0x356000`。因此本机按分区表校验后只刷应用区。社区合并镜像体积也限制在 `0x310000` 以内。其它设备安装前需核对实际布局。

- [原厂固件和蓝牙同步说明](https://ai-passport.folotoy.cn/guides/getting-started/)
- [社区玩法安装与覆盖行为](https://ai-passport.folotoy.cn/guides/flash-official-firmware/)
- [官方玩法开发及固件交付方式](https://ai-passport.folotoy.cn/guides/create-a-play-with-agent/)
- [官方桌面工具的设备安装与备份接口](https://pkg.go.dev/github.com/FoloToy/ai-passport-desktop/pkg/core)
- [无线玩法安装器](https://github.com/microdog/ai-passport-miniapp-installer)
- [Codex Buddy 的设备固件和主机桥](https://github.com/zhangsan2000w-art/ai-passport-codex-buddy)
- [FoloToy 自建服务 MQTT 接口](https://docs.folotoy.com/docs/integrations/mqtt/)

FoloToy 把侧边绿灯标为充电指示灯。公开引脚表和 BSP 没有列出绿灯的 GPIO 或控制接口，尚未找到可核对这条电路的公开原理图。[充电指示灯说明](https://ai-passport.folotoy.cn/guides/getting-started/) · [引脚与板级接口](https://github.com/FoloToy/ai-passport/blob/main/docs/hardware-design/AI_HARDWARE_DEVELOPMENT_GUIDE.md)
