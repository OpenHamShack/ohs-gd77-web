// Full read/edit/write sessions against the simulated radios. The real
// Session, transport and protocol code runs; only the USB device is fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, recoveryAdvice } from '../js/session.js';
import { SimulatedStockHID } from '../js/sim/stock-sim.js';
import { SimulatedOpenGD77Port } from '../js/sim/opengd77-sim.js';
import { sampleImage } from '../js/sim/sample.js';
import { decode, encode } from '../js/codeplug/codec.js';
import { codeplugFile, openCodeplugFile, stockImageToFile, stockImageFromFile } from '../js/files.js';

function session(extra = {}) {
  const saved = [];
  const logs = [];
  const s = new Session({ log: m => logs.push(m), saveFile: async (name, data) => { saved.push({ name, data }); }, ...extra });
  return { s, saved, logs };
}

// fw (the codeplug layout) -> [connect button, simulated radio]
const SIMS = {
  stock: o => new SimulatedStockHID(o),
  opengd77: o => new SimulatedOpenGD77Port(o),
  'opengd77-stm32': o => new SimulatedOpenGD77Port({ radioType: 6, ...o }),
};
const KIND = { stock: 'stock', opengd77: 'opengd77', 'opengd77-stm32': 'opengd77' };

// The simulated radio's memory, as an image comparable with ours.
function radioImage(fw, dev) {
  const img = sampleImage(fw).clone();
  for (const s of img.segs) {
    const mem = fw === 'stock' ? dev.mem : (s.bank === 'flash' ? dev.flash : dev.eeprom);
    s.data.set(mem.subarray(s.addr, s.addr + s.data.length));
  }
  if (fw === 'stock') img.segs[0].data.set(sampleImage('stock').segs[0].data.subarray(0, 0x80));
  return img;
}

for (const fw of ['stock', 'opengd77', 'opengd77-stm32']) {
  test(`${fw}: connect, read (backup saved first), edit, write; only the edited bytes change on the radio`, async () => {
    const dev = SIMS[fw]();
    const before = radioImage(fw, dev);
    if (fw === 'opengd77-stm32') dev.flash.fill(0x5a, 0, 0x80); // bytes outside the codeplug, in a sector it shares
    const beforeFlash = dev.flash?.slice();
    const { s, saved } = session();
    const info = await s.connect(KIND[fw], dev);
    assert.equal(info.firmware, fw);
    assert.equal(s.canWrite, false);

    const progress = [];
    const img = await s.read(p => progress.push(p));
    assert.equal(progress.at(-1), 1);
    assert.equal(saved.length, 1);
    assert.match(saved[0].name, new RegExp(`^gd77-${fw}-backup-\\d{8}-\\d{6}\\.(img|gd77backup)$`));
    // The backup is a loadable file holding exactly what was read.
    assert.ok(openCodeplugFile(saved[0].name, typeof saved[0].data === 'string' ? new TextEncoder().encode(saved[0].data) : saved[0].data).image.equals(img));
    assert.ok(s.canWrite);

    const cp = decode(img);
    cp.channels.find(c => c.slot === 200).name = 'EDITED 200';
    cp.contacts[0].dmrId = 9;
    (fw === 'stock' ? cp.general.radioName = 'GM4XYZ' : cp.general.callsign = 'GM4XYZ');
    const target = encode(cp);
    await s.write(target);

    const after = radioImage(fw, dev);
    const expect = target.clone();
    if (fw === 'stock') expect.segs[0].data.set(before.segs[0].data.subarray(0, 0x80));
    assert.ok(after.equals(expect), 'radio holds the edited codeplug');
    assert.deepEqual(decode(after).channels.find(c => c.slot === 200).name, 'EDITED 200');
    assert.deepEqual(dev.violations, []);
    if (fw === 'stock') {
      assert.equal(dev.inProgramMode, false, 'ENDW left programming mode');
      assert.equal(dev.writes, 3, 'three 32-byte blocks changed');
    } else {
      assert.equal(dev.inCPS, false, 'CLOSE_CPS sent');
      assert.equal(dev.outsideCPS, 0);
      assert.deepEqual(dev.commands.slice(-9), ['0', '1', '2', '2', '2', '3', '6:4', '6:2', '5']);
      if (fw === 'opengd77') {
        assert.equal(dev.flashCommits, 2, 'channel 200 sector and contact sector');
        assert.equal(dev.eepromWrites, 1);
      } else {
        // No EEPROM: the callsign goes through flash sector 0, which the
        // codeplug only covers from 0x80. The rest of that sector must
        // survive, because the radio's sector buffer starts as its contents.
        assert.equal(dev.flashCommits, 3, 'settings sector, channel 200 sector and contact sector');
        assert.equal(dev.eepromWrites, 0);
        assert.deepEqual([...dev.flash.subarray(0, 0x80)], [...beforeFlash.subarray(0, 0x80)]);
        assert.deepEqual([...dev.flash.subarray(0x6060, 0x7000)], [...beforeFlash.subarray(0x6060, 0x7000)]);
      }
    }
    // The radio now holds `target`, so writing it again changes nothing.
    assert.deepEqual(await s.write(target), { blocks: 0 });
    await s.disconnect();
  });

  test(`${fw}: writing is refused before a read, after reconnecting, and when the backup cannot be saved`, async () => {
    const dev = SIMS[fw]();
    const { s } = session();
    await s.connect(KIND[fw], dev);
    const img = sampleImage(fw);
    await assert.rejects(s.write(img), /Read this radio first/);
    await s.read();
    await s.connect(KIND[fw], dev);
    await assert.rejects(s.write(img), /Read this radio first/);

    const failing = new Session({ saveFile: async () => { throw new Error('disk full'); } });
    await failing.connect(KIND[fw], SIMS[fw]());
    await assert.rejects(failing.read(), /disk full/);
    assert.equal(failing.canWrite, false);
  });

  test(`${fw}: a codeplug for the other firmware is refused`, async () => {
    const { s } = session();
    await s.connect(KIND[fw], SIMS[fw]());
    await s.read();
    for (const other of Object.keys(SIMS).filter(f => f !== fw)) {
      await assert.rejects(s.write(sampleImage(other)), /Converting between them is not supported/);
    }
  });
}

