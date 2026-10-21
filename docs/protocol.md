# GD-77 CPS protocol reference (stock HID + OpenGD77 serial)

Sources used (all fetched via HTTPS raw/tarball, since `git clone` to github.com was blocked in this sandbox — HTTPS GET worked fine):

- **dmrconfig** (OpenRTX fork, master branch, fetched via raw.githubusercontent.com 2026-10-21): `gd77.c`, `hid.c`, `hid-libusb.c`, `radio.c`, `main.c`. Authoritative for the **stock Radioddity HID protocol** and the shared memory map as the stock firmware sees it.
- **qdmr** (`github.com/hmatuschek/qdmr`, cloned `--depth 1`, commit at HEAD 2026-10-21): `lib/opengd77_interface.{cc,hh}`, `lib/radioddity_codeplug.*`, `lib/gd77_codeplug.*`, `lib/opengd77_codeplug.*`, plus its pre-rendered byte-diagrams under `doc/code/*.txt`. Authoritative, GPL-licensed, cross-checked against real hardware by the qdmr author.
- **ReallyOpenGD77 WebCPSd** (`https://repo.w0chp.net/Chipster/ReallyOpenGD77-WebCPSd`, MIT, fetched via tarball) — a **working browser-based CPS for OpenGD77 radios already in production** (`frontend/js/app.js`, `backend/main.py`). This is extremely close prior art for exactly this task: WebUSB *and* Web Serial, `'C'/'R'/'W'` framing, full codec. Its own comments cite qdmr as the reverse-engineering reference. I did not find a current, cloneable `OpenGD77CPS` C# repo — the original `rogerclarkmelbourne/OpenGD77CPS` and `rogerclarkmelbourne/OpenGD77` repos are **both deleted** (404 confirmed via GitHub API); only unofficial preservation forks remain (e.g. `open-ham/OpenGD77`, `handeng/OpenGD77`), which I did not fetch — the WebCPSd + qdmr combination gave complete, cross-checked answers to every question the brief asks, and its decode/encode arithmetic is directly reusable JS.

---

## Corrections found while implementing (source wins)

Checked against the source trees while building the CPS (October 2026). Where
this list and the sections below disagree, this list is right, and the code
in `js/codeplug/layouts.js` follows it.

1. **HID framing / report IDs.** dmrconfig's libusb path sends Set_Report with
   report ID 0 and puts `01 00 len len` *in the data*; its Windows and macOS
   paths hand the same 42 bytes to the OS, where byte 0 is the report ID. So
   whether `01`/`03` are report IDs depends on the device's HID descriptor.
   The page reads `device.collections` and sends `sendReport(1, 41 bytes)` or
   `sendReport(0, 42 bytes)` accordingly. Unverified which the real radio uses.
2. **Stock read reply** is 36 payload bytes: 4 undocumented bytes, then the 32
   data bytes (`hid_send_recv` strips only the 4 framing bytes). The page uses
   those 4 bytes as a late-reply check only if the first read shows they echo
   the request.
3. **Stock wire range:** qdmr (fw 4.03.06) reads `0x00080-0x07c00` and
   `0x08000-0x1eb00`. dmrconfig stops at `0x1e2a0`, which truncates the RX
   group list table; the page uses qdmr's range, and when writing a dmrconfig
   `.img` it takes `0x1e2a0-0x1eb00` from the radio's own read.
4. **Stock RX group lists: 64** (qdmr `GD77Codeplug::GroupListBankElement`,
   0x80 header + 64 x 0x50), not 76 (dmrconfig). 76 is OpenGD77's count.
5. **Stock zones: 250 x 16 members** in qdmr's code; its GD-77 header comment
   "68 zones of 80 channels" is copied from OpenGD77.
6. **Stock channel bytes 0x24-0x2b** (dmrconfig struct and qdmr Offset agree):
   0x25 TX DTMF system, 0x27 RX DTMF system, 0x28 unused (0x16), 0x29 privacy
   group, 0x2a TX colour code, 0x2b RX group list. §3.3 had these shifted.
7. **OpenGD77 channel layout differs more than §3.3 says** (qdmr
   `opengd77base_codeplug.hh`, matched by WebCPSd): 0x19 power 0-10; 0x1a,
   0x1c-0x1f, 0x24 fixed-position lat/lon (no TOT rekey, admit or scan list);
   0x26 flags (b2 simplex, b3 fixed location, b5 no power save, b6 no beep,
   b7 DMR ID override); 0x27-0x29 24-bit BE per-channel DMR ID; **0x2b RX group
   list (same as stock, not 0x28)**; 0x2c single colour code; 0x2d APRS index;
   0x30 talker-alias bits; 0x33 b4 skip-all, b5 skip-zone; 0x37 squelch
   (0 global, 1 open, 15 closed).
8. **Contact DMR ID is big-endian BCD on both firmwares**: qdmr's code uses
   `getBCD8_be` in both ContactElement classes, dmrconfig's `GET_ID` and
   WebCPSd agree. Only qdmr's `gd77_contact.txt` diagram says little-endian.
   (Open risk 2 resolved by source; still worth one real-radio check.)
9. **Scan list flag byte 0x0f:** PL type is bits 5-6 (dmrconfig, qdmr diagram);
   qdmr's code reads it at bit 6, overlapping talkback (bit 7). Scan-list
   members and priority/TX channels are channel number + 1 (1 = selected
   channel); zone members are the plain channel number.
10. **OpenGD77 scan lists** are not modelled by qdmr; WebCPSd decodes them with
    a bitmap header and slot+1 members, inconsistent with stock. Not exposed;
    the bytes are left alone.
11. **OpenGD77 DTMF contacts: 32.** qdmr says 64, but 64 x 0x20 from 0x2f88
    would overrun channel bank 0 at 0x3780.
12. **Stock general settings** bit positions are taken from qdmr's code
    (`RadioddityCodeplug::GeneralSettingsElement`), which differs from its
    diagram in places (e.g. byte 0x1a). Stock per-channel squelch (0x33 b0)
    is not exposed: dmrconfig says 0 = tight, qdmr says 1 = tight.
13. **After a stock read** qdmr sends ENDR (dmrconfig has it commented out);
    the page sends it. **After an OpenGD77 write** qdmr also sends
    SAVE_SETTINGS_NOT_VFOS; WebCPSd sends only CLOSE_CPS; the page follows
    WebCPSd. Neither confirmed on hardware here.

14. **All OpenGD77 radios are accepted** (Brian, 21/10/2026). qdmr's
    `OpenGD77Interface::identifier()` maps radioType 0-4 (GD-77, GD-77S,
    DM-1801, RD-5R, DM-1801A) to one OpenGD77 codeplug and 5-10 (MD-9600,
    MD-UV380, MD-380, DM-1701, MD-2017, DM-1701 RGB) to one OpenUV380
    codeplug, so each family shares a layout. STM32 layout per qdmr
    `openuv380_codeplug.hh`: everything in flash; settings, channel bank 0,
    zones, boot text and DTMF at the GD-77 EEPROM addresses; channel banks
    1-7 at 0x9b1b0, contacts 0xa7620, group lists 0xad620, additional
    settings 0x20000. Writes use 'X'. The settings region starts at 0x80,
    mid-sector, so flash sectors only partly covered are staged with just
    the codeplug's blocks; qdmr's writer relies on the firmware loading the
    sector buffer from flash on SET_FLASH_SECTOR (not yet seen on hardware).

## What a real radio showed (MD-UV380 on OpenGD77, 21/10/2026)

One read-only read with `tools/real-read.mjs` (reads and screen commands
only, through `js/radio/readonly-guard.js`):

- READ_FIRMWARE_INFO: struct version 3, radioType 6, git `5797626`, built
  `20260130175517`; 46-byte payload as documented.
- 115200 8N1, DTR+RTS, 400 ms settle, then show CPS screen / clear / text /
  render / green LED - **without SAVE_SETTINGS_AND_VFOS** - read the whole
  codeplug (129760 bytes, 4057 reads of 32 bytes, 4.5 s) with no retries,
  resyncs or length errors, and CLOSE_CPS_SCREEN was acknowledged.
- The STM32 map above decodes cleanly: 161 channels, 13 zones, 25 contacts,
  1 RX group list; every zone and group-list member points at a real
  record; CTCSS tones decode as standard values; channel power 0/1/6/8.
