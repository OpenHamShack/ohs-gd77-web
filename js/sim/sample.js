// Builds the codeplug a simulated radio starts with. Every byte the codec
// does not model is filled with pseudo-random noise, so a test that reads
// this radio, edits it and writes it back can prove that the noise came
// back untouched. Only the validity markers are cleared before the sample
// records are added through the normal model operations.

import { Image } from '../codeplug/image.js';
import { LAYOUTS, isStock } from '../codeplug/layouts.js';
import { decode, encode } from '../codeplug/codec.js';
import { newRecord } from '../codeplug/ops.js';
import { prng, writeAscii } from '../util.js';

export function sampleImage(fw, seed = 7) {
  const L = LAYOUTS[fw];
  const img = Image.blank(L);
  const rnd = prng(seed);
  for (const s of img.segs) for (let i = 0; i < s.data.length; i++) s.data[i] = rnd();

  // Empty every table so the noise is not mistaken for records.
  for (let b = 0; b < L.channels.count / L.channels.perBank; b++) {
    const a = L.channels.bankAddr(b);
    img.view(a.bank, a.addr, L.channels.bitmapLen).fill(0);
  }
  img.view(L.zones.bank, L.zones.addr, L.zones.bitmapLen).fill(0);
  for (let i = 0; i < L.contacts.count; i++) {
    const v = img.view(L.contacts.bank, L.contacts.addr + i * L.contacts.recSize, L.contacts.recSize);
    writeAscii(v, 0, 16, '');
    if (L.contacts.validFlag !== null) v[L.contacts.validFlag] = 0;
  }
  img.view(L.groupLists.bank, L.groupLists.addr, L.groupLists.hdrLen).fill(0);
  if (L.scanLists) img.view(L.scanLists.bank, L.scanLists.addr, L.scanLists.hdrLen).fill(0);
  for (let i = 0; i < L.dtmf.count; i++) writeAscii(img.view(L.dtmf.bank, L.dtmf.addr + i * L.dtmf.recSize, 16), 0, 16, '');
  if (isStock(fw)) {
    // dmrconfig never reads these; a real image holds 0xFF there.
    img.view('mem', 0, 0x80).fill(0xff);
    img.view('mem', 0x7c00, 0x400).fill(0xff);
    img.view('mem', 0x1eb00, 0x20000 - 0x1eb00).fill(0xff);
    // The firmware version the CPS records at 0xB8; it tells the layouts apart.
    writeAscii(img.view('mem', 0xb8, 8), 0, 8, fw === 'stock-v2' ? 'V2.06.05' : 'V4.03.06');
  }

  const cp = decode(img);
  const g = cp.general;
  if (isStock(fw)) {
    Object.assign(g, {
      radioName: 'M0SIM', dmrId: 2351234, intro1: 'SIMULATED', intro2: 'GD-77 STOCK', bootDisplay: 1, progPassword: '',
      preamble: 1, monitorType: 0, voxSensitivity: 3, lowBatteryInterval: 24, callAlertDuration: 24, groupHang: 6, privateHang: 6,
      digitalTPT: 1, analogTPT: 0, selftestTone: 1, freeTone: 0, allTonesOff: 0, allLedsOff: 0, txExitTone: 0, animation: 0, scanMode: 0,
    });
  } else {
    Object.assign(g, { callsign: 'M0SIM', dmrId: 2351234, intro1: 'SIMULATED', intro2: 'OPENGD77', bootDisplay: 1 });
    if (fw === 'opengd77') Object.assign(g, { vhfMin: 144, vhfMax: 146, uhfMin: 430, uhfMax: 440 });
  }

  const tg = (name, dmrId, callType = 0) => newRecord(cp, 'contacts', { name, dmrId, callType }).slot;
  const ww = tg('Worldwide', 91), uk = tg('UK Wide', 235), scot = tg('Scotland', 2355);
  const local = tg('Local', 9), parrot = tg('Parrot', 9990, 1);
  tg('M0SIM', 2351234, 1);
  const gl = newRecord(cp, 'groupLists', { name: 'UK TGs', members: [ww, uk, scot, local] }).slot;

  const ch = (name, rx, tx, extra) => newRecord(cp, 'channels', { name, rxFreq: rx, txFreq: tx, ...extra }).slot;
  const fm = { mode: 0, bandwidth: 1 };
  const dmr = (contact, timeslot) => ({ mode: 1, bandwidth: 0, contact, groupList: gl, timeslot, ...(isStock(fw) ? { rxCC: 1, txCC: 1 } : { colorCode: 1 }) });
  const s20 = ch('S20 Calling', 145500000, 145500000, fm);
  const u280 = ch('U280 Calling', 433500000, 433500000, fm);
  const rpt = ch('GB3SIM', 145725000, 145125000, { ...fm, rxTone: '', txTone: '88.5' });
  const rptD = ch('GB3DCS', 439100000, 431500000, { ...fm, rxTone: 'D023N', txTone: 'D023N' });
  const d1 = ch('GB7SIM TG235', 439550000, 430550000, dmr(uk, 0));
  const d2 = ch('GB7SIM Local', 439550000, 430550000, dmr(local, 1));
  const d3 = ch('GB7SIM Parrot', 439550000, 430550000, dmr(parrot, 0));
  const simplex = ch('DMR Simplex 1', 438612500, 438612500, dmr(ww, 0));
  // A channel in a flash-backed bank on OpenGD77 (slot 200), so the sector
  // write path carries real data in tests.
  const far = newRecord(cp, 'channels', { slot: 200, name: 'Bank 2 test', rxFreq: 144800000, txFreq: 144800000, ...fm, rxOnly: 1 }).slot;

  newRecord(cp, 'zones', { name: 'Analogue', members: [s20, u280, rpt, rptD, far] });
  newRecord(cp, 'zones', { name: 'DMR', members: [d1, d2, d3, simplex] });
  if (L.scanLists) newRecord(cp, 'scanLists', { name: 'Calling', members: [s20, u280] });
  newRecord(cp, 'dtmf', { name: 'Echolink', code: '1234#' });

  return encode(cp);
}
