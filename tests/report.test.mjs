// The diagnostic report built from real sessions against the simulators.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../js/session.js';
import { SimulatedStockHID } from '../js/sim/stock-sim.js';
import { SimulatedOpenGD77Port } from '../js/sim/opengd77-sim.js';
import { decode, encode } from '../js/codeplug/codec.js';
import { buildReport, reportSizes, reportHeadline, collectEnvironment, MAX_REPORT_BYTES } from '../js/report.js';
import { Trace } from '../js/radio/trace.js';
import { fromBase64 } from '../js/util.js';
import { openGD77FromBackup } from '../js/files.js';

const env = { userAgent: 'node-test', platform: 'linux', language: 'en', hasSerial: false, hasHid: false, userAgentData: null };
const newSession = () => new Session({ saveFile: async () => {} });

test('stock: a report after a read carries the ID reply, HID mode, trace, image and summary, unredacted', async () => {
  const s = newSession();
  await s.connect('stock', new SimulatedStockHID());
  await s.read();
  const r = buildReport({ session: s, environment: env, simulated: true, user: { name: 'Test', message: 'hi' } });
  assert.deepEqual(Object.keys(r), ['format', 'formatVersion', 'createdAt', 'simulated', 'page', 'environment', 'user', 'transport', 'radio', 'session', 'error', 'codeplug', 'summary', 'firmware']);
  assert.equal(r.firmware, null, 'no firmware session unless the Firmware tab was used');
  assert.equal(r.format, 'gd77-web-diagnostic-report');
  assert.equal(r.simulated, true);
  assert.equal(r.page.version, 'dev');
  assert.equal(r.transport.device.api, 'webhid');
  assert.equal(r.transport.device.usb, '15a2:0073');
  assert.deepEqual(r.transport.device.collections[0].outputReports, [{ reportId: 1, bytes: 41 }]);
  assert.match(r.radio.detail.idHex, /^4d 44 2d 37 36 30 50 ff/); // "MD-760P"
  assert.deepEqual(r.radio.detail.hidReportMode, { outputReportId: 1, outputBytes: 41 });
  assert.equal(r.radio.identified.model, 'Radioddity GD-77');
  const img = fromBase64(r.codeplug.read.base64);
  assert.equal(img.length, 131072);
  assert.equal(String.fromCharCode(...img.subarray(0, 7)), 'MD-760P');
  assert.equal(r.codeplug.attemptedWrite, null);
  assert.deepEqual(r.summary.counts, { channels: 9, zones: 2, contacts: 6, groupLists: 1, scanLists: 1, dtmf: 1 });
  assert.equal(r.session.exchanges.length, 200);
  assert.ok(r.session.exchangesTotal > 3000);
  assert.ok(r.session.timings.some(t => t.label.startsWith('read 0x00080') && t.ok));
  assert.ok(r.session.log.some(l => /Read complete/.test(l.m)));
  assert.equal(r.error, null);
  // Nothing is redacted: the callsign and DMR ID are in there.
  const json = JSON.stringify(r);
  assert.ok(json.includes('M0SIM') || Buffer.from(img).includes('M0SIM'));
  assert.ok(reportSizes(r).total < MAX_REPORT_BYTES);
  assert.equal(reportHeadline(r), 'Radioddity GD-77 stock ok');
});

test('MD-UV380: firmware-info bytes and decode, serial USB IDs, .gd77backup segments', async () => {
  const s = newSession();
  await s.connect('opengd77', new SimulatedOpenGD77Port({ radioType: 6 }));
  await s.read();
  const r = buildReport({ session: s, environment: env, simulated: true });
  assert.equal(r.transport.device.api, 'webserial');
  assert.equal(r.transport.device.usb, '1fc9:0094');
  assert.match(r.radio.detail.firmwareInfoHex, /^03 00 00 00 06 00 00 00/);
  assert.equal(r.radio.detail.writeType, 'X');
  assert.equal(r.radio.identified.info.radioType, 6);
  assert.ok('flashId' in r.radio.identified.info && 'features' in r.radio.identified.info);
  assert.equal(r.codeplug.read.backup.radio_family, 'X');
  assert.ok(openGD77FromBackup(JSON.stringify(r.codeplug.read.backup)).image.equals(s.readImage));
  assert.equal(reportHeadline(r), 'TYT MD-UV380 opengd77-stm32 ok');
});

test('a failed write: the error with its radio state, the attempted image and the counters', async () => {
  const s = newSession();
  const dev = new SimulatedStockHID({ failWriteAt: 0x3780 });
  await s.connect('stock', dev);
  const cp = decode(await s.read());
  cp.channels[0].name = 'BOOM';
  await s.write(encode(cp)).catch(() => {});
  const r = buildReport({ session: s, environment: env, simulated: true });
  assert.equal(r.error.radioState, 'partial');
  assert.match(r.error.message, /refused the write/);
  assert.ok(r.error.stack);
  assert.ok(r.codeplug.attemptedWrite.base64);
  assert.ok(r.session.timings.some(t => /^write/.test(t.label) && !t.ok));
  assert.match(reportHeadline(r), /ERROR: Write failed/);
});

test('a refused connect still reports what the radio said', async () => {
  const s = newSession();
  await s.connect('stock', new SimulatedStockHID({ model: 'BF-5R' })).catch(() => {});
  const r = buildReport({ session: s, environment: env, simulated: false });
  assert.match(r.error.message, /BF-5R/);
  assert.match(r.radio.detail.idAscii, /^BF-5R/);
  assert.equal(r.simulated, false);
});

test('the trace ring keeps the last 200 exchanges, truncated, with counters', () => {
  const t = new Trace(200);
  for (let i = 0; i < 250; i++) t.add(i % 2 ? 'rx' : 'tx', new Uint8Array(100).fill(i));
  t.count('retries');
  const s = t.snapshot();
  assert.equal(s.exchanges.length, 200);
  assert.equal(s.exchangesTotal, 250);
  assert.equal(s.exchanges[0].hex.slice(0, 2), (50).toString(16));
  assert.ok(s.exchanges[0].hex.endsWith('…'));
  assert.equal(s.exchanges[0].len, 100);
  assert.equal(s.counters.retries, 1);
});

test('environment collection copes with missing APIs', async () => {
  assert.deepEqual(await collectEnvironment({ userAgent: 'x' }), { userAgent: 'x', platform: null, language: null, hasSerial: false, hasHid: false, userAgentData: null });
  const e = await collectEnvironment({ userAgent: 'y', hid: {}, userAgentData: { brands: [], mobile: false, platform: 'Linux', getHighEntropyValues: async () => ({ architecture: 'x86' }) } });
  assert.equal(e.hasHid, true);
  assert.equal(e.userAgentData.architecture, 'x86');
});