- **Contact DMR IDs are big-endian BCD**, confirmed: talkgroups read as
  91, 2355, 4000, 9990, 23526..23559 and personal IDs as 7-digit numbers,
  all within 24 bits. Read little-endian they would be eight-digit nonsense.
- The general-settings band-limit bytes (0x80-0x87) are all 0xFF on this
  radio, so they are not offered for the STM32 family.
- 13 channels sit at 380.000 MHz with placeholder names ("Channel11") -
  coherent records as stored by whatever CPS made them, not a decode error.

## .g77 files and the stock firmware 2.x layout (21/10/2026)

Worked out from a real .g77 (a friend's GD-77 on stock firmware V2.06.05,
kept outside the repository), dmrconfig `radio.c`/`rd5r.c`, qdmr
`rd5r_codeplug.hh`/`gd77_codeplug.hh` and WebCPSd's `.g77` import.

- **A .g77 is the radio's memory image.** 131072 bytes from address 0,
  block 0 tagged `MD-760P` + 0xFF: the same thing as dmrconfig's .img, with
  every record at the radio's own address. There is no reliable way to tell
  which tool wrote a file and no need to; what matters is which layout the
  bytes follow. The CPS fills the 0x80-0xDF "device info" (band limits as
  BCD, a date, "GD-77", the firmware version at 0xB8, the DSP version at
  0xC0); the OpenGD77 CPS also leaves its "OpenGD77" custom-data block at
  0x1EE60.
