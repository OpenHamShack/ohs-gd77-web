// Page controller: connection buttons, read/write with the safety gate,
// files, and the tabbed editor. All radio logic lives in session.js and
// below; this file only wires it to the page.

import { h, clear, $ } from './ui/dom.js';
import { recordTable, memberEditor } from './ui/tables.js';
import { fieldEditor, isChanged, CTCSS } from './ui/editors.js';
import { Session, recoveryAdvice } from './session.js';
import { STOCK_USB_FILTER } from './radio/stock-hid.js';
import { OGD_USB_FILTER } from './radio/opengd77-serial.js';
import { SimulatedStockHID } from './sim/stock-sim.js';
import { SimulatedOpenGD77Port } from './sim/opengd77-sim.js';
import { decode, encode } from './codeplug/codec.js';
import { LAYOUTS } from './codeplug/layouts.js';
import { openCodeplugFile, codeplugFile } from './files.js';
import { channelsToCSV, channelsFromCSV, contactsToCSV, contactsFromCSV } from './csv.js';
import { timestamp } from './util.js';
import { buildReport, collectEnvironment, reportSizes } from './report.js';
import { firmwarePanel, firmwareDiagnostics, firmwareAdvice, fw } from './ui/firmware-tab.js';

// The simulated radios on offer: which connect button finds each, and how
// it is built.
const SIMS = {
  stock: { kind: 'stock', label: 'a GD-77 running the stock firmware', make: () => new SimulatedStockHID() },
  opengd77: { kind: 'opengd77', label: 'a GD-77 running OpenGD77', make: () => new SimulatedOpenGD77Port() },
  uv380: { kind: 'opengd77', label: 'a TYT MD-UV380 running OpenGD77', make: () => new SimulatedOpenGD77Port({ radioType: 6 }) },
  // Found only by the Firmware tab's "Connect bootloader".
  uv380dfu: { kind: 'dfu', label: 'an MD-UV380 in its firmware bootloader (Firmware tab)', make: () => null },
};

const FW_NAMES = { stock: 'the stock GD-77 firmware', 'stock-v2': 'the stock GD-77 firmware 2.x', opengd77: 'OpenGD77 (GD-77 family)', 'opengd77-stm32': 'OpenGD77 (MD-UV380 family)' };

const state = {
  cp: null,             // the codeplug being edited
  source: '',           // where it came from, for the status line
  missing: [],          // byte ranges the opened file did not contain
  dirty: false,
  tab: 'general',
  sel: { zones: { sel: null }, groupLists: { sel: null }, scanLists: { sel: null } },
  sim: null,            // a key of SIMS, or null for a real radio
  simDevice: null,
  device: null,         // the HIDDevice / SerialPort in use
  lastBackup: null,     // { name, data, mime } of the read backup
  busy: false,
};

// --- log and notices ----------------------------------------------------------

