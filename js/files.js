// Codeplug files.
//
// Stock firmware: dmrconfig's raw .img, 131072 bytes, block 0 tagged
// "MD-760P" (dmrconfig gd77.c gd77_download / gd77_is_compatible). Other
// radios in the family write the same kind of file with a different tag
// ("BF-5R" for the RD-5R); those are refused because their layout differs.
//
// OpenGD77: the JSON backup format of ReallyOpenGD77 WebCPSd (.gd77backup),
// so a backup made here restores there and the other way round: base64
// segments with their bank, address and size, tagged with the radio family.

import { Image } from './codeplug/image.js';
import { STOCK, OPENGD77, OPENGD77_STM32, LAYOUTS } from './codeplug/layouts.js';
import { toBase64, fromBase64, bytesEqual } from './util.js';
import { isGd77Image, detectStockLayout, detectG77Firmware, openGD77FromG77, g77FromImage } from './g77.js';

export const BACKUP_FORMAT = 'ReallyOpenGD77-WebCPSd-flash-backup';

export function stockImageToFile(image) {
  const out = image.segs[0].data.slice();
  out.fill(0xff, 0, 0x80);
  out.set(Uint8Array.from('MD-760P', c => c.charCodeAt(0)), 0);
  return out;
}

export function stockImageFromFile(bytes) {
  if (bytes.length !== 0x20000) throw new Error(`A GD-77 image is 131072 bytes; this file is ${bytes.length}`);
  const tag = String.fromCharCode(...bytes.subarray(0, 7));
  if (tag !== 'MD-760P') {
    const shown = String.fromCharCode(...bytes.subarray(0, 16)).replace(/[^\x20-\x7e].*$/, '');
    throw new Error(`This image is tagged "${shown}", not "MD-760P" (GD-77). Images from other radios cannot be used.`);
  }
  // Firmware 2.x radios use an older layout in the same 128K (g77.js).
  const layout = detectStockLayout(bytes);
  const image = new Image(layout.fw, [{ bank: 'mem', addr: 0, data: bytes.slice() }]);
  // dmrconfig stops reading at 0x1e2a0, so its files have 0xFF where the
  // tail of the RX group list table lives. Report that so a write can take
  // those bytes from the radio instead of erasing the lists.
  const tail = bytes.subarray(STOCK.dmrconfigEnd, 0x1eb00);
  const missingTail = tail.every(b => b === 0xff);
  return { image, layout, missing: missingTail ? [{ bank: 'mem', addr: STOCK.dmrconfigEnd, size: 0x1eb00 - STOCK.dmrconfigEnd }] : [] };
}

// radio_family 'W' = MK22 radios (GD-77 family), 'X' = STM32 radios
// (MD-UV380 family), as in WebCPSd. The same addresses mean different
// bytes in the two families, so a backup is only ever opened as the
// family it says it is, and a write to the other family is refused.
export function openGD77ToBackup(image, { radioName = 'OpenGD77 radio', created = new Date() } = {}) {
  const L = LAYOUTS[image.fw];
  const segs = json => L.segments.filter(s => s.json === json).map(s => {
    const data = image.view(s.bank, s.addr, s.size);
    return { addr: s.addr, size: s.size, data: toBase64(data) };
  });
  return JSON.stringify({
    format: BACKUP_FORMAT, version: 1, radio_family: L.family, radio_name: radioName,
    created: created.toISOString(), generator: 'gd77-web',
    eeprom: segs('eeprom'), flash: segs('flash'),
  });
}

export function openGD77FromBackup(text, { expectFamily = null } = {}) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('Not a JSON backup file'); }
  if (j.format !== BACKUP_FORMAT) throw new Error('Not an OpenGD77 backup (.gd77backup) file');
  const L = j.radio_family === 'W' ? OPENGD77 : j.radio_family === 'X' ? OPENGD77_STM32 : null;
  if (!L) throw new Error(`Backup has an unknown radio family "${j.radio_family}"`);
  if (expectFamily && expectFamily !== j.radio_family) {
    throw new Error(`This backup is from an ${familyName(j.radio_family)} radio, not an ${familyName(expectFamily)} one; the memory layouts differ`);
  }
  const segs = L.segments.map(w => {
    const s = (j[w.json] || []).find(g => g.addr === w.addr);
    if (!s) throw new Error(`Backup has no ${w.json} segment at 0x${w.addr.toString(16)}`);
    if (s.size !== w.size) throw new Error(`Backup ${w.json} segment at 0x${w.addr.toString(16)} is ${s.size} bytes, expected ${w.size}`);
    const data = fromBase64(s.data);
    if (data.length !== s.size) throw new Error('Backup segment data is truncated');
    return { bank: w.bank, addr: w.addr, data };
  });
  return { image: new Image(L.fw, segs), missing: [], radioName: j.radio_name, created: j.created };
}

export function familyName(f) { return f === 'X' ? 'STM32-family (MD-UV380 type)' : 'MK22-family (GD-77 type)'; }

// Detects the format from the content, not the file name. A 128K
// "MD-760P" image is a .g77 or a dmrconfig .img, which are the same thing;
// its layout (stock 3/4, stock 2.x or OpenGD77) is read from the content
// too (g77.js). `as` overrides the firmware guess for a 3/4-layout file:
// 'stock' or 'opengd77'.
export function openCodeplugFile(name, bytes, { as = null } = {}) {
  if (bytes.length === 0x20000) {
    if (!isGd77Image(bytes)) stockImageFromFile(bytes); // throws with the tag it found
    const layout = detectStockLayout(bytes);
    const guess = layout.fw === 'stock' ? detectG77Firmware(bytes) : { fw: layout.fw, evidence: layout.evidence, certain: true };
    const fw = layout.fw === 'stock' ? (as ?? guess.fw) : layout.fw;
    if (fw === 'opengd77') return { fw, detected: guess, ...openGD77FromG77(bytes) };
    return { fw, detected: guess, ...stockImageFromFile(bytes) };
  }
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64 << 20)));
  if (text.trimStart().startsWith('{')) { const r = openGD77FromBackup(text); return { fw: r.image.fw, ...r }; }
  throw new Error(`${name}: not a GD-77 .img (131072 bytes) or an OpenGD77 .gd77backup file`);
}

export function codeplugFile(image, meta = {}) {
  if (meta.format === 'g77') return { ext: 'g77', mime: 'application/octet-stream', data: g77FromImage(image) };
  if (image.fw === 'stock' || image.fw === 'stock-v2') return { ext: 'img', mime: 'application/octet-stream', data: stockImageToFile(image) };
  return { ext: 'gd77backup', mime: 'application/json', data: openGD77ToBackup(image, meta) };
}

// Bytes a file does not carry are taken from the radio's own read, so that
// writing an older dmrconfig image cannot erase what it never contained.
export function fillMissing(image, missing, from) {
  if (!missing?.length || !from) return image;
  const out = image.clone();
  for (const m of missing) out.view(m.bank, m.addr, m.size).set(from.view(m.bank, m.addr, m.size));
  return out;
}

export { bytesEqual };
