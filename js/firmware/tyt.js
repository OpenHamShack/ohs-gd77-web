// TYT firmware files and their encryption, for the MD-UV380 family
// (MD-UV380/390, Retevis RT3S, MD-9600, MD-2017). Facts from
// docs/firmware.md, corrected where the real files showed otherwise.
//
// The encryption is a 1024-byte repeating XOR over the concatenated data of
// all regions. We do not ship the key: it is recovered at run time from the
// user's own TYT file. Firmware plaintext is dominated by a few byte values
// (0x00 above all), so for each of the 1024 key positions the key byte is
// the value that makes the ~1,250 ciphertext bytes at that position decrypt
// to the most firmware-like distribution. One pass of "most common
// ciphertext byte = key XOR 0x00" gets close; a second pass scores every
// candidate against the plaintext byte distribution that the first key
// produces and settles the rest. The winning candidate beats the runner-up
// by over 200 nats on every position of the real V18.11 and MD-9600 files,
// and the result is accepted only if it also decrypts to a valid Cortex-M
// vector table at 0x0800C000. (The doc's suggestion of reading the key off
// a long 0xFF run does not work on these files: no run is 1024 bytes long.)

export const START_MAGIC = 'OutSecurityBin\0\0';
export const END_MAGIC = 'OutputBinDataEnd';
export const APP_BASE = 0x0800c000;
export const FLASH_END = 0x08100000;

// counter_magic -> model family (docs/firmware.md §3.2). `key` names which
// key family the file is encrypted with: the files show MD-9600 and the
// MD-UV380 family use DIFFERENT keys, though the doc said one.
export const MODELS = [
  { magic: [0x02, 0x16, 0x0c], id: 'UV3X0_GPS', name: 'MD-UV380/390 or RT3S, GPS', key: 'UV3X0', supported: true, gps: true },
  { magic: [0x02, 0x17, 0x0c], id: 'UV3X0', name: 'MD-UV380/390 or RT3S, no GPS', key: 'UV3X0', supported: true, gps: false },
  { magic: [0x01, 0x14], id: 'MD9600', name: 'MD-9600', key: 'MD9600', supported: true },
  { magic: [0x02, 0x19, 0x0c], id: 'MD2017_GPS', name: 'MD-2017, GPS', key: 'MD2017', supported: true, gps: true },
  { magic: [0x02, 0x18, 0x0c], id: 'MD2017', name: 'MD-2017', key: 'MD2017', supported: true, gps: false },
  { magic: [0x01, 0x19], id: 'MD2017_GPS', name: 'MD-2017, GPS', key: 'MD2017', supported: true, gps: true },
  { magic: [0x01, 0x18], id: 'MD2017', name: 'MD-2017', key: 'MD2017', supported: true, gps: false },
  // Recognised so they can be refused by name. The DM-1701 has its own key
  // and an external flash interface the doc does not pin down; the MD-380
  // family is a different bootloader.
  { magic: [0x01, 0x0f], id: 'DM1701', name: 'Baofeng DM-1701', supported: false },
  { magic: [0x01, 0x10], id: 'MD390', name: 'MD-390', supported: false },
  { magic: [0x01, 0x0d], id: 'MD380', name: 'MD-380/446', supported: false },
  { magic: [0x01, 0x1b], id: 'MD280', name: 'MD-280', supported: false },
];

// What the bootloader's register 0x01 says, per model family. The real
// RT3S said "MD-UV390" (radio_tool --info, 21/10/2026).
export const BOOTLOADER_NAMES = { UV3X0: /^(MD-UV3[89]0|RT3S)/i, MD9600: /^MD-9600/i, MD2017: /^MD-2017/i };