function log(msg, level = 'info') {
  const t = new Date().toLocaleTimeString();
  const line = h('div', { class: 'log-line ' + level }, h('time', {}, t), ' ', msg);
  const box = $('#log');
  box.append(line);
  while (box.childNodes.length > 500) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

function notify(msg, level = 'info') {
  log(msg, level);
  const n = $('#notice');
  n.textContent = msg;
  n.className = 'notice ' + level;
  clearTimeout(notify.t);
  if (level !== 'error') notify.t = setTimeout(() => { n.textContent = ''; n.className = 'notice'; }, 6000);
}

// --- files ----------------------------------------------------------------------

// Hands a file to the browser's download machinery.
export let saveFile = async (name, data, mime = 'application/octet-stream') => {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

const session = new Session({
  log: m => log(m),
  saveFile: async (name, data, mime) => {
    state.lastBackup = { name, data, mime };
    await saveFile(name, data, mime);
  },
});

// --- progress -------------------------------------------------------------------

function progress(label) {
  const bar = $('#progress'), txt = $('#progress-text');
  bar.hidden = false; txt.hidden = false;
  return p => {
    bar.value = p;
    txt.textContent = `${label} ${Math.round(p * 100)}%`;
  };
}
function progressDone() { $('#progress').hidden = true; $('#progress-text').hidden = true; }

// --- connection -------------------------------------------------------------

async function connect(kind) {
  if (state.busy) return;
  try {
    setBusy(true);
    let device;
    if (state.sim) {
      if (SIMS[state.sim].kind !== kind) {
        throw new Error(`No ${kind === 'stock' ? 'stock-firmware' : 'OpenGD77'} radio found: the simulated radio is ${SIMS[state.sim].label}.`);
      }
      device = state.simDevice ??= SIMS[state.sim].make();
    } else if (kind === 'stock') {
      if (!navigator.hid) throw new Error('This browser has no WebHID. Use desktop Chrome or Edge.');
      const list = await navigator.hid.requestDevice({ filters: [STOCK_USB_FILTER] });
      if (!list.length) return;
      device = list[0];
    } else {
      if (!navigator.serial) throw new Error('This browser has no Web Serial. Use desktop Chrome or Edge.');
      try { device = await navigator.serial.requestPort({ filters: [OGD_USB_FILTER] }); }
      catch (e) { if (e.name === 'NotFoundError') return; throw e; }
    }
    state.device = device;
    const info = await session.connect(kind, device);
    notify(`Connected to ${info.model}${state.sim ? ' (simulated)' : ''}. Read the radio before writing to it.`, 'ok');
  } catch (e) {
    state.device = null;
    state.lastError = e;
    notify(e.message + (session.diag.kind ? ' A diagnostic report can help us fix this.' : ''), 'error');
  } finally {
    setBusy(false);
  }
}

async function disconnect() {
  await session.disconnect();
  state.device = null;
  notify('Disconnected');
  render();
}

if (navigator.hid) navigator.hid.addEventListener('disconnect', e => { if (e.device === state.device) { session.lost(); state.device = null; notify('The radio was unplugged', 'error'); render(); } });
if (navigator.serial) navigator.serial.addEventListener('disconnect', e => { if (e.target === state.device) { session.lost(); state.device = null; notify('The radio was unplugged', 'error'); render(); } });

// --- read / write -----------------------------------------------------------------

async function readRadio() {
  if (!confirmDiscard()) return;
  try {
    setBusy(true);
    state.lastError = null;
    const img = await session.read(progress('Reading'));
    loadImage(img, `Read from the radio at ${new Date().toLocaleTimeString()}`, []);
    notify(`Read complete. Backup downloaded as ${session.backupName}. Writing is now enabled. If anything looks wrong, use "Send diagnostic report".`, 'ok');
  } catch (e) {
    showFailure('Read failed', e);
  } finally {
    progressDone();
    setBusy(false);
  }
}

async function writeRadio() {
  if (!session.canWrite || !state.cp) return;
  let image;
  try { image = encode(state.cp); }
  catch (e) { notify('Cannot write: ' + e.message, 'error'); return; }
  const ok = await confirmWrite();
  if (!ok) return;
  try {
    setBusy(true);
    state.lastError = null;
    const r = await session.write(image, { missing: state.missing, onProgress: progress('Writing') });
    loadImage(session.readImage, `Written to the radio at ${new Date().toLocaleTimeString()}`, []);
    notify(r.blocks ? `Write complete: ${r.blocks} block(s) changed. Switch the radio off and on to be sure it reloads the codeplug.` : 'Nothing to write: the radio already holds this codeplug.', 'ok');
  } catch (e) {
    showFailure('Write failed', e);
  } finally {
    progressDone();
    setBusy(false);
  }
}

function confirmWrite() {
  const dlg = $('#write-dialog');
  const box = $('#write-ack');
  const go = $('#write-go');
  $('#write-backup').textContent = session.backupName;
  $('#write-target').textContent = session.info?.model ?? 'the radio';
  box.checked = false; go.disabled = true;
  box.onchange = () => { go.disabled = !box.checked; };
  dlg.showModal();
  return new Promise(resolve => {
    dlg.onclose = () => resolve(dlg.returnValue === 'write');
  });
}

function showFailure(title, e) {
  state.lastError = e;
  log(`${title}: ${e.message}`, 'error');
  const dlg = $('#error-dialog');
  $('#error-title').textContent = title;
  $('#error-message').textContent = e.message;
  const steps = clear($('#error-steps'));
  for (const s of (e?.name === 'DfuError' ? firmwareAdvice(e) : recoveryAdvice(e, session.backupName))) steps.append(h('li', {}, s));
  $('#error-backup').hidden = !state.lastBackup;
  dlg.showModal();
  render();
}

// --- codeplug loading and saving ----------------------------------------------

function loadImage(img, source, missing) {
  state.cp = decode(img);
  state.source = source;
  state.missing = missing;
  state.dirty = false;
  render();
}

function confirmDiscard() {
  return !state.dirty || confirm('You have unsaved changes. Discard them?');
}

async function openFile(file) {
  if (!confirmDiscard()) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let r = openCodeplugFile(file.name, bytes);
    // A 3/4-layout .g77 can be for the stock firmware or OpenGD77; when the
    // channels do not settle it, ask rather than guess.
    if (r.detected && !r.detected.certain && (r.fw === 'stock' || r.fw === 'opengd77')) {
      const other = r.fw === 'stock' ? 'opengd77' : 'stock';
      if (confirm(`${file.name}: ${r.detected.evidence}. Open it as ${r.fw === 'stock' ? 'stock firmware' : 'OpenGD77'}? (Cancel opens it as ${other === 'stock' ? 'stock firmware' : 'OpenGD77'}.)`) === false) r = openCodeplugFile(file.name, bytes, { as: other });
    }
    loadImage(r.image, `Opened ${file.name}`, r.missing);
    const notes = [];
    if (r.detected) notes.push(r.detected.evidence);
    if (r.fw === 'opengd77' && r.missing.length) notes.push('a .g77 has no satellite settings; a write keeps the radio\'s own');
    else if (r.missing.length) notes.push('the end of the RX group list table is not in the file; a write keeps the radio\'s own copy');
    if (LAYOUTS[r.fw].readOnly) notes.push('this layout can be edited and saved but not written to a radio');
    notify(`Opened ${file.name} (${LAYOUTS[r.fw].title})` + (notes.length ? ': ' + notes.join('; ') : ''), 'ok');
  } catch (e) {
    notify(e.message, 'error');
  }
}

async function saveCodeplug(format) {
  if (!state.cp) return;
  try {
    const img = encode(state.cp);
    const f = codeplugFile(img, { radioName: session.info?.model, format });
    const name = `gd77-${img.fw}-${timestamp()}.${f.ext}`;
    await saveFile(name, f.data, f.mime);
    state.cp = decode(img);
    state.dirty = false;
    notify(`Saved ${name}`, 'ok');
    render();
  } catch (e) {
    notify('Cannot save: ' + e.message, 'error');
  }
}

// --- diagnostic report ----------------------------------------------------------

const PART_LABELS = {
  format: 'Report format', formatVersion: 'Report format version', createdAt: 'Time', simulated: 'Simulated radio or not',
  page: 'Version of this page', environment: 'Browser and computer (user agent, platform)', user: 'Your name, email and message',
  transport: 'USB device (IDs, product name, HID layout)', radio: 'What the radio reported about itself',
  session: 'Log, timings and the last 200 raw USB exchanges', error: 'The error and where it happened',
  codeplug: 'Your codeplug as read (and as last written): callsign, DMR ID, channels, contacts', summary: 'Decoded counts and warnings',
};

let reportEnv = null;
let currentReport = null;

function makeReport() {
  currentReport = buildReport({
    session, environment: reportEnv, simulated: !!state.sim, error: state.lastError,
    user: { name: $('#report-name').value.trim(), email: $('#report-email').value.trim(), message: $('#report-message').value.trim() },
    pageUrl: location.origin + location.pathname,
    firmware: Object.keys(fw.files).length || fw.dfu || fw.error ? firmwareDiagnostics() : null,
  });
  return currentReport;
}

function renderReportPreview() {
  const r = makeReport();
  const sz = reportSizes(r);
  const kb = n => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);
  const list = clear($('#report-sizes'));
  for (const p of sz.parts) if (!['format', 'formatVersion', 'createdAt', 'simulated'].includes(p.part)) list.append(h('li', {}, `${PART_LABELS[p.part] ?? p.part}: ${kb(p.bytes)}`));
  list.append(h('li', {}, h('strong', {}, `Total: ${kb(sz.total)}`)));
  $('#report-json').value = JSON.stringify(r, null, 1);
  $('#report-send').disabled = sz.tooBig;
  if (sz.tooBig) setReportStatus('This report is too large to send; download it instead.', 'error');
}

