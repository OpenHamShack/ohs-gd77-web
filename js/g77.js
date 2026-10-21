// .g77 codeplug files (Radioddity CPS, OpenGD77 CPS) and how they relate to
// the images this page reads from radios.
//
// A .g77 is a 131072-byte copy of the GD-77's codeplug memory starting
// "MD-760P", which is also exactly what dmrconfig's .img is: the address of
// every record is the same, and the stock wire image *is* the file. Nothing
// in the content reliably says which tool saved it, and nothing needs to:
// what matters is which layout the bytes follow, and the file can follow
// three:
//
//  - stock firmware 3.x/4.x ("stock"): contacts at 0x17620. dmrconfig, qdmr.
//  - stock firmware 2.x ("stock-v2"): contacts at 0x1788, scan lists at
//    0x17620 (layouts.js STOCK_V2). The CPS writes the radio's firmware
//    version string at 0xB8 ("V2.06.05" in the real file), which is the
//    first thing checked.
//  - OpenGD77: the same 128K window over OpenGD77's EEPROM (same addresses)
//    and flash, whose codeplug part is shifted down by 0x70000 (channel
//    banks 1-7 0x7b1b0 -> 0xb1b0, contacts 0x87620 -> 0x17620, group lists
//    0x8d620 -> 0x1d620), per ReallyOpenGD77 WebCPSd's G77_FLASH_OFFSET.
//    The satellite block in flash 0x0-0x2000 is not in a .g77 at all.
//    These files keep the stock 3/4 addresses but OpenGD77's channel
//    record, so they are told apart by the channels themselves (below).

import { Image } from './codeplug/image.js';
import { OPENGD77 } from './codeplug/layouts.js';
import { readAscii, getBCDBE } from './util.js';

export const G77_SIZE = 0x20000;
export const G77_FLASH_SHIFT = 0x70000;
const TAG = Uint8Array.from('MD-760P\xff', c => c.charCodeAt(0));

export function isGd77Image(bytes) {
  return bytes.length === G77_SIZE && String.fromCharCode(...bytes.subarray(0, 7)) === 'MD-760P';
}

// The firmware version the CPS recorded at 0xB8, e.g. "V2.06.05", or ''.
export function recordedFirmware(bytes) {
  const v = readAscii(bytes, 0xb8, 8);
  return /^V\d+\.\d+/.test(v) ? v : '';
}

function plausibleContacts(bytes, addr, count) {
  let n = 0;
  for (let i = 0; i < count; i++) {
    const o = addr + i * 24;
    const c = bytes[o];
    if (c < 0x20 || c > 0x7e) continue;
    if (getBCDBE(bytes, o + 16, 4) === null || bytes[o + 20] > 2) continue;
    n++;
  }
  return n;
}

// Which stock layout an image follows: { fw, evidence }.
export function detectStockLayout(bytes) {
  const v = recordedFirmware(bytes);
  if (v) return { fw: Number(v.slice(1).split('.')[0]) <= 2 ? 'stock-v2' : 'stock', evidence: `firmware version ${v} recorded in the file` };
  const old = plausibleContacts(bytes, 0x1788, 256), cur = plausibleContacts(bytes, 0x17620, 256);
  if (old > cur) return { fw: 'stock-v2', evidence: `${old} contacts in the firmware 2.x place (0x1788), ${cur} in the 3/4 place` };
  return { fw: 'stock', evidence: cur ? `${cur} contacts in the firmware 3/4 place (0x17620)` : 'no firmware version or contacts to go on; assumed firmware 3/4' };
}

// Stock or OpenGD77, for a file in the 3/4 layout. Stock channels always
// carry 0x50 at byte 0x1E (qdmr ChannelElement::clear) and 0 at 0x19;
// OpenGD77 uses 0x19 for power (0-10) and 0x1E for the fixed position.
export function detectG77Firmware(bytes) {
  let stock = 0, ogd = 0;
  const bm = bytes.subarray(0x3780, 0x3790);
  for (let i = 0; i < 128; i++) {
    if (!((bm[i >> 3] >> (i & 7)) & 1)) continue;
    const c = bytes.subarray(0x3790 + i * 0x38, 0x3790 + (i + 1) * 0x38);
    if (c[0x1e] === 0x50 && c[0x19] === 0) stock++;
    else if (c[0x19] <= 10) ogd++;
  }
  if (!stock && !ogd) return { fw: 'stock', evidence: 'no channels to go on; assumed stock firmware', certain: false };
  return ogd > stock
    ? { fw: 'opengd77', evidence: `${ogd} of ${ogd + stock} channels use OpenGD77's channel record`, certain: stock === 0 }
    : { fw: 'stock', evidence: `${stock} of ${ogd + stock} channels use the stock channel record`, certain: ogd === 0 };
}

// OpenGD77 image <- .g77. The satellite segment is not in the file; it is
// reported as missing so a write takes it from the radio's own read.
export function openGD77FromG77(bytes) {
  const segs = OPENGD77.segments.map(s => {
    const data = new Uint8Array(s.size).fill(0xff);
    if (s.bank === 'eeprom') data.set(bytes.subarray(s.addr, s.addr + s.size));
    else if (s.addr >= G77_FLASH_SHIFT) data.set(bytes.subarray(s.addr - G77_FLASH_SHIFT, s.addr - G77_FLASH_SHIFT + s.size));
    return { bank: s.bank, addr: s.addr, data };
  });
  const missing = OPENGD77.segments.filter(s => s.bank === 'flash' && s.addr < G77_FLASH_SHIFT).map(s => ({ bank: s.bank, addr: s.addr, size: s.size }));
  return { image: new Image('opengd77', segs), missing };
}

// .g77 <- image. Stock images are the file already (block 0 tagged);
// OpenGD77 images are laid out as above. OpenGD77 on the STM32 radios has
// a different map and no .g77 form that this page knows.
export function g77FromImage(image) {
  if (image.fw === 'stock' || image.fw === 'stock-v2') {
    const out = image.segs[0].data.slice();
    if (String.fromCharCode(...out.subarray(0, 7)) !== 'MD-760P') out.set(TAG);
    return out;
  }
  if (image.fw !== 'opengd77') throw new Error('Only GD-77-family codeplugs can be saved as .g77');
  const out = new Uint8Array(G77_SIZE).fill(0xff);
  out.set(TAG);
  for (const s of image.segs) {
    if (s.bank === 'eeprom') out.set(s.data, s.addr);
    else if (s.addr >= G77_FLASH_SHIFT) out.set(s.data, s.addr - G77_FLASH_SHIFT);
  }
  return out;
}
