# Current Sprint

- Ship a host and firmware installer that uses the same Git commit for both.
- Verify the five-minute approval deadline, physical device queue and source metadata.
- Keep one local daemon. Use a CoreBluetooth helper only for a paired macOS device and the Codex bridge only for the desktop session.
- Provide Chinese and English setup and removal instructions.
- Route supported human-input events to the shared device queue with an explicit desktop handoff.

USB and macOS Bluetooth have passed a physical device round trip. Codex desktop command approvals, physical queue counts, two-choice rendering and desktop handoff have been exercised. A logged-in Claude session, a real dsh profile, Linux hardware, and managed cloud approvals remain outside the verified matrix.

Host v0.4.4 and firmware v0.3.5 add receipt times and group completion cards
by host, project, and conversation. The new firmware was flashed and connected
over USB and Bluetooth. Visual layout and physical controls in this build
still await manual confirmation.

The multi-host branch adds automatic Tailnet discovery and peer fan-out to the
daemon. Integration tests cover three daemons with simulated device links.
Two Macs discovered each other without configured addresses and sent a test
notification and approval to physical devices over USB and Bluetooth. Approving
on the USB device cleared the same card on the Bluetooth device, as confirmed
on its screen.

The macOS installer places the signed bundle in the user’s Applications folder
and opens it through Launch Services. The bell starts or connects to the local
daemon. The menu offers a local test notification and optional Codex Desktop
approval setup. On a Mac with two
paired boards, the menu showed two unread notifications and one pending
approval. Opening a notification reduced the unread count to one, and settling
the approval on a board cleared the pending count. Re-pairing the Waveshare
through the menu saved its new key and authenticated a Bluetooth reconnect. The
Passport enrollment was retained.

Menu bar v0.5.2 was installed and tested on the Mac. The completion entry showed
the host, project, conversation, and completion status. Clearing only
notifications left the pending approval in place. Clearing both reset the two
counts, withdrew the card from the physical device, and returned the approval
to its originating client.

The menu notification list retains the latest entry and receipt time per host,
project, and conversation. Unread counts and clear actions use the displayed
entries. Clearing an older snapshot cannot clear a replacement notification.

The menu bar uses one entry for firmware setup and updates. Waveshare can be
flashed before it can pair, while Passport requires its compatible factory
partition layout. The installer verifies both firmware sets. The daemon keeps
its inbox and releases the USB port until the flasher exits.

See [Chinese setup](../README.md), [English setup](../README.en.md), [protocol](protocol.md), and [progress](progress.md).

The FoloToy branch adds AI Passport community-play and application-only images.
On a Passport with identities and assets adjacent to the factory app, the
application-only install kept the original partition table, NVS and assets
byte-for-byte before boot. The board booted, passed its font self-test and
accepted USB traffic. Passport firmware v0.3.6 puts key hints along the right
edge at the three side-key positions. The layout coordinates were checked with
LVGL and the new firmware passed its USB handshake. The center side key
confirmed USB enrollment. With USB disabled in the test daemon, the Passport
reconnected over Bluetooth after a daemon restart, returned an approval
and displayed the completion notice.
See [FoloToy feasibility](folotoy-feasibility.md).

Passport v0.3.13 adds a short doorbell chime for new cards with steady screen brightness.
Holding the lower right button on the idle or notification screen toggles the chime
and saves the setting to device storage.

Passport v0.3.14 adds landscape. Holding the middle button rotates the current
screen. Landscape puts the three action labels along the top edge, and the
selected orientation is saved on the device. On the Passport, the landscape
approval labels lined up with the physical buttons and a short middle press
approved the test card. After a restart, USB and Bluetooth reported landscape.

Passport v0.3.15 uses the landscape idle screen width for the host and parallel
Bluetooth and USB status. Its two-note alert is about 0.1 seconds long.

Passport v0.3.16 displays sound state on the landscape idle and notification
screens. A silent playback test was clean. On the device, the former
98 ms tone took 638 ms to synthesize and feed through I2S. The new 72 ms single
tone is synthesized before I2S starts, and its peak PCM level is 3 dB higher
than the single-tone sample played during the audition.

Passport v0.3.17 places sound state below the two connection indicators on the
landscape idle screen and moves the content up to keep the final line visible.
The device reported 87 ms for PCM output including the drain wait. The listener
confirmed both a complete status line and clean sound.

Passport v0.3.18 centers the landscape idle footer and raises the alert's PCM
level by 6 dB while retaining headroom.

Passport v0.3.19 aligns the landscape idle footer with the host name at the left.

Passport v0.3.20 gives the host and project separate full-width lines on
landscape cards.

The installer accepts `--flash --board folotoy-passport`. It stages the Passport
package from the same revision as the host, validates the existing partition
layout, and writes only the factory application. Uninstall removes the staged
images and keeps pairing data.

Host v0.4.5 keeps multiple enrollments in one daemon. Automated tests cover
two paired boards receiving the same message and the first decision clearing
both cards. Passport has also reconnected to this version of the main daemon.

Waveshare uses the shared ES8311 chime for new cards and controls its
onboard speaker amplifier during playback. The listener heard v0.3.7 in an
isolated USB test. Waveshare v0.3.8 keeps the 80 ms amplifier wake delay and
uses a quieter 140 ms cue with a gentler envelope. The board reconnected over
USB and Bluetooth and reported playback for both isolated USB test cards.
Waveshare v0.3.9 lowers the PCM peak by about 3 dB while retaining the cue
length and envelope. It was flashed and logged one isolated USB playback.
Waveshare v0.3.10 halves the PCM amplitude again and passes an isolated USB
playback test.
Waveshare v0.3.12 uses two 40 ms tones separated by 120 ms. The first tone
starts after 70 ms of silence following DAC unmute. The listener heard both
tones during an isolated USB test.
Waveshare v0.3.13 reduces each tone to 30 ms and its PCM peak by about 2 dB.
An isolated USB test logged playback on the board.
Waveshare v0.3.15 reduces the PCM peak to 1500 after a further volume
reduction, keeps the two 30 ms tones and passes an isolated USB playback test.
The listener approved this cue after a Waveshare-only replay.

Waveshare v0.3.16 shares the Passport-style idle view, one-card notification
paging and approval reading behavior. The Waveshare touch controls and
physical keys support muting, and the device stores the sound and orientation
settings. The host suite, both firmware builds and the package checks pass.
A headless LVGL check verified paging, mute, rotation and rotated touch hit
testing. On the Waveshare board, the listener confirmed the Passport-style
idle layout and physical paging and clearing. After a single touchscreen tap
to mute, a device reboot preserved the setting. Two test notifications and
one approval rendered without an audible cue.
