#!/usr/bin/env bash
set -euo pipefail
umask 077

port=
baud=460800
check=false
lang=${AGENTREMINDER_LANG:-zh}
say() { if [[ "$lang" == en ]]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
usage() {
  say '用法：bash flash.sh [--port DEVICE] [--baud RATE] [--check] [--lang zh|en]' \
      'Usage: bash flash.sh [--port DEVICE] [--baud RATE] [--check] [--lang zh|en]'
}
while (( $# )); do
  case "$1" in
    --port) [[ -n ${2:-} ]] || { usage >&2; exit 2; }; port=$2; shift 2;;
    --baud) [[ ${2:-} =~ ^[0-9]+$ ]] || { usage >&2; exit 2; }; baud=$2; shift 2;;
    --lang) case "${2:-}" in zh|en) lang=$2;; *) usage >&2; exit 2;; esac; shift 2;;
    --check) check=true; shift;;
    -h|--help) usage; exit 0;;
    *) usage >&2; exit 2;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image_dir="$root/firmware/release/waveshare-amoled-2.16"
python3 - "$image_dir" "$lang" <<'PY'
import hashlib, sys
from pathlib import Path
root = Path(sys.argv[1])
english = sys.argv[2] == 'en'
names = {"bootloader.bin", "partitions.bin", "boot_app0.bin", "firmware.bin"}
try:
    for line in (root / "SHA256SUMS").read_text().splitlines():
        expected, name = line.split()
        names.remove(name)
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
            raise ValueError(name)
    if names:
        raise ValueError(", ".join(sorted(names)))
except (OSError, ValueError, KeyError) as error:
    message = "Firmware files are missing or failed verification. Download them again." if english else "固件不完整或校验失败。请从仓库完整下载后重试。"
    sys.exit(f"{message} {error}")
print("Firmware SHA-256 verification passed." if english else "固件 SHA-256 校验通过。")
PY
if "$check"; then exit 0; fi

env_dir="${AGENTREMINDER_HOME:-"$HOME/.agentreminder"}/flash/esptool-4.9.0"
python="${AGENTREMINDER_FLASH_PYTHON:-"$env_dir/bin/python"}"
if [[ ! -x "$python" ]]; then
  if [[ -n ${AGENTREMINDER_FLASH_PYTHON:-} ]]; then
    say "找不到指定的 Python：$python" "Python executable not found: $python" >&2
    exit 1
  fi
  python3 -m venv "$env_dir"
fi
if ! "$python" -c 'import esptool, serial; assert esptool.__version__ == "4.9.0"' 2>/dev/null; then
  "$python" -m pip install 'esptool==4.9.0'
fi

if [[ -z "$port" ]]; then
  port="$("$python" - "$lang" <<'PY'
import sys
from serial.tools import list_ports

ports = [p.device for p in list_ports.comports() if (p.vid, p.pid) == (0x303a, 0x1001)]
if len(ports) != 1:
    message = ("Connect one ESP32-S3 USB Serial/JTAG board or pass --port."
               if sys.argv[1] == 'en' else "请只连接一台 ESP32-S3 USB Serial/JTAG 设备，或用 --port 指定串口。")
    sys.exit(message + (" " + ", ".join(ports) if ports else ""))
print(ports[0])
PY
)"
fi
[[ -c "$port" ]] || { say "找不到串口：$port" "Serial port not found: $port" >&2; exit 1; }
host="$root/host/agentreminder.js"
if [[ -f "$host" ]] && command -v node >/dev/null; then
  if node "$host" stop --if-running; then
    trap 'node "$host" start' EXIT
  else
    status=$?
    if [[ "$status" != 3 ]]; then exit "$status"; fi
  fi
fi

say "正在为微雪 ESP32-S3-Touch-AMOLED-2.16 刷机：$port" "Flashing Waveshare ESP32-S3-Touch-AMOLED-2.16 on $port"
"$python" -m esptool --chip esp32s3 --port "$port" --baud "$baud" \
  --before default_reset --after hard_reset write_flash -z \
  --flash_mode dio --flash_freq 80m --flash_size 16MB \
  0x0000 "$image_dir/bootloader.bin" \
  0x8000 "$image_dir/partitions.bin" \
  0xe000 "$image_dir/boot_app0.bin" \
  0x10000 "$image_dir/firmware.bin"
say '刷机成功。设备重启后即可通过 USB 配对。' 'Flashing complete. Once the board restarts, you can pair it over USB.'
