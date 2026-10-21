// CSV import/export for channels and contacts.
//
// Channel columns follow CHIRP's export (Location, Name, Frequency, Duplex,
// Offset, Tone, rToneFreq, cToneFreq, DtcsCode, DtcsPolarity, RxDtcsCode,
// CrossMode, Mode, Power) so an analogue channel list can move between the
// two, with DMR columns added after them (ColorCode, TimeSlot, Contact,
// RxGroupList, RxOnly). Contacts and group lists are referred to by name in
// the file and resolved to slot numbers on import.

import { newRecord } from './codeplug/ops.js';
import { isStock } from './codeplug/layouts.js';

export function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

const quote = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function toCSV(rows) { return rows.map(r => r.map(quote).join(',')).join('\r\n') + '\r\n'; }

function table(text) {
  const rows = parseCSV(text.replace(/^﻿/, ''));
  if (!rows.length) throw new Error('The CSV file is empty');
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  return rows.slice(1).map((r, i) => ({ line: i + 2, get: (...names) => { for (const n of names) { const k = head.indexOf(n); if (k >= 0 && r[k] !== undefined) return r[k].trim(); } return ''; } }));
}

const mhz = hz => (hz / 1e6).toFixed(6);
const isDcs = t => /^D\d{3}[NI]$/.test(t);
const isCtcss = t => /^\d+(\.\d)?$/.test(t);

function toneColumns(rx, tx) {
  const o = { Tone: '', rToneFreq: '88.5', cToneFreq: '88.5', DtcsCode: '023', DtcsPolarity: 'NN', RxDtcsCode: '023', CrossMode: 'Tone->Tone' };
  if (!rx && !tx) return o;
  if (isCtcss(tx) && !rx) return { ...o, Tone: 'Tone', rToneFreq: tx };
  if (isCtcss(tx) && tx === rx) return { ...o, Tone: 'TSQL', rToneFreq: tx, cToneFreq: tx };
  if (isDcs(tx) && isDcs(rx) && tx.slice(1, 4) === rx.slice(1, 4)) {
    return { ...o, Tone: 'DTCS', DtcsCode: tx.slice(1, 4), RxDtcsCode: rx.slice(1, 4), DtcsPolarity: (tx[4] === 'I' ? 'R' : 'N') + (rx[4] === 'I' ? 'R' : 'N') };
  }
  const kind = t => (isDcs(t) ? 'DTCS' : isCtcss(t) ? 'Tone' : '');
  const out = { ...o, Tone: 'Cross', CrossMode: `${kind(tx)}->${kind(rx)}` };
  if (isCtcss(tx)) out.rToneFreq = tx;
  if (isCtcss(rx)) out.cToneFreq = rx;
  if (isDcs(tx)) out.DtcsCode = tx.slice(1, 4);
  if (isDcs(rx)) out.RxDtcsCode = rx.slice(1, 4);
  out.DtcsPolarity = (isDcs(tx) && tx[4] === 'I' ? 'R' : 'N') + (isDcs(rx) && rx[4] === 'I' ? 'R' : 'N');
  return out;
}

function tonesFromColumns(g) {
  const mode = g('tone');
  const pol = (g('dtcspolarity') || 'NN').toUpperCase();
  const dcs = (code, p) => 'D' + String(code || '023').padStart(3, '0') + (p === 'R' ? 'I' : 'N');
  const rT = g('rtonefreq') || '88.5', cT = g('ctonefreq') || rT;
  switch (mode) {
    case '': return { txTone: '', rxTone: '' };
    case 'Tone': return { txTone: rT, rxTone: '' };
    case 'TSQL': return { txTone: cT, rxTone: cT };
    case 'DTCS': return { txTone: dcs(g('dtcscode'), pol[0]), rxTone: dcs(g('rxdtcscode') || g('dtcscode'), pol[1]) };
    case 'Cross': {
      const [t, r] = (g('crossmode') || 'Tone->Tone').split('->');
      const side = (k, isTx) => (k === 'Tone' ? (isTx ? rT : cT) : k === 'DTCS' ? dcs(isTx ? g('dtcscode') : g('rxdtcscode'), pol[isTx ? 0 : 1]) : '');
      return { txTone: side(t, true), rxTone: side(r, false) };
    }
    default: throw new Error(`Unknown Tone mode "${mode}"`);
  }
}

export function channelsToCSV(cp) {
  const contactName = s => cp.contacts.find(c => c.slot === s)?.name ?? '';
  const glName = s => cp.groupLists.find(c => c.slot === s)?.name ?? '';
  const head = ['Location', 'Name', 'Frequency', 'Duplex', 'Offset', 'Tone', 'rToneFreq', 'cToneFreq', 'DtcsCode', 'DtcsPolarity', 'RxDtcsCode', 'CrossMode', 'Mode', 'Power', 'ColorCode', 'TimeSlot', 'Contact', 'RxGroupList', 'RxOnly'];
  const rows = [head];
  for (const c of cp.channels) {
    if (c.rxFreq === null) continue;
    const tx = c.txFreq ?? c.rxFreq;
    let duplex = '', offset = 0;
    if (tx !== c.rxFreq) {
      const d = tx - c.rxFreq;
      if (Math.abs(d) <= 70e6) { duplex = d > 0 ? '+' : '-'; offset = Math.abs(d); } else { duplex = 'split'; offset = tx; }
    }
    const t = c.mode === 1 ? toneColumns('', '') : toneColumns(c.rxTone, c.txTone);
    const power = isStock(cp.fw) ? (c.power ? 'High' : 'Low') : String(c.power);
    rows.push([c.slot, c.name, mhz(c.rxFreq), duplex, mhz(offset), t.Tone, t.rToneFreq, t.cToneFreq, t.DtcsCode, t.DtcsPolarity, t.RxDtcsCode, t.CrossMode,
      c.mode === 1 ? 'DMR' : c.bandwidth ? 'FM' : 'NFM', power,
      isStock(cp.fw) ? c.rxCC : c.colorCode, c.timeslot ? 2 : 1, contactName(c.contact), glName(c.groupList), c.rxOnly ? 'Yes' : '']);
  }
  return toCSV(rows);
}

