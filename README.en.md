# AgentReminder

[简体中文](README.md)

Show approvals and completion messages on a Waveshare ESP32-S3-Touch-AMOLED-2.16. Cards show the title, conversation, source host, and project. The idle screen shows the connected host and link status. With the display facing you and the USB port at the bottom, press **left (BOOT/-) to deny** or **right (+/KEY) to allow**, or use the touchscreen.

## Install, flash, and pair

Use macOS or Linux with Node.js 18 or newer. Both support USB. Bluetooth LE requires macOS 13 or newer on Apple silicon or Intel. Flashing requires Python 3 and a USB data cable. The bundled image targets the **Waveshare ESP32-S3-Touch-AMOLED-2.16 with 16 MB flash and 8 MB PSRAM**.

From a clone of the repository:

```bash
bash install.sh --lang en --flash
```

`--flash` verifies the firmware checksums, replaces the firmware on the connected board, and then installs the host hooks and enables USB pairing. Omit `--flash` if the board already has AgentReminder firmware. Specify `--flash --port DEVICE` if more than one board is attached.

The repository is private. Use `GH_TOKEN` with repository read access. With an authenticated GitHub CLI, use `export GH_TOKEN="$(gh auth token)"`. To install directly from GitHub:

```bash
printf 'Authorization: Bearer %s\n' "${GH_TOKEN:?Set GH_TOKEN first}" |
  curl -fsS -H @- -H 'Accept: application/vnd.github.raw+json' \
    'https://api.github.com/repos/popomars/agentreminder/contents/install.sh?ref=main' \
    -o agentreminder-install.sh &&
  bash agentreminder-install.sh --lang en --flash
```

The GitHub installer fetches the host and firmware files from the same commit. Use `--agent codex --agent claude` to override agent detection, or `--no-pair` to skip pairing and starting the daemon during setup. The default install path is `~/.agentreminder/app`.

1. Connect the board with a USB data cable. When the board asks to pair (`配对这台电脑`), press the right button.
2. In Codex, open `/hooks` and review and trust the AgentReminder hooks. Reopen Claude Code sessions to load its hooks.
3. Check connection status, or run a device round-trip check:

   ```bash
   node ~/.agentreminder/app/host/agentreminder.js status
   node ~/.agentreminder/app/host/tools/hardware-check.js
   ```

If pairing times out, reconnect USB or run `node ~/.agentreminder/app/host/agentreminder.js pair`. On Linux, confirm that your user has access to `/dev/ttyACM*`.

To add a board, connect it by USB and run the same `pair` command. The host keeps existing enrollments and sends notifications and supported approvals to all connected paired boards. The first decision clears the matching approval on the other boards.

### Bluetooth and a new host

Enable Bluetooth on the Mac and grant permission if macOS asks. Wait for `bluetooth: "connected"` in `status`, or `蓝牙已连接` on the board's idle screen, before disconnecting the data cable. Keep the board powered with an installed battery or a USB charger. It reconnects automatically when powered and in range. USB remains available when plugged into a computer. [Waveshare board and power documentation](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-2.16)

To switch hosts, attach USB to the new computer, install AgentReminder, and confirm on the board. If the new computer already has AgentReminder, run the `pair` command. Each board stores the Bluetooth key for its most recent host. You can temporarily turn off Bluetooth on the old Mac while pairing.

### Approve from either Codex Desktop or the device

On macOS, run the following once, then quit the desktop app and reopen it from its usual Dock icon:

```bash
node ~/.agentreminder/app/host/configure-codex-dock.js install
```

Use manual approval in the chat. The first response to a mirrored command or file approval wins. When the device disconnects, reaches its deadline, or hands the approval back, Codex's native prompt remains available. Use `status` or `uninstall` in place of `install` to inspect or remove the Dock integration. For a one-off launch, use `bash ~/.agentreminder/app/host/open-codex.sh` after quitting the app.

### Queue and timeout

