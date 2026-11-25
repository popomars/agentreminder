#!/usr/bin/env bash
set -euo pipefail
umask 077

port=
baud=460800
check=false
while (( $# )); do
  case "$1" in
    --port) port="${2:?请提供串口路径}"; shift 2;;
    --baud) baud="${2:?请提供波特率}"; [[ "$baud" =~ ^[0-9]+$ ]] || exit 2; shift 2;;
    --check) check=true; shift;;
    -h|--help) echo '用法：bash flash.sh [--port /dev/串口] [--baud 460800] [--check]'; exit 0;;
    *) echo "未知选项：$1" >&2; exit 2;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image_dir="$root/firmware/release/waveshare-amoled-2.16"
python3 - "$image_dir" <<'PY'
import hashlib, sys
from pathlib import Path
root = Path(sys.argv[1])
names = {"bootloader.bin", "partitions.bin", "boot_app0.bin", "firmware.bin"}
try:
    for line in (root / "SHA256SUMS").read_text().splitlines():
        expected, name = line.split()
        names.remove(name)
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
            raise ValueError("校验失败 " + name)
    if names:
        raise ValueError("校验清单缺少 " + ", ".join(sorted(names)))
except (OSError, ValueError, KeyError) as error:
    sys.exit(f"固件不完整或校验失败。请从仓库完整下载后重试。{error}")
print("固件 SHA-256 校验通过。")
PY
if "$check"; then exit 0; fi

env_dir="${AGENTREMINDER_HOME:-"$HOME/.agentreminder"}/flash/esptool-4.9.0"
python="${AGENTREMINDER_FLASH_PYTHON:-"$env_dir/bin/python"}"
if [[ ! -x "$python" ]]; then
  if [[ -n ${AGENTREMINDER_FLASH_PYTHON:-} ]]; then
    echo "找不到指定的 Python：$python" >&2
    exit 1
  fi
  python3 -m venv "$env_dir"
fi
if ! "$python" -c 'import esptool, serial; assert esptool.__version__ == "4.9.0"' 2>/dev/null; then
  "$python" -m pip install 'esptool==4.9.0'
fi

if [[ -z "$port" ]]; then
  port="$("$python" - <<'PY'
import sys
from serial.tools import list_ports

ports = [p.device for p in list_ports.comports() if (p.vid, p.pid) == (0x303a, 0x1001)]
if len(ports) != 1:
    sys.exit("请只连接一台 ESP32-S3 USB Serial/JTAG 设备，或用 --port 指定串口。"
             + (" 检测到：" + ", ".join(ports) if ports else ""))
print(ports[0])
PY
)"
fi
[[ -c "$port" ]] || { echo "找不到串口：$port" >&2; exit 1; }
host="${AGENTREMINDER_HOME:-"$HOME/.agentreminder"}/app/host/agentreminder.js"
if [[ ! -f "$host" ]]; then host="$root/host/agentreminder.js"; fi
if [[ -f "$host" ]] && command -v node >/dev/null; then
  node "$host" stop
  sleep 1
  trap 'node "$host" start' EXIT
fi

echo "正在为微雪 ESP32-S3-Touch-AMOLED-2.16 刷机：$port"
"$python" -m esptool --chip esp32s3 --port "$port" --baud "$baud" \
  --before default_reset --after hard_reset write_flash -z \
  --flash_mode dio --flash_freq 80m --flash_size 16MB \
  0x0000 "$image_dir/bootloader.bin" \
  0x8000 "$image_dir/partitions.bin" \
  0xe000 "$image_dir/boot_app0.bin" \
  0x10000 "$image_dir/firmware.bin"
echo '刷机成功。设备重启后即可通过 USB 配对。'
