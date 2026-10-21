// The Firmware tab: flash stock TYT firmware or OpenGD77 (with the codec
// merged in) onto an MD-UV380-family radio through its bootloader.
//
// Order of things, deliberately: the user picks files and the whole flash
// is planned and checked first; only then can the bootloader be connected,
// and its own model string has to match the plan before the Flash button
// unlocks. The user supplies every firmware file; nothing is shipped here.

import { h, clear } from './dom.js';
import { planStock, planOpenGD77 } from '../firmware/plan.js';
import { TytDfu, DFU_FILTER } from '../firmware/dfu.js';
import { sha256Hex } from '../firmware/tyt.js';
import { SimulatedTytDfu } from '../sim/tyt-dfu-sim.js';
import { syntheticTyt, syntheticDonor, syntheticOpenGD77 } from '../sim/synthetic-firmware.js';

// Everything the tab knows; also what a diagnostic report includes.
export const fw = {
  mode: 'stock',
  files: {},            // role -> { name, size, sha256, bytes }
  plan: null, planError: null,
  device: null, dfu: null, bootloaderName: null,
  gps: '',              // '', 'yes', 'no'
  ack: false, busy: false, result: null, error: null,
};

const ROLES = {
  stock: [['tyt', 'TYT firmware file for your radio', '.bin']],
  opengd77: [
    ['ogd', 'OpenGD77 build for the MD-UV380 (OpenMDUV380.bin)', '.bin'],
    ['donor', 'Codec donor: TYT MD-9600 V26.45 (MD9600-CSV(2571V5)-V26.45.bin)', '.bin'],
    ['tyt', 'TYT firmware file for your radio (gives its encryption key)', '.bin'],
  ],
};

export function firmwareDiagnostics() {
  return {
    mode: fw.mode,
    files: Object.fromEntries(Object.entries(fw.files).map(([k, f]) => [k, { name: f.name, size: f.size, sha256: f.sha256 }])),
    plan: fw.plan && {
      mode: fw.plan.mode, family: fw.plan.family.id, codecMerged: fw.plan.codecMerged, bytes: fw.plan.imageEncrypted.length,
      erase: fw.plan.erase.map(s => '0x' + s.addr.toString(16)), excluded: fw.plan.excluded, keyConfidence: fw.plan.keyConfidence ?? null, donor: fw.plan.donor ?? null,
    },
    planError: fw.planError,
    bootloaderName: fw.bootloaderName,
    gpsAnswer: fw.gps,
    usb: fw.device ? { usb: `${fw.device.vendorId.toString(16).padStart(4, '0')}:${fw.device.productId.toString(16).padStart(4, '0')}`, productName: fw.device.productName ?? null, manufacturerName: fw.device.manufacturerName ?? null, simulated: !!fw.device.simulated } : null,
    trace: fw.dfu ? fw.dfu.trace.snapshot() : null,
    result: fw.result,
    error: fw.error ? { name: fw.error.name, message: fw.error.message, stage: fw.error.stage ?? null, radioState: fw.error.radioState ?? null } : null,
  };
}

export function firmwareAdvice(e) {
  if (e?.radioState === 'partial') {
    return [
      'The radio\'s firmware is now incomplete, so it will not start normally. The bootloader is not touched and still works.',
      'Switch the radio off. Hold PTT and the button above it, and switch it on again to re-enter the bootloader.',
      'Connect the bootloader again and flash again (the same files, or stock TYT firmware).',
      'Your codeplug and settings are not part of the firmware and are not affected.',
    ];
  }
  if (e?.radioState === 'written') return ['The firmware was written. Switch the radio off and on; if it does not start, flash it again.'];
  return ['Nothing was written to the radio. Check the files and the cable, then try again.'];
}

