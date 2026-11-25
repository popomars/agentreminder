# AgentReminder

Shows approval requests and task-completion messages from Claude Code / Codex / DeepSeek Harness (dsh) on an ESP32-S3 touchscreen. Tap the screen to approve or deny. The device connects over **native USB CDC** by default. Wi-Fi TCP is optional and can run alongside USB when enabled. BLE is planned, not implemented.

```
 Claude Code ─┐  PermissionRequest / Stop / Notification
 Codex ───────┼─ hook ─► host/agentreminder.js ──HTTP──► daemon (127.0.0.1:47321)
 dsh ─────────┘          (spawns the daemon on first use)  │
                                                           ├─ USB CDC  /dev/cu.usbmodem*
                                                           └─ Wi-Fi TCP agentreminder.local:47322
                                                                      │
                                                         ESP32-S3 touchscreen: 拒绝 / 终端 / 同意
```

- **同意 / 拒绝 (approve / deny)**: the decision goes straight back to the agent.
- **终端 (terminal)**, no device connected, or timeout (90 s by default): the hook prints nothing and the agent shows its own approval prompt as usual. The approval hook waits for the device decision, then falls back on timeout; completion notifications never return a blocking decision.
- Hitting Esc / cancelling in the terminal: the card on the device disappears automatically.
- **Conversation context**: cards show the conversation name, approval reason and tool arguments; the project folder is secondary. Codex titles come from its local session database, Claude from its session index/transcript, or an explicit hook title. Missing titles fall back to the session ID.
- A response ended (`Stop`), or Claude is waiting for input: a notification card appears on the device. Tap it to dismiss.

Requirements: Node.js ≥ 18 (the host side has zero dependencies) and PlatformIO (for flashing the firmware). The configured board is **Waveshare ESP32-S3-Touch-AMOLED-2.16**, CO5300 QSPI AMOLED + CST9220 touch, 16 MB flash / 8 MB OPI PSRAM.

## Install from GitHub

On macOS or Linux with Node.js 18 or later, connect a device already running
AgentReminder firmware with a USB data cable. Sign in to GitHub CLI (`gh`) with
an account that can read the private repository, then run:

```sh
gh api -H 'Accept: application/vnd.github.raw+json' \
  'repos/popomars/agentreminder/contents/install.sh?ref=main' > agentreminder-install.sh \
  && bash agentreminder-install.sh
```

The installer discovers local agents and copies only the host files into
`~/.agentreminder/app`. Press the right button on the device when it asks to
pair. The host saves that USB device ID and directs future cards to it. The
same board can be paired on a different computer. This setup uses USB.

Use `--agent codex`, `--agent claude`, or `--agent dsh` to choose agents. Repeat
the option to install more than one. For a checkout cloned via SSH, run
`bash install.sh` inside it. Use `--no-pair` to install on a remote agent host.
To pair or replace the device later, connect only the intended device and run
`node ~/.agentreminder/app/host/agentreminder.js pair`.

Codex requires hook review through `/hooks`. Claude Code loads the config in a
new session. For dsh, complete the bridge setup below using the generated file
and the patch under `~/.agentreminder/app/integrations/dsh`.

## 1. Flash the firmware

From the repository root:

```sh
python3 -m venv .venv
.venv/bin/pip install platformio
PLATFORMIO_CORE_DIR="$PWD/.platformio" .venv/bin/pio run -d firmware -t upload
node host/agentreminder.js start
node host/tools/hardware-check.js
```

The hardware check asks for **拒绝** with the left physical key on a Codex card, then **同意** with the right physical key on a Claude card,
then sends a completion card. These are real USB hook round trips; the displayed
operation is never executed. Results go into `.runtime/hardware-check.json`.
A complete 16 MB pre-flash backup, if taken, is kept under `.runtime/backups/`.
For another board, replace `firmware/src/board_config.h`; do not reuse these pins.

Optional Wi-Fi: enable `wifi.enabled` in the config, restart the daemon, then run
`node host/agentreminder.js wifi <SSID> <password>` with USB connected. Wi-Fi TCP
currently has no pairing or encryption; USB is the validated default.

