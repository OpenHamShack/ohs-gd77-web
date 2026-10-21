# Firmware tab research write-up (for `docs/firmware.md`)

Everything below is read-only research. I did not touch the gd77-web repo, did not open a USB/WebUSB connection to anything, and did not flash or key any radio. All claims are backed by a source line; anything inferred rather than read directly is in the final "Unconfirmed" section.

## Corrections found while building the Firmware tab (21/10/2026)

Checked against the real files and the reference sources; where this list
and the sections below disagree, this list is right and `js/firmware/`
follows it.

1. **MD-9600 and the MD-UV380 family use different keys.** §3.3 says the
   UV3X0 table covers the MD-9600; it does not. The MD-9600 donor decrypts
   only with grid.radio's separate `MD9600` table (6 of 1024 bytes agree
   with the UV3X0 one). §5.2 already decrypts the donor with the MD-9600
   key and re-encrypts with the target's, which is why that is right.
2. **A stock flash writes the file's data still encrypted.**
   `TYTRadio::WriteFirmware` writes the region data as read, with no
   decrypt; the bootloader decrypts. §7.1 step 3 ("decrypt") is wrong.
   It follows that the bootloader decrypts at (address - 0x0800C000) mod
   1024, which matches the files because their application region starts
   1024-aligned in the data stream; the planner refuses a file where it
   does not.
3. **SetAddress is per sector, not per region.** Both tools call SetAddress
   at every sector start and number that sector's blocks from wValue 2
   (radio_tool's per-sector callback, grid.radio's address table, and the
   flash log's "Writing: 0x0800c000 [Size=0x4000]" lines).
4. **The key cannot be read off 0xFF runs** in these files: no plaintext run
   of 0xFF or 0x00 is 1024 bytes long (the longest are ~810). The key is
   recovered statistically instead (`js/firmware/tyt.js`): per key position,
   the value that makes the ~1,250 ciphertext bytes there decrypt to the
   most firmware-like byte distribution. On all four V18.11 files and the
   MD-9600 donor this reproduces the published tables exactly, with the
   best candidate ahead of the next by more than 200 nats at every position.
5. **The codec position is specific to the donor build.** The four UV380
   V18.11 files do not contain the donor's codec bytes anywhere, so only a
   donor whose codec is known to sit at 0x0807537C can be used; the page
   accepts the MD-9600 V26.45 file by its SHA-256.
6. **The container trailer** is 240 bytes of 0xFF plus the 16-byte end
   magic, so file size = 0x100 + sum of region lengths + 256 (all five files).
7. **The model identifier's length byte is part of the table entries**
   (`02 17 0c` is length 2 plus `17 0c`).

---

## 1. Radios in scope

TYT's MD-UV380/UV390 family (STM32F405/F407-based), which also covers the Baofeng DM-1701, TYT MD-9600, TYT MD-2017 and rebadges including the Retevis RT3S. They share one bootloader (ST's DfuSe over USB, VID `0x0483` PID `0xDF11`) and one firmware-container format. Two firmware "flavours" exist for this hardware:

- **Stock TYT firmware** — proprietary, includes the DMR AMBE+2 vocoder.
- **OpenGD77 firmware** — open source, ships with the vocoder region blanked out because OpenGD77 cannot redistribute TYT's proprietary codec. This is the "codec merge" the task asks for.

---

## 2. The DFU protocol (0483:df11 bootloader)

Standard USB DFU (class requests) plus TYT's own vendor commands layered on top. Confirmed identically in two independent implementations: radio_tool's C++ (`/home/user/build/rt3s-flash/radio_tool`, used today to flash this exact RT3S — log at `/home/user/build/rt3s-flash/flash.log`) and grid.radio's `webusb.js`.

### 2.1 Standard DFU requests used

All control transfers are `bmRequestType` class/interface, interface number `0`:

| Request | bRequest | Direction | Notes |
|---|---|---|---|
| DNLOAD | `0x01` | OUT | Carries both data and the two custom sub-commands below |
| GETSTATUS | `0x03` | IN, 6 bytes | `{status, pollTimeout(3 bytes), state, discarded}` |
| GETSTATE | `0x05` | IN, 1 byte | |
| ABORT | `0x06` | OUT | |
| CLRSTATUS | `0x04` | OUT | |

