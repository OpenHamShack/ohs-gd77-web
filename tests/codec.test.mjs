// Codec, model operations, files and CSV. Expected addresses are written
// out as literals from the reference sources (see js/codeplug/layouts.js),
// not computed from the layout tables, so a wrong table fails here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleImage } from '../js/sim/sample.js';
import { decode, encode, decodeTone, encodeTone } from '../js/codeplug/codec.js';
import { newRecord, deleteRecords, duplicateChannel } from '../js/codeplug/ops.js';
import { stockImageToFile, stockImageFromFile, openGD77ToBackup, openGD77FromBackup, openCodeplugFile } from '../js/files.js';
import { channelsToCSV, channelsFromCSV, contactsToCSV, contactsFromCSV, parseCSV } from '../js/csv.js';

// Lists every byte that differs between two images as "bank:addr".
function diff(a, b) {
  const out = [];
  a.segs.forEach((s, i) => {
    const t = b.segs[i].data;
    for (let k = 0; k < s.data.length; k++) if (s.data[k] !== t[k]) out.push(`${s.bank}:${(s.addr + k).toString(16)}`);
  });
  return out;
}

const range = (bank, from, n) => Array.from({ length: n }, (_, i) => `${bank}:${(from + i).toString(16)}`);

for (const fw of ['stock', 'opengd77', 'opengd77-stm32']) {
  test(`${fw}: decode then encode gives back the identical image`, () => {
    const img = sampleImage(fw, 11);
    assert.ok(encode(decode(img)).equals(img));
  });

  test(`${fw}: decoding finds the sample's records`, () => {
    const cp = decode(sampleImage(fw));
    assert.deepEqual(cp.channels.map(c => c.slot), [1, 2, 3, 4, 5, 6, 7, 8, 200]);
    assert.equal(cp.channels[2].txTone, '88.5');
    assert.equal(cp.channels[3].rxTone, 'D023N');
    assert.equal(cp.channels[4].rxFreq, 439550000);
    assert.equal(cp.channels[4].txFreq, 430550000);
    assert.deepEqual(cp.zones.map(z => [z.name, z.members]), [['Analogue', [1, 2, 3, 4, 200]], ['DMR', [5, 6, 7, 8]]]);
    assert.deepEqual(cp.contacts.map(c => [c.name, c.dmrId]).slice(0, 2), [['Worldwide', 91], ['UK Wide', 235]]);
    assert.deepEqual(cp.groupLists.map(g => [g.name, g.members]), [['UK TGs', [1, 2, 3, 4]]]);
    assert.equal(cp.general.dmrId, 2351234);
  });
}

test('stock: channel edits land at the dmrconfig/qdmr offsets and nowhere else', () => {
  const img = sampleImage('stock');
  const cp = decode(img);
  const ch = cp.channels[0]; // slot 1: bank 0 at 0x3780, record at 0x3790
  ch.name = 'NEW NAME';
  ch.rxFreq = 145612500;
  const out = encode(cp);
  const v = out.segs[0].data;
  assert.equal(String.fromCharCode(...v.subarray(0x3790, 0x3798)), 'NEW NAME');
  assert.ok(v.subarray(0x3798, 0x37a0).every(b => b === 0xff));
  // 145.6125 MHz = 14561250 x 10 Hz, BCD little-endian
  assert.deepEqual([...v.subarray(0x37a0, 0x37a4)], [0x50, 0x12, 0x56, 0x14]);
  const d = diff(img, out);
  assert.ok(d.every(a => a >= 'mem:3790' && a < 'mem:37a4'), d.join(' '));
});

test('stock: a channel in bank 1 starts at 0xb1b0 + bitmap; power and timeslot bits are in 0x31/0x33', () => {
  const img = sampleImage('stock');
  const cp = decode(img);
  const ch = cp.channels.find(c => c.slot === 200); // bank 1, index 71
  const rec = 0xb1b0 + 0x10 + 71 * 0x38;
  ch.power = ch.power ? 0 : 1;
  ch.timeslot = 1;
  const out = encode(cp);
  const v = out.segs[0].data, o = img.segs[0].data;
  assert.equal(v[rec + 0x33] ^ o[rec + 0x33], 0x80);
  assert.equal(v[rec + 0x31] & 0x40, 0x40);
  assert.deepEqual(diff(img, out).sort(), [`mem:${(rec + 0x31).toString(16)}`, `mem:${(rec + 0x33).toString(16)}`].sort());
});

