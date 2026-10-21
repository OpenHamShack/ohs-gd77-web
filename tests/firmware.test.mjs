// Firmware flashing: TYT file parsing, key recovery, the codec merge, and
// full flashes through the real DFU code against the simulated bootloader.
//
// The tests on real files use TYT's and OpenGD77's own files from the local
// disk (never the repository) and are skipped, with the reason, when absent:
//   GD77_FW_DIR      TYT V18.11 bundle (default ~/build/rt3s-flash/firmware)
//   GD77_FW_REF      md9600-donor.bin + OpenMDUV380.bin (default ~/build/gd77-fw-ref)
//   GD77_RADIO_TOOL  radio_tool source, for its published UV3X0 table (comparison only)
//   GD77_GRID_JS     grid.radio stm32_ciphers.js, for its MD9600 table (comparison only)

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTyt, deriveKey, keyFor, xor, vectorTableOk, APP_BASE } from '../js/firmware/tyt.js';
import { planStock, planOpenGD77, CODEC_ADDR, CODEC_SIZE } from '../js/firmware/plan.js';
import { TytDfu } from '../js/firmware/dfu.js';
import { SimulatedTytDfu } from '../js/sim/tyt-dfu-sim.js';
import { syntheticTyt, syntheticDonor, syntheticOpenGD77, SIM_KEYS, SIM_CODEC } from '../js/sim/synthetic-firmware.js';

const FW = process.env.GD77_FW_DIR ?? join(homedir(), 'build/rt3s-flash/firmware');
const REF = process.env.GD77_FW_REF ?? join(homedir(), 'build/gd77-fw-ref');
const RT = process.env.GD77_RADIO_TOOL ?? join(homedir(), 'build/rt3s-flash/radio_tool/include/radio_tool/fw/cipher/uv3x0.hpp');
const GRID = process.env.GD77_GRID_JS ?? join(homedir(), 'build/gd77-fw-ref/stm32_ciphers.js');
const V18 = ['MD-UV380(CSV)-V18.11.bin', 'MD-UV380(REC)-D18.11.bin', 'MD-UV390(CSV-GPS)-P18.11.bin', 'MD-UV390(GPS-REC)-S18.11.bin'];
const realFiles = V18.every(f => existsSync(join(FW, f))) && existsSync(join(REF, 'md9600-donor.bin')) && existsSync(join(REF, 'OpenMDUV380.bin'));
const skipReal = realFiles ? false : `real firmware files not found in ${FW} and ${REF}; real-file checks skipped`;
const rd = p => new Uint8Array(readFileSync(p));

// Published tables, read at run time from the reference sources on disk,
// only to compare against; never copied into the repository.
function publishedUV() {
  if (!existsSync(RT)) return null;
  return Uint8Array.from(readFileSync(RT, 'utf8').match(/0x[0-9a-fA-F]{2}/g).slice(0, 1024), x => parseInt(x, 16));
}
function publishedMD9600() {
  if (!existsSync(GRID)) return null;
  const js = readFileSync(GRID, 'utf8');
  const s = js.slice(js.indexOf('MD9600: new Uint8Array(['));
  return Uint8Array.from(s.slice(s.indexOf('[') + 1, s.indexOf('])')).match(/0x[0-9a-fA-F]+|\b\d+\b/g).slice(0, 1024), x => Number(x));
}

async function flashWith(sim, plan) {
  const dfu = new TytDfu(sim);
  await dfu.open();
  const progress = [];
  await dfu.flash(plan, p => progress.push(p));
  return { dfu, progress };
}

// --- synthetic files --------------------------------------------------------

test('key recovery finds the synthetic keys exactly, with a wide margin', () => {
  const uv = parseTyt(syntheticTyt().file);
  const d = parseTyt(syntheticDonor().file);
  assert.deepEqual(keyFor(uv).key, SIM_KEYS.UV3X0);
  assert.deepEqual(keyFor(d).key, SIM_KEYS.MD9600);
  assert.ok(keyFor(uv).minGap > 100);
});

test('codec merge equals an independent computation', async () => {
  const ogd = syntheticOpenGD77();
  const plan = await planOpenGD77({ ogd, donor: syntheticDonor().file, target: syntheticTyt().file, allowUnknownDonor: true });
  // Independently: the OpenGD77 image with the known codec spliced in at
  // flash 0x0807537C, padded with 0xFF to whole KiB, XORed with the
  // radio's key from offset 0.
  const expectPlain = new Uint8Array(Math.ceil(ogd.length / 1024) * 1024).fill(0xff);
  expectPlain.set(ogd);
  expectPlain.set(SIM_CODEC, 0x6937c);
  const expectEnc = expectPlain.map((b, i) => b ^ SIM_KEYS.UV3X0[i % 1024]);
  assert.deepEqual(plan.imagePlain, expectPlain);
  assert.deepEqual(plan.imageEncrypted, expectEnc);
  assert.equal(plan.codecMerged, true);
  assert.deepEqual(plan.erase.map(s => s.addr.toString(16)), ['800c000', '8010000', '8020000', '8040000', '8060000', '8080000', '80a0000', '80c0000']);
});

