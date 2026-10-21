// In-page end-to-end check, loaded only when the URL has ?selftest (and a
// ?sim=stock|opengd77 radio). It drives the real page through its own
// buttons and inputs: connect, read, edit a channel and a zone in the
// editor, write, then decodes the simulated radio's memory to confirm the
// edits arrived. The verdict goes into <pre id="selftest-result"> so a
// headless browser's --dump-dom can be checked by tools/browser-test.sh.

import { _test } from '../../js/app.js';
import { decode } from '../../js/codeplug/codec.js';
import { Image } from '../../js/codeplug/image.js';
import { LAYOUTS } from '../../js/codeplug/layouts.js';

const errors = [];
window.addEventListener('error', e => errors.push('error: ' + e.message));
window.addEventListener('unhandledrejection', e => errors.push('unhandled rejection: ' + (e.reason?.message ?? e.reason)));
const origError = console.error;
console.error = (...a) => { errors.push('console.error: ' + a.join(' ')); origError(...a); };

const saved = [];
_test.setSaveFile(async (name, data) => { saved.push({ name, size: data.length }); });

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('Timed out waiting for ' + what); await sleep(20); }
}
function type(el, value, ev = 'change') { el.value = value; el.dispatchEvent(new Event(ev, { bubbles: true })); }

function radioImage(dev, fw) {
  const L = LAYOUTS[fw];
  return new Image(fw, L.segments.map(s => ({
    bank: s.bank, addr: s.addr,
    data: (fw === 'stock' ? dev.mem : s.bank === 'flash' ? dev.flash : dev.eeprom).slice(s.addr, s.addr + s.size),
  })));
}

async function run() {
  const steps = [];
  const sim = new URLSearchParams(location.search).get('sim');
  if (!sim) throw new Error('selftest needs ?sim=stock, opengd77 or uv380');
  const { state, session } = _test;

  // The getting-started help is on the welcome view and behind Help.
  if (sim !== 'uv380dfu' && !/Getting started/.test($('#panel').textContent)) throw new Error('Welcome view lacks the getting-started help');
  $('#btn-help').click();
  if (!$('#help-dialog').open || !/K plug/.test($('#help-dialog').textContent)) throw new Error('Help dialog did not open with the help text');
  $('#help-dialog').close();
  // A browser without WebHID/Web Serial gets a sentence instead of dead buttons.
  const simWas = state.sim;
  Object.defineProperty(navigator, 'hid', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'serial', { value: undefined, configurable: true });
  state.sim = null; _test.render();
  const blocked = $('#btn-stock').hidden && $('#btn-ogd').hidden && /Chrome or Edge/.test($('#no-usb').textContent) && !$('#no-usb').hidden;
  delete navigator.hid; delete navigator.serial;
  state.sim = simWas; _test.render();
  if (!blocked) throw new Error('Missing WebHID/Web Serial was not explained in place of the connect buttons');
  if ($('#btn-stock').hidden || !$('#no-usb').hidden) throw new Error('Connect buttons did not come back with the simulator');
  steps.push('help and no-USB message shown');

  if (sim === 'uv380dfu') return firmwareFlow(steps);

  $(sim === 'stock' ? '#btn-stock' : '#btn-ogd').click();
  await until('connection', () => session.connected && !state.busy);
  steps.push('connected: ' + session.info.model);
  if (!$('#btn-write').disabled) throw new Error('Write was enabled before any read');

  $('#btn-read').click();
  await until('read', () => session.readImage && !state.busy && state.cp);
  if (saved.length !== 1 || !/backup/.test(saved[0].name)) throw new Error('No backup was saved by the read: ' + JSON.stringify(saved));
  steps.push('read; backup ' + saved[0].name);
  if ($('#btn-write').disabled) throw new Error('Write stayed disabled after the read');

  // Diagnostic report: offered after the read, previewed, sent to the
  // endpoint served beside the page, and the reference shown.
  if ($('#btn-report').hidden) throw new Error('No diagnostic report button after the read');
  $('#btn-report').click();
  await until('report dialog', () => $('#report-dialog').open && $('#report-json').value);
  if ($('#report-sim').hidden) throw new Error('Report from a simulator is not marked simulated');
  $('#report-name').value = 'Selftest'; $('#report-name').dispatchEvent(new Event('change'));
  const preview = JSON.parse($('#report-json').value);
  if (!preview.simulated || preview.user.name !== 'Selftest' || !preview.codeplug.read) throw new Error('Report preview is missing parts');
  $('#report-send').click();
  await until('report reference', () => $('#report-ref') || /Could not/.test($('#report-status').textContent));
  const ref = $('#report-ref')?.textContent;
  if (!/^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(ref || '')) throw new Error('No report reference: ' + $('#report-status').textContent);
  $('#report-dialog').close();
  steps.push('report sent: ' + ref);

  $('#tab-channels').click();
  const row = document.querySelector('table.grid tbody tr[data-slot="3"]');
  type(row.querySelector('td.f-name input'), 'SELFTEST', 'input');
  type(row.querySelector('td.f-rxFreq input'), '145.7375');
  type(row.querySelector('td.f-txTone input'), '94.8');
  if (!row.querySelector('td.f-name').classList.contains('changed')) throw new Error('Edited cell not marked as changed');
  steps.push('edited channel 3');

  $('#tab-zones').click();
  const pick = document.querySelector('.detail-pane select');
  pick.value = '7';
  [...document.querySelectorAll('.detail-pane .toolbar button')].find(b => b.textContent === 'Add').click();
  steps.push('added channel 7 to zone 1');

  $('#btn-write').click();
  await until('write dialog', () => $('#write-dialog').open);
  $('#write-ack').click();
  $('#write-go').click();
  await until('write', () => !state.busy && !state.dirty && /Written/.test(state.source));

  const after = decode(radioImage(state.simDevice, state.cp.fw));
  const ch = after.channels.find(c => c.slot === 3);
  if (ch.name !== 'SELFTEST' || ch.rxFreq !== 145737500 || ch.txTone !== '94.8') throw new Error('Radio does not hold the edited channel: ' + JSON.stringify(ch));
  if (!after.zones[0].members.includes(7)) throw new Error('Radio zone 1 lacks channel 7');
  if (state.simDevice.violations.length) throw new Error('Simulator protocol violations: ' + state.simDevice.violations.join('; '));
  steps.push('write verified on the simulated radio');

  if (sim !== 'uv380') {
    const before = saved.length;
    $('#btn-save-g77').click();
    await until('g77 save', () => saved.length > before);
    if (!/\.g77$/.test(saved.at(-1).name) || saved.at(-1).size !== 131072) throw new Error('Save as .g77 gave ' + JSON.stringify(saved.at(-1)));
    steps.push('saved as .g77');
  }

  // ?end=<tab> leaves that tab open for a screenshot.
  const end = new URLSearchParams(location.search).get('end') || 'channels';
  if (end === 'report') await _test.openReport(); else $('#tab-' + end).click();
  return steps;
}

