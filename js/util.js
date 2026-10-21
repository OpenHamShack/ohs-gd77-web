// Byte-level helpers shared by the codec, the transports and the simulators.
// Everything here works on plain Uint8Arrays so it runs unchanged in the
// browser and under node's test runner.

export function hex(n, width = 2) {
  return '0x' + n.toString(16).padStart(width, '0');
}

export function hexdump(bytes, max = 48) {
  const a = Array.from(bytes.slice(0, max), b => b.toString(16).padStart(2, '0'));
  return a.join(' ') + (bytes.length > max ? ' ...' : '');
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Text fields on both firmwares are ASCII padded with 0xFF; a 0x00 also ends
// a string (OpenGD77 sometimes leaves NULs behind). Characters outside
// printable ASCII are kept as-is so a decode/encode cycle cannot alter them.
export function readAscii(b, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = b[off + i];
    if (c === 0xff || c === 0x00) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function writeAscii(b, off, len, str, pad = 0xff) {
  str = String(str ?? '');
  for (let i = 0; i < len; i++) b[off + i] = i < str.length ? (str.charCodeAt(i) & 0xff) : pad;
}

export function getU16LE(b, o) { return b[o] | (b[o + 1] << 8); }
export function setU16LE(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; }
export function getU24BE(b, o) { return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]; }
export function setU24BE(b, o, v) { b[o] = (v >> 16) & 0xff; b[o + 1] = (v >> 8) & 0xff; b[o + 2] = v & 0xff; }
export function getU32LE(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

export function getBit(b, o, bit) { return (b[o] >> bit) & 1; }
export function setBit(b, o, bit, v) {
  if (v) b[o] |= (1 << bit); else b[o] &= ~(1 << bit) & 0xff;
}
export function getBits(b, o, shift, width) { return (b[o] >> shift) & ((1 << width) - 1); }
export function setBits(b, o, shift, width, v) {
  const mask = ((1 << width) - 1) << shift;
  b[o] = (b[o] & ~mask & 0xff) | ((v << shift) & mask);
}

// Packed BCD. Returns null rather than a number when any nibble is not a
// decimal digit: erased memory (0xFF) is common in unused records, and
// turning it into a plausible-looking number would invite a write-back that
// the user never asked for.
function digitsToNumber(digits) {
  let v = 0;
  for (const d of digits) { if (d > 9) return null; v = v * 10 + d; }
  return v;
}

// Big-endian: first byte holds the two most significant digits.
export function getBCDBE(b, o, nbytes) {
  const d = [];
  for (let i = 0; i < nbytes; i++) d.push(b[o + i] >> 4, b[o + i] & 15);
  return digitsToNumber(d);
}
export function setBCDBE(b, o, nbytes, v) {
  const s = String(Math.max(0, Math.trunc(v))).padStart(nbytes * 2, '0').slice(-nbytes * 2);
  for (let i = 0; i < nbytes; i++) b[o + i] = (Number(s[2 * i]) << 4) | Number(s[2 * i + 1]);
}

// Little-endian: first byte holds the two least significant digits.
export function getBCDLE(b, o, nbytes) {
  const d = [];
  for (let i = nbytes - 1; i >= 0; i--) d.push(b[o + i] >> 4, b[o + i] & 15);
  return digitsToNumber(d);
}
export function setBCDLE(b, o, nbytes, v) {
  const s = String(Math.max(0, Math.trunc(v))).padStart(nbytes * 2, '0').slice(-nbytes * 2);
  for (let i = 0; i < nbytes; i++) {
    const j = nbytes - 1 - i;
    b[o + i] = (Number(s[2 * j]) << 4) | Number(s[2 * j + 1]);
  }
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function timestamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// A tiny deterministic PRNG so simulator images and tests are reproducible.
export function prng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s & 0xff;
  };
}