function setReportStatus(text, level, ref) {
  const st = clear($('#report-status'));
  st.className = 'notice ' + (level || '');
  st.append(text);
  if (ref) st.append(' ', h('strong', { id: 'report-ref' }, ref));
}

async function openReport() {
  for (const d of document.querySelectorAll('dialog[open]')) if (d.id !== 'report-dialog') d.close();
  reportEnv ??= await collectEnvironment();
  $('#report-sim').hidden = !state.sim;
  $('#report-send').disabled = false;
  setReportStatus('', '');
  renderReportPreview();
  if (!$('#report-dialog').open) $('#report-dialog').showModal();
}

async function sendReport() {
  const body = JSON.stringify(makeReport());
  $('#report-send').disabled = true;
  setReportStatus('Sending…', '');
  try {
    const res = await fetch('api/report.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    let j = {};
    try { j = await res.json(); } catch { /* not JSON: reported below */ }
    if (res.status === 201 && j.id) {
      setReportStatus('Sent, thank you. Your reference is', 'ok', j.id);
      log(`Diagnostic report sent: reference ${j.id}`, 'ok');
      return;
    }
    throw new Error(j.error || `the server answered ${res.status}`);
  } catch (e) {
    setReportStatus(`Could not send the report (${e.message}). Use "Download instead" and send the file another way.`, 'error');
    $('#report-send').disabled = false;
  }
}

function downloadReport() {
  saveFile(`gd77-report-${timestamp()}.json`, JSON.stringify(makeReport(), null, 1), 'application/json');
}

// --- rendering ------------------------------------------------------------------

function setBusy(b) { state.busy = b; renderStatus(); }

function onEdit(rec, key, value, err) {
  if (err) { $('#notice').textContent = `${key}: ${err.message}`; $('#notice').className = 'notice error'; return; }
  state.dirty = true;
  renderStatus();
}

function refOptions(cp) {
  return kind => (cp[kind] || []).map(r => [r.slot, `${r.slot}: ${r.name || '(no name)'}`]);
}

function renderStatus() {
  const c = session.connected;
  $('#conn').textContent = c ? `${session.info.model} · ${session.firmware === 'stock' ? 'stock firmware (USB HID)' : 'OpenGD77 (USB serial)'}${state.sim ? ' · simulated' : ''}` : 'No radio connected';
  $('#conn').className = 'pill ' + (c ? 'on' : 'off');
  $('#btn-stock').disabled = state.busy;
  $('#btn-ogd').disabled = state.busy;
  $('#btn-disconnect').disabled = state.busy || !c;
  $('#btn-read').disabled = state.busy || !c;
  const fwMismatch = state.cp && c && state.cp.fw !== session.firmware;
  const readOnly = state.cp && LAYOUTS[state.cp.fw].readOnly;
  const canWrite = !state.busy && session.canWrite && !!state.cp && !fwMismatch && !readOnly;
  $('#btn-write').disabled = !canWrite;
  $('#write-why').textContent = !c ? 'Connect a radio first.'
    : !session.readImage ? 'Writing unlocks after a complete read of this radio (the read is saved as a backup first).'
      : readOnly ? readOnly
      : fwMismatch ? `The open codeplug is for ${FW_NAMES[state.cp.fw]}; the radio runs ${FW_NAMES[session.firmware]}.`
        : `Backup of this radio: ${session.backupName}`;
  $('#btn-save').disabled = state.busy || !state.cp;
  $('#btn-save-g77').disabled = state.busy || !state.cp || state.cp.fw === 'opengd77-stm32';
  $('#btn-open').disabled = state.busy;
  $('#btn-backup-again').hidden = !state.lastBackup;
  $('#btn-report').hidden = !session.diag.kind;
  $('#cp-info').textContent = state.cp ? `${LAYOUTS[state.cp.fw].title} · ${state.source}${state.dirty ? ' · unsaved changes' : ''}` : 'No codeplug loaded: read a radio or open a file.';
}

const TABS = [
  ['general', 'General'], ['channels', 'Channels'], ['zones', 'Zones'], ['contacts', 'Contacts'],
  ['groupLists', 'RX group lists'], ['scanLists', 'Scan lists'], ['dtmf', 'DTMF contacts'], ['firmware', 'Firmware'],
];

function renderTabs() {
  const nav = clear($('#tabs'));
  const cp = state.cp;
  for (const [id, label] of TABS) {
    if (id === 'scanLists' && cp && !LAYOUTS[cp.fw].scanLists) continue;
    const n = cp && cp[id] ? ` (${cp[id].length})` : '';
    // Firmware works without a codeplug: the radio is in its bootloader.
    nav.append(h('button', { type: 'button', role: 'tab', id: 'tab-' + id, 'aria-selected': state.tab === id ? 'true' : 'false', class: state.tab === id ? 'on' : '', disabled: !cp && id !== 'firmware', onclick: () => { state.tab = id; renderTabs(); renderPanel(); } }, label + n));
  }
}

function csvTools(kind) {
  const isCh = kind === 'channels';
  const input = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    try {
      const r = (isCh ? channelsFromCSV : contactsFromCSV)(state.cp, await f.text());
      state.dirty = true;
      notify(`Imported ${f.name}: ${r.added} added, ${r.updated} updated${r.warnings.length ? `, ${r.warnings.length} warning(s) (see log)` : ''}`, r.warnings.length ? 'warn' : 'ok');
      r.warnings.forEach(w => log(w, 'warn'));
      render();
    } catch (e) { notify(e.message, 'error'); }
  });
  return [
    h('button', { type: 'button', onclick: () => input.click() }, 'Import CSV'), input,
    h('button', { type: 'button', onclick: () => saveFile(`gd77-${kind}-${timestamp()}.csv`, (isCh ? channelsToCSV : contactsToCSV)(state.cp), 'text/csv') }, 'Export CSV'),
  ];
}