test('stock: general settings and boot text addresses', () => {
  const img = sampleImage('stock');
  const cp = decode(img);
  cp.general.dmrId = 2359999;
  cp.general.radioName = 'GM4XYZ';
  cp.general.intro2 = 'HELLO';
  const v = encode(cp).segs[0].data;
  assert.deepEqual([...v.subarray(0xe8, 0xec)], [0x02, 0x35, 0x99, 0x99]); // BCD big-endian
  assert.equal(String.fromCharCode(...v.subarray(0xe0, 0xe6)), 'GM4XYZ');
  assert.equal(String.fromCharCode(...v.subarray(0x7550, 0x7555)), 'HELLO');
});

test('opengd77: channel 200 lives in flash at 0x7b1b0 + 0x10 + 71*0x38; power 0x19, squelch 0x37', () => {
  const img = sampleImage('opengd77');
  const cp = decode(img);
  const ch = cp.channels.find(c => c.slot === 200);
  ch.power = 7; ch.squelch = 15;
  const out = encode(cp);
  const rec = 0x7b1b0 + 0x10 + 71 * 0x38;
  assert.equal(out.view('flash', rec + 0x19, 1)[0], 7);
  assert.equal(out.view('flash', rec + 0x37, 1)[0], 15);
  assert.deepEqual(diff(img, out).sort(), [`flash:${(rec + 0x19).toString(16)}`, `flash:${(rec + 0x37).toString(16)}`].sort());
});

test('opengd77: contacts are in flash at 0x87620, DMR ID big-endian BCD, TS override at +0x17', () => {
  const img = sampleImage('opengd77');
  const cp = decode(img);
  const c = cp.contacts[0];
  c.dmrId = 12345678; c.tsOverride = 2;
  const out = encode(cp);
  assert.deepEqual([...out.view('flash', 0x87620 + 0x10, 4)], [0x12, 0x34, 0x56, 0x78]);
  assert.equal(out.view('flash', 0x87620 + 0x17, 1)[0], 0x02);
  assert.equal(diff(img, out).length, 5); // 4 ID bytes (all change) + override
});

test('opengd77: general settings (callsign 0xe0, DMR ID 0xe8, band limits BCD LE at 0x80-0x87)', () => {
  const img = sampleImage('opengd77');
  const cp = decode(img);
  cp.general.callsign = 'GM4XYZ'; cp.general.vhfMax = 148; cp.general.dmrId = 2351235;
  const out = encode(cp);
  assert.equal(String.fromCharCode(...out.view('eeprom', 0xe0, 6)), 'GM4XYZ');
  assert.deepEqual([...out.view('eeprom', 0x86, 2)], [0x48, 0x01]);
  assert.deepEqual([...out.view('eeprom', 0xe8, 4)], [0x02, 0x35, 0x12, 0x35]);
});

test('bytes the codec does not model survive an edit of the same record', () => {
  const img = sampleImage('stock');
  img.segs[0].data.set([0xde, 0xad, 0xbe, 0xef], 0x3790 + 0x34); // channel 1, unused bytes 0x34-0x37
  const cp = decode(img);
  cp.channels[0].name = 'CHANGED';
  cp.channels[0].vox = 1;
  const out = encode(cp);
  assert.deepEqual([...out.segs[0].data.subarray(0x3790 + 0x34, 0x3790 + 0x38)], [0xde, 0xad, 0xbe, 0xef]);
});

test('deleting a channel clears its bitmap bit and removes it from zones and scan lists', () => {
  const img = sampleImage('stock');
  const cp = decode(img);
  deleteRecords(cp, 'channels', [2]);
  const out = encode(cp);
  const v = out.segs[0].data;
  assert.equal(v[0x3780] & 0x02, 0); // slot 2 = bank 0 bit 1
  const back = decode(out);
  assert.deepEqual(back.zones[0].members, [1, 3, 4, 200]);
  assert.deepEqual(back.scanLists[0].members, [1]);
  // zone 1 members: channel numbers, u16 LE, zero-padded
  assert.deepEqual([...v.subarray(0x8030 + 0x10, 0x8030 + 0x1a)], [1, 0, 3, 0, 4, 0, 200, 0, 0, 0]);
});

test('deleting a contact drops it from group lists and channels', () => {
  const cp = decode(sampleImage('opengd77'));
  deleteRecords(cp, 'contacts', [2]);
  const back = decode(encode(cp));
  assert.deepEqual(back.groupLists[0].members, [1, 3, 4]);
  assert.equal(back.channels.find(c => c.slot === 5).contact, 0);
  assert.equal(back.contacts.find(c => c.slot === 2), undefined);
  // the group list header byte is members + 1
  assert.equal(encode(cp).view('flash', 0x8d620, 1)[0], 4);
});