- **Stock firmware 2.x uses an older layout** (dmrconfig refuses these as
  "Old Radioddity GD-77 v2.6"): 256 contacts at **0x1788** (24-byte records,
  big-endian BCD IDs, no validity byte - names decide), scan lists at
  **0x17620** (256 valid bytes, 250 lists), zones at 0x8010 but **68 x 80**
  (0xB0 records from 0x8030), RX group lists at 0x1d620 (assumed the
  RD-5R's 64 x 16; the real file had none). Channels, general settings and
  boot text are where firmware 3/4 keeps them. The page detects it from the
  version at 0xB8 (else from where plausible contacts are), reads and saves
  it, and refuses to write it to a radio until the group-list shape is seen.
- **OpenGD77 .g77**: the same 128K over OpenGD77's EEPROM (same addresses)
  plus its flash codeplug shifted down by 0x70000 (WebCPSd
  `G77_FLASH_OFFSET`): bank 1 0x7b1b0 -> 0xb1b0, contacts 0x87620 ->
  0x17620, group lists 0x8d620 -> 0x1d620. The flash satellite block
  (0x0-0x2000) is not in the file. Stock 3/4 and OpenGD77 .g77 files share
  addresses, so the page tells them apart by the channel records: stock
  channels always have 0x50 at 0x1E and 0 at 0x19; OpenGD77 puts power (0-10)
  at 0x19 and position bytes at 0x1E. Ambiguous files are asked about.
- **Correction:** qdmr's GD-77 map table says "68 zones of 80 channels" at
  0x8010 while its code uses 250 x 16. The 2.x file has 68 x 80; firmware
  3/4 is still assumed 250 x 16 (dmrconfig and qdmr's code), unconfirmed on
  a real 3/4 radio.

---

## 1. Stock Radioddity HID protocol

**Transport:** USB HID, vendor VID `0x15a2`, PID `0x0073` (shared with Baofeng RD-5R / DM-1801, which use the same HID chipset/protocol) — `radio.c:101` (`hid_init(0x15a2, 0x0073)`).

Use WebHID (`navigator.hid.requestDevice({filters:[{vendorId:0x15a2, productId:0x0073}]})`). On Linux the dmrconfig reference claims the raw HID interface via libusb `HID Set_Report`/interrupt-IN (`hid-libusb.c`); WebHID exposes the same reports without needing interface claiming.

**HID report framing** (`hid-libusb.c`, function `hid_send_recv`, and `write_read`):
- Fixed-size HID reports of **42 bytes** each way.
- **Output report** (host→radio): byte 0 = report ID `0x01`; byte 1 = `0x00`; bytes 2–3 = payload length, **little-endian** 16-bit; bytes 4..4+len-1 = payload; remaining bytes zero-padded to 42.
- **Input report** (radio→host): byte 0 = report ID `0x03` (fixed); byte 1 = `0x00` (fixed); byte 2 = reply payload length; byte 3 = `0x00` (fixed); bytes 4..4+len-1 = payload.
- The code asserts `reply[0]==3 && reply[1]==0 && reply[3]==0` and `reply[2]==rlength` — any deviation is treated as a fatal protocol error (`hid-libusb.c`, `hid_send_recv`).
- Transport uses HID **Set_Report** (class request `0x09`, report type `Output`=`0x02<<8`) for the OUT direction and an **interrupt IN** transfer for the response, with a 500 ms timeout and retry-on-timeout loop (`hid-libusb.c:TIMEOUT_MSEC`, `write_read`). WebHID's `sendReport`/`oninputreport` model maps onto this directly: reportId 1 to send, reportId 3 arriving is the response.

**Handshake / "PROGRAM" sequence** (`hid.c`, `hid_identify`):
1. Host sends `"\x02PROGRA"` (7 bytes, `CMD_PRG`). Radio must reply with a single ACK byte `'A'` (`0x41`). Mismatch → abort.
2. Host sends `"M\x02"` (2 bytes, `CMD_PRG2`). Radio replies with **16 bytes** containing the identification string, e.g. `42 46 2d 35 52 ff ff ff 56 32 31 30 00 04 80 04` → `"BF-5R"` + version info, `0xff`-terminated ASCII (`hid.c` comment). For the GD-77 this string is expected to resolve to `"MD-760P"` (see `radio.c:49`, table entry `{"MD-760P", &radio_gd77}`) — **the radio identifies itself as "MD-760P" even though it's sold as GD-77**; this is the firmware-internal model name dmrconfig matches against, not the retail name.
3. Host sends ACK byte `'A'` (`CMD_ACK`, 1 byte). Radio replies with 1 ACK byte; mismatch → abort.
4. Programming session is now open. Reads/writes may proceed.

**Addressing / bank-switch quirk** (`hid.c`, `hid_read_block`/`hid_write_block`):
The radio's address space is split at `0x10000`. Before the *first* access below `0x10000`, or whenever switching from the high half back to the low half, the host must send `CMD_CWB0 = "CWB\x04\x00\x00\x00\x00"` (8 bytes) and expect a 1-byte ACK. Before the first access at/above `0x10000`, send `CMD_CWB1 = "CWB\x04\x00\x01\x00\x00"` (8 bytes), same ACK. A static `offset` variable tracks which half is "selected" so this bank-switch command is only sent on a transition — **sending reads/writes across the 0x10000 boundary without this switch will desync the radio.**

**Block read** (`hid.c`, `hid_read_block`):
- Request: `'R'` (`0x52`) + addr-high-byte + addr-low-byte + length(`0x20`=32) — 4 bytes. Note: only the low 16 bits of the address are sent (1 byte high, 1 byte low) — addressing within each 64 KB half is 16-bit; the half itself is selected by the CWB0/CWB1 command above, not encoded in this request.
- Response: 32+4=36-byte reply; the 32 bytes of data start at reply offset 4 (the leading 4 bytes echo back report framing handled already by `hid_send_recv`, so the caller just takes `reply+4`).
- Reads are issued in fixed 32-byte chunks; a "block" in dmrconfig's own terms is **128 bytes** = 4 chunks of 32 (see `gd77_download`, `nbytes=128`).

**Block write** (`hid.c`, `hid_write_block`):
- Request: `'W'` (`0x57`) + addr-high + addr-low + length(`0x20`) + 32 bytes of data = 36 bytes.
- Response: 1-byte ACK, must equal `'A'` (`0x41`); any mismatch is fatal (`exit(-1)` in the reference tool — the builder should surface this as a recoverable error, not crash the browser tab, but **must stop the write and not continue to the next block**, since a radio that stops ACKing is in an unknown state).
- Also issued in 32-byte sub-chunks per 128-byte logical block (`gd77_upload`).

**End-of-session commands** (`hid.c`):
- After a read pass: `CMD_ENDR = "ENDR"` (4 bytes), expect 1-byte ACK. (Note: `gd77_download()` in `gd77.c:358` actually has this call **commented out** — `//hid_read_finish();` — meaning the reference tool does *not* currently send `ENDR` after a read on the GD-77 path; only after a write. Treat ENDR as optional/best-effort for a read-only session, but still send it in a correctly-implemented client since other radios in the same family *do* rely on it.)
- After a write pass: `CMD_ENDW = "ENDW"` (4 bytes), expect 1-byte ACK. This **is** called unconditionally at the end of `gd77_upload` (`gd77.c:398-399`, via `hid_write_finish()`), and should be treated as mandatory — it is what returns the radio to normal operating mode after a write.
- `radio_disconnect()` (`radio.c:67`) also calls `dfu_reboot()` for the DFU-based radios, but for the GD-77/RD-5R/DM-1801 HID family there is **no explicit reboot command** in the reference code — the radio apparently returns to normal mode on its own once `ENDW`/`ENDR` is acknowledged and the HID session is released. **Unconfirmed**: whether the physical radio needs a manual power-cycle after a WebHID session simply closes without `ENDR`/`ENDW` (e.g. a crashed tab). Treat an unclean disconnect as a "may need power-cycle" case in the UI, matching the OpenGD77 side's documented recovery story (see §2).

**Memory range actually read/written** (`gd77.c`, `download()`/`gd77_upload()`, `gd77.c:335-399`):
- Total logical image size `MEMSZ = 0x20000` (131072 bytes), held in a shared 2 MB `radio_mem[]` buffer (`radio.c:60`) also used by every other supported radio — only the first `MEMSZ` bytes are meaningful for the GD-77.
- Blocks are 128 bytes; block numbers `bno = 1 .. 965` are read/written, i.e. byte range `0x80` through `0x1e29f` inclusive. **Block 0 (bytes 0x00–0x7f) is never touched on the wire** — it's a synthetic header the *tool* fills in afterwards.
- **Blocks 248–255 inclusive are explicitly skipped** (`if (bno >= 248 && bno < 256) continue;`), i.e. byte range `0x7c00`–`0x7fff` is never read or written over HID at all. After `download()`, dmrconfig memsets that same range to `0xff` in its in-memory image (`gd77.c:363`, `memset(&radio_mem[248*128], 0xff, 8*128)`) — so in a saved `.img` file this range is always `0xff`, not real radio content. **This is a "do not touch" gap — do not assume anything you read there reflects the radio.**
- After download, bytes `0x1e2a0` through `MEMSZ-1` (`966*128` to `0x1fffff`→i.e. `0x20000`) are zero/0xff-filled by the tool, not read from the radio (`gd77.c:364`).
- Before download, block 0 (bytes 0–127) is forced to `0xff` then the string `"MD-760P"` (no NUL, 7 bytes) is written into the first 7 bytes (`gd77.c:gd77_download`, line ~367) — this is purely a file-format tag for the tool's own compatibility check (`gd77_is_compatible`, `gd77.c:402-405`: `strncmp("MD-760P", &radio_mem[0], 7)==0`), **it is never sent to the radio**.

**Quirks / anything that can brick, per the reference tool's own behaviour:**
- Any ACK mismatch during read/write is treated by dmrconfig as fatal and it calls `exit(-1)` immediately, mid-transfer, with no attempt to leave the radio in a clean state. A browser implementation must not do this — it should abort the write cleanly and tell the user the radio needs checking/power-cycling, since the radio's own “programming” firmware state is unknown at that point.
- Writing an **incompatible image is explicitly guarded against** (`gd77_is_compatible`, `radio.c` `radio_upload`): the tool refuses to upload unless the in-memory image's first 7 bytes are exactly `"MD-760P"`. A web CPS reading its own structured codeplug and re-serialising to this exact byte layout does not need this tag at all (it's a dmrconfig file-format artefact, not a radio requirement) — but if you support importing dmrconfig's raw `.img` files, you must check/require it, and importing an `.img` from a *different* dmrconfig-supported radio (e.g. `"BF-5R"`/RD-5R) into a GD-77 write path **must be refused** even though the wire protocol and HID VID/PID are identical, because the detailed channel/zone struct layouts differ subtly between radios in this family (confirmed only for GD-77 vs OpenGD77 here — RD-5R/DM-1801 struct deltas are **unconfirmed**, not researched in this pass).
- The 128-byte "block" used for addressing purposes is **not an atomic erase/program unit** on this radio — unlike the OpenGD77 flash path (§2), there is no sector-erase step anywhere in `gd77.c`/`hid.c`. Each 32-byte chunk write is presumably a direct EEPROM-style write; no evidence of wear-levelling concerns was found, but no sector-erase quirks to worry about either.
- **Unconfirmed / not found in dmrconfig source**: a separate "stock CPS does X around writes" warning (e.g. pre-write validation, checksum). dmrconfig's write path is exactly as described above with nothing beyond blind ACK-checked block writes — there appears to be no checksum field anywhere in the GD-77 memory map that the host must compute and the radio verify. If the real Radioddity-branded Windows CPS does something extra (e.g. a timestamp write, since `OFFSET_TIMESTMP=0x00088` exists in the struct — `gd77.c:48`), dmrconfig does not reproduce it, and I did not find/inspect the Windows CPS binary to confirm — flag this as **unconfirmed** for the builder: consider writing a plausible BCD timestamp to `0x88` (6 bytes, format mirrors the print routine at `gd77.c` `gd77_print_version`: `YYYYMMDDhhmm` as BCD nibbles) on every write, since the stock CPS visibly displays "Last Programmed Date" from that field and a web CPS probably should populate it, but this is not required by the radio's firmware as far as the reference protocol shows.

---

## 2. OpenGD77 serial (USB-CDC) protocol

**Transport:** USB-CDC virtual serial port, fixed VID `0x1fc9` / PID `0x0094` for **every** OpenGD77-firmware radio regardless of underlying MCU family (confirmed in two independent sources: qdmr `lib/opengd77_interface.cc:9-10` `#define USB_VID 0x1fc9` / `#define USB_PID 0x0094`, and ReallyOpenGD77 WebCPSd `app.js:2830-2831`). Use Web Serial (`navigator.serial.requestPort({filters:[{usbVendorId:0x1fc9, usbProductId:0x0094}]})`), since the brief specifies Web Serial for this firmware; WebUSB also works on non-macOS platforms per the WebCPSd implementation but **macOS's built-in AppleUSBCDC driver claims the CDC interface before WebUSB can**, making WebUSB unreliable there — Web Serial is the only portable choice and should be the primary path (`app.js:2763-2770`).

**Line settings:** 115200 baud, 8 data bits, 1 stop bit, no parity (`app.js:3032`, `port.open({baudRate:115200, dataBits:8, stopBits:1, parity:'none'})`). After opening, assert DTR+RTS (`setSignals({dataTerminalReady:true, requestToSend:true})`) and then **wait ~300 ms** before sending anything — confirmed-on-real-hardware comment: hitting the radio with zero delay after DTR-up "reproducibly leaves its firmware stuck answering nothing, forever, until the USB connection itself is reset" (`app.js:2851-2864`). This is a load-bearing timing quirk, not a nicety — implement the delay.

**Message framing** — three request types, one leading type byte each (`qdmr` `lib/opengd77_interface.hh:207-320`, cross-checked against WebCPSd `app.js:3202-3372` and qdmr's own byte-diagrams `doc/code/opengd77_protocol_*.txt`):

| Type byte | Direction | Purpose |
|---|---|---|
| `'R'` (0x52) | host→radio | Read request |
| `'W'` (0x57) MK22 family, `'X'` (0x58) STM32 family | host→radio | Write request (which letter to send is determined from the radio's own reported `radioType`, never guessed/hardcoded — see Firmware-ID below) |
| `'C'` (0x43) | host→radio | Command (CPS screen control, save/reboot options) |
| `'-'` (0x2D) | radio→host | Generic OK/ACK for Command and Write requests |

### Read request/response
Request (8 bytes, `ReadRequest` struct, big-endian per qdmr's own packed struct and byte-diagram `doc/code/opengd77_protocol_read_request.txt`):
```
byte 0:    'R' (0x52)
byte 1:    source — 1=READ_FLASH, 2=READ_EEPROM, 5=READ_MCU_ROM,
                     6=READ_DISPLAY_BUFFER, 7=READ_WAV_BUFFER,
                     8=READ_AMBE_BUFFER, 9=READ_FIRMWARE_INFO
bytes 2-5: address, uint32 **big-endian**
bytes 6-7: length, uint16 **big-endian**
```
(qdmr `opengd77_interface.hh:208-236`, enum at line 211-219; WebCPSd's JS builds the identical byte layout manually, e.g. `app.js:3301-3319`.)

Response:
```
byte 0:    'R' (0x52) echoed
bytes 1-2: length, uint16 big-endian
bytes 3..: `length` bytes of payload (or, for READ_FIRMWARE_INFO, the FirmwareInfo struct below)
```
In practice reads are always issued in 32-byte chunks (`length=0x20` in every call site in WebCPSd), confirmed working end-to-end against real hardware per that app's commit history and comments.

**Firmware-info struct** (`opengd77_radio_info.txt`, `opengd77_interface.hh:239-259`), returned by a `READ_FIRMWARE_INFO` (source=9) request — **little-endian**, unlike the read/write request headers which are big-endian:
```
0x00  uint32 LE   struct version (currently 3)
0x04  uint32 LE   radioType — 0=GD77, 1=GD77S, 2=DM1801, 3=RD5R, 4=DM1801A,
                              5=MD9600, 6=MDUV380, 7=MD380, 8=DM1701, 9=MD2017, 10=DM1701RGB
0x08  16 bytes    firmware git-version string, ASCII (0-padded)
0x18  16 bytes    build date/time, ASCII "YYYYMMDDhhmmss" (0-padded)
0x28  uint32 LE   flash chip serial/part number
0x2c  uint16 LE   feature flags (inverted-display bit, extended-callsign-DB bit, voice-prompt-loaded bit — exact bit numbers not confirmed in the docs pulled; see `FirmwareInfo::featureInvertedDisplay()` etc. in qdmr source for the bit math if needed)
```
**radioType 0–4 (GD77/GD77S/DM1801/RD5R/DM1801A) are the "MK22" family and use write-type `'W'`; radioType 5–10 (MD9600/MDUV380/MD380/DM1701/MD2017/DM1701RGB) are the "STM32" family and use write-type `'X'`.** This byte is determined entirely from the radio's own response, never from a user-selected dropdown — the dropdown in WebCPSd exists only so the model is human-discoverable, with the actual VID/PID filter being the single shared pair above (`app.js:2833-2849`, `app.js:2988-3004`).

### Write requests
Four distinct operations, selected by byte 1 after the `'W'`/`'X'` type byte (`opengd77_interface.hh:275-312`, enum `SET_FLASH_SECTOR=1, WRITE_SECTOR_BUFFER=2, WRITE_FLASH_SECTOR=3, WRITE_EEPROM=4`; the WebCPSd code reproduces these same integer values at `app.js:3339-3371`):

1. **`WRITE_EEPROM` (command=4)** — direct EEPROM write, no erase step needed:
   ```
   byte 0: 'W' or 'X' (per radio family)
   byte 1: 4
   bytes 2-5: address, uint32 BE
   bytes 6-7: length, uint16 BE (always 32 in practice)
   bytes 8..39: 32 bytes of data
   ```
   Response: 2 bytes, must echo back `(type, command)` i.e. `(req[0], req[1])`, else treat as failed write.

2. **`SET_FLASH_SECTOR` (command=1)** — must be sent once before writing any data into a 4096-byte flash sector (flash is sector-erase based, unlike EEPROM):
   ```
   byte 0: 'W'/'X'
   byte 1: 1
   bytes 2-4: sector number = floor(address/4096), 24-bit **big-endian**
   ```
   Response: 2 bytes echoing `(type, command)`.

3. **`WRITE_SECTOR_BUFFER` (command=2)** — stage 32 bytes into the currently-selected sector's write buffer (same header shape as `WRITE_EEPROM` but writes to the flash sector buffer, not EEPROM directly):
   ```
   byte 0: 'W'/'X'
   byte 1: 2
   bytes 2-5: address, uint32 BE
   bytes 6-7: length (32), uint16 BE
   bytes 8..39: 32 bytes of data
   ```
   Response: 2 bytes echoing `(type, command)`.

4. **`WRITE_FLASH_SECTOR` (command=3)** — commits the staged sector buffer to flash (the actual erase+program happens here):
   ```
   byte 0: 'W'/'X'
   byte 1: 3
   (no further payload)
   ```
   Response: 2 bytes echoing `(type, command)`.

**Correct flash-write sequence per sector** (`app.js:3399-3410`, `ogdWriteMap`): for each 4096-byte-aligned sector address within a flash region: `SET_FLASH_SECTOR(sectorAddr)` once → `WRITE_SECTOR_BUFFER` once per 32-byte chunk (128 calls per 4096-byte sector) → `WRITE_FLASH_SECTOR()` once to commit. **EEPROM regions skip the sector dance entirely** and just issue `WRITE_EEPROM` directly per 32-byte chunk (`app.js:3390-3397`).

**Backup-file sector-alignment constraint** (`app.js:3593-3597`): flash segment sizes **must be exact multiples of 4096 bytes**; a partial trailing sector would leave stale data in the last sector's unwritten tail, since erase operates on whole sectors.

### Command requests ('C')
Fixed 23-byte frame (`app.js:3206-3213`, matching qdmr's `CommandRequest` struct and its sub-enum at `opengd77_interface.hh:322-344`):
```
byte 0:  'C' (0x43)
byte 1:  command — 0=SHOW_CPS_SCREEN, 1=CLEAR_SCREEN, 2=DISPLAY, 3=RENDER_CPS,
                    5=CLOSE_CPS_SCREEN, 6=COMMAND  (note: 4 is unused/reserved — not documented anywhere found)
byte 2:  x-coordinate (DISPLAY) or option value (COMMAND)
byte 3:  y-coordinate (DISPLAY)
byte 4:  font (fixed to 3 in WebCPSd — meaning unconfirmed beyond "a valid font index")
byte 5:  alignment
byte 6:  inverted flag
bytes 7-22: message text, 16 bytes ASCII (only relevant to DISPLAY)
```
`COMMAND` (byte1=6) options (byte 2), per `opengd77_interface.hh:335-344`: `0=SAVE_SETTINGS_NOT_VFOS, 1=REBOOT, 2=SAVE_SETTINGS_AND_VFOS, 3=FLASH_GREEN_LED, 4=FLASH_RED_LED, 5=INIT_CODEC, 6=INIT_SOUND, 7=SET_DATETIME, 10=DELAY_10ms` (list truncated at the point captured; there may be more options beyond `DELAY_10ms` — **unconfirmed**, not fully read).

**Enter-CPS-mode sequence actually used by a working CPS** (`app.js:3276-3288`, `ogdEnterCPS`) — necessary before any bulk read/write, and this exact order matters since it's been exercised against real hardware:
1. `SHOW_CPS_SCREEN` (cmd 0)
2. `CLEAR_SCREEN` (cmd 1)
3. `DISPLAY` (cmd 2) three times (y=0/16/32) to paint status text on the radio's own screen — cosmetic, not required by the protocol, but shown here as the known-working pattern.
4. `RENDER_CPS` (cmd 3)
5. `COMMAND` with option `FLASH_GREEN_LED` (reading) or `FLASH_RED_LED` (writing)
6. `COMMAND` with option `SAVE_SETTINGS_AND_VFOS`

**Exit:** `CLOSE_CPS_SCREEN` (cmd 5) — call this unconditionally in a `finally`/error path, not just on success; the WebCPSd code's own hard-won comment: *"a transfer is ever left unanswered... the radio firmware's USB command parser can get permanently stuck... previously the only fix was to physically unplug/replug the radio"* (`app.js:3075-3098`) — this is the single most important operational lesson from this whole codebase. Every read/write/backup/restore path there wraps its body in try/catch and calls a best-effort `ogdExitCPSQuiet()` on failure specifically to avoid leaving the radio showing "Reading/Writing Codeplug" forever.

**Every command/read/write exchange expects an immediate ACK byte `0x2D` ('-')** for Command requests specifically (`ogdSendCommand`, `app.js:3266-3275`); Read/Write responses are self-framed (type byte + length) rather than a separate `-` ack.

**Known transport flakiness and required mitigations** (all drawn from in-code comments describing real failures seen on real hardware — essential for a robust implementation, not optional polish):
- **Never race a bare `reader.read()` against a timeout and discard the loser.** Chrome/Web Serial keeps a "lost" read queued; the next real response can silently satisfy it instead of the next request, corrupting every subsequent read. Fix: one continuous background read loop feeding a shared buffer, with requests polling that buffer instead of calling `read()` per-request (`app.js:2782-2816`, `radioReadChunk`).
- **A stray leftover ACK byte can prepend itself to the next response** (observed on macOS Web Serial as `[0x2D, 0x52, 0x00]` when `0x52` was expected first). Mitigation: a byte-aligned resync that discards up to 4 unexpected bytes looking for the expected marker before giving up (`usbReadByteAligned`, `app.js:3222-3234`).
- **A discarded stray byte can coincidentally resync onto a header that parses as valid but carries a bogus length** (e.g. `52 00 00` instead of the real `52 00 20`) — always validate the returned length against the requested length and treat a mismatch as a desync, not real data (`app.js:3325-3334`).
- **Single exchanges occasionally time out on macOS/Chromium over Web Serial with the link still alive** — wrap every request in a retry (3 attempts, 250 ms backoff), and flush any stale buffered bytes before resending so a late-arriving stale response can't collide with the retry's own response (`ogdRetrying`, `app.js:3246-3265`).
- **On WebUSB specifically**, a single `transferIn()` call returns header+payload together whenever both fit in one USB transfer (confirmed via `usbmon` capture against real hardware) — splitting "read header" and "read payload" into two separate `transferIn()` calls silently drops the payload. Carry any such overflow bytes into the next read instead (`usbReadOverflow`, `app.js:3154-3195`).
- **USB/serial disconnect events must be handled explicitly** (`navigator.usb`'s `disconnect` event / `navigator.serial`'s `disconnect` event) — without a listener, a physical unplug leaves the UI showing "Connected" forever (`app.js:2879-2906`).
- **Manual "Reset USB" recovery**: `USBDevice.reset()` for WebUSB, or close+reopen the port for Web Serial (no bus-reset equivalent exists in the Web Serial API) — both followed by redoing the DTR/RTS + 300 ms settle handshake and re-identifying the radio (`resetRadioConnection`, `app.js:3099-3127`).

### Address ranges per codeplug region (OpenGD77, MK22 family — GD-77/GD-77S/RD-5R/DM-1801/DM-1801A)
All addresses below are the ones sent in Read/Write requests; `bank` = `EEPROM` or `FLASH` per the table (`app.js:150-243`, cross-checked against qdmr's `OpenGD77Codeplug::Offset` constants referenced in the same file's comments):

| Region | Bank | Address | Size |
|---|---|---|---|
| Band limits (UHF min/max, VHF min/max) | EEPROM | `0x000080` | 8 bytes (4×2) |
| General settings: callsign | EEPROM | `0x0000E0` | 8 bytes ASCII, 0xFF-padded |
| General settings: DMR ID | EEPROM | `0x0000E8` | 4 bytes, packed BCD **big-endian** |
| APRS systems (×8) | EEPROM | `0x001588` | 8 × 0x40 = 0x200 bytes |
| Scan lists (×64) + bitmap | EEPROM | `0x001790` | bitmap 0x40 + 64×0x58 |
| DTMF contacts (×32) | EEPROM | `0x002f88` | 32 × 0x20 bytes |
| Channel bank 0 (channels 1-128) | EEPROM | `0x003780` | bitmap 0x10 + 128×0x38 = 0x1c10 |
| Boot settings (text-enable + 2 intro lines) | EEPROM | `0x007518` | 0x48 bytes |
| VFO A | EEPROM | `0x007590` | 0x38 bytes (one channel element) |
| VFO B | EEPROM | `0x0075c8` | 0x38 bytes |
| Zone bank (68 zones) + bitmap | EEPROM | `0x008010` | bitmap 0x20 + 68×0xb0 |
| Channel banks 1-7 (channels 129-1024, 7×128) | **FLASH** | `0x07b1b0` | 7 × 0x1c10 |
| Contacts (1024) | **FLASH** | `0x087620` | 1024 × 0x18 bytes |
| Group lists / "RX group lists" (76) + header | **FLASH** | `0x08d620` | header 0x80 + 76×0x50 |
| Additional-settings TLV block (satellite orbitals, boot melody/images/themes) | **FLASH**, separate segment | `0x000000` | 0x11a0 bytes |

Sector-aligned transfer segments actually used for bulk read/write (`OGD_EEPROM_SEGS`/`OGD_FLASH_SEGS`, `app.js:242-243`):
```
EEPROM segs: { addr: 0x000080, size: 0x05fe0 },  { addr: 0x007500, size: 0x03b00 }
FLASH  segs: { addr: 0x07b000, size: 0x14000 },  { addr: 0x000000, size: 0x2000 }
```
These are rounded to convenient read/write boundaries (and, for flash, to whole 4096-byte sectors) and fully cover every region in the table above.

**STM32 family (MD9600/MDUV380/MD380/DM1701/MD2017/DM1701RGB) address shift** (`applyRadioFamilyMemoryMap`, `app.js:201-219`): this family has no discrete EEPROM chip — the entire `GEN_CALL..ZONE_BANK` region moves into **FLASH at the same addresses**, and everything *after* `ZONE_BANK` additionally shifts **+0x20000**:
```
CH_BANK1    = 0x0009b1b0   (was 0x07b1b0)
CONTACTS    = 0x000a7620   (was 0x087620)
GROUPLISTS  = 0x000ad620   (was 0x08d620)
SATCFG      = 0x00020000   (was 0x000000)
```
This was confirmed (per the code comment) against real UV380/RT3S hardware: reading at the MK22 addresses via the EEPROM bank returned readable-looking data for the first couple of channels (coincidental overlap with flash) then garbage, "because contacts/TG-lists/most channels live 0x20000 further into FLASH than the MK22 offsets point to." **The GD-77/GD-77S are always MK22-family** — this shift only matters if the builder's code is shared with other OpenGD77 radios; for a GD-77-only CPS it can be hardcoded to the MK22 values, but detect-from-`radioType` is strongly recommended anyway since it's nearly free.

**Record sizes / counts (OGD_SZ / OGD_LIM constants, `app.js:220-233`):**
```
CHANNEL=0x38, CH_BANK (incl. bitmap)=0x1c10, CH_BANK_BITMAP=0x10, CH_PER_BANK=128, CH_BANKS=8
ZONE=0xb0, ZONE_BANK_BITMAP=0x20, ZONES=68, ZONE_MEMBERS=80 (channels per zone — extended from stock's 16)
CONTACT=0x18, CONTACTS=1024
GROUPLIST=0x50, GROUPLIST_HDR=0x80, GROUPLISTS=76, GL_CONTACTS=32
APRS_SYSTEM=0x40, APRS_SYSTEMS=8
SCAN_LIST=0x58, SCAN_LIST_BITMAP=0x40, SCAN_LISTS=64, SCAN_MEMBERS=32
DTMF_CONTACT=0x20, DTMF_CONTACTS=32
```

**How the OpenGD77 CPS differs from stock, confirmed in this pass:**
- **Zones: 80 channels/zone vs stock's 16**, but **68 zone slots vs stock's 250** (`OGD_LIM.ZONES=68` vs dmrconfig's `NZONES=250`, `gd77.c:38`). Net zone-member capacity is much larger per zone, fewer zones overall.
- **Satellite/orbital tracking (TLE-based, up to 25 satellites) and APRS config (8 systems)** exist only on OpenGD77 — no equivalent anywhere in the stock dmrconfig GD-77 struct.
- **DMR ID callsign database**: both firmwares support one, but in **different formats** (see §3/§4 below) — not a capability difference, a format difference.
- Group lists/contacts/channel-bank-1 live in a genuinely separate flash address space on OpenGD77 (`0x087620` etc.) vs the stock firmware's single linear `0x20000`-byte image (`0x17620` etc. — see §3) — **these are not the same numbers and must not be conflated**; they are two different wire protocols addressing the same physical radio differently, not two views of one address space.
- OpenGD77 adds a boot **password enable bit** unused-by-stock at the general-settings boot struct (per qdmr's byte-diagram, `radioddity_bootsettings.txt`, offset `0x01`) — present in the **shared struct layout already**, so this is actually a stock-firmware field OpenGD77 continues to use, not a new one. No evidence found of OpenGD77-only *new* general-settings fields beyond band limits/satellites/APRS already covered above.

---

## 3. Shared codeplug memory map — field-by-field

The two firmwares' record **shapes** are close to identical at the bit level (both descend from reverse-engineering the same original Radioddity firmware) but live at **different absolute addresses and through different wire protocols** — never share address constants between the HID and serial paths. Field offsets below are **relative to the start of each record**, confirmed independently by dmrconfig (stock) and qdmr's documentation/WebCPSd's codec (OpenGD77) agreeing byte-for-byte on every field both sides implement.

### 3.1 General settings (0x20 bytes region, stock `general_settings_t`; OpenGD77 `GeneralSettingsElement`)
Stock, at `radio_mem[0xe0..]` (`gd77.c:189-197`); OpenGD77 base starts at `0x000080` with these two fields at `+0x60`/`+0x68` relative (`app.js:151-160`):

| Field | Offset (rel.) | Size | Encoding |
|---|---|---|---|
| Radio name / callsign | `0x00` | 8 bytes | ASCII, `0xFF`-terminated/padded |
| DMR ID | `0x08` | 4 bytes | packed BCD, **big-endian** (8 digits) |

qdmr's fuller `radioddity_generalsettings.txt` byte-diagram documents many more fields that live in the **same struct, at larger offsets**, not implemented by either dmrconfig's GD-77 driver or the WebCPSd app (so treat as present-on-radio but currently unmanaged by either reference CPS — safe to leave untouched on write, per the "never clobber what you don't decode" principle both reference implementations use):
```
+0x10: VOX sensitivity[1..10](nibble) | Monitor type(1 bit: 0=open,1=silent) | Tx preamble ×60ms | unused
+0x14: Lone worker reminder(s) | Lone worker response(min) | Call alert duration(×5s) | Low battery interval(×5s)
+0x18: Group/priv-call hang-time(×500ms each) + ARTS tone + several 1-bit flags (UNT/RST/UMV/DMV/SBP/SBR/DAT/FIT/STT/PAT/PDT)
+0x1c: more 1-bit flags (IQO/DAL/ScanM/ANI/DBW/TXT) + repeater STE + repeater delay
+0x20: Programming password, 8 ASCII bytes, 0xFF-terminated
```
(`qdmr doc/code/radioddity_generalsettings.txt`.) **Band-limit fields (VHF/UHF min/max, 2 bytes each, packed BCD4 little-endian, whole MHz)** live immediately *before* this struct on OpenGD77 at `0x000080-0x000087` (`app.js:155-158`) — **not confirmed present/used in dmrconfig's GD-77 driver** (searched `gd77.c`, no VHF/UHF band-limit offsets found there; may be a fixed firmware constant on stock, or simply unmanaged by dmrconfig — flag as unconfirmed for stock).

### 3.2 Boot/intro text
Stock (`gd77.c:195-204`, `OFFSET_INTRO = 0x07540`):
```
+0x00 (abs 0x7540): intro line 1, 16 ASCII bytes, 0xFF-padded
+0x10 (abs 0x7550): intro line 2, 16 ASCII bytes, 0xFF-padded
```
No boot-enable flag found in the stock struct itself — presumably always shown, or controlled elsewhere unconfirmed.

OpenGD77 (`app.js:161-165,237`, abs `0x007518`, struct size `0x48`):
```
+0x00: text-enable flag (1=show intro text)
+0x0c: 6-digit BCD boot password (not exposed by the reference CPS UI, but present)
+0x28: intro line 1, 16 bytes ASCII/0xFF
+0x38: intro line 2, 16 bytes ASCII/0xFF
```
qdmr's own byte-diagram (`radioddity_bootsettings.txt` + `radioddity_boottext.txt`) splits this into two adjacent structs — a 4-byte "boot settings" flags+password header immediately followed by a 0x20-byte "boot text" struct holding the two 16-byte lines at `+0x00`/`+0x10` *relative to the boot-text struct*, which is consistent with OpenGD77's combined offsets above once you add the two structs' base offsets together.

### 3.3 Channel element — 0x38 (56) bytes, both firmwares, byte-size-identical
Confirmed structurally identical size and field positions for every field both firmwares use (cross-checked: dmrconfig's bit-field struct in `gd77.c:69-157` sums to exactly 56 bytes; qdmr's two byte-diagrams `radioddity_channel.txt`/`opengd77_channel.txt` agree on nearly every offset). Differences are called out inline.

| Offset | Size | Field | Encoding |
|---|---|---|---|
| `0x00` | 16 | Name | ASCII, `0xFF`-terminated/padded |
| `0x10` | 4 | RX frequency | packed BCD, 8 digits, **little-endian**, units of 10 Hz |
| `0x14` | 4 | TX frequency | packed BCD, 8 digits, little-endian, units of 10 Hz |
| `0x18` | 1 | Mode | `0`=Analog(FM), `1`=Digital(DMR) |
| `0x19` | 1 | — | Stock: unused(0). **OpenGD77: Power, 0-10** (0=radio default, 10=max) — this byte's meaning differs between firmwares; stock power lives elsewhere (see below) |
| `0x1a` | 1 | — | unused (0) both firmwares |
| `0x1b` | 1 | TOT | TX timeout, units of 15 s (0=infinite on stock) |
| `0x1c` | 1 | TOT rekey delay | seconds, both firmwares |
| `0x1d` | 1 | Admit criterion | `0`=Always, `1`=Channel Free, `2`=Color Code |
| `0x1e` | 1 | — | unknown/fixed `0x50` on both — **do not change** |
| `0x1f` | 1 | Scan-list index | `+1` encoded, `0`=None |
| `0x20` | 2 | RX CTCSS/DCS | 16-bit tone code, little-endian (decode below), `0xFFFF`=off |
| `0x22` | 2 | TX CTCSS/DCS | same encoding |
| `0x24`/`0x26` | 1 each | RX/TX DTMF signalling-system index | `+1` encoded on stock; OpenGD77 repurposes one of these bytes for a 24-bit little-endian "per-channel radio ID" field at `0x25-0x27` plus a 1-bit "radio ID enable" flag — this is an OpenGD77-only extension layered over stock's unused bytes, confirmed by qdmr's `opengd77_channel.txt` showing `RID` flag + 24-bit Radio ID spanning `0x24-0x27` where stock shows plain signalling-index bytes |
| `0x28` | 1 | Privacy group | `0`=None, `1`=`53474c39` (stock only — field meaning on OpenGD77 at this exact byte is the RX group-list index per its diagram; **the two firmwares use this byte differently** — always decode per-firmware, never assume universal meaning past `0x24`) |
| `0x29` | 1 | TX Color Code | 0-15 |
| `0x2a` | 1 | RX group-list index | `+1` encoded (stock, at `0x2a`; OpenGD77's equivalent is at `0x28`, see above — **offsets diverge from here on by one byte in places**, always use the per-firmware table, not a single shared one past the tone bytes) |
| `0x2c` | 1 | RX Color Code | 0-15 |
| `0x2d` | 1 | Emergency-system index | `+1` encoded |
| `0x2e` | 2 | TX contact index | `+1` encoded, little-endian |
| `0x30` | 1 | bit-packed flags | Stock: `DCC,EAC,...,SLT,PRV,...,PCC,...,STE,...,DCM,PWR,VOX,...,TLK,RXO,BW,...` — see `radioddity_channel.txt` for exact bit numbers. OpenGD77: `DCC,EAA,...,ARTS,...,SLT,PRV,...,PCC,STE,NFS,...,PTTId,...,DCD,...,VOX,SZS,SAS,TLK,RXO,BW,SQT` — bit layout **not identical** between firmwares past the first couple of bits; OpenGD77 repurposed stock's "auto scan enable"/"lone worker enable" bits as `SZS`(scan-zone-skip)/`SAS`(scan-all-skip) respectively. **Always use the firmware-specific bit table, never share bit-offset constants across firmwares for this byte.** |
| `0x34` | 4 | — | unused, `0` (stock). OpenGD77 reuses the last byte of this range (`0x37`) for **squelch, in units of 5%, 0=default** — confirmed in WebCPSd's codec: `squelch: Math.min(10, Math.max(0, Math.round((10*(b[0x37]-1))/14)))` (`app.js:381`) and the byte-diagram's `SQT`/squelch field at `+0x37`. |

**CTCSS/DCS tone 16-bit code** (both firmwares, confirmed by WebCPSd's working codec `app.js:321-335`, matches qdmr's documented bit layout):
```
bit 15: DCS flag (1=DCS, 0=CTCSS)
bit 14: inverted flag (DCS only)
bits 0-13: 4-digit BCD of the tone value ×10 (CTCSS: e.g. 67.0 Hz → 0670 → BCD; DCS: 3-digit code)
0xFFFF = tone off
```
Decode (JS, directly portable): `dcs=(code>>15)&1; inv=(code>>14)&1; bcd=code&0x3FFF` → unpack 4 BCD nibbles → value. CTCSS display = `value/10` (one decimal); DCS display = zero-padded 3-digit code + `N`(normal)/`I`(inverted) suffix.

**Power byte, stock vs OpenGD77 — confirmed real difference, not a typo:** stock encodes power as a **single bit** inside the `0x30` flags byte (`POWER_HIGH=1, POWER_LOW=0` — only two levels, `gd77.c:155-156`). OpenGD77 instead uses a dedicated byte at `0x19` holding **0-10** (11 levels, 0=radio default/max per some paths, 10=max — see WebCPSd's `pwrOpts()`/`ogdNormalizePower()`, `app.js:7-13,352-357`). **A codeplug converted between the two firmwares cannot preserve power level exactly** — map stock's 2 levels to the nearest OpenGD77 equivalent (e.g. Low→1, High→10) and vice versa (OpenGD77 0-10 → stock bit: anything ≥ some threshold → High).

### 3.4 Channel bank (bitmap + 128 channels) — 0x1c10 bytes, identical shape both firmwares
```
+0x00: 16-byte bitmap, 1 bit per channel slot (bit set = channel present/valid)
+0x10: 128 × 0x38-byte channel elements
```
Confirmed identical on both sides (`gd77.c:166-169` `bank_t`; `OGD_SZ.CH_BANK=0x1c10, CH_BANK_BITMAP=0x10`, `app.js:221`). Stock has 8 such banks (`NCHAN=1024` ÷ 128), bank 0 at `OFFSET_BANK_0=0x03780`, banks 1-7 starting at `OFFSET_BANK_1=0x0b1b0` and stepping by `0x1c10` each (**stock address**, not to be confused with OpenGD77's `0x07b1b0` for the same logical bank 1 — different wire protocols, different absolute addresses, same internal shape).

### 3.5 Contact — 0x18 (24) bytes, near-identical both firmwares
| Offset | Size | Field | Encoding |
|---|---|---|---|
| `0x00` | 16 | Name | ASCII, `0xFF`-terminated |
| `0x10` | 4 | DMR ID | 8-digit packed BCD. **Stock: little-endian** (`gd77.c` `GET_ID` macro reads nibble order consistent with LE unpacking — confirmed by the macro's bit-shift pattern, `gd77.c:177-184`). **OpenGD77: documented as plain "8 BCD digits"** without an explicit endianness call-out in `opengd77_contact.txt`, but qdmr's own `gd77_contact.txt` (stock) explicitly says "little endian" while `opengd77_contact.txt` does not repeat that qualifier — **treat as unconfirmed whether OpenGD77's contact DMR ID is BE or LE; verify empirically against a real contact before shipping** (every other BCD-8 field in this document that qdmr calls out explicitly is BE for general-settings DMR ID and LE for channel frequencies, so don't assume either way here). |
| `0x14` | 1 | Call type | `0`=Group, `1`=Private, `2`=All |
| `0x15` | 1 | RX tone | `0`=off, `1`=on |
| `0x16` | 1 | Ring style | 0-10 |
| `0x17` | 1 | Stock: valid-flag (`0xFF`=used, `0x00`=blank). **OpenGD77: timeslot override** — repurposed byte, confirmed by WebCPSd's codec: `b[0x17]===0x00→ts1, 0x02→ts2, else 0` (`app.js:761-762`) vs qdmr's `opengd77_contact.txt` showing a "Timeslot override" field at this offset. |

### 3.6 Zone
Stock (`gd77.c:206-214`, `zone_t`): name (16 bytes ASCII/0xFF) + **16** member channel indices (`uint16`, `+1` encoded, `0`=empty), total 48 bytes/zone, up to **250 zones** with a 32-byte (250-bit) bitmap header (`zonetab_t`, `NZONES=250`).

OpenGD77 (`opengd77_zone.txt`, `app.js:222,230`): name (16 bytes) + **80** member channel indices (`uint16` LE, `+1` encoded), total `0xb0`=176 bytes/zone, up to **68 zones** with a 68-bit (rounded to a larger bitmap region, 0x20 bytes incl. other header fields) bitmap header.

### 3.7 Group list / RX group list / "TG list"
Stock (`gd77.c:216-232`, `grouplist_t`/`grouptab_t`): header is **128 bytes of `nitems+1` validity bytes** (one per list, `0`=disabled) followed by 76 × (16-byte name + 32×`uint16` member) = 76 × 80 = 76×0x50 bytes.

OpenGD77 (`app.js:224,231`, `OGD_SZ.GROUPLIST=0x50, GROUPLIST_HDR=0x80`): structurally the same — 0x80-byte header (one validity byte per list, matching stock's "nitems1[128]" scheme even though only 76 are used) + 76 × 0x50-byte records (16-byte name + 32×`uint16` LE member, `+1` encoded, `0`=empty slot). **These two are the same record shape**, confirmed by matching sizes (`0x50`=80 bytes both) and matching "contact index +1" member encoding.

### 3.8 Scan list — 0x58 (88) bytes, same shape both firmwares
| Offset | Size | Field |
|---|---|---|
| `0x00` | 15 | Name, ASCII/0xFF |
| `0x0f` | 1 | bit-packed: channel-mark(1 bit) / mode(2 bits, `0`=non-priority,`1`=disable,`2`=priority,`3`=priority+non-priority) / talkback(1 bit) |
| `0x10` | 64 (32×2) | Member channel indices, `uint16` LE, `+1` encoded, `0`/`1`=selected-channel sentinel per `CHAN_SELECTED` |
| `0x50` | 2 | Priority channel 1 index, `+1` encoded |
| `0x52` | 2 | Priority channel 2 index |
| `0x54` | 2 | Revert/TX-designated channel index, `0`=last-active |
| `0x56` | 1 | Hold time, ×25 ms |
| `0x57` | 1 | Priority sample time, ×250 ms |

Header: stock has a `valid[64]` byte array (1 byte/list, `NSCANL=64`); OpenGD77 has `SCAN_LIST_BITMAP=0x40` (64 bytes) immediately preceding 64 × 0x58-byte records — same shape.

### 3.9 DTMF contact — 0x20 (32) bytes, both firmwares
```
+0x00: name, 16 ASCII bytes
+0x10: DTMF code/digit string, 16 ASCII bytes
```
Confirmed identical both sides (`app.js:447-454`; not found as a separate struct in the dmrconfig excerpt pulled, but the size/shape match the general DTMF-contact convention used elsewhere in this family — **not independently confirmed from dmrconfig source for stock**, flag as moderate-confidence only).

### 3.10 Text messages (stock only, confirmed; OpenGD77 equivalent not found in sources pulled)
Stock `msgtab_t` (`gd77.c:230-237`, `NMESSAGES=32`):
```
+0x00: message count (1 byte)
+0x01..0x07: unused(0)
+0x08: 32× message length bytes (1 byte each)
+0x28: 32× unused bytes
+0x48: 32× 144-byte ASCII messages (0xFF-terminated), 32×144=4608 bytes total
```
qdmr's own `radioddity_messagebank.txt` confirms this exact layout for the **64**-message variant used by some radios in the family (note: qdmr's diagram shows message indices up to `3f`=63, i.e. 64 messages, while dmrconfig's `NMESSAGES=32` — **this count differs between the two reference sources; dmrconfig's GD-77-specific constant (32) should be treated as authoritative for the GD-77 specifically**, since qdmr's diagram may be documenting a different radio in the Radioddity family with a larger table). **I did not find an OpenGD77-side text-message region in the sources pulled — unconfirmed whether/where OpenGD77 firmware keeps this.**

### 3.11 Button/one-touch settings (stock structure, confirmed present; not mapped into either reference CPS's UI)
`radioddity_buttonsettings.txt`: long-press duration, short/long press actions for SK1/SK2/(GD-77-specific "TK" key), and 6× "one-touch" slots each encoding an action-type byte + contact-index + message-index. **Not implemented in either reference CPS (dmrconfig's GD-77 driver has no button-setup code path found; WebCPSd has no button UI)** — present on the radio, offsets documented, but no working encode/decode reference exists in the sources pulled. Treat as a "leave untouched on write" region unless the builder wants to reverse further from qdmr's own `.cc` files (not read in this pass).

### 3.12 "In use" bitmaps — summary
Every variable-length table in this family uses a **leading bitmap or byte-array of validity flags** immediately before the table's fixed-size records, with record `N` valid iff bit/byte `N` is set — confirmed for channel banks (16-byte bitmap), zones (32-byte bitmap stock / ~0x20 OpenGD77), scan lists (64-byte array stock, 0x40-byte bitmap OpenGD77), and group lists (128-byte `nitems+1` array both firmwares). The one exception found: **contacts have no separate bitmap** — validity is encoded in-record (stock: last byte `0xFF`/`0x00`; OpenGD77: name field non-empty, confirmed by WebCPSd's decode loop checking `if (!name) continue`, `app.js:757`).

---

## 4. File formats worth supporting

| Format | Firmware | Header | Body | Source |
|---|---|---|---|---|
| Raw `.img` | Stock (dmrconfig convention) | First 7 bytes = `"MD-760P"` ASCII (no NUL) written into an otherwise-blank 128-byte block 0 | Bytes `0x80`–`0x1e29f` = real radio content (block numbers 1-965, 128 bytes each, with blocks 248-255 i.e. `0x7c00-0x7fff` forced to `0xFF`); total file size `MEMSZ=0x20000` (131072 bytes), tail from `0x1e2a0` onward is `0xFF`/zero filler never read from the radio | `dmrconfig gd77.c:360-367,402-405`, `radio.c:182-280`, `main.c` usage text (`-r`→`device.img`, `-w`→write from `.img`) |
| `.gd77backup` (JSON) | OpenGD77 (ReallyOpenGD77 WebCPSd's own format — not an upstream/official standard, but a sensible one to imitate) | `{format:"ReallyOpenGD77-WebCPSd-flash-backup", version:1, radio_family:"W"|"X", radio_name, created}` | `eeprom`/`flash` arrays of `{addr, size, data:<base64>}` segments, matching the exact `OGD_EEPROM_SEGS`/`OGD_FLASH_SEGS` layout at backup time — restore refuses if `radio_family` or segment layout (addr/size) doesn't match the connected radio, to avoid writing MK22 bytes at STM32 addresses or vice versa | `app.js:3507-3674` |
| `.g77` | OpenGD77 CPS (official, upstream) | **Not confirmed in this pass** — the original `OpenGD77CPS` repo that would define this is deleted from GitHub (404s on both the repo page and the GitHub API), and I did not fetch a preservation fork to inspect it. WebCPSd's code references ".g77" import/export (`lastG77Bytes`, `g77MapsFromBytes` function names appear in `app.js` around the write-radio satellite-handling logic) implying it reads/writes this format, but **I did not pull the function body that parses it**, so its header/layout is **unconfirmed** — flag clearly to the builder: either fetch `app.js`'s `g77MapsFromBytes`/`g77BytesFromMaps` functions (not yet read in this research pass, but present in the same file, likely a short diff from the EEPROM/FLASH segment tables above since the comment at `app.js:3455-3461` says a `.g77` import "has no flash segment covering the satellite region") or omit `.g77` support for v1 and rely on the raw-segment backup format above, which is simpler and already fully specified. |

**Recommendation for the builder:** support (a) the raw stock `.img` format exactly as above for stock-firmware interchange with dmrconfig, and (b) a JSON backup format modelled on `.gd77backup` above for OpenGD77 — both are fully specified from sources actually read. Treat `.g77` as a stretch goal requiring one more research pass into WebCPSd's `g77MapsFromBytes`/`g77BytesFromMaps` functions before it can be implemented correctly.

---

## 5. Firmware/model identification (so the page can refuse a non-GD-77 radio)

**Stock HID path:**
1. WebHID device filter already restricts to VID `0x15a2`/PID `0x0073` — but this VID/PID pair is **shared with RD-5R and DM-1801** (confirmed: `radio.c:49-51`, same VID/PID used for all three in dmrconfig's `radio_connect()`).
2. After the PROGRAM handshake (§1), the 16-byte identification string returned must be checked. For GD-77 specifically, dmrconfig expects `"MD-760P"` (`radio_tab[]` entry, `radio.c:49`). **Any other string (e.g. `"BF-5R"` for RD-5R, `"1801"` for DM-1801) must be refused** — same VID/PID, different internal model string, genuinely different codeplug struct offsets in the general dmrconfig codebase (though this pass only confirmed the GD-77 struct in detail).

**OpenGD77 serial path:**
1. WebSerial/WebUSB filter on VID `0x1fc9`/PID `0x0094` — shared by **every** OpenGD77-firmware radio across both MCU families.
2. Send `READ_FIRMWARE_INFO` (§2) and check the returned `radioType` field: **`0`=GD77, `1`=GD77S** are the two values that should be accepted for "this is a GD-77 family radio"; refuse `2-10` (DM1801/RD5R/DM1801A/MD9600/MDUV380/MD380/DM1701/MD2017/DM1701RGB) if the page is GD-77-specific, or branch UI/memory-map behaviour on it if supporting the wider family later. This is exactly how WebCPSd itself decides MK22-vs-STM32 write framing and memory-map shift (`app.js:2994-3004`, `OGD_RADIO_TYPES` table at `app.js:2838-2848`) — reuse that same table.
3. **Distinguishing stock vs OpenGD77 firmware on the *same* physical radio**: these are two entirely different USB device descriptors (different VID/PID pairs) because OpenGD77 is a full firmware replacement that re-enumerates as its own USB-CDC device — so "which firmware is this radio running" is answered simply by **which VID/PID the OS reports the device as**, not by any in-band query. A page can offer two separate "Connect" buttons/filters (`0x15a2:0x0073` → stock HID path; `0x1fc9:0x0094` → OpenGD77 serial path) and whichever filter matches tells you the firmware.

---

## Open risks / things I could not confirm

1. **`.g77` file format** — not read in this pass; the function names exist in WebCPSd's `app.js` but I did not pull their bodies. Needs one more fetch before implementing `.g77` import/export.
2. **OpenGD77 contact DMR-ID endianness** (BCD big- vs little-endian) — qdmr's byte-diagrams are inconsistent in whether they call this out for OpenGD77 vs stock; verify against a real contact on real hardware before shipping write support for contacts.
3. **Text-message table on OpenGD77** — stock's layout is fully documented (§3.10); I found no equivalent OpenGD77 region in the sources pulled. May not exist, may live somewhere not yet located.
4. **Button/one-touch settings encode/decode** — offsets are documented (§3.11) but no working reference implementation was found on either side; untested.
5. **Stock general-settings fields beyond radio-name/DMR-ID** (VOX, lone-worker, hang-times, programming password, band limits) — documented from qdmr's byte-diagram but **not exercised by dmrconfig's own GD-77 driver** (`gd77.c` only reads/prints name+ID), so their exact presence/behaviour on real GD-77 (vs some other member of the same qdmr "radioddity" family the diagram might be more specifically describing) is lower-confidence than everything confirmed by a working reference implementation.
6. **Whether the stock radio needs a manual power-cycle after an abnormally-terminated WebHID session** (no `ENDR`/`ENDW` sent) — inferred as likely from the OpenGD77 side's well-documented "stuck forever until reset" failure mode, but not demonstrated for the stock/HID path specifically in the sources read.
7. **`git clone` to github.com did not work in this sandbox** (plain HTTPS GET did); I did not attempt a `.git`-protocol workaround for the two repos that 404'd (`OpenGD77CPS`, `OpenGD77` firmware) because both turned out to be deleted upstream anyway — their preservation forks (`open-ham/OpenGD77`, `handeng/OpenGD77`) exist but were not fetched.

---

**File paths referenced in this research** (all under the session scratchpad, not the project — nothing was written to `/home/user/gd77-web`):
- `/tmp/claude-1000/.../scratchpad/src/dmrconfig/` (gd77.c, hid.c, hid-libusb.c, radio.c, main.c)
- `/tmp/claude-1000/.../scratchpad/src/qdmr/lib/opengd77_interface.{cc,hh}`, `doc/code/*.txt`
- `/tmp/claude-1000/.../scratchpad/src/rogd77/reallyopengd77-webcpsd/frontend/js/app.js`

Sources:
- [dmrconfig (OpenRTX fork)](https://github.com/OpenRTX/dmrconfig)
- [qdmr](https://github.com/hmatuschek/qdmr)
- [ReallyOpenGD77 WebCPSd](https://repo.w0chp.net/Chipster/ReallyOpenGD77-WebCPSd) / [project site](https://w0chp.radio/ogd77-webcpsd/)
- [open-ham/OpenGD77 (preservation fork, not fetched)](https://github.com/open-ham/OpenGD77)