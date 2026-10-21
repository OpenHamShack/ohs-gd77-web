# GD-77 & OpenGD77 Codeplug Programmer (web)

A browser-based CPS. It reads, edits and writes the codeplug of:

- a **Radioddity GD-77 on the stock firmware** over USB HID (WebHID; the
  radio must identify as `MD-760P`, so the RD-5R and DM-1801 that share its
  USB IDs are refused);
- **any radio running OpenGD77** over USB serial (Web Serial): the MK22
  family (GD-77, GD-77S, DM-1801, RD-5R, DM-1801A) and the STM32 family
  (MD-UV380/RT3S, MD-380, DM-1701, MD-2017, MD-9600). The radio's own
  firmware-info reply picks the memory layout; a codeplug or backup for one
  family is refused on the other.

Which connect button finds the radio tells the page which firmware it runs.
It edits general settings, channels (1024, in banks), zones, contacts, RX
group lists, scan lists (stock only) and DTMF contacts, with OpenGD77 extras
(power 0-10, per-channel squelch, scan skips). Anything not decoded is kept
byte for byte: the codec writes only the fields you changed into a copy of
the bytes that were read.

Files: a 128 KiB `.g77` (Radioddity or OpenGD77 CPS) or dmrconfig `.img`
opens with its layout detected from the content - stock firmware 3/4, stock
firmware 2.x (read and saved, not written), or OpenGD77 - and any GD-77
codeplug can be saved as `.g77`. Otherwise the stock firmware uses dmrconfig's 128 KiB `.img`; OpenGD77 uses
ReallyOpenGD77 WebCPSd's `.gd77backup` JSON, so backups move between the two
tools. Channels and contacts import/export as CSV (CHIRP's channel columns
plus DMR columns).

It needs desktop Chrome or Edge (WebHID / Web Serial) and is plain static
files: no build step, no external assets, relative URLs only.

## Writing is experimental

**Writing has only been tested against the built-in simulated radios, never a
real GD-77.** The page guards it:

- Write stays disabled until a complete read of the connected radio in this
  session has succeeded and been downloaded as a timestamped backup file.
  Reconnecting, unplugging or a failed write closes the gate again.
- Only 32-byte blocks (stock, OpenGD77 EEPROM) or 4 KiB flash sectors
  (OpenGD77) that differ from that read are written.
- Writes are never retried. The first unacknowledged block stops the
  transfer; ENDW (stock) or CLOSE_CPS (OpenGD77) is still sent, and a dialog
  explains recovery: power-cycle, reconnect, read, then write the backup back.

## Firmware tab (MD-UV380 / RT3S, MD-9600, MD-2017)

Flashes stock TYT firmware, or OpenGD77 with the AMBE codec merged in, over
WebUSB to the radio's bootloader (0483:df11). The user supplies every file:
a TYT file for the radio (stock), or the OpenGD77 build, the MD-9600 V26.45
codec donor and a TYT file for the radio (OpenGD77 - the radio's file gives
its encryption key, which differs from the donor's). Keys are recovered from
those files at run time; none is shipped. The whole flash is planned and
checked before connecting, the bootloader's own model string must match,
GPS/non-GPS must be confirmed for stock files, nothing below 0x0800C000 is
ever erased, and the 0x00060000 segment of stock files is listed as not
written. **Untested on a real radio**; `?sim=uv380dfu` simulates the
bootloader. Details and corrections to the research: `docs/firmware.md`.

## Diagnostic reports

After a read, in the read/write error dialog and under Help, the page offers
"Send diagnostic report". It shows the whole report first (browser, USB
device, what the radio said, the log, the last 200 raw USB exchanges, the
error, and the full codeplug) and sends it only when the user clicks Send;
"Download instead" saves the same JSON. Reports from a simulator are marked
simulated. The endpoint is `server/gd77-report.php`; deployment, config and
API are in `server/README.md`. On shack, `tools/fetch-reports.sh` (hourly,
via `tools/systemd/`) fetches new reports and notifies once per report.

## Run locally

    python3 -m http.server 8000
    # open http://localhost:8000/        (real radio)
    # open http://localhost:8000/?sim=stock, opengd77, uv380 or uv380dfu   (simulators)

WebHID and Web Serial need a secure context; `localhost` counts. On Linux the
user needs access to the device nodes (udev rules for `15a2:0073` hidraw and
`1fc9:0094` ttyACM).

## Test

    tools/test.sh               # node tests + headless Chromium check
    tools/dev-server.sh ~/build/gd77-dev 8000   # page + report endpoint as deployed
                                                # (PHP 8.3 container), at /gd77/
    tools/test.sh --no-browser  # node tests only
    SHOTS=~/build/shots tools/test.sh   # also save light/dark screenshots

- `tests/codec.test.mjs`: decode/encode round trips, edits landing at the
  addresses the reference sources give (as literals), unmodelled bytes
  surviving, files and CSV.
- `tests/session.test.mjs`: full connect/read/edit/write sessions through the
  real transports against the simulated radios (`js/sim/`), which implement
  the radio side byte for byte and record protocol violations; fault cases
  (NAKed and silent writes, dropped replies, stray bytes, wrong models, the
  OpenGD77 post-DTR settle time).
- `tools/browser-test.sh`: loads the page with `?sim=…&selftest`, which
  clicks through connect, read, edits, the write dialog and verifies the
  simulated radio's memory, failing on any console error.

## Reading a real radio from the command line

    node tools/real-read.mjs            # the one OpenGD77 radio in /dev/serial/by-id
    node tools/real-read.mjs --sim      # rehearse against the simulated MD-UV380

Read-only by construction: `js/radio/readonly-guard.js` refuses every frame
that is not a read or a screen/LED command (including the radio's own
SAVE_SETTINGS_AND_VFOS unless `--save-settings`), and `tools/serial-bridge.py`
(run with `sudo -n`, for users not in `dialout`) only opens an OpenGD77
`/dev/serial/by-id` link. The image and a `.gd77backup` go to
`~/build/<model>-read/` (mode 0600; never commit them) and a decode summary
with sanity checks is printed.

**Verified on hardware (21/10/2026):** a full read of a TYT MD-UV380 on
OpenGD77 (firmware 5797626) with this tool, decoding cleanly; it settled
contact DMR IDs as big-endian BCD. See docs/protocol.md.

## Not verified on real hardware

See `docs/protocol.md` ("Corrections found while implementing" and "Open
risks"). In short: every write path, on every radio (including partial
flash-sector writes on the STM32 family); any stock-firmware radio at all;
any MK22 OpenGD77 radio; whether the stock radio's HID
descriptor uses numbered reports (detected at runtime); whether stock read
replies echo the request in their 4 undocumented header bytes (detected at
runtime); identify-then-ENDR at connect on the stock radio; whether OpenGD77
needs SAVE_SETTINGS_NOT_VFOS after a write (qdmr sends it, WebCPSd does not;
we follow WebCPSd); stock group-list count 64 (qdmr) vs 76 (dmrconfig).

## Sources and licences

Protocol facts from dmrconfig and qdmr (used as references, no code copied)
and ReallyOpenGD77 WebCPSd (MIT, © 2026 Chip Cuccio W0CHP), whose serial
transport mitigations are adapted in `js/radio/opengd77-serial.js` with its
notice kept there.