test('stock: a radio that is not a GD-77 is refused, and left out of programming mode', async () => {
  const dev = new SimulatedStockHID({ model: 'BF-5R' });
  const { s } = session();
  await assert.rejects(s.connect('stock', dev), /"BF-5R", not a GD-77/);
  assert.equal(dev.inProgramMode, false);
  assert.equal(s.connected, false);
});

test('opengd77: every known radio type connects with its family layout; unknown types are refused', async () => {
  const expect = [[0, 'Radioddity GD-77', 'opengd77'], [1, 'Radioddity GD-77S', 'opengd77'], [3, 'Baofeng RD-5R', 'opengd77'],
    [4, 'Baofeng DM-1801A', 'opengd77'], [5, 'TYT MD-9600', 'opengd77-stm32'], [6, 'TYT MD-UV380', 'opengd77-stm32'], [10, 'Baofeng DM-1701 RGB', 'opengd77-stm32']];
  for (const [radioType, model, fw] of expect) {
    const { s } = session();
    const info = await s.connect('opengd77', new SimulatedOpenGD77Port({ radioType }));
    assert.deepEqual([info.model, info.firmware, s.firmware], [model, fw, fw]);
  }
  await assert.rejects(session().s.connect('opengd77', new SimulatedOpenGD77Port({ radioType: 11 })), /type 11/);
});

