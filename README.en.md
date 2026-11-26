# AgentReminder

[简体中文](README.md)

View agent notifications and pending approvals from the Mac menu bar. Pair a Waveshare ESP32-S3-Touch-AMOLED-2.16 or FoloToy AI Passport to receive cards, respond to approvals, and answer two-option questions on the device.

## macOS quick start

### 1. Run the installer

You need macOS 13 or later, Node.js 18 or later, Python 3, and Xcode Command Line Tools. Sign in to the Mac desktop, open Terminal, and run this command from the repository root:

```bash
bash install.sh --lang en
```

You can also install directly from GitHub. These commands use one revision for the installer, host software, and both firmware bundles.

```bash
api=https://api.github.com/repos/popomars/agentreminder
revision="$(curl -fsS -H 'Accept: application/vnd.github.sha' "$api/commits/main")" &&
curl -fsS -H 'Accept: application/vnd.github.raw+json' \
  "$api/contents/install.sh?ref=$revision" -o agentreminder-install.sh &&
  bash agentreminder-install.sh --ref "$revision" --lang en
```

After setup, click the **AgentReminder bell** in the menu bar. The installer puts a complete `AgentReminder.app` in your user Applications folder (`~/Applications`) and launches it through macOS. You can close Terminal. Setup registers the app to open when you sign in. Manage it under **Launch at login**. After quitting the app, choose Go → Go to Folder in Finder, enter `~/Applications`, and double-click **AgentReminder**.

### 2. Pair from the bell

1. Connect one device using a USB data cable. If it needs AgentReminder firmware, choose **Install or update firmware… → device model** in the bell menu, confirm, and wait for the board to restart.
2. If the pairing prompt is already on the device screen, confirm it there. Otherwise choose **Pair a new device…**, then confirm on the board. Use the right button on a Waveshare with its screen facing you and USB port down. Use the middle function button on a Passport in portrait orientation.
3. Choose **Send test notification**. Check **Notifications** in the bell menu and look for the same card on the board. This test goes to the local service and its connected devices.
4. For wireless use, allow Bluetooth access when macOS asks and wait for the board to show a Bluetooth connection. Keep the board powered with a battery or USB power supply. You can reconnect the data cable at any time.

To move a board to a new Mac, connect it by USB and pair from the bell on the new Mac. The board keeps its latest Bluetooth pairing. Adding a board preserves that Mac's other enrollments.

### 3. Connect your agent

The installer detects Codex CLI, Claude Code CLI, dsh, and WorkBuddy and merges the required hooks. For a CLI installed in a custom location, run the installer from a terminal that can run the command. If you use an alias, add the executable's directory to `PATH`, or use `--agent codex`, `--agent claude`, or `--agent dsh` to write the hooks explicitly. The installer remembers the Claude executable it finds so the menu bar service can check its version after login.

Codex CLI defaults to `~/.codex/hooks.json` and Claude Code to `~/.claude/settings.json`. If either client uses a custom configuration directory, follow the GitHub download steps above and replace the final line with the command below. The menu service remembers the directories you pass. Set only the variable for each directory you customized.

```bash
CODEX_HOME="$HOME/custom settings/codex" \
CLAUDE_CONFIG_DIR="$HOME/custom settings/claude" \
bash agentreminder-install.sh --ref "$revision" --lang en
```

When installing from a checkout, keep the same environment variables and use `bash install.sh --lang en` as the final line. Use **Agent integrations** to enable agents installed later.

For a relocated Codex Desktop app, the bell looks through running apps and apps registered with macOS. If there are multiple copies or none is detected, use **Agent integrations → Codex Desktop approvals → Choose Desktop App…** and select the `.app` you use. After relocating WorkBuddy, open it once and enable its integration from the bell. Configure the dsh profile you actually use as shown below.

| Agent | After installation |
| --- | --- |
| Codex CLI | Open a new session. Run `/hooks` and review and trust the AgentReminder `PermissionRequest` and `Stop` hooks. The bell shows **Hooks configured** once setup has written them. |
| Codex Desktop | Choose **Agent integrations → Codex Desktop approvals → Enable** from the bell, then choose **Restart Now** or **Reopen Later**. Use manual approval and set the reviewer to the user. |
| Claude Code CLI | Start a new `claude` session. AgentReminder supports `AskUserQuestion` and, on version 2.1.76 or later, `Elicitation`. |
| dsh | Install the Claude Code hooks bridge in your profile, merge the Cordis example, and set `configPath` to the absolute path of `~/.agentreminder/dsh-hooks.json`. [Cordis configuration](integrations/dsh/cordis.patch.yml) |
| WorkBuddy (macOS) | Reopen WorkBuddy. Task completions are forwarded automatically. When a command triggers WorkBuddy's local security approval, the device prompts you to return to WorkBuddy to confirm. Approval reminders appear under **Notifications**. |