// Rows with a Location update the channel in that slot (only the fields
// that actually change are then written to the radio); rows without one
// go into free slots.
export function channelsFromCSV(cp, text) {
  const warnings = [];
  let added = 0, updated = 0;
  const byName = (list, name, what, line) => {
    if (!name) return 0;
    const r = list.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!r) { warnings.push(`Line ${line}: no ${what} called "${name}"; left empty`); return 0; }
    return r.slot;
  };
  for (const { line, get: g } of table(text)) {
    try {
      const name = g('name').slice(0, 16);
      const rx = Math.round(parseFloat(g('frequency', 'rxfrequency', 'rx')) * 1e6);
      if (!name || !Number.isFinite(rx)) { warnings.push(`Line ${line}: needs a Name and a Frequency; skipped`); continue; }
      const duplex = g('duplex'), off = Math.round((parseFloat(g('offset')) || 0) * 1e6);
      const tx = duplex === '+' ? rx + off : duplex === '-' ? rx - off : duplex === 'split' ? off : rx;
      const modeS = (g('mode') || 'FM').toUpperCase();
      const dmr = modeS === 'DMR' || modeS === 'DIG';
      const vals = { name, rxFreq: rx, txFreq: tx, mode: dmr ? 1 : 0, bandwidth: dmr || modeS === 'NFM' ? 0 : 1, rxOnly: duplex === 'off' || /^(y|yes|1|true)$/i.test(g('rxonly')) ? 1 : 0 };
      Object.assign(vals, dmr ? { rxTone: '', txTone: '' } : tonesFromColumns(g));
      const p = g('power');
      if (p) {
        const n = parseFloat(p);
        if (isStock(cp.fw)) vals.power = /^h/i.test(p) || n >= 5 ? 1 : 0;
        else vals.power = Number.isFinite(n) && /^\d+$/.test(p) ? Math.min(10, n) : /^h/i.test(p) ? 9 : /^l/i.test(p) ? 3 : /^m/i.test(p) ? 0 : 0;
      }
      if (dmr) {
        const cc = parseInt(g('colorcode', 'cc'), 10);
        if (Number.isFinite(cc)) { if (isStock(cp.fw)) { vals.rxCC = cc; vals.txCC = cc; } else vals.colorCode = cc; }
        const ts = parseInt(g('timeslot', 'ts'), 10);
        if (ts === 1 || ts === 2) vals.timeslot = ts - 1;
        vals.contact = byName(cp.contacts, g('contact'), 'contact', line);
        vals.groupList = byName(cp.groupLists, g('rxgrouplist', 'grouplist'), 'RX group list', line);
      }
      const loc = parseInt(g('location'), 10);
      const existing = Number.isFinite(loc) ? cp.channels.find(c => c.slot === loc) : null;
      if (existing) { Object.assign(existing, vals); updated++; }
      else { newRecord(cp, 'channels', Number.isFinite(loc) && loc >= 1 && loc <= 1024 ? { ...vals, slot: loc } : vals); added++; }
    } catch (e) { warnings.push(`Line ${line}: ${e.message}`); }
  }
  return { added, updated, warnings };
}

const CALL = ['Group', 'Private', 'All'];
const TS = { 1: 'None', 0: 'TS1', 2: 'TS2' };

export function contactsToCSV(cp) {
  const head = ['Location', 'Name', 'DMR ID', 'Call Type', isStock(cp.fw) ? 'Ring Tone' : 'TS Override'];
  const rows = [head];
  for (const c of cp.contacts) {
    rows.push([c.slot, c.name, c.dmrId ?? '', CALL[c.callType] ?? c.callType, isStock(cp.fw) ? (c.ringTone ? 'On' : 'Off') : (TS[c.tsOverride] ?? c.tsOverride)]);
  }
  return toCSV(rows);
}

export function contactsFromCSV(cp, text) {
  const warnings = [];
  let added = 0, updated = 0;
  for (const { line, get: g } of table(text)) {
    try {
      const name = g('name', 'callsign', 'contactname').slice(0, 16);
      const id = parseInt(g('dmrid', 'id', 'radioid', 'callid', 'number'), 10);
      if (!name || !Number.isFinite(id)) { warnings.push(`Line ${line}: needs a Name and a DMR ID; skipped`); continue; }
      const t = g('calltype', 'type').toLowerCase();
      const vals = { name, dmrId: id, callType: t.startsWith('p') ? 1 : t.startsWith('a') ? 2 : 0 };
      if (isStock(cp.fw)) { const r = g('ringtone'); if (r) vals.ringTone = /^(on|yes|1)$/i.test(r) ? 1 : 0; }
      else { const o = g('tsoverride').toUpperCase(); if (o) vals.tsOverride = o === 'TS1' ? 0 : o === 'TS2' ? 2 : 1; }
      const loc = parseInt(g('location', 'no'), 10);
      const existing = Number.isFinite(loc) ? cp.contacts.find(c => c.slot === loc) : cp.contacts.find(c => c.name === name && c.dmrId === id);
      if (existing) { Object.assign(existing, vals); updated++; }
      else { newRecord(cp, 'contacts', Number.isFinite(loc) && loc >= 1 && loc <= 1024 ? { ...vals, slot: loc } : vals); added++; }
    } catch (e) { warnings.push(`Line ${line}: ${e.message}`); }
  }
  return { added, updated, warnings };
}
