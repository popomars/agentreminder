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
