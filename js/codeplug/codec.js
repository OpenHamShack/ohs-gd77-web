// Decodes a codeplug image into an editable model and encodes the model back.
//
// The rule that shapes this file: encoding never rebuilds a record from the
// model. Each decoded record remembers the values it was decoded with
// (`_orig`), and encode() writes only the fields whose value has changed,
// directly into a copy of the original bytes. An untouched codeplug
// therefore encodes to the identical image, bytes we do not understand
// survive any number of edits, and a value we can only half-decode (a tone
// code that is not valid BCD, an erased frequency) is never "normalised"
// behind the user's back.

import { Image } from './image.js';
import { LAYOUTS } from './layouts.js';
import {
  readAscii, writeAscii, getU16LE, setU16LE, getBit, setBit, getBits, setBits,
  getBCDBE, setBCDBE, getBCDLE, setBCDLE,
} from '../util.js';

// --- tones -------------------------------------------------------------------
// 16-bit code: bit 15 = DCS, bit 14 = inverted (DCS only), low 14 bits = four
// BCD digits of the CTCSS frequency × 10 or the octal DCS code; 0xFFFF = off
// (qdmr opengd77base_codeplug.cc encode/decodeSelectiveCall; same on stock).

export function decodeTone(code) {
  if (code === 0xffff) return '';
  const dcs = (code >> 15) & 1, inv = (code >> 14) & 1, bcd = code & 0x3fff;
  const d = [(bcd >> 12) & 15, (bcd >> 8) & 15, (bcd >> 4) & 15, bcd & 15];
  // A non-BCD code is kept verbatim so that it encodes back to itself.
  if (d.some(x => x > 9) || (!dcs && inv)) return 'raw:' + code.toString(16).padStart(4, '0');
  const v = d[0] * 1000 + d[1] * 100 + d[2] * 10 + d[3];
  return dcs ? 'D' + String(v).padStart(3, '0') + (inv ? 'I' : 'N') : (v / 10).toFixed(1);
}

export function encodeTone(str) {
  const s = String(str ?? '').trim().toUpperCase();
  if (s === '' || s === 'OFF' || s === 'NONE') return 0xffff;
  if (s.startsWith('RAW:')) return parseInt(s.slice(4), 16) & 0xffff;
  let dcs = 0, inv = 0, v;
  const m = /^D(\d{1,3})([NI])?$/.exec(s);
  if (m) { dcs = 1; inv = m[2] === 'I' ? 1 : 0; v = parseInt(m[1], 10); if (/[89]/.test(m[1])) throw new Error(`DCS code ${s} is not octal`); }
  else {
    const f = Number(s);
    if (!Number.isFinite(f) || f < 30 || f > 300) throw new Error(`"${str}" is not a CTCSS tone (e.g. 88.5) or DCS code (e.g. D023N)`);
    v = Math.round(f * 10);
  }
  const bcd = ((Math.floor(v / 1000) % 10) << 12) | ((Math.floor(v / 100) % 10) << 8) | ((Math.floor(v / 10) % 10) << 4) | (v % 10);
  return (dcs << 15) | (inv << 14) | bcd;
}

// --- single fields -----------------------------------------------------------

export function readField(b, off, f) {
  switch (f.type) {
    case 'ascii': return readAscii(b, off, f.len);
    case 'u8': return b[off];
    case 'u16le': case 'ref16': return getU16LE(b, off);
    case 'ref8': return b[off];
    case 'bit': return getBit(b, off, f.bit);
    case 'bits': return getBits(b, off, f.shift, f.width);
    case 'bcd8be': return getBCDBE(b, off, 4);
    case 'bcd4le': return getBCDLE(b, off, 2);
    case 'freq': { const v = getBCDLE(b, off, 4); return v === null ? null : v * 10; }
    case 'tone': return decodeTone(getU16LE(b, off));
    case 'bcdstamp': {
      const d = getBCDBE(b, off, 6);
      if (d === null) return '';
      const s = String(d).padStart(12, '0');
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
    }
    default: throw new Error('Unknown field type ' + f.type);
  }
}

