# AgentReminder

[简体中文](README.md)

Show agent approvals, questions and completion messages on a Waveshare ESP32-S3-Touch-AMOLED-2.16 or FoloToy AI Passport. Cards include the title, conversation, source host and project. The idle screen shows the connected host and link status. Waveshare supports touch and uses its left and right buttons to deny and allow. Passport aligns its prompts with its three function buttons.

## Install, flash, and pair

Use macOS or Linux with Node.js 18 or newer. Both support USB. Bluetooth LE requires macOS 13 or newer on Apple silicon or Intel. Flashing requires Python 3 and a USB data cable.

Choose the command for your board from a clone of the repository.

- Waveshare uses `bash install.sh --lang en --flash`.
- Passport uses `bash install.sh --lang en --flash --board folotoy-passport`.

`--flash` defaults to the Waveshare ESP32-S3-Touch-AMOLED-2.16 with 16 MB flash and 8 MB PSRAM. With `--board folotoy-passport`, the script checks the existing partition table and updates a compatible application partition. The installer then writes the host hooks and enables USB pairing. Specify `--port DEVICE` when multiple boards are attached. For a device already running AgentReminder, run the installer without flashing. [Passport layout and backup instructions](firmware/release/folotoy-ai-passport/README.md#安装与恢复)

The repository is private. Use `GH_TOKEN` with repository read access. With an authenticated GitHub CLI, use `export GH_TOKEN="$(gh auth token)"`. To install directly from GitHub:

```bash
printf 'Authorization: Bearer %s\n' "${GH_TOKEN:?Set GH_TOKEN first}" |
  curl -fsS -H @- -H 'Accept: application/vnd.github.raw+json' \
    'https://api.github.com/repos/popomars/agentreminder/contents/install.sh?ref=main' \
    -o agentreminder-install.sh &&
  bash agentreminder-install.sh --lang en --flash
```

The downloaded installer accepts the same board options and fetches the host and firmware from the same commit. Use `--agent codex --agent claude` to override agent detection, or `--no-pair` to skip pairing and starting the daemon during setup. The default install path is `~/.agentreminder/app`.

1. Connect the board with a USB data cable. When it asks to pair (`配对这台电脑`), follow its approval prompt. Use the right button on Waveshare in portrait or the middle function button on Passport.
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

Approvals, questions, and notifications show when the host service first received them in its local time, for example `11-25 14:08`. A card keeps its original time when switching between USB and Bluetooth. Run the `install.sh --flash` command for your board to update the host and firmware together.

Set `approvalTimeoutSec` in `~/.agentreminder/config.json` to change the wait. For older installations or after changing the limit, rerun the installer for the same agent and restart the agent so it uses the updated hook timeout. Update the dsh bridge timeout in its profile too.

### Questions and other input

For a single two-option question, use the physical buttons indicated on screen. Waveshare also supports touch and uses a short **PWR** press to hand off to the computer. Passport uses a short press of the bottom function button in portrait. Requests with more choices, multiple questions, text fields or authentication show a reminder on the board and can be completed on the computer. For secret fields, the board only shows a handoff reminder. Approvals and live input requests share the pending queue.

Codex Desktop uses the desktop bridge for native questions, MCP forms and permission requests that need desktop review. For a single native question with two preset answers, the device displays both choices. To enter an optional **Other** answer, use the on-screen instructions to hand off to the computer. Reopen Codex to load the updated bridge. Claude Code uses `AskUserQuestion`, plus the `Elicitation` hook in Claude Code 2.1.76 or newer. Use Claude Code 2.1.76 or newer for the plugin package. For a two-option prompt, Claude waits for the device answer or handoff. Other prompts open on the computer. dsh can display reminders from its configured bridge and answers remain in dsh. Managed cloud interactions need an event source that connects to the local hooks or bridge.

### dsh and remote agents

Install with `--agent dsh`, install the Claude Code hooks bridge in your dsh profile, and merge the [Cordis example](integrations/dsh/cordis.patch.yml). Set `configPath` to the absolute path of `~/.agentreminder/dsh-hooks.json`. dsh still applies its own approval policy.

For remote agents over SSH, use `--no-pair` on the remote machine and forward the remote loopback port to the local daemon. See [the protocol guide](docs/protocol.md#ssh-远程-agent).

## macOS menu bar

Run `bash install.sh --menu-bar` from this checkout. Building the menu bar app requires macOS 13 or later and Xcode Command Line Tools. After setup, open **AgentReminder** in Finder under `~/Applications`. The app connects to the local service or starts it for you. Allow Bluetooth access when macOS prompts. On an existing installation, run `bash install.sh --menu-bar --skip-hooks --no-pair` to retain the current hooks and pairing settings.

The bell shows the unread notification and pending approval counts. Open its menu to view either list. Opening a notification marks it as read, and there is also a **Mark all as read** action. The service keeps up to 100 notifications for its current run. Completion entries show the host, project, conversation, and “Task completed”. Use the Notifications submenu to clear the local notification list, or the main menu to clear notifications and approvals together. Clearing approvals retracts their device cards and hands decisions back to the originating client. To add a device, connect a board with AgentReminder firmware over USB, choose **Pair a new device**, then confirm on the board.

## Waveshare notification sound

The Waveshare ESP32-S3-Touch-AMOLED-2.16 plays two short beeps for new approvals, questions, and notifications. The device combines duplicate USB and Bluetooth deliveries and plays at most one pair of beeps per second.

## FoloToy AI Passport

The AI Passport build is a separate community play. It uses the three function buttons on the right and the same host service. USB enrollment and macOS Bluetooth messaging have been tested on the device. Like the Waveshare build, Passport shows receipt times on approvals, questions, and notifications, and keeps only the latest completion per host, project, and conversation. Installation replaces the active play. [Image, controls, and installation](firmware/release/folotoy-ai-passport/README.md)

## Firmware only

From a clone, run `bash flash.sh --lang en` for Waveshare or `bash flash.sh --lang en --board folotoy-passport` for Passport. Add `--check` to verify the selected package without connecting a board. The script installs esptool into a private Python environment when needed. If Waveshare cannot enter flashing mode, hold BOOT while connecting USB and rerun the command. [Waveshare firmware](firmware/release/waveshare-amoled-2.16) · [Passport firmware](firmware/release/folotoy-ai-passport)

## Multiple computers and devices

Install the same service from this branch on each computer with `bash install.sh`. Keep the current firmware on paired USB or Bluetooth devices. A computer that only sends events can install with `--no-pair` and start the service separately.

Merge the following into each computer's `~/.agentreminder/config.json`, keeping existing pairing settings. Use the same key on each member. The daemon uses `tailscale status --json` to discover its local address and online peers every 10 seconds. Adding a computer requires no edits on existing members. Allow TCP port `47323` between participants. [Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli)

```json
{
  "tailnet": {
    "enabled": true,
    "key": "replace-with-the-same-64-lowercase-hex-characters-on-each-computer"
  }
}
```

Generate one key with `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. Share it privately and set the config file's permissions to `600`. The daemon verifies that a peer holds the key before sending a card. To migrate from manual configuration, remove `listen` and `peers` together, then restart.

Run the following on every computer after configuration. Start the service again after a reboot. When `tailnet.listening` is true, use `node ~/.agentreminder/app/host/agentreminder.js test` on any member to send sample cards.

```bash
node ~/.agentreminder/app/host/agentreminder.js stop
node ~/.agentreminder/app/host/agentreminder.js start
node ~/.agentreminder/app/host/agentreminder.js status
```

The service sends supported notifications, approvals, and questions to every online member's paired devices. The originating computer can have no device. The first valid response to reach it wins, and the remaining cards close. Choosing **Continue on computer** returns control to the original conversation. Events missed while offline are not replayed. Agents still apply their own hook and permission capabilities. Each computer can pair with multiple boards.

## Uninstall

```bash
bash ~/.agentreminder/app/uninstall.sh --lang en
```

For older installations, run `bash uninstall.sh --lang en` from this checkout. The script stops the local service and removes installer-managed hooks, Dock configuration, host files and firmware files downloaded by the installer. It preserves pairing data, logs and other hooks. Reopen running agents afterward. Disable any separately installed plugin in its plugin manager. You can remove the dsh profile entry you added manually. To stop temporarily, run `node ~/.agentreminder/app/host/agentreminder.js stop`.

## Processes and development

The host runs one Node.js daemon on `127.0.0.1`. macOS uses one CoreBluetooth child per paired Bluetooth board. USB is handled in the daemon. The optional Codex approval proxy runs with the Codex session. Its macOS login item sets the launch path and exits.

- Run tests with `node --test host/test/*.test.js`.
- Build Waveshare firmware with `pio run -d firmware`. Build and package Passport firmware with `bash firmware/build-passport.sh`.