test('a new channel is written from the template into a free slot and marked in the bitmap', () => {
  const cp = decode(sampleImage('stock'));
  const r = newRecord(cp, 'channels', { name: 'NEW', rxFreq: 433450000, txFreq: 433450000 });
  assert.equal(r.slot, 9);
  const v = encode(cp).segs[0].data;
  const rec = 0x3790 + 8 * 0x38;
  assert.equal(v[0x3781] & 0x01, 1);
  assert.equal(v[rec + 0x1e], 0x50);
  assert.equal(v[rec + 0x28], 0x16);
  const back = decode(encode(cp));
  assert.equal(back.channels.find(c => c.slot === 9).rxFreq, 433450000);
});

test('duplicating a channel copies its values into the next free slot', () => {
  const cp = decode(sampleImage('opengd77'));
  const d = duplicateChannel(cp, 5);
  const back = decode(encode(cp)).channels.find(c => c.slot === d.slot);
  assert.equal(back.rxFreq, 439550000);
  assert.equal(back.contact, 2);
  assert.equal(back.name, 'GB7SIM TG235+');
});

test('tones: CTCSS, DCS normal/inverted, off, and codes that are not BCD round-trip', () => {
  for (const [s, code] of [['88.5', 0x0885], ['67.0', 0x0670], ['D023N', 0x8023], ['D754I', 0xc754], ['', 0xffff]]) {
    assert.equal(encodeTone(s), code, s);
    assert.equal(decodeTone(code), s);
  }
  assert.equal(decodeTone(0x0aff), 'raw:0aff');
  assert.equal(encodeTone('raw:0aff'), 0x0aff);
  assert.throws(() => encodeTone('D089N'), /octal/);
  assert.throws(() => encodeTone('hello'), /CTCSS/);
});

test('an erased frequency decodes as empty and is not rewritten unless edited', () => {
  const img = sampleImage('stock');
  img.segs[0].data.fill(0xff, 0x37a4, 0x37a8); // channel 1 TX frequency erased
  const cp = decode(img);
  assert.equal(cp.channels[0].txFreq, null);
  cp.channels[0].name = 'X';
  assert.ok(encode(cp).segs[0].data.subarray(0x37a4, 0x37a8).every(b => b === 0xff));
});

test('out-of-range values are rejected with the field name', () => {
  const cp = decode(sampleImage('opengd77'));
  cp.channels[0].power = 11;
  assert.throws(() => encode(cp), /Power/);
});

test('stock .img: dmrconfig layout, MD-760P tag, other radios refused', () => {
  const img = sampleImage('stock');
  const file = stockImageToFile(img);
  assert.equal(file.length, 131072);
  assert.equal(String.fromCharCode(...file.subarray(0, 7)), 'MD-760P');
  const back = stockImageFromFile(file);
  assert.ok(back.image.equals(img) || diff(img, back.image).every(a => a < 'mem:80'));
  assert.deepEqual(back.missing, []);
  const rd5r = file.slice(); rd5r.set(Uint8Array.from('BF-5R\xff\xff', c => c.charCodeAt(0)));
  assert.throws(() => stockImageFromFile(rd5r), /BF-5R/);
  // A dmrconfig-made file has 0xFF from 0x1e2a0: flagged as missing.
  const old = file.slice(); old.fill(0xff, 0x1e2a0);
  assert.deepEqual(stockImageFromFile(old).missing, [{ bank: 'mem', addr: 0x1e2a0, size: 0x1eb00 - 0x1e2a0 }]);
});

test('opengd77 backup: WebCPSd .gd77backup JSON round trip; STM32 and wrong layouts refused', () => {
  const img = sampleImage('opengd77');
  const json = openGD77ToBackup(img, { created: new Date('2026-01-02T03:04:05Z') });
  const j = JSON.parse(json);
  assert.equal(j.format, 'ReallyOpenGD77-WebCPSd-flash-backup');
  assert.deepEqual(j.eeprom.map(s => [s.addr, s.size]), [[0x80, 0x5fe0], [0x7500, 0x3b00]]);
  assert.deepEqual(j.flash.map(s => [s.addr, s.size]), [[0x7b000, 0x14000], [0, 0x2000]]);
  assert.ok(openGD77FromBackup(json).image.equals(img));
  assert.ok(openCodeplugFile('x', new TextEncoder().encode(json)).image.equals(img));
  assert.throws(() => openGD77FromBackup(json, { expectFamily: 'X' }), /MK22-family .* not an STM32-family/);
  // An MK22 backup relabelled as STM32 lacks the STM32 segments.
  assert.throws(() => openGD77FromBackup(JSON.stringify({ ...j, radio_family: 'X' })), /no flash segment at 0x9b000/);
  assert.throws(() => openGD77FromBackup(JSON.stringify({ ...j, flash: j.flash.slice(0, 1) })), /no flash segment/);
});