export function writeField(b, off, f, v) {
  if (f.readonly) return;
  // A select field may still show a raw value it found on the radio, but
  // the user can only set one of the listed values.
  if (f.options && !f.options.some(o => o[0] === Number(v))) {
    throw new Error(`${f.label || f.key}: ${v} is not one of ${f.options.map(o => o[0]).join(', ')}`);
  }
  switch (f.type) {
    case 'ascii': writeAscii(b, off, f.len, v); break;
    case 'u8': case 'ref8': b[off] = clampInt(v, 0, 255, f); break;
    case 'u16le': case 'ref16': setU16LE(b, off, clampInt(v, 0, 65535, f)); break;
    case 'bit': setBit(b, off, f.bit, v ? 1 : 0); break;
    case 'bits': setBits(b, off, f.shift, f.width, clampInt(v, 0, (1 << f.width) - 1, f)); break;
    case 'bcd8be': setBCDBE(b, off, 4, clampInt(v, 0, 99999999, f)); break;
    case 'bcd4le': setBCDLE(b, off, 2, clampInt(v, 0, 9999, f)); break;
    case 'freq':
      // An emptied frequency goes back to erased flash rather than 0 Hz.
      if (v === null || v === '') { b.fill(0xff, off, off + 4); break; }
      setBCDLE(b, off, 4, Math.round(clampInt(v, 0, 999999990, f) / 10));
      break;
    case 'tone': setU16LE(b, off, encodeTone(v)); break;
    default: throw new Error('Unknown field type ' + f.type);
  }
}

export function fieldSize(f) {
  switch (f.type) {
    case 'ascii': return f.len;
    case 'u16le': case 'ref16': case 'bcd4le': case 'tone': return 2;
    case 'bcd8be': case 'freq': return 4;
    case 'bcdstamp': return 6;
    default: return 1;
  }
}