Sources: `radio_tool/include/radio_tool/dfu/dfu.hpp:31-73`, `radio_tool/src/dfu.cpp:27-157`; grid.radio `webusb.js:7342-7367` (`DFU_CMD`, `DFU_INTERFACE`), `webusb.js:7390-7445` (`dfuControlOut`/`dfuControlIn`).

### 2.2 DNLOAD sub-commands (first byte of the payload selects the operation)

- **Set address** — `0x21` + 4-byte little-endian address.
  `radio_tool/src/dfu.cpp:27-37`; `webusb.js:7572-7583` (`dfuSetAddress`).
- **Erase page** — `0x41` + 4-byte little-endian address (erases the sector containing that address).
  `radio_tool/src/dfu.cpp:39-49`; `webusb.js:7551-7564` (`dfuPageErase`).
- Each of these is followed by two GETSTATUS polls expecting `DFU_DOWNLOAD_BUSY` then `DFU_DOWNLOAD_IDLE`; anything else is an error. `radio_tool/src/dfu.cpp:69-86`; `webusb.js:7449-7460` + per-call `dfuCheckStatus`.

### 2.3 TYT custom radio commands (first byte `0x91`)

Sent as a DNLOAD payload `[0x91, <cmd>]`, `wValue=0`:

| Command | Byte | Purpose |
|---|---|---|
| ProgrammingMode | `0x01` | Arm the radio for a firmware write |
| SetRTC | `0x02` | Followed by a second DNLOAD carrying a BCD timestamp, prefixed `0xb5` |
| Reboot | `0x05` | Radio reboots immediately; the follow-up status read is expected to fail |
| FirmwareUpgrade | `0x31` | Must be sent once before any erase/write |

Source: `radio_tool/include/radio_tool/dfu/tyt_dfu.hpp:27-33`, `radio_tool/src/tyt_dfu.cpp:68-83`. grid.radio sends the same two bytes in the same order before erasing: `webusb.js:7221-7222` (`dfuSendCustomCommand(0x91,0x01)` then `(0x91,0x31)`), helper at `webusb.js:7594-7605`.

### 2.4 TYT registers (identification), command `0xA2`

`ReadRegister(reg)`: DNLOAD `[0xA2, reg]`, then UPLOAD 1024 bytes (`RegisterSize`). Register `0x01` ("RadioInfo") returns a null-padded ASCII model string — this is the only way to read back *which radio* is actually attached in DFU mode.

Source: `radio_tool/include/radio_tool/dfu/tyt_dfu.hpp:35-65`, `radio_tool/src/tyt_dfu.cpp:27-43`.

**Neither reference tool calls this before writing firmware.** radio_tool's `TYTRadio::WriteFirmware` (`radio_tool/src/tyt_radio.cpp:45-91`) never calls `IdentifyDevice()`; grid.radio's `writeFirmwareSTM32DFU` (`webusb.js:7080-7319`) only validates a *string the user picked in the UI* (`normalizeSTM32Model`, `webusb.js:7786`), never reads register `0x01` back from the device. **This is a real gap in both existing tools — see §6, Safety checks.**

### 2.5 Write sequence (erase, address, block-numbered writes)