for (const fw of ['stock', 'opengd77', 'opengd77-stm32']) {
  test(`${fw}: channel and contact CSV export re-imports without changing a byte`, () => {
    const img = sampleImage(fw);
    const cp = decode(img);
    const ch = channelsFromCSV(cp, channelsToCSV(cp));
    const co = contactsFromCSV(cp, contactsToCSV(cp));
    assert.deepEqual([ch.warnings, co.warnings], [[], []]);
    assert.equal(ch.updated, 9);
    assert.equal(co.updated, 6);
    assert.deepEqual(diff(img, encode(cp)), []);
  });
}

test('CSV import of CHIRP-style analogue rows: duplex, tone modes, new slots', () => {
  const cp = decode(sampleImage('stock'));
  const csv = [
    'Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,DtcsPolarity,Mode,Power',
    ',GB3ABC,145.775000,-,0.600000,Tone,77.0,88.5,023,NN,FM,High',
    ',GB3DEF,433.150000,+,1.600000,TSQL,88.5,94.8,023,NN,NFM,Low',
    ',DCS TEST,446.006250,,0.000000,DTCS,88.5,88.5,754,RN,NFM,Low',
    ',"Quoted, name",144.800000,off,0,,,,,,FM,Low',
  ].join('\n');
  const r = channelsFromCSV(cp, csv);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.added, 4);
  const back = decode(encode(cp));
  const byName = n => back.channels.find(c => c.name === n);
  assert.equal(byName('GB3ABC').txFreq, 145175000);
  assert.equal(byName('GB3ABC').txTone, '77.0');
  assert.equal(byName('GB3ABC').rxTone, '');
  assert.equal(byName('GB3DEF').txFreq, 434750000);
  assert.deepEqual([byName('GB3DEF').txTone, byName('GB3DEF').rxTone, byName('GB3DEF').bandwidth], ['94.8', '94.8', 0]);
  assert.deepEqual([byName('DCS TEST').txTone, byName('DCS TEST').rxTone], ['D754I', 'D754N']);
  assert.equal(byName('Quoted, name').rxOnly, 1);
});

test('CSV contacts import from a plain list resolves into free slots', () => {
  const cp = decode(sampleImage('opengd77'));
  const r = contactsFromCSV(cp, 'Name,Radio ID,Call Type\nGB7XX,2350001,Private\nTG 2351,2351,Group\n');
  assert.equal(r.added, 2);
  const back = decode(encode(cp));
  assert.deepEqual(back.contacts.slice(-2).map(c => [c.slot, c.name, c.dmrId, c.callType]), [[7, 'GB7XX', 2350001, 1], [8, 'TG 2351', 2351, 0]]);
  assert.deepEqual(parseCSV('a,"b ""q"""\r\n1,2'), [['a', 'b "q"'], ['1', '2']]);
});

test('opengd77-stm32: no EEPROM; settings in flash at the GD-77 EEPROM addresses, the rest 0x20000 higher', () => {
  const img = sampleImage('opengd77-stm32');
  assert.ok(img.segs.every(s => s.bank === 'flash'));
  const cp = decode(img);
  cp.general.callsign = 'GM4XYZ';
  cp.contacts[0].dmrId = 2351111;
  cp.channels.find(c => c.slot === 200).power = 4;
  cp.channels.find(c => c.slot === 1).power = 5;
  const out = encode(cp);
  assert.equal(String.fromCharCode(...out.view('flash', 0xe0, 6)), 'GM4XYZ');
  assert.deepEqual([...out.view('flash', 0xa7620 + 0x10, 4)], [0x02, 0x35, 0x11, 0x11]);
  assert.equal(out.view('flash', 0x9b1b0 + 0x10 + 71 * 0x38 + 0x19, 1)[0], 4);
  assert.equal(out.view('flash', 0x3790 + 0x19, 1)[0], 5);
  const j = JSON.parse(openGD77ToBackup(out));
  assert.equal(j.radio_family, 'X');
  assert.deepEqual(j.eeprom.map(s => s.addr), [0x80, 0x7500]);
  assert.deepEqual(j.flash.map(s => s.addr), [0x9b000, 0x20000]);
  const back = openCodeplugFile('x', new TextEncoder().encode(JSON.stringify(j)));
  assert.equal(back.fw, 'opengd77-stm32');
  assert.ok(back.image.equals(out));
});