function renderPanel() {
  const panel = clear($('#panel'));
  const cp = state.cp;
  if (state.tab === 'firmware') {
    panel.append(firmwarePanel({ simulated: () => state.sim === 'uv380dfu', log, notify, progress, progressDone, showFailure }));
    return;
  }
  if (!cp) {
    panel.append(helpContent());
    panel.append(h('div', { class: 'welcome' },
      h('p', {}, 'Already have a saved codeplug? Open it: a dmrconfig ', h('code', {}, '.img'), ' for the stock firmware or a ', h('code', {}, '.gd77backup'), ' for OpenGD77.'),
      h('p', { class: 'muted' }, 'No radio to hand? Pick a simulated one from the Simulator menu.')));
    return;
  }
  const L = LAYOUTS[cp.fw];
  const structure = () => { state.dirty = true; render(); };
  const common = { cp, refOptions: refOptions(cp), onChange: onEdit, onStructure: structure, notify };
  switch (state.tab) {
    case 'general': {
      panel.append(h('div', { class: 'panel-body' }, h('div', { class: 'form' },
        L.general.map(f => h('label', { class: 'field' + (isChanged(cp.general, f.key) ? ' changed' : '') },
          h('span', {}, f.label + (f.unit ? ` (${f.unit})` : '')), fieldEditor(f, cp.general, { refOptions: common.refOptions, onChange: onEdit })))),
      h('p', { class: 'muted' }, 'Only settings whose encoding is confirmed by a working reference implementation are shown. Everything else in the codeplug is kept exactly as it was read.')));
      break;
    }
    case 'channels':
      panel.append(recordTable({ ...common, kind: 'channels', title: 'Channels', fields: L.channels.fields, allowDuplicate: true, extraTools: csvTools('channels') }));
      break;
    case 'contacts':
      panel.append(recordTable({ ...common, kind: 'contacts', title: 'Contacts', fields: L.contacts.fields, extraTools: csvTools('contacts') }));
      break;
    case 'dtmf':
      panel.append(recordTable({ ...common, kind: 'dtmf', title: 'DTMF contacts', fields: [{ key: 'name', label: 'Name', type: 'ascii', len: 16 }, { key: 'code', label: 'Code (0-9 A-D * #)', type: 'ascii', len: 16 }] }));
      break;
    case 'zones':
      panel.append(memberEditor({ ...common, kind: 'zones', title: 'Zones', memberKind: 'channels', maxMembers: L.zones.members, nameLen: L.zones.nameLen, state: state.sel.zones }));
      break;
    case 'groupLists':
      panel.append(memberEditor({ ...common, kind: 'groupLists', title: 'RX group lists', memberKind: 'contacts', maxMembers: L.groupLists.members, nameLen: L.groupLists.nameLen, state: state.sel.groupLists }));
      break;
    case 'scanLists': {
      // Priority and TX channels are stored as channel number + 1, with
      // 1 = the selected channel and 0 = none (or "last active" for TX).
      const chans = cp.channels.map(c => [c.slot + 1, `${c.slot}: ${c.name}`]);
      const fields = L.scanLists.fields.map(f => (f.key === 'prio1' || f.key === 'prio2') ? { ...f, options: [[0, 'None'], [1, 'Selected channel'], ...chans] }
        : f.key === 'txChannel' ? { ...f, options: [[0, 'Last active channel'], [1, 'Selected channel'], ...chans] } : f);
      panel.append(memberEditor({ ...common, kind: 'scanLists', title: 'Scan lists', memberKind: 'channels', maxMembers: L.scanLists.members, nameLen: L.scanLists.nameLen, fields, extraMemberOptions: [[0, 'Selected channel']], state: state.sel.scanLists }));
      break;
    }
  }
}

