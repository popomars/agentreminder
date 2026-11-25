# 微雪 ESP32-S3-Touch-AMOLED-2.16 固件

这组文件来自 AgentReminder v0.3.5 固件构建。审批、问题和通知卡可显示主机服务接收时间。完成通知按主机、项目和对话分组，每组保留最新一条。短按中间的 PWR 键可将当前审批或问题交回电脑。等待审批或回答时显示待处理总数。卡片标题和对话使用 35 px，主机、项目和时间使用 24 px，完成页提示使用 22 px。适用于
CO5300、CST9220、16 MB Flash 和 8 MB PSRAM 的微雪 2.16 英寸 AMOLED 板。

| 文件 | 写入地址 |
| --- | --- |
| bootloader.bin | `0x0000` |
| partitions.bin | `0x8000` |
| boot_app0.bin | `0xe000` |
| firmware.bin | `0x10000` |

从项目根目录运行 `bash flash.sh`。脚本逐个写入上述区域。
更新预编译文件时，从同一 PlatformIO 构建复制前三个构建输出
`bootloader.bin`、`partitions.bin`、`firmware.bin`，并取对应 Arduino
框架的 `tools/partitions/boot_app0.bin`，最后重新生成 `SHA256SUMS`。