### 4. Handle approvals in the CLI

1. Send a test notification from the bell. To send a sample approval to the bell and any connected boards, run `node ~/.agentreminder/app/host/agentreminder.js test`.
2. Start a new session in your project. To test with Codex CLI, run `codex --sandbox read-only --ask-for-approval on-request` and complete the trust review in `/hooks`. For Claude Code, run `claude --permission-mode default`. Ask the agent to perform a harmless operation that requires permission, such as creating a temporary test file. Operations already allowed by the active policy run directly.
3. Approve or deny from the bell or a board. If you hand the request back to the agent or the wait expires, handle it in the original terminal. The CLI waits for the approval hook before showing its own prompt. Simultaneous prompts are available through Codex Desktop approvals.
4. After the task finishes, look for its completion in the bell's **Notifications**. If Codex cannot start or has no `/hooks` command, check `codex --version` and install a version that supports hooks.

[Codex hooks documentation](https://learn.chatgpt.com/docs/hooks) · [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks)

## Use the bell menu

| Item | What it does |
| --- | --- |
| **Notifications** | Keeps the latest notice per host, project, and conversation with its receipt time. Opening a notice marks it read, and the bell counts unread groups. Dismissing a notice on a board removes it from the bell and other boards. Clearing all notifications from this submenu also syncs. |
| **Pending approvals** | Shows approvals and questions even when the board is offline. Open a card to approve, deny, answer a two-choice question, or hand it back to its agent. With Codex Desktop approvals enabled, settling a request in Codex, the menu, or on a board clears the other copies. **Clear all approvals and notifications** hands waiting approvals back to their originating clients. |
| **Pair a new device…** | Adds or re-pairs a board over USB. |
| **Install or update firmware…** | Installs the bundled firmware for the selected model. Keep USB connected while writing. Paired boards reconnect after restarting. |
| **Send test notification** | Checks delivery to the menu and local devices. |
| **Tailnet service** | **Initialize** creates and copies a new group key. **Join Tailnet service** uses an existing group key. **View shared key** displays or copies the saved key. |
| **Agent integrations** | Shows the status of Codex CLI, Codex Desktop approvals, Claude Code CLI, dsh, and WorkBuddy. Each integration can be enabled or disabled independently. Codex Desktop changes apply after reopening ChatGPT. |
| **Launch at login** | Appears as AgentReminder in macOS Login Items & Extensions. It starts the bell and local service, and restores the Codex Dock configuration when enabled. |
| **Prevent idle sleep** | Defaults to on when the macOS service starts and keeps the system awake while the Mac is locked or the display is off. Turning it off is remembered across restarts. |
| **Check for updates…** | Checks GitHub `main` for a newer version. Choose **Install update** to install it and reopen the bell while retaining pairings, Tailnet settings, and hooks. |

The board shows one approval at a time with a five-minute default deadline. For a question with two preset answers, use the indicated buttons. Return to the original conversation for extra choices, text input, or authentication. Press **PWR** briefly on Waveshare or the bottom function button on Passport in portrait orientation to hand a question back.

Synced dismissal requires host 0.5.11, Waveshare firmware 0.3.17, and Passport firmware 0.3.21 or later. It also works across hosts with the Tailnet service enabled.

Starting with host 0.5.13, a board reconnecting over Bluetooth receives any approvals still pending and up to 20 of the latest unread notifications from the local bell. Replayed cards keep their original receipt time. The host skips read, dismissed, and superseded notifications and settled approvals. For a paired board with compatible firmware, updating the host software enables this feature.

Turning off **Prevent idle sleep** or stopping the host service releases the sleep assertion. macOS still manages lid closure, manual sleep, and low battery. To turn it off on a headless Mac, set `"preventIdleSleep": false` in `~/.agentreminder/config.json` and restart the service.

Press **Control–Command–Q** to lock the screen while keeping the menu and agents in your signed-in session. **Shift–Command–Q** signs you out and closes the menu bar app. **Prevent idle sleep** only controls idle sleep. At the next login, **Launch at login** reopens the bell if macOS has granted permission. If the receiving host was offline when an approval was sent, check the originating agent for it. [Apple keyboard shortcuts](https://support.apple.com/102650)

Connect only one board when flashing. When the Waveshare USB port is missing, hold **BOOT/−** while plugging in USB, then release it. Back up your Passport before its first flash. The flasher checks the existing partition layout and installs esptool when needed. [Waveshare flashing guide](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-2.16/Instructions-For-Use) · [Passport backup and recovery](firmware/release/folotoy-ai-passport/README.md#安装与恢复)

## Board controls

On Waveshare, the idle screen shows the host, Bluetooth, and USB status. In the notification view, press left for the preceding card, center to clear, and right for the next card. Touch controls do the same. On the idle or notification screen, hold right to toggle sound or hold left to rotate. Both settings survive a restart. On an approval, hold left to scroll or hold right to rotate. Short presses deny on left, hand back on center, and approve on right. Button positions refer to USB facing down. [Waveshare firmware guide](firmware/release/waveshare-amoled-2.16/README.md) · [Passport controls](firmware/release/folotoy-ai-passport/README.md)

## Update or uninstall

- **Update the Mac app and hooks**. Choose **Check for updates…** in the bell or rerun the installer. Updates retain pairings, Tailnet settings, and an explicitly saved sleep preference. Add `--skip-hooks --no-pair` when running the installer to update just the app and host components. Reopen an agent after updating its hooks. Add `--no-autostart` to skip registering launch at login.
- **Update board firmware**. Use **Install or update firmware…** from the bell.
- **Uninstall**. Run `bash ~/.agentreminder/app/uninstall.sh --lang en` to remove the app, host software, and installer-managed hooks while retaining pairings, logs, and unrelated hooks.

## Linux, SSH, and command line

On Linux, run the same installer and connect by USB. Use `--no-menu-bar` for a headless macOS installation. For a remote host that only forwards hooks, use `--no-menu-bar --no-pair`. [SSH setup](docs/protocol.md#ssh-远程-agent)

- Use `node ~/.agentreminder/app/host/agentreminder.js pair` to pair manually over USB.
- Use `node ~/.agentreminder/app/host/agentreminder.js status` to check connections. To change the approval wait, set `approvalTimeoutSec` in `~/.agentreminder/config.json`, rerun the installer for your agent, and reopen it.
- From a checkout, run `bash flash.sh` for Waveshare or `bash flash.sh --board folotoy-passport` for Passport. Use `--check` to verify the images or `--port DEVICE` to select a specific serial port.

## Multiple computers and devices

Connect the Macs to the same Tailnet.

1. On the first Mac, choose **Tailnet service → Initialize**. AgentReminder creates and saves a shared key and copies it to the clipboard.
2. On each other Mac, choose **Tailnet service → Join Tailnet service** and paste the same key.
3. On any configured Mac, choose **Tailnet service → View shared key** to display or copy the key again. Initialize and Join are disabled once you have a group.

Run `bash install.sh --init-tailnet` to open initialization during installation. When installing from GitHub, append `--init-tailnet` to the line that runs the downloaded script. This option requires the macOS menu bar app version 0.5.8 or later. On a configured Mac, it opens the saved key.

Tailscale discovers computer addresses automatically. The service authenticates peers with the shared key before forwarding cards. Allow TCP port `47323` between group members. Enabling the Tailnet service from the menu keeps existing notifications, approvals, and device pairings. [Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli)

### Headless hosts

A computer that only sends events can install with `--no-menu-bar --no-pair` and start the service separately.

Merge the following into each computer's `~/.agentreminder/config.json`, keeping existing pairing settings. Use the same key on each member. The daemon uses `tailscale status --json` to discover its local address and online peers every 10 seconds. Adding a computer requires no edits on existing members.

```json
{
  "tailnet": {
    "enabled": true,
    "key": "replace-with-the-same-64-lowercase-hex-characters-on-each-computer"
  }
}
```

Generate one key with `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. Share it privately and set the config file's permissions to `600`. The daemon verifies that a peer holds the key before sending a card. To migrate from manual configuration, remove `listen` and `peers` together, then restart.

Run the following after configuring the service manually. When `tailnet.listening` is true, use `node ~/.agentreminder/app/host/agentreminder.js test` on any member to send sample cards.

```bash
node ~/.agentreminder/app/host/agentreminder.js stop
node ~/.agentreminder/app/host/agentreminder.js start
node ~/.agentreminder/app/host/agentreminder.js status
```

The service broadcasts supported notifications, approvals, and questions to online members. Each Mac's bell and its paired boards can receive them, and the originating computer can have no device. The first valid response to reach the origin wins and clears the other copies. **Continue on computer** hands the request back to the original conversation. Bluetooth reconnect can replay cards already received by the local host. Events missed while a Tailnet host is offline are skipped. Each computer can pair with multiple boards.

## Development

Run `node --test host/test/*.test.js`. Build Waveshare firmware with `pio run -d firmware` and regenerate Passport binaries and checksums with `bash firmware/build-passport.sh`. [Protocol and remote integration](docs/protocol.md)