function helpContent() { return $('#help-content').content.cloneNode(true); }

// Without WebHID or Web Serial the connect buttons can do nothing, so they
// are replaced by a plain sentence saying why. The simulator needs neither.
function renderUsbSupport() {
  const missing = [];
  if (!navigator.hid) missing.push('stock');
  if (!navigator.serial) missing.push('opengd77');
  const real = !state.sim;
  $('#btn-stock').hidden = real && missing.includes('stock');
  $('#btn-ogd').hidden = real && missing.includes('opengd77');
  const msg = !real || !missing.length ? ''
    : missing.length === 2 ? 'This browser cannot talk to the radio. Use Chrome or Edge on a Windows, Mac or Linux computer.'
      : `This browser cannot connect to a radio on ${missing[0] === 'stock' ? 'the stock firmware (no WebHID)' : 'OpenGD77 (no Web Serial)'}. Use Chrome or Edge on a computer.`;
  $('#no-usb').textContent = msg;
  $('#no-usb').hidden = !msg;
}

function render() { renderUsbSupport(); renderStatus(); renderTabs(); renderPanel(); }

// --- start-up -----------------------------------------------------------------

function setSim(kind) {
  state.sim = SIMS[kind] ? kind : null;
  if (state.sim === 'uv380dfu') state.tab = 'firmware';
  state.simDevice = null;
  $('#sim').value = state.sim || '';
  $('#sim-banner').hidden = !state.sim;
  $('#sim-banner').textContent = state.sim ? `Simulator: ${SIMS[state.sim].label} (simulated) is "plugged in". Nothing here touches a real radio.` : '';
}