test('stock: a NAK in the middle of a write stops at once, sends ENDW and closes the gate', async () => {
  const failAt = 0xb1b0 + 0x10 + 71 * 0x38 - ((0xb1b0 + 0x10 + 71 * 0x38) % 32); // block holding channel 200's name
  const dev = new SimulatedStockHID({ failWriteAt: failAt });
  const { s } = session();
  await s.connect('stock', dev);
  const cp = decode(await s.read());
  cp.general.radioName = 'FIRST';               // block 0xe0: written before the failure
  cp.channels.find(c => c.slot === 200).name = 'FAILS';
  cp.contacts[0].name = 'NEVER';                // 0x17620: after the failure, must not be written
  const err = await s.write(encode(cp)).catch(e => e);
  assert.equal(err.name, 'RadioError');
  assert.equal(err.radioState, 'partial');
  assert.match(err.message, /refused the write at 0x0c140/);
  assert.equal(dev.inProgramMode, false, 'ENDW sent from the failure path');
  assert.equal(dev.writes, 1);
  assert.equal(String.fromCharCode(...dev.mem.subarray(0x17620, 0x17625)), 'World');
  assert.equal(s.canWrite, false);
  const advice = recoveryAdvice(err, 'b.img');
  assert.match(advice.join(' '), /off and on again/);
  assert.match(advice.join(' '), /b\.img/);
  // Recovery: read again, then the write is possible again.
  await s.read();
  assert.ok(s.canWrite);
});

test('stock: a write the radio never answers stops the transfer as partial', async () => {
  const dev = new SimulatedStockHID({ silentWriteAt: 0xe0 });
  const { s } = session();
  await s.connect('stock', dev);
  const cp = decode(await s.read());
  cp.general.radioName = 'SILENT';
  cp.channels[0].name = 'NOT WRITTEN';
  const err = await s.write(encode(cp)).catch(e => e);
  assert.equal(err.radioState, 'partial');
  assert.match(err.message, /No acknowledgement/);
  assert.equal(dev.writes, 0);
});

test('opengd77: a rejected flash sector commit stops the write and still closes CPS mode', async () => {
  const sector = 0x7b000 + 0x1000 * Math.floor((0x7b1b0 + 0x10 + 71 * 0x38 - 0x7b000) / 0x1000);
  const dev = new SimulatedOpenGD77Port({ failWriteAt: { bank: 'flash', addr: sector } });
  const { s } = session();
  await s.connect('opengd77', dev);
  const cp = decode(await s.read());
  cp.channels.find(c => c.slot === 200).name = 'FAILS';
  cp.contacts[0].name = 'NEVER';
  const err = await s.write(encode(cp)).catch(e => e);
  assert.equal(err.radioState, 'partial');
  assert.match(err.message, /rejected flash sector select/);
  assert.equal(dev.inCPS, false);
  assert.equal(dev.flashCommits, 0);
  assert.equal(s.canWrite, false);
});

test('opengd77: an unanswered EEPROM write times out and stops', async () => {
  const dev = new SimulatedOpenGD77Port({ silentWriteAt: { bank: 'eeprom', addr: 0xe0 } });
  const { s } = session();
  await s.connect('opengd77', dev);
  const cp = decode(await s.read());
  cp.general.callsign = 'GM4XYZ';
  const err = await s.write(encode(cp)).catch(e => e);
  assert.equal(err.radioState, 'partial');
  assert.match(err.message, /No confirmation for EEPROM write at 0x0000e0/);
  assert.equal(dev.inCPS, false);
});

test('reads survive a dropped reply (stock) and a stray ACK byte and dropped reply (OpenGD77)', async () => {
  const stock = new SimulatedStockHID({ dropReadAt: 0x3780 });
  const a = session();
  await a.s.connect('stock', stock);
  const img = await a.s.read();
  assert.ok(decode(img).channels.length === 9);
  assert.ok(a.logs.some(l => /retrying/.test(l)));

  const ogd = new SimulatedOpenGD77Port({ strayAckAt: 0x3780, dropReadAt: 0x8000 });
  const b = session();
  await b.s.connect('opengd77', ogd);
  const img2 = await b.s.read();
  assert.ok(img2.equals(radioImage('opengd77', ogd)));
  assert.ok(b.logs.some(l => /Resynced/.test(l)));
  assert.ok(b.logs.some(l => /retrying/.test(l)));
});

test('stock: a device without numbered HID reports is driven with report id 0 and 42-byte frames', async () => {
  const dev = new SimulatedStockHID({ numberedReports: false });
  const { s, logs } = session();
  await s.connect('stock', dev);
  await s.read();
  assert.ok(logs.some(l => /report id 0, 42 bytes/.test(l)));
  assert.deepEqual(dev.violations, []);
});

