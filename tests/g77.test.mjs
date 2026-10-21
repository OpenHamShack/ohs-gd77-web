// .g77 files and the stock firmware 2.x layout. Synthetic images throughout;
// one optional test reads a real friend's .g77 from the path below (never
// stored in the repository) and is skipped when it is absent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { sampleImage } from '../js/sim/sample.js';
import { decode, encode } from '../js/codeplug/codec.js';
import { summarize } from '../js/codeplug/checks.js';
import { openCodeplugFile, codeplugFile } from '../js/files.js';
import { detectStockLayout, detectG77Firmware, g77FromImage, openGD77FromG77 } from '../js/g77.js';
import { Session } from '../js/session.js';
import { SimulatedStockHID } from '../js/sim/stock-sim.js';

const REAL = process.env.GD77_REAL_G77 ?? '/home/user/.claude/uploads/e0f5de5e-0321-4d68-b506-47140e053a29/7f91a362-MM3YFT_1021_132516.g77';

test('stock firmware 2.x layout: contacts at 0x1788, 68 zones of 80 at 0x8030, scan lists at 0x17620', () => {
  const img = sampleImage('stock-v2');
  const cp = decode(img);
  assert.equal(cp.fw, 'stock-v2');
  assert.deepEqual(cp.contacts.map(c => c.name).slice(0, 2), ['Worldwide', 'UK Wide']);
  cp.contacts[0].dmrId = 2350001;
  cp.zones[1].name = 'SECOND';
  cp.scanLists[0].name = 'SCANS';
  const v = encode(cp).segs[0].data;
  assert.deepEqual([...v.subarray(0x1788 + 0x10, 0x1788 + 0x14)], [0x02, 0x35, 0x00, 0x01]);
  assert.equal(String.fromCharCode(...v.subarray(0x8030 + 0xb0, 0x8030 + 0xb6)), 'SECOND');
  assert.equal(String.fromCharCode(...v.subarray(0x17620 + 0x100, 0x17620 + 0x105)), 'SCANS');
  assert.ok(encode(decode(img)).equals(img));
});

test('the layout is detected from the recorded firmware version, or else from where the contacts are', () => {
  const v2 = sampleImage('stock-v2').segs[0].data.slice(), v4 = sampleImage('stock').segs[0].data.slice();
  assert.equal(detectStockLayout(v2).fw, 'stock-v2');
  assert.match(detectStockLayout(v2).evidence, /V2\.06\.05/);
  assert.equal(detectStockLayout(v4).fw, 'stock');
  v2.fill(0xff, 0xb8, 0xc0); v4.fill(0xff, 0xb8, 0xc0);
  assert.equal(detectStockLayout(v2).fw, 'stock-v2');
  assert.match(detectStockLayout(v2).evidence, /0x1788/);
  assert.equal(detectStockLayout(v4).fw, 'stock');
});

test('.g77 of a stock image is the image itself, and opens back identically', () => {
  for (const fw of ['stock', 'stock-v2']) {
    const img = sampleImage(fw);
    img.segs[0].data.set(Uint8Array.from('MD-760P\xff', c => c.charCodeAt(0)));
    const f = codeplugFile(img, { format: 'g77' });
    assert.equal(f.ext, 'g77');
    assert.deepEqual(f.data, img.segs[0].data);
    const back = openCodeplugFile('x.g77', f.data);
    assert.equal(back.fw, fw);
    assert.ok(back.image.equals(img));
  }
});

test('OpenGD77 .g77: flash shifted down 0x70000, satellites not included, firmware told from the channel records', () => {
  const ogd = sampleImage('opengd77');
  const g = g77FromImage(ogd);
  assert.equal(g.length, 0x20000);
  assert.deepEqual(g.subarray(0x17620, 0x17620 + 0x18), ogd.view('flash', 0x87620, 0x18));      // contacts
  assert.deepEqual(g.subarray(0xb1b0, 0xb1b0 + 0x1c10), ogd.view('flash', 0x7b1b0, 0x1c10));   // channel bank 1
  assert.deepEqual(g.subarray(0x3780, 0x5390), ogd.view('eeprom', 0x3780, 0x1c10));          // bank 0, same address
  const d = detectG77Firmware(g);
  assert.equal(d.fw, 'opengd77');
  assert.equal(d.certain, true);
  const r = openCodeplugFile('x.g77', g);
  assert.equal(r.fw, 'opengd77');
  assert.deepEqual(r.missing, [{ bank: 'flash', addr: 0, size: 0x2000 }]);
  for (const s of ogd.segs.filter(s => !(s.bank === 'flash' && s.addr === 0))) assert.deepEqual(r.image.view(s.bank, s.addr, s.data.length), s.data);
  assert.deepEqual(decode(r.image).channels.map(c => c.name), decode(ogd).channels.map(c => c.name));
  assert.deepEqual(openGD77FromG77(g).image.view('flash', 0, 16), new Uint8Array(16).fill(0xff));
  // A stock 3/4 image reads as stock; the guess can be overridden.
  const st = sampleImage('stock').segs[0].data.slice(); st.set(Uint8Array.from('MD-760P', c => c.charCodeAt(0)));
  assert.equal(detectG77Firmware(st).fw, 'stock');
  assert.equal(openCodeplugFile('y.g77', g, { as: 'stock' }).fw, 'stock');
});

test('a firmware 2.x codeplug is read and saved but never written to a radio', async () => {
  const dev = new SimulatedStockHID({ image: sampleImage('stock-v2') });
  const logs = [];
  const s = new Session({ log: m => logs.push(m), saveFile: async () => {} });
  await s.connect('stock', dev);
  const img = await s.read();
  assert.equal(img.fw, 'stock-v2');
  assert.ok(logs.some(l => /firmware 2\.x/.test(l)));
  const cp = decode(img); cp.channels[0].name = 'NOPE';
  await assert.rejects(s.write(encode(cp)), /read and save but not yet write/);
  assert.equal(dev.writes, 0);
});

test('real .g77 from a GD-77 on firmware V2.06.05 decodes completely and round-trips', { skip: existsSync(REAL) ? false : `no real .g77 at ${REAL}` }, () => {
  const bytes = new Uint8Array(readFileSync(REAL));
  const r = openCodeplugFile('real.g77', bytes);
  assert.equal(r.fw, 'stock-v2');
  const cp = decode(r.image);
  const s = summarize(cp);
  assert.deepEqual(s.counts, { channels: 98, zones: 14, contacts: 235, groupLists: 0, scanLists: 0, dtmf: 0 });
  assert.ok(cp.zones.every(z => /^[\x20-\x7e]+$/.test(z.name)), 'every zone has a readable name');
  assert.ok(cp.contacts.filter(c => c.dmrId !== null).every(c => c.dmrId <= 16777215), 'contact IDs fit in 24 bits');
  assert.ok(s.personalIds > 100, '7-digit personal IDs present');
  assert.ok(cp.general.dmrId >= 1000000 && cp.general.dmrId <= 9999999);
  const zoneRefs = cp.zones.flatMap(z => z.members);
  assert.ok(zoneRefs.length > 0 && zoneRefs.every(m => cp.channels.some(c => c.slot === m)), 'every zone member is a channel');
  assert.ok(cp.channels.filter(c => c.mode === 1).every(c => c.rxCC <= 15 && c.txCC <= 15));
  // Untouched, it saves back as the identical file.
  assert.deepEqual(codeplugFile(encode(cp), { format: 'g77' }).data, bytes);
});