export function init() {
  const dl = h('datalist', { id: 'ctcss-list' }, CTCSS.map(t => h('option', { value: t })));
  document.body.append(dl);
  $('#btn-stock').onclick = () => connect('stock');
  $('#btn-ogd').onclick = () => connect('opengd77');
  $('#btn-disconnect').onclick = disconnect;
  $('#btn-read').onclick = readRadio;
  $('#btn-write').onclick = writeRadio;
  $('#btn-save').onclick = () => saveCodeplug();
  $('#btn-save-g77').onclick = () => saveCodeplug('g77');
  $('#btn-open').onclick = () => $('#file-input').click();
  $('#file-input').onchange = () => { const f = $('#file-input').files[0]; $('#file-input').value = ''; if (f) openFile(f); };
  $('#btn-backup-again').onclick = () => state.lastBackup && saveFile(state.lastBackup.name, state.lastBackup.data, state.lastBackup.mime);
  $('#error-backup').onclick = () => state.lastBackup && saveFile(state.lastBackup.name, state.lastBackup.data, state.lastBackup.mime);
  $('#sim').onchange = async () => { await session.disconnect(); state.device = null; setSim($('#sim').value); render(); };
  $('#log-clear').onclick = () => clear($('#log'));
  window.addEventListener('beforeunload', e => { if (state.dirty || state.busy) { e.preventDefault(); e.returnValue = ''; } });
  const sim = new URLSearchParams(location.search).get('sim');
  setSim(sim);
  document.addEventListener('click', e => { if (e.target.closest('.report-open')) openReport(); });
  $('#report-send').onclick = sendReport;
  $('#report-download').onclick = downloadReport;
  for (const id of ['#report-name', '#report-email', '#report-message']) $(id).addEventListener('change', renderReportPreview);
  $('#btn-help').onclick = () => { clear($('#help-body')).append(helpContent()); $('#help-dialog').showModal(); };
  render();
  log('Ready.');
}

// Used by the in-page self-test (tests/browser/selftest.js) only.
export const _test = { state, session, setSaveFile: f => { saveFile = f; }, render, openReport, fw };