test('stock: replies that do not echo the request still read correctly', async () => {
  const dev = new SimulatedStockHID({ echo: false });
  const { s, logs } = session();
  await s.connect('stock', dev);
  const img = await s.read();
  const radio = radioImage('stock', dev);
  assert.deepEqual(img.segs[0].data.subarray(0x80), radio.segs[0].data.subarray(0x80));
  assert.ok(logs.some(l => /late-reply detection is off/.test(l)));
});

test('opengd77: talking to the radio inside the post-DTR settle time leaves it deaf (why the 300 ms wait exists)', async () => {
  const dev = new SimulatedOpenGD77Port();
  const { s } = session({ settleMs: 0 });
  await assert.rejects(s.connect('opengd77', dev), /Timed out/);
  assert.equal(dev.deaf, true);
});

test('stock: writing a dmrconfig image takes the group list tail it lacks from the radio read', async () => {
  const dev = new SimulatedStockHID();
  // Put a group list in slot 50, which lives past dmrconfig's 0x1e2a0.
  const glAddr = 0x1d620 + 0x80 + 49 * 0x50;
  assert.ok(glAddr >= 0x1e2a0);
  dev.mem[0x1d620 + 49] = 1;
  dev.mem.set(Uint8Array.from('TAIL LIST\xff\xff\xff\xff\xff\xff\xff', c => c.charCodeAt(0)), glAddr);
  const { s } = session();
  await s.connect('stock', dev);
  const read = await s.read();
  assert.ok(decode(read).groupLists.some(g => g.name === 'TAIL LIST'));
  const file = stockImageToFile(read);
  file.fill(0xff, 0x1e2a0);
  const opened = stockImageFromFile(file);
  const cp = decode(opened.image);
  cp.channels[0].name = 'FROM FILE';
  await s.write(encode(cp), { missing: opened.missing });
  assert.equal(String.fromCharCode(...dev.mem.subarray(glAddr, glAddr + 9)), 'TAIL LIST');
  assert.equal(String.fromCharCode(...dev.mem.subarray(0x3790, 0x3799)), 'FROM FILE');
  assert.deepEqual(dev.violations, []);
});

test('the read backup file is the format the page saves', () => {
  assert.equal(codeplugFile(sampleImage('stock')).ext, 'img');
  assert.equal(codeplugFile(sampleImage('opengd77')).ext, 'gd77backup');
});

test('unplugging the radio closes the write gate', async () => {
  const { s } = session();
  await s.connect('stock', new SimulatedStockHID());
  await s.read();
  assert.ok(s.canWrite);
  s.lost();
  assert.equal(s.canWrite, false);
  await assert.rejects(s.write(sampleImage('stock')), /No radio connected/);
});

test('read-only guard: a full read passes it without SAVE_SETTINGS; any write is stopped before reaching the radio', async () => {
  const { readOnlyPort, checkReadOnlyFrame } = await import('../js/radio/readonly-guard.js');
  const { OpenGD77Radio } = await import('../js/radio/opengd77-serial.js');
  const dev = new SimulatedOpenGD77Port({ radioType: 6 });
  const radio = new OpenGD77Radio(readOnlyPort(dev), { settleMs: 260 });
  await radio.open();
  const img = await radio.readImage(() => {}, { saveSettings: false });
  assert.ok(img.equals(radioImage('opengd77-stm32', dev)));
  assert.deepEqual(dev.commands, ['0', '1', '2', '2', '2', '3', '6:3', '5']);
  const cp = decode(img); cp.general.callsign = 'NOPE';
  const err = await radio.writeImage(encode(cp), img).catch(e => e);
  assert.match(err.message, /Read-only guard refused/);
  assert.equal(dev.flashCommits, 0);
  assert.equal(dev.inCPS, false);
  await radio.close();
  for (const f of [Uint8Array.of(0x58, 1, 0, 0, 0), Uint8Array.of(0x57, 3), new Uint8Array(23).fill(0).fill(6, 1, 2).fill(2, 2, 3)]) {
    f[0] = f[0] || 0x43;
    assert.throws(() => checkReadOnlyFrame(f), /refused/);
  }
});