The device shows one approval at a time in arrival order. The count at the top includes the visible approval. Each approval has its own deadline starting on arrival, with a **five-minute default**. At its deadline the device removes the card and returns control to the client.

Completion notifications are grouped by host, project, and conversation. Each group shows its latest card. When conversation IDs are available, chats with the same title each get their own card. The notification list appears after the approval queue clears, newest first, with up to 20 notification cards in total.

Approvals, questions, and notifications show when the host service first received them in its local time, for example `11-25 14:08`. A card keeps its original time when switching between USB and Bluetooth. On an existing installation, run `bash install.sh --flash` from the updated checkout to upgrade the host and firmware together.

Set `approvalTimeoutSec` in `~/.agentreminder/config.json` to change the wait. For older installations or after changing the limit, rerun the installer for the same agent and restart the agent so it uses the updated hook timeout. Update the dsh bridge timeout in its profile too.

### Questions and other input

For a single two-option question, use the two on-screen choices or the matching physical buttons. Briefly press the center **PWR** key or tap **Continue on computer** to hand it back. A short PWR press on an approval card also defers to the computer. Requests with more choices, multiple questions, text fields or authentication show a reminder on the board and can be completed on the computer. For secret fields, the board only shows a handoff reminder. Approvals and live input requests share the pending queue.

Codex Desktop uses the desktop bridge for native questions, MCP forms and permission requests that need desktop review. For a single native question with two preset answers, the device displays both choices. To enter an optional **Other** answer, briefly press the center PWR key and continue on the computer. Reopen Codex to load the updated bridge. Claude Code uses `AskUserQuestion`, plus the `Elicitation` hook in Claude Code 2.1.76 or newer. Use Claude Code 2.1.76 or newer for the plugin package. For a two-option prompt, Claude waits for the device answer or handoff. Other prompts open on the computer. dsh can display reminders from its configured bridge and answers remain in dsh. Managed cloud interactions need an event source that connects to the local hooks or bridge.

### dsh and remote agents

Install with `--agent dsh`, install the Claude Code hooks bridge in your dsh profile, and merge the [Cordis example](integrations/dsh/cordis.patch.yml). Set `configPath` to the absolute path of `~/.agentreminder/dsh-hooks.json`. dsh still applies its own approval policy.

For remote agents over SSH, use `--no-pair` on the remote machine and forward the remote loopback port to the local daemon. See [the protocol guide](docs/protocol.md#ssh-远程-agent).

## FoloToy AI Passport

The AI Passport build is a separate community play. It uses the three function buttons on the right and the same host service. USB enrollment and macOS Bluetooth messaging have been tested on the device. Like the Waveshare build, Passport shows receipt times on approvals, questions, and notifications, and keeps only the latest completion per host, project, and conversation. Installation replaces the active play. [Image, controls, and installation](firmware/release/folotoy-ai-passport/README.md)

## Firmware only

The [prebuilt images and checksums](firmware/release/waveshare-amoled-2.16) live in the repository. From a clone, use `bash flash.sh --lang en` to verify and flash them, or `bash flash.sh --lang en --check` to verify only. On the first flash, the script may install esptool into a private Python environment. If the board cannot enter flashing mode, hold BOOT while connecting USB and rerun the command.

## Uninstall

```bash
bash ~/.agentreminder/app/uninstall.sh --lang en
```

For older installations, run `bash uninstall.sh --lang en` from this checkout. The script removes installer-managed hooks, Dock configuration and host files, then stops local service as part of cleanup. It preserves pairing data, logs, and other hooks. Reopen running agents afterward. Disable any separately installed plugin in its plugin manager. You can remove the dsh profile entry you added manually. To stop temporarily, run `node ~/.agentreminder/app/host/agentreminder.js stop`.

## Processes and development

The host runs one Node.js daemon on `127.0.0.1`. A paired Mac uses one CoreBluetooth child. USB is handled in the daemon. The optional Codex approval proxy runs with the Codex session. Its macOS login item sets the launch path and exits.

- Run tests with `node --test host/test/*.test.js`.
- Build firmware with `pio run -d firmware`.