const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function parseTyt(bytes, label = 'file') {
  if (bytes.length < 0x200) throw new Error(`${label} is too short to be a TYT firmware file`);
  if (ascii(bytes, 0, 16) !== START_MAGIC) throw new Error(`${label} is not a TYT firmware file (no "OutSecurityBin" header)`);
  if (ascii(bytes, bytes.length - 16, 16) !== END_MAGIC) throw new Error(`${label} is truncated or damaged (no "OutputBinDataEnd" trailer)`);
  const model = ascii(bytes, 0x10, 16).replace(/[\0\xff].*$/s, '');
  const clen = bytes[0x30];
  if (clen < 1 || clen > 75) throw new Error(`${label}: unreadable model identifier`);
  // The identifier is a length byte and that many bytes; the known
  // identifiers are written including the length byte.
  const magic = Array.from(bytes.subarray(0x30, 0x31 + clen));
  const m = MODELS.find(x => x.magic.length === magic.length && x.magic.every((v, i) => v === magic[i]));
  if (!m) throw new Error(`${label}: unknown model identifier ${magic.map(x => x.toString(16).padStart(2, '0')).join(' ')}`);
  let n = u32(bytes, 0x7c);
  if (n === 0xffffffff) n = 1;
  if (n < 1 || n > 16) throw new Error(`${label}: impossible region count ${n}`);
  const regions = [];
  let off = 0;
  for (let i = 0; i < n; i++) {
    const addr = u32(bytes, 0x80 + 8 * i), len = u32(bytes, 0x84 + 8 * i);
    if (!len || len > 0x200000) throw new Error(`${label}: region ${i} has impossible length 0x${len.toString(16)}`);
    regions.push({ addr, len, streamOff: off });
    off += len;
  }
  if (0x100 + off + 256 !== bytes.length) throw new Error(`${label}: the regions (${off} bytes) do not match the file size`);
  const stream = bytes.subarray(0x100, 0x100 + off);
  const app = regions.find(r => r.addr === APP_BASE);
  if (!app) throw new Error(`${label} has no application image at 0x0800C000`);
  for (const r of regions) {
    const internal = r.addr >= 0x08000000 && r.addr < FLASH_END;
    if (internal && (r.addr < APP_BASE || r.addr + r.len > FLASH_END)) {
      throw new Error(`${label}: region 0x${r.addr.toString(16)}+0x${r.len.toString(16)} would touch the bootloader or run past the end of flash`);
    }
    r.internal = internal;
  }
  return { model, magic, family: m, regions, stream, app, bytes };
}

export function xor(data, key, phase = 0) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[(i + phase) & 1023];
  return out;
}

// Returns { key, minGap }: the 1024-byte key and the weakest position's
// margin (log-likelihood of the winner over the runner-up).
export function deriveKey(stream) {
  const counts = Array.from({ length: 1024 }, () => new Uint32Array(256));
  for (let i = 0; i < stream.length; i++) counts[i & 1023][stream[i]]++;
  const key = new Uint8Array(1024);
  for (let j = 0; j < 1024; j++) {
    let best = 0;
    for (let v = 1; v < 256; v++) if (counts[j][v] > counts[j][best]) best = v;
    key[j] = best; // assumes plaintext 0x00 is the commonest byte
  }
  const hist = new Float64Array(256);
  for (let j = 0; j < 1024; j++) for (let v = 0; v < 256; v++) hist[v ^ key[j]] += counts[j][v];
  const total = hist.reduce((a, b) => a + b, 0);
  const logp = hist.map(h => Math.log((h + 1) / (total + 256)));
  let minGap = Infinity;
  for (let j = 0; j < 1024; j++) {
    const c = counts[j];
    const present = [];
    for (let v = 0; v < 256; v++) if (c[v]) present.push(v);
    let best = -Infinity, second = -Infinity, bestK = 0;
    for (let k = 0; k < 256; k++) {
      let s = 0;
      for (const v of present) s += c[v] * logp[v ^ k];
      if (s > best) { second = best; best = s; bestK = k; } else if (s > second) second = s;
    }
    key[j] = bestK;
    minGap = Math.min(minGap, best - second);
  }
  return { key, minGap };
}

export function vectorTableOk(b, off = 0) {
  if (b.length < off + 8) return false;
  const sp = u32(b, off), reset = u32(b, off + 4);
  return sp >= 0x20000000 && sp <= 0x20020000 && (sp & 3) === 0 && (reset & 1) === 1 && reset > APP_BASE && reset < FLASH_END;
}

// The key for a parsed file, checked: confident on every position and
// decrypting to a plausible vector table at 0x0800C000.
export function keyFor(fw, label = 'file') {
  const { key, minGap } = deriveKey(fw.stream);
  const vt = xor(fw.stream.subarray(fw.app.streamOff, fw.app.streamOff + 8), key, fw.app.streamOff);
  if (minGap < 30 || !vectorTableOk(vt)) {
    throw new Error(`Could not recover the encryption key from ${label} with confidence; it may not be a genuine TYT firmware file. Nothing was written.`);
  }
  return { key, minGap };
}

export async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), x => x.toString(16).padStart(2, '0')).join('');
}