## 2. Install into the agents

**Claude Code** (plugin):
```
/plugin marketplace add /absolute/path/to/agentreminder
/plugin install agentreminder@agentreminder
```
Uses the `PermissionRequest` (approve/deny), `Stop` (done) and `Notification` (waiting for input) hooks.

**Codex**:
```
node host/agentreminder.js install codex     # merges into ~/.codex/hooks.json (backs up to .bak)
```
Then run `/hooks` inside Codex to review and trust them. The repo also ships `.codex-plugin/plugin.json` + `hooks/codex.json`, so you can install it through Codex's plugin mechanism instead.

**dsh (DeepSeek Harness)**: through the official Claude Code hook bridge
```
dsh plugin --profile <your profile> add @deepseek-ai/dsh-hooks-claude-code
node host/agentreminder.js install dsh       # generates ~/.agentreminder/dsh-hooks.json
```
Then merge `integrations/dsh/cordis.patch.yml` into your profile config (point `configPath` at the absolute path of that file). Verify with `dsh web --dump-config | grep -i hook`.
> Limitation: the bridge has no PermissionRequest, so it uses `PreToolUse` + a tool-name matcher (Bash/Write/Edit…). While the device is connected, every matching tool call goes to the device. The matcher includes lowercase dsh names as well as Claude-style names. `allow` is handed to the bridge and may still be subject to harness permission policy. The matcher can be changed via `dshMatcher` in `~/.agentreminder/config.json`. The long-term plan is a native Cordis plugin hooked into `tools/pre-execute`.

## 3. Configuration `~/.agentreminder/config.json` (optional)

```json
{
  "approvalTimeoutSec": 90,
  "usb":  { "enabled": true },
  "wifi": { "enabled": false, "hosts": ["agentreminder.local"], "port": 47322 },
  "notify": { "stop": true, "idle": true }
}
```
If mDNS is unreliable, put the device's IP in `hosts` (the screen's status bar shows the IP).

## Common commands

| Command | Purpose |
|---|---|
| `node host/agentreminder.js status` | Daemon status, connected devices, pending approvals |
| `node host/agentreminder.js log` | Last 60 lines of the log |
| `node host/agentreminder.js stop` | Stop the daemon (the next hook restarts it) |
| `node host/tools/fake-device.js` | Simulate the device in a terminal (enable `wifi.enabled` and set `wifi.hosts` to `127.0.0.1`) |

Protocol details: [docs/protocol.md](docs/protocol.md)

## Validation and remote agents

```sh
node --test host/test/*.test.js
```

Tests include real hook subprocesses, the local HTTP daemon, a TCP device
simulator, allow/deny/skip, notifications, cancellation, disconnection, malformed
settings preservation, and UTF-8 split across transport reads. This does not
replace the physical touchscreen check or an agent's own hook trust review.
`Stop` means the agent ended a response, not proof that the overall task succeeded.

For an agent on an SSH host, install the hooks **on that host** and forward a remote
loopback port to the Mac daemon, for example from the Mac:

```sh
ssh -N -R 127.0.0.1:47331:127.0.0.1:47321 user@remote
```

Set `httpPort` to `47331` in the remote `~/.agentreminder/config.json`. Hook HTTP
requests then reach the Mac, and device decisions return through the same tunnel.
Do not expose the daemon on a public interface. This remote path has not yet been
accepted on a real remote agent. Managed cloud products need their own supported
hooks or event/approval APIs; installing this local plugin alone is insufficient.

## Physical buttons and fonts

Firmware v0.2 uses the two outer keys for the current approval, with 35ms debounce
and no repeat into the next card while a key is held. The center power key retains
its power function. The BOOT key retains its boot-loader role during startup.

A generated Noto Sans SC font covers Basic CJK, kana, Latin-1, punctuation and
arrows. Its open font license and regeneration steps are in `firmware/src/fonts/`.
Emoji and supplementary-plane Han are outside this font's coverage.
