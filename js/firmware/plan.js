// What a firmware flash will write, worked out and checked entirely before
// any USB device is touched. Two modes:
//
//  stock:    a TYT file for the radio's model. Its internal-flash region is
//            written exactly as it sits in the file, still encrypted: the
//            bootloader decrypts as it writes (radio_tool writes the file's
//            region data without decrypting it). No key is needed.
//  opengd77: an OpenGD77 build (plain image for 0x0800C000 with a blank
//            placeholder where the proprietary AMBE codec goes), the
//            MD-9600 donor file that holds the codec, and a TYT file for
//            the radio's own model. The codec is decrypted out of the donor
//            with the donor's key, spliced into the OpenGD77 image, and the
//            whole image is encrypted with the radio's key, both keys
//            recovered from the files themselves (tyt.js).
//
// Regions outside internal flash (stock files carry one at 0x00060000,
// probably external SPI data) are listed as not written: radio_tool skips
// them without saying so, and the 21/10/2026 flash of the RT3S that wrote
// only 0x0800C000 left a working radio. Anything that would touch the
// bootloader's sectors below 0x0800C000 is refused outright.

import { parseTyt, keyFor, xor, vectorTableOk, sha256Hex, APP_BASE, FLASH_END } from './tyt.js';

// STM32F40x sectors (docs/firmware.md §2.6); the first three hold the
// bootloader and are never in a plan.
export const SECTORS = [
  [0x08000000, 0x4000], [0x08004000, 0x4000], [0x08008000, 0x4000], [0x0800c000, 0x4000], [0x08010000, 0x10000],
  [0x08020000, 0x20000], [0x08040000, 0x20000], [0x08060000, 0x20000], [0x08080000, 0x20000],
  [0x080a0000, 0x20000], [0x080c0000, 0x20000], [0x080e0000, 0x20000],
].map(([addr, size]) => ({ addr, size }));

// The codec: 297,904 bytes at flash 0x0807537C in both the MD-9600 donor
// and every OpenGD77 build for this family (docs/firmware.md §5).
export const CODEC_ADDR = 0x0807537c;
export const CODEC_SIZE = 0x48bb0;

// Donor files whose codec is known to sit at CODEC_ADDR: the offsets are
// fixed, so an unknown donor could splice the wrong bytes. SHA-256 of
// MD9600-CSV(2571V5)-V26.45.bin (1,096,192 bytes), the donor grid.radio
// uses and docs/firmware.md checked.
export const KNOWN_DONORS = {
  d8a653307222e576ee416ab6d4704d14758fa71c1b0e826ffd840f26266cf11f: 'TYT MD-9600 V26.45 (MD9600-CSV(2571V5)-V26.45.bin)',
};

function sectorsFor(addr, len) {
  const out = [];
  for (const s of SECTORS) if (s.addr < addr + len && s.addr + s.size > addr) out.push(s);
  if (out.some(s => s.addr < APP_BASE)) throw new Error('This image would overwrite the bootloader; refusing');
  if (addr + len > FLASH_END) throw new Error('This image runs past the end of flash; refusing');
  return out;
}

// Split an image for APP_BASE into per-sector writes: each starts with
// SetAddress(sector) and numbers its 1024-byte blocks from wValue 2, as
// both reference tools do and as the 21/10 flash log shows.
function sectorWrites(addr, data) {
  return sectorsFor(addr, data.length).map(s => {
    const from = Math.max(s.addr, addr), to = Math.min(s.addr + s.size, addr + data.length);
    return { addr: from, data: data.subarray(from - addr, to - addr) };
  });
}