// Firmware tab against the simulated bootloader: plan, connect, refuse
// until GPS is answered, flash stock, then OpenGD77 with the codec, and
// check the simulated radio's flash; then a diagnostic report that
// carries the firmware session.
async function firmwareFlow(steps) {
  const { fw } = _test;
  const { syntheticTyt, syntheticOpenGD77, SIM_CODEC } = await import('../../js/sim/synthetic-firmware.js');
  if ($('#tab-firmware').getAttribute('aria-selected') !== 'true') $('#tab-firmware').click();
  for (const mode of ['stock', 'opengd77']) {
    document.querySelector(`input[name="fw-mode"][value="${mode}"]`).click();
    await until('mode ' + mode, () => fw.mode === mode);
    $('#fw-sim-files').click();
    await until('plan ' + mode, () => $('#fw-plan') || $('#fw-plan-error'), 30000);
    if (!$('#fw-plan')) throw new Error('Plan refused: ' + $('#fw-plan-error').textContent);
    if (mode === 'opengd77' && !/codec merged in: yes/i.test($('#fw-plan').textContent)) throw new Error('Plan does not say the codec is merged');
    if (!$('#fw-flash').disabled) throw new Error('Flash enabled before connecting');
    $('#fw-connect').click();
    await until('bootloader', () => fw.device && $('#fw-bootloader'));
    const dev = fw.device;
    if (mode === 'stock') {
      if (!$('#fw-flash').disabled || !/GPS/.test($('#fw-why').textContent)) throw new Error('Flash not held back for the GPS question');
      document.querySelector('input[name="fw-gps"][value="no"]').click();
    }
    if (!fw.ack) $('#fw-ack').click();
    await until('flash enabled', () => !$('#fw-flash').disabled);
    $('#fw-flash').click();
    await until('flashed ' + mode, () => $('#fw-done') || $('#error-dialog').open, 30000);
    if (!$('#fw-done')) throw new Error('Flash failed: ' + $('#error-message').textContent);
    if (dev.violations.length) throw new Error('Bootloader violations: ' + dev.violations.join('; '));
    if (!dev.read(0x08000000, 0xc000).every(b => b === 0xb0)) throw new Error('Bootloader area changed');
    const want = mode === 'stock' ? syntheticTyt().appPlain : syntheticOpenGD77();
    const got = dev.read(0x0800c000, want.length);
    const codecAt = 0x0807537c - 0x0800c000;
    for (let i = 0; i < want.length; i++) {
      const expect = mode === 'opengd77' && i >= codecAt && i < codecAt + SIM_CODEC.length ? SIM_CODEC[i - codecAt] : want[i];
      if (got[i] !== expect) throw new Error(`${mode}: flash byte 0x${(0x0800c000 + i).toString(16)} wrong`);
    }
    steps.push(`flashed ${mode} on the simulated bootloader`);
  }
  $('#tab-firmware').click();
  await _test.openReport();
  const r = JSON.parse($('#report-json').value);
  if (r.firmware?.bootloaderName !== 'MD-UV390' || !r.firmware.files.tyt?.sha256) throw new Error('Report lacks the firmware session');
  $('#report-send').click();
  await until('report reference', () => $('#report-ref') || /Could not/.test($('#report-status').textContent));
  if (!$('#report-ref')) throw new Error('Report not sent: ' + $('#report-status').textContent);
  steps.push('report sent: ' + $('#report-ref').textContent);
  if (new URLSearchParams(location.search).get('end') === 'firmware') {
    $('#report-dialog').close();
    // Leave a planned, connected stock flash on screen for a screenshot.
    document.querySelector('input[name="fw-mode"][value="stock"]').click();
    $('#fw-sim-files').click();
    await until('plan', () => $('#fw-plan'), 30000);
    $('#fw-connect').click();
    await until('bootloader', () => fw.device && $('#fw-bootloader'));
  }
  return steps;
}

const out = document.createElement('pre');
out.id = 'selftest-result';
out.hidden = true;
document.body.append(out);
run().then(steps => {
  out.textContent = JSON.stringify({ ok: errors.length === 0, steps, errors });
}, e => {
  out.textContent = JSON.stringify({ ok: false, failure: e.message, errors });
}).finally(() => { document.title = 'SELFTEST DONE'; });