test('stock plan: writes the 0x0800C000 region as it is in the file, lists 0x00060000 as not written', () => {
  const { file } = syntheticTyt();
  const plan = planStock(file);
  const fw = parseTyt(file);
  assert.deepEqual(plan.imageEncrypted, fw.stream.subarray(fw.app.streamOff));
  assert.deepEqual(plan.excluded.map(e => e.addr), [0x00060000]);
  assert.equal(plan.writes[0].addr, APP_BASE);
  assert.ok(plan.erase.every(s => s.addr >= APP_BASE));
});

test('simulated flash, stock firmware: exact bytes land, bootloader untouched, sequence as specified', async () => {
  const { file, appPlain } = syntheticTyt();
  const sim = new SimulatedTytDfu();
  const { dfu, progress } = await flashWith(sim, planStock(file));
  assert.deepEqual(sim.violations, []);
  assert.deepEqual(sim.read(APP_BASE, appPlain.length), appPlain);
  assert.ok(sim.read(0x08000000, 0xc000).every(b => b === 0xb0), 'bootloader sectors untouched');
  assert.ok(sim.erased.every(a => a >= APP_BASE));
  assert.deepEqual(sim.commands.slice(0, 3), ['reg 1', '91 01', '91 31']);
  assert.equal(sim.commands.at(-1), 'reset 0x8000000');
  assert.ok(sim.commands.filter(c => c.startsWith('addr')).length >= 9, 'one SetAddress per sector');
  assert.equal(progress.at(-1), 1);
  assert.equal(dfu.bootloaderName, 'MD-UV390');
  assert.ok(dfu.trace.snapshot().exchanges.length > 0);
});

test('simulated flash, OpenGD77 + codec: the radio ends up holding OpenGD77 with the codec in place', async () => {
  const ogd = syntheticOpenGD77();
  const plan = await planOpenGD77({ ogd, donor: syntheticDonor().file, target: syntheticTyt().file, allowUnknownDonor: true });
  const sim = new SimulatedTytDfu();
  await flashWith(sim, plan);
  assert.deepEqual(sim.violations, []);
  assert.deepEqual(sim.read(APP_BASE, ogd.length).subarray(0, 0x6937c), ogd.subarray(0, 0x6937c));
  assert.deepEqual(sim.read(CODEC_ADDR, CODEC_SIZE), SIM_CODEC);
  assert.deepEqual(sim.read(CODEC_ADDR + CODEC_SIZE, ogd.length - 0x6937c - CODEC_SIZE), ogd.subarray(0x6937c + CODEC_SIZE));
  assert.ok(sim.read(APP_BASE + ogd.length, 0x080e0000 - APP_BASE - ogd.length).every(b => b === 0xff), 'the rest of the written sectors is erased');
  assert.ok(sim.read(0x08000000, 0xc000).every(b => b === 0xb0));
});

// --- refusals ---------------------------------------------------------------

test('file checks refuse bad files before anything is connected', async () => {
  const good = syntheticTyt().file;
  const bad = (f, edit) => { const b = f.slice(); edit(b); return b; };
  assert.throws(() => parseTyt(bad(good, b => { b[0] = 0x41; })), /not a TYT firmware file/);
  assert.throws(() => parseTyt(good.subarray(0, good.length - 1)), /truncated|do not match/);
  assert.throws(() => parseTyt(bad(good, b => { b[0x31] = 0x99; })), /unknown model identifier/);
  assert.throws(() => planStock(syntheticTyt({ magic: [0x01, 0x0f] }).file), /DM-1701/);
  assert.throws(() => parseTyt(bad(good, b => { b.set([0x00, 0x80, 0x00, 0x08], 0x80); })), /bootloader/); // first region moved to 0x08008000
  assert.throws(() => parseTyt(bad(good, b => { b.set([0, 0, 0, 0], 0x84); })), /impossible length/);
  // A TYT-shaped file whose content is noise: no key can be trusted.
  const noise = good.slice(); for (let i = 0x100; i < noise.length - 256; i++) noise[i] = (i * 2654435761) >>> 24;
  assert.throws(() => keyFor(parseTyt(noise)), /Could not recover the encryption key/);

  const ogd = syntheticOpenGD77(), donor = syntheticDonor().file, target = syntheticTyt().file;
  await assert.rejects(planOpenGD77({ ogd: ogd.slice().fill(0, 0, 8), donor, target, allowUnknownDonor: true }), /vector table/);
  await assert.rejects(planOpenGD77({ ogd: bad(ogd, b => { b[0x6937c + 10] = 1; }), donor, target, allowUnknownDonor: true }), /codec goes/);
  await assert.rejects(planOpenGD77({ ogd, donor, target }), /not one whose codec position is known/);
  await assert.rejects(planOpenGD77({ ogd, donor: bad(donor, b => { b[3] = 0; }), target, allowUnknownDonor: true }), /donor file is not a TYT/);
  await assert.rejects(planOpenGD77({ ogd, donor: syntheticTyt({ magic: [0x01, 0x14], key: SIM_KEYS.MD9600, appLen: 0x80000 }).file, target, allowUnknownDonor: true }), /too short/);
  await assert.rejects(planOpenGD77({ ogd: ogd.subarray(0, 0x70000), donor, target, allowUnknownDonor: true }), /too short to hold the codec/);
});