function clampInt(v, lo, hi, f) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${f.label || f.key}: "${v}" is not a number`);
  const min = f.min ?? lo, max = f.max ?? hi;
  if (n < min || n > max) throw new Error(`${f.label || f.key}: ${v} is outside ${min}..${max}`);
  return Math.trunc(n);
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return a === b;
}

function snapshot(rec, keys) {
  const o = {};
  for (const k of keys) o[k] = Array.isArray(rec[k]) ? rec[k].slice() : rec[k];
  return o;
}

// --- record tables -----------------------------------------------------------

function channelLoc(L, n) { // n is 1-based
  const c = L.channels, b = Math.floor((n - 1) / c.perBank), i = (n - 1) % c.perBank;
  const base = c.bankAddr(b);
  return { bank: base.bank, bitmapAddr: base.addr, byte: i >> 3, bit: i & 7, addr: base.addr + c.bitmapLen + i * c.recSize };
}

function decodeFields(view, fields) {
  const o = {};
  for (const f of fields) o[f.key] = readField(view, f.off, f);
  return o;
}

function decodeMembers(view, t) {
  const out = [];
  for (let i = 0; i < t.members; i++) {
    const raw = getU16LE(view, t.memberOff + 2 * i);
    if (raw) out.push(raw - t.memberBias);
  }
  return out;
}

function encodeMembers(view, t, members) {
  if (members.length > t.members) throw new Error(`At most ${t.members} members fit, got ${members.length}`);
  for (let i = 0; i < t.members; i++) setU16LE(view, t.memberOff + 2 * i, i < members.length ? members[i] + t.memberBias : 0);
}

export function decode(image) {
  const L = LAYOUTS[image.fw];
  if (!L) throw new Error('Unknown firmware ' + image.fw);
  const cp = { fw: image.fw, image: image.clone(), origSlots: {} };

  cp.general = {};
  for (const f of L.general) cp.general[f.key] = readField(image.view(f.bank, f.addr, fieldSize(f)), 0, f);
  cp.general._orig = snapshot(cp.general, L.general.map(f => f.key));

  const chKeys = L.channels.fields.map(f => f.key);
  cp.channels = [];
  for (let n = 1; n <= L.channels.count; n++) {
    const loc = channelLoc(L, n);
    const bm = image.view(loc.bank, loc.bitmapAddr, L.channels.bitmapLen);
    if (!getBit(bm, loc.byte, loc.bit)) continue;
    const rec = { slot: n, ...decodeFields(image.view(loc.bank, loc.addr, L.channels.recSize), L.channels.fields) };
    rec._orig = snapshot(rec, chKeys);
    cp.channels.push(rec);
  }

  const z = L.zones;
  cp.zones = [];
  const zbm = image.view(z.bank, z.addr, z.bitmapLen);
  for (let i = 0; i < z.count; i++) {
    if (!getBit(zbm, i >> 3, i & 7)) continue;
    const v = image.view(z.bank, z.addr + z.bitmapLen + i * z.recSize, z.recSize);
    const rec = { slot: i + 1, name: readAscii(v, 0, z.nameLen), members: decodeMembers(v, z) };
    rec._orig = snapshot(rec, ['name', 'members']);
    cp.zones.push(rec);
  }

  const c = L.contacts, cKeys = c.fields.map(f => f.key);
  cp.contacts = [];
  for (let i = 0; i < c.count; i++) {
    const v = image.view(c.bank, c.addr + i * c.recSize, c.recSize);
    // A contact needs a name starting with a printable character: old
    // layouts have no validity byte, and stale entries can hold control
    // bytes (seen on a real firmware 2.x .g77).
    if (!readAscii(v, 0, 16) || v[0] < 0x20 || v[0] > 0x7e) continue;
    if (c.validFlag !== null && v[c.validFlag] === 0x00) continue;
    const rec = { slot: i + 1, ...decodeFields(v, c.fields) };
    rec._orig = snapshot(rec, cKeys);
    cp.contacts.push(rec);
  }

  const g = L.groupLists;
  cp.groupLists = [];
  for (let i = 0; i < g.count; i++) {
    const cnt = image.view(g.bank, g.addr + i, 1)[0];
    // members + 1; 0 is an unused list and anything larger is erased memory.
    if (!cnt || cnt > g.members + 1) continue;
    const v = image.view(g.bank, g.addr + g.hdrLen + i * g.recSize, g.recSize);
    const rec = { slot: i + 1, name: readAscii(v, 0, g.nameLen), members: decodeMembers(v, g) };
    rec._orig = snapshot(rec, ['name', 'members']);
    cp.groupLists.push(rec);
  }

  cp.scanLists = [];
  if (L.scanLists) {
    const s = L.scanLists, sKeys = ['name', 'members', ...s.fields.map(f => f.key)];
    for (let i = 0; i < s.count; i++) {
      const valid = image.view(s.bank, s.addr + i, 1)[0];
      if (!valid || valid === 0xff) continue; // 0xFF: erased, not a list
      const v = image.view(s.bank, s.addr + s.hdrLen + i * s.recSize, s.recSize);
      const rec = { slot: i + 1, name: readAscii(v, 0, s.nameLen), members: decodeMembers(v, s), ...decodeFields(v, s.fields) };
      rec._orig = snapshot(rec, sKeys);
      cp.scanLists.push(rec);
    }
  }

  const d = L.dtmf;
  cp.dtmf = [];
  for (let i = 0; i < d.count; i++) {
    const v = image.view(d.bank, d.addr + i * d.recSize, d.recSize);
    const name = readAscii(v, 0, 16);
    if (!name) continue;
    const rec = { slot: i + 1, name, code: readAscii(v, 16, 16) };
    rec._orig = snapshot(rec, ['name', 'code']);
    cp.dtmf.push(rec);
  }

  for (const k of ['channels', 'zones', 'contacts', 'groupLists', 'scanLists', 'dtmf']) cp.origSlots[k] = new Set(cp[k].map(r => r.slot));
  return cp;
}

// Writes `rec` into `view`. A record without _orig is new: it starts from
// the template and every field is written.
function writeChanged(view, fields, rec, template) {
  if (!rec._orig && template) view.set(template);
  for (const f of fields) {
    if (f.readonly) continue;
    if (rec._orig && sameValue(rec[f.key], rec._orig[f.key])) continue;
    try { writeField(view, f.off, f, rec[f.key]); }
    catch (e) { throw new Error(`${rec.name ? '"' + rec.name + '"' : '#' + rec.slot}: ${e.message}`); }
  }
}

function checkSlots(list, count, what) {
  const seen = new Set();
  for (const r of list) {
    if (!Number.isInteger(r.slot) || r.slot < 1 || r.slot > count) throw new Error(`${what} slot ${r.slot} is outside 1..${count}`);
    if (seen.has(r.slot)) throw new Error(`Two ${what} records use slot ${r.slot}`);
    seen.add(r.slot);
  }
}

export function encode(cp) {
  const L = LAYOUTS[cp.fw];
  const img = cp.image.clone();

  for (const f of L.general) {
    if (f.readonly || sameValue(cp.general[f.key], cp.general._orig[f.key])) continue;
    writeField(img.view(f.bank, f.addr, fieldSize(f)), 0, f, cp.general[f.key]);
  }

  // Channels
  checkSlots(cp.channels, L.channels.count, 'channel');
  const liveCh = new Set(cp.channels.map(r => r.slot));
  for (const n of cp.origSlots.channels) {
    if (liveCh.has(n)) continue;
    const loc = channelLoc(L, n);
    setBit(img.view(loc.bank, loc.bitmapAddr, L.channels.bitmapLen), loc.byte, loc.bit, 0);
  }
  for (const r of cp.channels) {
    const loc = channelLoc(L, r.slot);
    if (!r.name && (!r._orig || r.name !== r._orig.name)) throw new Error(`Channel ${r.slot} needs a name`);
    writeChanged(img.view(loc.bank, loc.addr, L.channels.recSize), L.channels.fields, r, L.channels.template());
    setBit(img.view(loc.bank, loc.bitmapAddr, L.channels.bitmapLen), loc.byte, loc.bit, 1);
  }

  // Zones
  const z = L.zones;
  checkSlots(cp.zones, z.count, 'zone');
  const zbm = img.view(z.bank, z.addr, z.bitmapLen);
  const liveZ = new Set(cp.zones.map(r => r.slot));
  for (const n of cp.origSlots.zones) if (!liveZ.has(n)) setBit(zbm, (n - 1) >> 3, (n - 1) & 7, 0);
  for (const r of cp.zones) {
    const v = img.view(z.bank, z.addr + z.bitmapLen + (r.slot - 1) * z.recSize, z.recSize);
    if (!r.name && (!r._orig || r.name !== r._orig.name)) throw new Error(`Zone ${r.slot} needs a name`);
    if (!r._orig) { v.fill(0); writeAscii(v, 0, 16, ''); }
    if (!r._orig || r.name !== r._orig.name) writeAscii(v, 0, z.nameLen, r.name);
    if (!r._orig || !sameValue(r.members, r._orig.members)) encodeMembers(v, z, r.members);
    setBit(zbm, (r.slot - 1) >> 3, (r.slot - 1) & 7, 1);
  }

  // Contacts
  const c = L.contacts;
  checkSlots(cp.contacts, c.count, 'contact');
  const liveC = new Set(cp.contacts.map(r => r.slot));
  for (const n of cp.origSlots.contacts) {
    if (liveC.has(n)) continue;
    const v = img.view(c.bank, c.addr + (n - 1) * c.recSize, c.recSize);
    writeAscii(v, 0, 16, '');
    if (c.validFlag !== null) v[c.validFlag] = 0x00;
  }
  for (const r of cp.contacts) {
    if (!r.name && (!r._orig || r.name !== r._orig.name)) throw new Error(`Contact ${r.slot} needs a name`);
    const v = img.view(c.bank, c.addr + (r.slot - 1) * c.recSize, c.recSize);
    writeChanged(v, c.fields, r, c.template());
    if (c.validFlag !== null) v[c.validFlag] = 0xff;
  }

  // RX group lists: the header byte is the member count + 1, so it changes
  // whenever the membership does.
  const g = L.groupLists;
  checkSlots(cp.groupLists, g.count, 'group list');
  const liveG = new Set(cp.groupLists.map(r => r.slot));
  for (const n of cp.origSlots.groupLists) if (!liveG.has(n)) img.view(g.bank, g.addr + n - 1, 1)[0] = 0;
  for (const r of cp.groupLists) {
    if (!r.name && (!r._orig || r.name !== r._orig.name)) throw new Error(`RX group list ${r.slot} needs a name`);
    const v = img.view(g.bank, g.addr + g.hdrLen + (r.slot - 1) * g.recSize, g.recSize);
    if (!r._orig) v.fill(0);
    if (!r._orig || r.name !== r._orig.name) writeAscii(v, 0, 16, r.name.slice(0, g.nameLen));
    if (!r._orig || !sameValue(r.members, r._orig.members)) {
      encodeMembers(v, g, r.members);
      img.view(g.bank, g.addr + r.slot - 1, 1)[0] = r.members.length + 1;
    }
  }

  // Scan lists (stock only)
  if (L.scanLists) {
    const s = L.scanLists;
    checkSlots(cp.scanLists, s.count, 'scan list');
    const liveS = new Set(cp.scanLists.map(r => r.slot));
    for (const n of cp.origSlots.scanLists) if (!liveS.has(n)) img.view(s.bank, s.addr + n - 1, 1)[0] = 0;
    for (const r of cp.scanLists) {
      if (!r.name && (!r._orig || r.name !== r._orig.name)) throw new Error(`Scan list ${r.slot} needs a name`);
      const v = img.view(s.bank, s.addr + s.hdrLen + (r.slot - 1) * s.recSize, s.recSize);
      writeChanged(v, s.fields, r, s.template());
      if (!r._orig || r.name !== r._orig.name) writeAscii(v, 0, s.nameLen, r.name);
      if (!r._orig || !sameValue(r.members, r._orig.members)) encodeMembers(v, s, r.members);
      img.view(s.bank, s.addr + r.slot - 1, 1)[0] = 1;
    }
  } else if (cp.scanLists.length) {
    throw new Error('This firmware has no scan lists');
  }

  // DTMF contacts
  const d = L.dtmf;
  checkSlots(cp.dtmf, d.count, 'DTMF contact');
  const liveD = new Set(cp.dtmf.map(r => r.slot));
  for (const n of cp.origSlots.dtmf) if (!liveD.has(n)) writeAscii(img.view(d.bank, d.addr + (n - 1) * d.recSize, 16), 0, 16, '');
  for (const r of cp.dtmf) {
    const v = img.view(d.bank, d.addr + (r.slot - 1) * d.recSize, d.recSize);
    if (!r._orig || r.name !== r._orig.name) writeAscii(v, 0, 16, r.name);
    if (!r._orig || r.code !== r._orig.code) {
      if (!/^[0-9A-D*#]*$/.test(r.code)) throw new Error(`DTMF code "${r.code}" may only contain 0-9 A-D * #`);
      writeAscii(v, 16, 16, r.code);
    }
  }

  return img;
}

// After a successful write or save the encoded image becomes the new
// baseline, so later edits are compared against what is now on the radio.
export function rebase(cp) {
  return decode(encode(cp));
}

export function layoutOf(cp) { return LAYOUTS[cp.fw]; }