export function firmwarePanel(ctx) {
  const { simulated, log, notify, progress, progressDone, showFailure } = ctx;
  const root = h('div', { class: 'panel-body firmware' });

  const set = (patch) => { Object.assign(fw, patch); draw(); };

  async function pick(role, file, bytes) {
    fw.files[role] = { name: file, size: bytes.length, sha256: await sha256Hex(bytes), bytes };
    await replan();
  }

  async function replan() {
    fw.plan = null; fw.planError = null; fw.result = null;
    const need = ROLES[fw.mode].map(r => r[0]);
    if (need.every(r => fw.files[r])) {
      try {
        fw.plan = fw.mode === 'stock'
          ? planStock(fw.files.tyt.bytes, fw.files.tyt.name)
          : await planOpenGD77({ ogd: fw.files.ogd.bytes, donor: fw.files.donor.bytes, target: fw.files.tyt.bytes, allowUnknownDonor: simulated() });
        log(`Firmware plan ready: ${fw.plan.family.name}, ${fw.plan.imageEncrypted.length} bytes${fw.plan.codecMerged ? ', codec merged' : ''}`);
      } catch (e) {
        fw.planError = e.message;
        log('Firmware files refused: ' + e.message, 'error');
      }
    }
    draw();
  }

  async function connect() {
    try {
      set({ busy: true, error: null });
      let device;
      if (simulated()) device = new SimulatedTytDfu();
      else {
        if (!navigator.usb) throw new Error('This browser has no WebUSB. Use Chrome or Edge on a computer.');
        device = await navigator.usb.requestDevice({ filters: [DFU_FILTER] });
      }
      const dfu = new TytDfu(device, { log });
      await dfu.open();
      const name = await dfu.identify();
      fw.device = device; fw.dfu = dfu; fw.bootloaderName = name;
      fw.gps = /GPS/i.test(name) ? 'yes' : '';
      notify(`Bootloader found: "${name}"${device.simulated ? ' (simulated)' : ''}`, 'ok');
    } catch (e) {
      if (e.name !== 'NotFoundError') { fw.error = e; notify('Could not reach the bootloader: ' + e.message, 'error'); }
    } finally { set({ busy: false }); }
  }

  function blockers() {
    const p = fw.plan;
    const out = [];
    if (!p) out.push('Choose the firmware files first.');
    if (!fw.dfu) out.push('Connect the radio in bootloader mode.');
    if (p && fw.bootloaderName && !TytDfu.matches(fw.bootloaderName, p.keyFamily)) out.push(`The radio says "${fw.bootloaderName}", which is not a ${p.family.name}. Refused.`);
    if (p && p.mode === 'stock' && p.family.gps !== undefined) {
      if (!fw.gps) out.push('Say whether your radio has GPS.');
      else if ((fw.gps === 'yes') !== p.family.gps) out.push(`This file is the ${p.family.gps ? 'GPS' : 'non-GPS'} firmware but you said your radio ${fw.gps === 'yes' ? 'has' : 'has no'} GPS. Use the matching file.`);
    }
    if (!fw.ack) out.push('Tick the box to confirm you have read the warnings.');
    return out;
  }

  async function flash() {
    const b = blockers();
    if (b.length) { notify(b[0], 'error'); return; }
    set({ busy: true, error: null, result: null });
    try {
      await fw.dfu.flash(fw.plan, progress('Flashing'));
      fw.result = { ok: true, at: new Date().toISOString() };
      notify('Firmware written and the radio is restarting.' + (fw.plan.mode === 'opengd77' ? ' Now restore your codeplug: Connect OpenGD77, open your .gd77backup, and Write.' : ''), 'ok');
      fw.dfu = null; fw.device = null; // the radio has left the bootloader; its name stays for the report
    } catch (e) {
      fw.error = e; fw.result = { ok: false };
      showFailure('Firmware flash failed', e);
    } finally {
      progressDone();
      set({ busy: false });
    }
  }

  async function loadSimulatedFiles() {
    if (fw.mode === 'stock') await pick('tyt', 'simulated-MD-UV380-noGPS.bin', syntheticTyt().file);
    else {
      fw.files.ogd = { name: 'simulated-OpenMDUV380.bin', size: 0, sha256: '', bytes: syntheticOpenGD77() };
      fw.files.donor = { name: 'simulated-MD9600-donor.bin', size: 0, sha256: '', bytes: syntheticDonor().file };
      for (const k of ['ogd', 'donor']) { fw.files[k].size = fw.files[k].bytes.length; fw.files[k].sha256 = await sha256Hex(fw.files[k].bytes); }
      await pick('tyt', 'simulated-MD-UV380-noGPS.bin', syntheticTyt().file);
    }
  }

  function fileInput(role, label, accept) {
    const input = h('input', { type: 'file', accept, id: 'fw-file-' + role });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (f) await pick(role, f.name, new Uint8Array(await f.arrayBuffer()));
    });
    const have = fw.files[role];
    return h('label', { class: 'fw-file' }, h('span', {}, label), input,
      have ? h('span', { class: 'muted fw-have' }, `${have.name} · ${(have.size / 1024).toFixed(0)} KB · SHA-256 ${have.sha256.slice(0, 12)}…`) : null);
  }

  function planView() {
    if (fw.planError) return h('p', { class: 'notice error', id: 'fw-plan-error' }, 'Refused: ' + fw.planError);
    const p = fw.plan;
    if (!p) return h('p', { class: 'muted' }, 'The plan appears here once the files are chosen. Nothing is sent to the radio until you press Flash.');
    const kb = n => `${(n / 1024).toFixed(0)} KB`;
    return h('div', { class: 'fw-plan', id: 'fw-plan' },
      h('h3', {}, 'What will be written'),
      h('ul', {},
        h('li', {}, `Radio model: ${p.family.name}`),
        h('li', {}, `Firmware: ${p.mode === 'stock' ? 'stock TYT' : 'OpenGD77'}, ${kb(p.imageEncrypted.length)} at 0x0800C000`),
        h('li', {}, `AMBE codec merged in: ${p.codecMerged ? 'yes, from ' + p.donor : 'no (stock firmware has its own)'}`),
        h('li', {}, `Flash sectors to erase: ${p.erase.length} (${p.erase.map(s => '0x' + s.addr.toString(16).toUpperCase().padStart(8, '0')).join(', ')}); the bootloader below 0x0800C000 is never touched`),
        ...p.excluded.map(x => h('li', {}, `Not written: the 0x${x.addr.toString(16).padStart(8, '0')} segment (${kb(x.len)}), ${x.why}`))));
  }

  function draw() {
    const p = fw.plan;
    const gpsRelevant = p && p.mode === 'stock' && p.family.gps !== undefined;
    const block = blockers();
    // DOM append() would print a null as the text "null".
    clear(root).append(...[
      h('div', { class: 'help fw-intro' },
        h('h2', {}, 'Firmware (MD-UV380 / RT3S, MD-9600, MD-2017)'),
        h('p', { class: 'warn-text' }, h('strong', {}, 'Experimental, not yet tested on a real radio.'), ' Flashing firmware rewrites the radio\'s program. If it stops part way the radio will not start until it is flashed again; its bootloader is never touched, so that is always possible.'),
        h('ol', {},
          h('li', {}, 'Back up your codeplug first (Read on the main page). Firmware does not touch it, but you will want it after switching firmware.'),
          h('li', {}, 'Put the radio in bootloader mode: switch it off, hold PTT and the button just above PTT, and switch it on. The screen stays blank and the LED lights.'),
          h('li', {}, 'Drivers: none on a Mac or with Chrome on Linux (on Linux allow 0483:df11 with a udev rule). On Windows the bootloader may need the WinUSB driver, installed with Zadig.'),
          h('li', {}, 'After flashing OpenGD77, restore your codeplug: Connect OpenGD77, open your .gd77backup, Write.'),
          h('li', {}, 'OpenGD77 is free for non-commercial use only: ', h('a', { href: 'https://www.opengd77.com/', target: '_blank', rel: 'noopener' }, 'see the OpenGD77 licence'), '. You supply all firmware files; this page does not provide any.'))),
      h('fieldset', { class: 'fw-mode' }, h('legend', {}, 'What to flash'),
        ...[['stock', 'Stock TYT firmware'], ['opengd77', 'OpenGD77, with the codec merged in from a TYT file']].map(([v, l]) =>
          h('label', {}, h('input', { type: 'radio', name: 'fw-mode', value: v, checked: fw.mode === v, onchange: () => { fw.mode = v; replan(); } }), ' ', l))),
      h('div', { class: 'fw-files' }, ROLES[fw.mode].map(r => fileInput(...r)),
        simulated() ? h('button', { type: 'button', id: 'fw-sim-files', onclick: loadSimulatedFiles }, 'Use simulated firmware files') : null),
      planView(),
      h('div', { class: 'toolbar' },
        h('button', { type: 'button', id: 'fw-connect', disabled: fw.busy || !p, onclick: connect }, fw.dfu ? 'Reconnect bootloader' : 'Connect bootloader'),
        fw.dfu && fw.bootloaderName ? h('span', { id: 'fw-bootloader', class: 'pill ' + (p && TytDfu.matches(fw.bootloaderName, p.keyFamily) ? 'on' : 'off') }, `Bootloader: ${fw.bootloaderName}`) : null),
      gpsRelevant ? h('fieldset', { class: 'fw-gps' }, h('legend', {}, 'Does your radio have GPS?'),
        h('p', { class: 'muted' }, fw.bootloaderName && !/GPS/i.test(fw.bootloaderName) ? `The bootloader says "${fw.bootloaderName}", which does not tell GPS and non-GPS radios apart. If OpenGD77 is on it now, its menu shows a GPS entry only when GPS is fitted.` : 'GPS and non-GPS radios need different stock firmware files.'),
        ...[['yes', 'Yes, it has GPS'], ['no', 'No GPS']].map(([v, l]) => h('label', {}, h('input', { type: 'radio', name: 'fw-gps', value: v, checked: fw.gps === v, onchange: () => set({ gps: v }) }), ' ', l))) : null,
      h('label', { class: 'ack' }, h('input', { type: 'checkbox', id: 'fw-ack', checked: fw.ack, onchange: e => set({ ack: e.target.checked }) }), ' I have backed up my codeplug and understand this is experimental.'),
      h('div', { class: 'toolbar' },
        h('button', { type: 'button', id: 'fw-flash', class: 'danger', disabled: fw.busy || block.length > 0, onclick: flash }, 'Flash firmware'),
        h('span', { class: 'muted', id: 'fw-why' }, block[0] ?? (fw.result?.ok ? 'Done.' : 'Ready to flash.'))),
      fw.result?.ok ? h('p', { class: 'notice ok', id: 'fw-done' }, 'Firmware written; the radio restarted.' + (fw.plan?.mode === 'opengd77' ? ' Restore your codeplug now from your .gd77backup.' : '')) : null,
    ].filter(Boolean));
  }

  draw();
  return root;
}