test('a radio whose bootloader names another model is refused before anything is erased', async () => {
  const sim = new SimulatedTytDfu({ model: 'MD-9600' });
  await assert.rejects(flashWith(sim, planStock(syntheticTyt().file)), /says "MD-9600"/);
  assert.deepEqual(sim.erased, []);
  assert.ok(!sim.commands.includes('91 31'));
});

test('a failure mid-flash stops at once and reports a partly written radio; an unplug before the reboot is a failure too', async () => {
  const plan = planStock(syntheticTyt().file);
  const sim = new SimulatedTytDfu({ failWriteAt: 0x08020400 });
  const e = await flashWith(sim, plan).catch(x => x);
  assert.equal(e.name, 'DfuError');
  assert.equal(e.radioState, 'partial');
  assert.equal(e.stage, 'write');
  assert.ok(!sim.commands.some(c => c.startsWith('reset')));
  const sim2 = new SimulatedTytDfu({ unplugAt: 0x08040000 });
  const e2 = await flashWith(sim2, plan).catch(x => x);
  assert.equal(e2.radioState, 'partial');
  const sim3 = new SimulatedTytDfu({ failEraseAt: 0x08010000 });
  const e3 = await flashWith(sim3, plan).catch(x => x);
  assert.equal(e3.stage, 'erase');
});

// --- the real files -----------------------------------------------------------

test('real V18.11 and MD-9600 files: keys recovered at run time decrypt to valid programs and round-trip', { skip: skipReal }, t => {
  const uvPub = publishedUV(), mdPub = publishedMD9600();
  if (!uvPub || !mdPub) t.diagnostic('published tables not found; derived keys checked by vector table and round trip only');
  for (const f of [...V18.map(n => join(FW, n)), join(REF, 'md9600-donor.bin')]) {
    const fw = parseTyt(rd(f), f);
    const { key, minGap } = keyFor(fw, f);
    assert.ok(minGap > 200, `${f}: margin ${minGap}`);
    const plain = xor(fw.stream, key);
    assert.ok(vectorTableOk(plain, fw.app.streamOff), `${f}: vector table`);
    assert.deepEqual(xor(plain, key), fw.stream, `${f}: encrypt(decrypt(x)) == x`);
    const pub = fw.family.key === 'UV3X0' ? uvPub : mdPub;
    if (pub) assert.deepEqual(key, pub, `${f}: derived key equals the published ${fw.family.key} table`);
  }
  // The MD-9600 key is not the MD-UV380 one (docs/firmware.md said they were).
  const k1 = keyFor(parseTyt(rd(join(FW, V18[0])))).key, k2 = keyFor(parseTyt(rd(join(REF, 'md9600-donor.bin')))).key;
  assert.ok(k1.some((b, i) => b !== k2[i]));
  // GPS and non-GPS files share the UV3X0 key.
  assert.deepEqual(keyFor(parseTyt(rd(join(FW, V18[3])))).key, k1);
});

test('real files: the merged, encrypted OpenGD77 image equals the documented algorithm with the published tables', { skip: skipReal }, async t => {
  const uvPub = publishedUV(), mdPub = publishedMD9600();
  if (!uvPub || !mdPub) { t.skip('published tables not on this machine'); return; }
  const ogd = rd(join(REF, 'OpenMDUV380.bin')), donor = rd(join(REF, 'md9600-donor.bin')), target = rd(join(FW, V18[0]));
  const plan = await planOpenGD77({ ogd, donor, target });
  // docs/firmware.md §5.2, step by step, with the published tables.
  const combined = ogd.slice();
  for (let i = 0; i < 0x48bb0; i++) combined[0x6937c + i] = donor[0xc2c7c + i] ^ mdPub[(i + 892) % 1024];
  const enc = combined.map((b, i) => b ^ uvPub[i % 1024]);
  assert.deepEqual(plan.imageEncrypted.subarray(0, ogd.length), enc);
  // Our only addition: the final block's padding decrypts to erased flash.
  assert.ok(xor(plan.imageEncrypted.subarray(ogd.length), uvPub, ogd.length).every(b => b === 0xff));
  assert.ok(vectorTableOk(plan.imagePlain));
  assert.equal(plan.donor, 'TYT MD-9600 V26.45 (MD9600-CSV(2571V5)-V26.45.bin)');
});