export function planStock(tytBytes, label = 'TYT firmware file') {
  const fw = parseTyt(tytBytes, label);
  if (!fw.family.supported) throw new Error(`${label} is for a ${fw.family.name}; this page only flashes the MD-UV380/390, RT3S, MD-9600 and MD-2017`);
  // The bootloader decrypts at (address - 0x0800C000) mod 1024, which only
  // matches the file's own encryption if the region starts on a 1024-byte
  // boundary of the data stream, as in every file seen so far.
  if (fw.app.streamOff % 1024) throw new Error(`${label} has an unexpected layout (application image not 1024-aligned in the file); refusing`);
  const excluded = fw.regions.filter(r => !r.internal);
  const image = fw.stream.subarray(fw.app.streamOff, fw.app.streamOff + fw.app.len);
  return {
    mode: 'stock', family: fw.family, keyFamily: fw.family.key,
    imageEncrypted: image, writes: sectorWrites(APP_BASE, image), erase: sectorsFor(APP_BASE, image.length),
    excluded: excluded.map(r => ({ addr: r.addr, len: r.len, why: 'outside the radio\'s internal flash; not written (radio_tool does not write it either)' })),
    codecMerged: false,
  };
}

export async function planOpenGD77({ ogd, donor, target, allowUnknownDonor = false }) {
  // OpenGD77 build: a bare image for 0x0800C000 with the codec placeholder blank.
  if (!vectorTableOk(ogd)) throw new Error('The OpenGD77 file does not start with a valid program for this radio (no vector table); is it the MD-UV380 build?');
  if (ogd.length > FLASH_END - APP_BASE) throw new Error('The OpenGD77 file is larger than the radio\'s flash');
  if (ogd.length < CODEC_ADDR - APP_BASE + CODEC_SIZE) throw new Error('The OpenGD77 file is too short to hold the codec');
  const placeholder = ogd.subarray(CODEC_ADDR - APP_BASE, CODEC_ADDR - APP_BASE + CODEC_SIZE);
  if (!placeholder.every(b => b === 0xff)) throw new Error('The OpenGD77 file has data where the codec goes (0x6937C); it is not a build this page knows how to merge into');

  // Donor: a known MD-9600 file, its codec region inside its 0x0800C000 image.
  const d = parseTyt(donor, 'The donor file');
  const hash = await sha256Hex(donor);
  if (!KNOWN_DONORS[hash] && !allowUnknownDonor) throw new Error(`The donor file is not one whose codec position is known (SHA-256 ${hash.slice(0, 16)}…). Use the TYT MD-9600 V26.45 file.`);
  if (d.app.len < CODEC_ADDR - APP_BASE + CODEC_SIZE) throw new Error('The donor file is too short to contain the codec');
  const donorKey = keyFor(d, 'the donor file');
  const codecOff = d.app.streamOff + (CODEC_ADDR - APP_BASE);
  const codec = xor(d.stream.subarray(codecOff, codecOff + CODEC_SIZE), donorKey.key, codecOff);
  if (codec.every(b => b === 0xff) || codec.every(b => b === 0)) throw new Error('The donor file has no codec at the expected place');

  // Target: the radio's own TYT file, for its key and model.
  const t = parseTyt(target, 'Your radio\'s TYT firmware file');
  if (!t.family.supported) throw new Error(`Your radio's TYT file is for a ${t.family.name}; not supported`);
  const targetKey = t.family.key === d.family.key ? donorKey : keyFor(t, 'your radio\'s TYT firmware file');

  // Merge, pad to whole 1024-byte blocks with 0xFF (in the plaintext, so
  // the radio decrypts the tail to erased flash), then encrypt from 0.
  const plain = new Uint8Array(Math.ceil(ogd.length / 1024) * 1024).fill(0xff);
  plain.set(ogd);
  plain.set(codec, CODEC_ADDR - APP_BASE);
  const enc = xor(plain, targetKey.key, 0);
  return {
    mode: 'opengd77', family: t.family, keyFamily: t.family.key,
    imagePlain: plain, imageEncrypted: enc, writes: sectorWrites(APP_BASE, enc), erase: sectorsFor(APP_BASE, enc.length),
    excluded: [], codecMerged: true, donor: KNOWN_DONORS[hash] || 'unrecognised donor', donorHash: hash,
    keyConfidence: { donor: donorKey.minGap, target: targetKey.minGap },
  };
}