1. Send `FirmwareUpgrade` (`0x91 0x31`).
2. For each region in the firmware file, erase every flash sector it overlaps, aligned to sector boundaries (sector sizes are not uniform — see §3.3). Radios in this family withhold the sectors their bootloader lives in (`0x08000000`–`0x0800C000`) from the chip map the C++/JS tools assume; the current production tools don't check this, they just never target that range because firmware files for this family start at `0x0800C000`.
3. For each erased region: `SetAddress(region.start)`, then DNLOAD the data 1024 bytes at a time (padded to 1024 with `0xFF` on the last block), with `wValue` numbered **starting at 2** and incrementing per block (`wValue = 2, 3, 4, …`). The address set once at the start of the region is implicit for every following block — the device places block *n* at `pointer + (n-2)*1024`. This diverges from generic dfu-util behaviour (which re-sets the address before every block); doing it generically has been observed (by radio_tool's newer Rust rewrite) to silently brick a DM-1701: it took every byte, reported success, and would not boot after a power cycle.
4. After the last block, exit: `SetAddress(0x08000000)` then a **zero-length DNLOAD** to trigger manifestation/jump-to-application. The radio reboots as soon as this is processed, so the follow-up GETSTATUS read is *expected* to fail/disconnect — that is success, not an error.

Sources: `radio_tool/src/tyt_radio.cpp:45-91`, block-numbering comment and brick warning in `radio_tool/rust/crates/device/src/dfu.rs:676-700`; grid.radio mirrors this exactly at `webusb.js:7210-7319` (erase loop `7236-7245`, address+block loop `7258-7299`, blocks numbered from `blockStart = 2` at `webusb.js:7255`), reset at `webusb.js:7636-7655`.

### 2.6 STM32F40x sector map used by both tools

```
0x08000000  16K   <- bootloader (never targeted by firmware files in this family)
0x08004000  16K   <- bootloader
0x08008000  16K   <- bootloader
0x0800c000  16K   <- first application sector (every firmware file starts here)
0x08010000  64K
0x08020000 128K
0x08040000 128K
0x08060000 128K
0x08080000 128K
0x080a0000 128K
0x080c0000 128K
0x080e0000 128K   (ends at 0x08100000, 1 MiB total)
```
Source: `radio_tool/include/radio_tool/util/flash.hpp:138-152` (C++) and the identical table in `radio_tool/rust/crates/device/src/flash.rs:39-103`; grid.radio's hardcoded addresses/sizes at `webusb.js:7227-7234` match exactly.

---

## 3. The firmware-file container format ("OutSecurityBin")

This is the TYT `.bin` container used for stock firmware for this whole family (MD-380/390/UV380/UV390/9600/2017, Baofeng DM-1701). It is **not** used by OpenGD77's own distributed `.bin` files (§4).

### 3.1 Byte layout

```
0x000  16  "OutSecurityBin\0\0"              <- start magic
0x010  16  firmware model, e.g. "MD-9600"    <- null padded
0x020  16  four little-endian uint32 ("n1..n4"); meaning not needed for flashing
0x030  76  "counter magic": [0]=length of rest, then that many identifying bytes, rest 0xFF-filled
0x07c   4  region/segment count (uint32); 0xFFFFFFFF is treated as 1
0x080 128  region table: pairs of (uint32 start_addr, uint32 length), unused entries 0xFF-filled
0x100   n  firmware data for every region, laid end to end, XOR-encrypted (§3.2)
       240  0xFF padding
        16  "OutputBinDataEnd"                <- end magic
```
Total header+table before data = `0x100` bytes exactly.

Source (struct + exact field sizes, cross-checked C++ against the newer Rust rewrite which documents the same layout in prose):
`radio_tool/include/radio_tool/fw/tyt_fw.hpp:122-130` (`TYTFirmwareHeader`, `static_assert(sizeof==128)`), reading/writing in `radio_tool/src/tyt_fw.cpp:23-130`; prose confirmation `radio_tool/rust/crates/firmware/src/tyt.rs:1-16` (`HEADER_LEN=0x80`, `REGION_TABLE_LEN=0x80`, `DATA_OFFSET=0x100`).

Verified directly against two real files in `/home/user/build/rt3s-flash/firmware/`:

| File | counter_magic | n_regions | region 0 | region 1 |
|---|---|---|---|---|
| `MD-UV380(CSV)-V18.11.bin` | `02 17 0c` → model **UV3X0** | 2 | start `0x00060000` len `0x0005d400` | start `0x0800c000` len `0x000dd800` |
| `md9600-donor.bin` (grid.radio's built-in donor, see §4) | `01 14` → model **MD9600** | 2 | start `0x00060000` len `0x00059800` | start `0x0800c000` len `0x000b2000` |

(Verified by reading the raw header bytes with a small script; matches the struct layout exactly.)

### 3.2 Identification table ("counter magic") and model names

```
UV3X0_GPS = {0x02,0x16,0x0c}   MD-UV3X0 (REC/CSV)(GPS) / RT3S
UV3X0     = {0x02,0x17,0x0c}   MD-UV3X0 (REC/CSV) / RT3S
MD9600    = {0x01,0x14}
MD2017_*  = {0x02,0x19,0x0c} / {0x02,0x18,0x0c} / {0x01,0x19} / {0x01,0x18}
DM1701    = {0x01,0x0f}
MD390/MD380/MD446 = {0x01,0x10}/{0x01,0x0d}/{0x01,0x0d}
MD280     = {0x01,0x1b}
```
All of UV3X0(_GPS), MD2017_*, and MD9600 share **`firmware_model = "MD-9600"`** in the header and the same cipher (§3.3). This is why grid.radio's single built-in "STM32 donor" file (an MD-9600 firmware image) works as the AMBE donor for MD-UV380/390/2017/9600 alike.

Source: `radio_tool/include/radio_tool/fw/tyt_fw.hpp:71-117` (table `tyt::config::All`), identical in `radio_tool/rust/crates/firmware/src/tyt.rs:48-120`.

### 3.3 Encryption (XOR, 1024-byte key, per model family)

```
for i in 0..data.len():
    data[i] ^= cipher[i % 1024]
```
Applied to the whole concatenated data stream (all regions together, starting again from `cipher[0]` at the first byte), offset 0, no extra salt. XOR is its own inverse, so encrypt and decrypt are the same operation.

- `UV3X0` cipher (covers MD-UV3X0/RT3S, MD-9600, MD-2017 — all "MD-9600" firmware_model radios): 1024-byte table at `radio_tool/include/radio_tool/fw/cipher/uv3x0.hpp:24-89`. **Byte-for-byte identical** to `STM32_CIPHERS.MDUV380` in grid.radio's `stm32_ciphers.js:78-81` (independently verified: both start `00 aa 89 89 1f 4b ec cf …`) — strong confirmation this is TYT's actual vendor key, not a tool-specific artefact.
- Separate 1024-byte tables exist for `DM1701` and `MD380` (different vendor keys per hardware family) — `radio_tool/include/radio_tool/fw/tyt_fw.hpp:104-117`; grid.radio has matching `STM32_CIPHERS.DM1701` etc.
- Apply/remove logic: `radio_tool/include/radio_tool/util.hpp:140-156` (`ApplyXOR`); grid.radio's `encryptSTM32Firmware` at `webusb.js:7671-7685` is the same formula.

### 3.4 Licence of radio_tool

**GNU GPL v3** (`radio_tool/LICENSE`, full text, `Copyright (c) 2020 v0l`). This means: **do not copy radio_tool's C++/Rust source into gd77-web** (incorporating GPLv3 code would require the consuming work to also be GPLv3, which nobody has decided to do here). Everything above is safe to **reimplement from this description** — it is protocol/format facts (byte offsets, command codes, a vendor-supplied XOR table) rather than expressive code, but the specific 1024-byte cipher arrays as they appear verbatim in radio_tool's source are literally copied GPL'd source constants; see §7 for the one open question this raises.

---

## 4. The OpenGD77 firmware file itself (plain `.bin`, no container)

Confirmed by downloading a real current build from grid.radio's own CDN (its manifest lists exact per-version download paths; this is the canonical OpenGD77 distribution point it uses, mirroring opengd77.com):

- `firmware_manifest.json` → `radioTypes.MDUV380_DM1701.versions.PD0FR_SMS_23_3.models.OpenMDUV380.variants.Standard` → `MDUV380_DM1701/PD0FR_SMS_23_3/firmware/OpenMDUV380.bin`, 807,256 bytes.
- Fetched and inspected directly: **no `OutSecurityBin` magic, no header, no region table, no XOR** — it is a bare, unencrypted application image. First 16 bytes `fc ff 01 20 71 e1 00 08 3d df 00 08 3f df 00 08` is a textbook Cortex-M vector table (initial SP `0x2001fffc`, reset handler pointer `0x080…`), i.e. this file is meant to be written starting exactly at flash address `0x0800c000` with no further processing.
- **The 297,904-byte range at file offset `0x6937c` (flash address `0x0807537C`) is entirely `0xFF`** in this file — confirmed byte-for-byte (`all(b==0xff for b in sec)` over the whole range). This is the AMBE codec placeholder OpenGD77 leaves blank. See §5.

So: **OpenGD77's distributed firmware is a plain flat `.bin` for the internal-flash application region only.** It has no `0x00060000`-style segment at all.

---

## 5. The codec merge — exact mechanism (reimplement this; do not copy grid.radio's JS, see §8)

Source for all of this: grid.radio `webusb.js:7159-7208` (merge) and `7210-7213` (encrypt), reverse-engineered description in its own comments ("matches `opengd77_stm32_firmware_loader.py` and the decompiled CPS"). I independently re-derived and checked every constant below against the real files; the arithmetic is exact, not approximate.

### 5.1 What's merged, and where

The donor is a **complete stock TYT `OutSecurityBin` container** (plain `.bin`, downloaded as-is — grid.radio's built-in donor is `MD9600-CSV(2571V5)-V26.45.bin`, 1,096,192 bytes, `expectedFilename` in its manifest; a user may instead supply their own TYT firmware file for their exact model).

The code treats the donor as **one flat byte array indexed from file offset 0**, i.e. it does **not** parse the TYT header/region-table structure at all — it just hard-codes a byte offset that happens to land in the right place:

```
DONOR_OFFSET            = 0xC2C7C   // 797,820 — raw byte offset into the donor FILE (incl. its 0x100 header)
AMBE_SECTION_SIZE        = 0x48BB0   // 297,904 bytes
TARGET_OFFSET            = 0x6937C   // 430,972 — byte offset into the OpenGD77 FILE (which has no header; file offset 0 == flash 0x0800c000)
AMBE_SECTION_CIPHER_OFFSET = 892     // == TARGET_OFFSET % 1024
```

I verified these constants against the real files:

- Donor file byte `0xC2C7C` minus the donor's own `0x100` header = data-stream offset `0xC2B7C` (797,564). Region 0 of this donor is `0x00060000`/len `0x59800` (366,592 bytes) — `797,564 > 366,592`, so this lands in **region 1** (the internal-flash application image, base `0x0800c000`), at region-relative offset `797,564 − 366,592 = 0x6937C`. Flash address = `0x0800c000 + 0x6937C = 0x0807537C`.
- OpenGD77's plain `.bin` has file offset 0 == flash `0x0800c000` (no header). `TARGET_OFFSET = 0x6937C` → flash address `0x0800c000 + 0x6937C = 0x0807537C`.

**Both addresses are identical: `0x0807537C`.** So the AMBE codec section is a fixed, ~291 KiB range *inside the main STM32 internal-flash application image* (not in the external `0x00060000` segment that stock-TYT firmware also carries — see §6), at the same flash address in both the stock firmware and OpenGD77's build. In OpenGD77's build that range is deliberately left `0xFF`-filled (confirmed in §4). This is airtight: the two independently-derived addresses match exactly, and the OpenGD77 build's placeholder is exactly that size at exactly that offset.

### 5.2 Merge algorithm

```
1. combinedFirmware = copy of the OpenGD77 raw .bin (flat, no header)
2. ambeSection = donorFile[DONOR_OFFSET .. DONOR_OFFSET+AMBE_SECTION_SIZE]   // still TYT-encrypted
3. ambeSection[i] ^= MD9600_cipher[(i + 892) % 1024]   for each i           // decrypt, using the MD9600 cipher
                                                                              // and offset 892 (== TARGET_OFFSET % 1024,
                                                                              // i.e. the cipher's phase at that flash address)
4. combinedFirmware[TARGET_OFFSET .. TARGET_OFFSET+AMBE_SECTION_SIZE] = ambeSection   // splice in, still decrypted
5. encryptedFirmware = XOR the WHOLE combinedFirmware with the TARGET model's cipher (offset 0 for the whole file, §3.3)
   — i.e. everything is re-encrypted once, from scratch, after the splice.
```
Note step 3 always uses the **MD9600 cipher** specifically (because the donor file, whatever its own counter-magic, is always an MD9600-family firmware_model file), regardless of which target model (MDUV380/MD9600/MD2017/DM1701) is being flashed. Step 5 uses the cipher that matches the *target* radio being flashed (`stm32_ciphers.js` table, selected by `outputType`).

Source: `webusb.js:7159-7213`.

### 5.3 Why this needs *two* input files from the user

The task's "codec merge" requirement maps exactly onto this: the user supplies (a) the OpenGD77 build for their exact model/variant (plain `.bin`, from opengd77.com or grid.radio's own mirror), and (b) a TYT stock firmware file for *any* radio in the MD-9600 family (grid.radio defaults to a bundled MD-9600 file, but accepts the user's own, e.g. the `MD-UV380(CSV)-V18.11.bin` or `MD-UV390(GPS-REC)-S18.11.bin` already in `/home/user/build/rt3s-flash/firmware/`). Donor model/variant does not need to match the target radio model exactly — only the donor's `firmware_model` field ("MD-9600") and the fixed offset/size need to hold, which they do across all donor files I checked.

### 5.4 Safety validation grid.radio performs on the donor (minimal)

- Checks `donorFirmware.length >= DONOR_OFFSET + AMBE_SECTION_SIZE` and `combinedFirmware.length >= TARGET_OFFSET + AMBE_SECTION_SIZE`; if either is too small it **skips the merge silently (just logs a console warning and continues)** rather than aborting the flash — firmware without a working codec would then be written. `webusb.js:7172-7207`.
- Filename-only sanity check in the UI (`expectedFilename` warning, not a hard block) — `firmware.js:519-552`.
- No cryptographic/checksum validation of donor contents, no check that the donor's declared model is actually TYT firmware at all (no magic-byte check).

---

## 6. What the `0x00060000` segment actually is, and why today's flash only wrote `0x0800c000`

This directly answers the task's "notably" question.

### 6.1 Confirmed: why radio_tool only wrote `0x0800c000` today

`TYTRadio::WriteFirmware` (`radio_tool/src/tyt_radio.cpp:45-91`) iterates every region returned by `fw.GetDataSegments()` — which **does** include the `0x00060000` region (`FirmwareSupport::GetDataSegments`, `radio_tool/include/radio_tool/fw/fw.hpp:112-131`, returns every entry in `memory_ranges`, unfiltered). For each region it calls `AlignedContiguousMemoryOp(flash::STM32F40X, region.address, region.address+region.size, …)`. `STM32F40X` only covers `0x08000000`–`0x08100000` (§2.6). For a region starting at `0x00060000`, `GetSector()` finds no match on the very first address, and `AlignedContiguousMemoryOp`'s loop hits its `else { break; }` branch (`radio_tool/include/radio_tool/util/flash.hpp:118-133`) — **immediately, silently, with no erase, no write, and no error or log line at all**, for *both* the erase pass and the write pass. This is exactly what flash.log shows: zero mention of `0x00060000`, only the `0x0800c000`→`0x080e0000` sectors. This is confirmed from reading the source, not inferred.

The current Rust rewrite of radio_tool (`rust/crates/device/src/dfu.rs:625-652`) deliberately changed this: `flashing::write()` now **refuses** (returns an `Err`) if any region falls outside the given flash map, rather than silently skipping it — specifically because the old silent-skip behaviour is unsafe. Comment at `rust/crates/device/src/dfuse.rs:1-20` explains the broader motivation: trust the device's own DfuSe memory-layout string (ST AN3156 format) rather than a hardcoded chip map, because a radio in this family withholds the bootloader's own sectors from what it advertises, and a hardcoded map starting lower than that is a bricking hazard.

### 6.2 What the segment is (reasoned, not fully confirmed)

- It is **not** internal MCU flash — `0x00060000` is far below the STM32's `0x08000000` flash base.
- The newer radio_tool explicitly documents a second DfuSe alternate-interface memory region on a sibling radio in the *same firmware-container family* (the Baofeng DM-1701, which shares the `OutSecurityBin` format): `"@SPI Flash Memory /0x00000000/16*064Kg"` — an external SPI NOR flash chip, addressed starting at `0x00000000`, selected via `SET_INTERFACE`/alternate-setting rather than the normal internal-flash DFU interface (`rust/crates/device/src/dfuse.rs:258`, test confirms `start()==0`, `size()==1MiB`). `0x00060000` is a plausible offset *into* such a chip.
- The content is **not** the AMBE codec — §5 showed conclusively (exact, matching byte-for-byte arithmetic from two independent files) that the codec lives inside the `0x0800c000` internal-flash image, not here.
- Since radio_tool wrote only `0x0800c000` today and the radio worked (per the task's framing — the flash succeeded), whatever lives at `0x00060000` is **not required for the radio to boot or for DMR voice to work**. Plausible candidates, by elimination and by analogy with other TYT/Baofeng radios in this family: factory voice-prompt audio samples, calibration/backup data, or GPS map/POI data stored in external SPI flash that ships pre-written and is not normally rewritten by a firmware update. **This specific content is not confirmed — see §8.**

---

## 7. The flash sequence, end to end (for the gd77-web Firmware tab)

### 7.1 Stock TYT firmware → radio (no merge needed)
1. Connect over WebUSB to VID `0x0483` PID `0xDF11`.
2. Load the TYT container file, read the 128-byte header, validate the start magic `OutSecurityBin\0\0` and that `counter_magic` matches a known model (§3.2) — **reject anything else before touching the device**.
3. Decrypt (XOR) the data stream with the cipher matching the file's `counter_magic` (§3.3).
4. `0x91 0x01` (ProgrammingMode), `0x91 0x31` (FirmwareUpgrade).
5. For each region: erase every sector it overlaps (§2.5 step 2); `SetAddress(region.start)`; write 1024-byte blocks, `wValue` from 2 upward.
6. `SetAddress(0x08000000)`; zero-length DNLOAD to reset/jump. Treat the resulting disconnect as success.

### 7.2 OpenGD77 firmware → radio (with codec merge)
1. Take the user's two files: OpenGD77 `.bin` (plain, flat) and a stock TYT donor `.bin` (any MD-9600-family firmware_model file).
2. Re-encrypt donor's own data isn't needed wholesale — only decrypt the one 297,904-byte AMBE slice at the fixed offset (§5.1–5.2), using the **MD9600 cipher** at phase `892`.
3. Splice that decrypted slice into the OpenGD77 image at the same fixed offset.
4. Re-encrypt the *entire* combined image with the cipher matching the **target** model being flashed (§3.3; e.g. the `UV3X0`/"MDUV380" table for an MD-UV380/390/RT3S).
5. Flash exactly as §7.1 steps 4–6, using the fixed region table `0x0800C000, 0x08010000, 0x08020000, 0x08040000, 0x08060000, 0x08080000, 0x080A0000, 0x080C0000, 0x080E0000` with sizes `0x4000, 0x10000, 0x20000×7` (`webusb.js:7227-7234`) — i.e. OpenGD77 images for this family are always written starting at `0x0800c000` with no other region to worry about.

---

## 8. Safety checks — what to build that neither existing tool does

1. **Validate the DFU device is actually this family before erasing anything**: VID `0x0483` / PID `0xDF11` (§2.1), *and* read TYT register `0x01` (`0xA2, 0x01` → Upload 1024 bytes) to get the radio's own declared model string, and refuse/warn on mismatch against the firmware file's `counter_magic`-derived model. **Neither radio_tool's CLI nor grid.radio does this before writing** (confirmed by reading both; §2.4). This is the single most load-bearing safety gap worth closing, since a wrong cipher/region table for this hardware family is a bricking risk (§2.5 step 3's DM-1701 brick anecdote).
2. **Validate container magic/region table before any erase**, not just before writing (`OutSecurityBin\0\0` start, `OutputBinDataEnd` end, region count ≤ 16, each region inside the known flash map) — refuse rather than silently skip a region outside the map, matching the Rust rewrite's fix (§6.1) rather than the old C++/JS behaviour.
3. **Validate donor file size and magic** before attempting the codec splice (grid.radio only checks length, and even then just warns and silently flashes a codec-less image — §5.4). Reject outright rather than proceed with a partial merge.
4. **Confirm the write actually landed**: there is no read-back/verify step in either reference tool. Consider an optional post-write UPLOAD-and-compare if the bootloader supports it (not confirmed either way — see below).
5. Treat a mid-flash USB disconnect **after** the final zero-length DNLOAD as expected success (both tools do this; a disconnect *before* that point is a real failure and must be surfaced as such).

---

## 9. Licensing summary

| Source | Licence | Implication |
|---|---|---|
| radio_tool (C++ and Rust) | **GPLv3**, full text at `radio_tool/LICENSE` | Facts/protocol/offsets freely usable; do not copy its source code (including its cipher byte-array literals verbatim) into gd77-web without the project becoming GPLv3. |
| grid.radio's `firmware.js`/`webusb.js`/`stm32_ciphers.js`/`mk22_cipher.js` | **No licence statement found anywhere on the page, in the JS file headers, in a footer, or a linked LICENSE file.** Only a copyright-notices modal crediting the *OpenGD77 firmware project* for components it bundles — nothing about grid.radio's own JS. Default is "all rights reserved." | **Must not copy this code.** The task's instruction to reimplement from description only is the right approach and is what this document supports. |
| OpenGD77 firmware itself | **Modified BSD with an explicit non-commercial clause**: *"Use of this source code or binary releases for commercial purposes is strictly forbidden… including incorporation into a product or project which allows commercial use."* (full text at `grid-opengd77.html:4858-4877`, `Copyright (C) 2019-2024 OpenGD77 firmware developers`) | This governs the OpenGD77 **firmware binary** the user supplies, not gd77-web's own code — gd77-web isn't distributing or incorporating that firmware, just accepting a user-supplied file and transforming it locally in the browser. But if gd77-web or Dock360 has any commercial dimension, this clause is worth a deliberate decision rather than an assumption — **flagging for Brian, not resolving it myself.** |

The **vendor XOR cipher tables** (1024-byte arrays, §3.3) sit in an awkward spot: they are TYT's own proprietary data, extracted/reverse-engineered by both of the above projects, and appear byte-for-byte identical in both the GPLv3 radio_tool source and the unlicensed grid.radio source. Whether a 1024-byte vendor constant is itself copyrightable expression (as opposed to a fact) is a real question I can't resolve as a researcher. **Recommend the builder either derive the key independently (e.g., by XOR-ing a known plaintext/ciphertext pair from a real firmware file, which is a mechanical, non-copying operation) or get an explicit decision from Brian before transcribing the array from either source.**

---

## 10. Unconfirmed — explicit list

1. **Exact content of the `0x00060000` segment.** Strong circumstantial evidence it's an external SPI-flash region (by analogy with the DM-1701's documented second DfuSe interface) and that it's not required for boot or DMR voice (since today's flash omitted it and worked), but I did not find a source that states what data it actually holds (voice prompts / calibration backup / GPS data / something else).
2. **Whether the RT3S itself (as opposed to the DM-1701) actually exposes a second DfuSe alternate-interface for that SPI region**, or whether `0x00060000` on this specific hardware is unreachable from the DFU interface at all. I found the DfuSe-string evidence only for the DM-1701, not for a UV3X0/RT3S device string directly (no USB device was opened this session, per the task's hard rule).
3. **Whether grid.radio validates the connected device's actual model (via TYT register `0x01`) anywhere I didn't find** — I searched its full JS bundle for register-read calls in the DFU flashing path and found none, but a web app's full control flow across multiple files is hard to rule out exhaustively by grep alone.
4. **The precise 1024-byte phase/offset convention if a future donor file has region boundaries that don't exactly match the `MD9600-CSV(2571V5)-V26.45.bin` donor's.** My arithmetic matched exactly for that specific file; a different TYT firmware version's region-table lengths could in principle shift the byte math, though the `TARGET_OFFSET`/`DONOR_OFFSET` constants are hardcoded in grid.radio's JS regardless of which donor is supplied, implying the TYT vendor keeps this layout stable across versions — but I haven't verified that stability across more than the one donor file in hand.
5. **Whether OpenGD77's own build process padding (the `0xFF` region) is *always* exactly `AMBE_SECTION_SIZE` at `TARGET_OFFSET` across all OpenGD77 variants/versions for this family**, or whether this was only confirmed for the one `OpenMDUV380.bin` (`PD0FR_SMS_23_3`) build I downloaded and checked.
6. **GPS vs non-GPS firmware_model distinction** (`UV3X0` vs `UV3X0_GPS` magic) — both exist and must be matched to the specific radio variant; I did not determine a way to tell them apart other than the user knowing their own hardware, and neither reference tool auto-detects it from the DFU-mode identify register in a way I could confirm.

---

## Sources

- `/home/user/build/rt3s-flash/radio_tool/` (GPLv3) — C++: `include/radio_tool/dfu/dfu.hpp`, `src/dfu.cpp`, `include/radio_tool/dfu/tyt_dfu.hpp`, `src/tyt_dfu.cpp`, `include/radio_tool/radio/tyt_radio.hpp`, `src/tyt_radio.cpp`, `include/radio_tool/fw/tyt_fw.hpp`, `src/tyt_fw.cpp`, `include/radio_tool/fw/cipher/uv3x0.hpp`, `include/radio_tool/util/flash.hpp`, `include/radio_tool/fw/fw.hpp`, `src/usb_radio_factory.cpp`, `README.md`, `LICENSE`, `CHANGELOG.md`. Rust rewrite: `rust/crates/device/src/dfu.rs`, `rust/crates/device/src/dfuse.rs`, `rust/crates/device/src/flash.rs`, `rust/crates/device/src/usb.rs`, `rust/crates/firmware/src/tyt.rs`.
- `/home/user/build/rt3s-flash/flash.log` — today's real flash log (0483:df11, UV3X0 family).
- `/home/user/build/rt3s-flash/firmware/MD-UV380(CSV)-V18.11.bin` and `md9600-donor.bin` (downloaded this session from grid.radio) — direct header/region inspection.
- `/home/user/build/rt3s-flash/OPENGD77-RETURN.md` — earlier unverified hypothesis; corrected by §5–6 above.
- https://grid.radio/opengd77/ — fetched page + JS bundle, saved to scratchpad `fw/`: `firmware.js`, `webusb.js`, `stm32_ciphers.js`, `mk22_cipher.js`, `g77.js`, `config.js`, `app.js`, `firmware_manifest.json`, donor file, and `OpenMDUV380.bin` (R20260131-line build `PD0FR_SMS_23_3`).

All file paths above with line numbers are cited inline in the relevant section.