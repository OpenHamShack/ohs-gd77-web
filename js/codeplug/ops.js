// Edits that touch more than one table. Records refer to each other by slot
// number (1-based), exactly as the radio stores them, so deleting a record
// has to clear every reference to it, or the radio would follow a dangling
// index into whatever is written in that slot next.

import { LAYOUTS, isStock } from './layouts.js';

const KINDS = {
  channels: l => l.channels.count,
  zones: l => l.zones.count,
  contacts: l => l.contacts.count,
  groupLists: l => l.groupLists.count,
  scanLists: l => (l.scanLists ? l.scanLists.count : 0),
  dtmf: l => l.dtmf.count,
};

export function capacity(cp, kind) { return KINDS[kind](LAYOUTS[cp.fw]); }

export function freeSlot(cp, kind) {
  const used = new Set(cp[kind].map(r => r.slot));
  const max = capacity(cp, kind);
  for (let n = 1; n <= max; n++) if (!used.has(n)) return n;
  return null;
}

function sortBySlot(list) { list.sort((a, b) => a.slot - b.slot); }

// Default values for a new record, taken from the layout's template bytes
// so that "new" means the same thing in the model and in the image.
export function newRecord(cp, kind, values = {}) {
  const L = LAYOUTS[cp.fw];
  const slot = values.slot ?? freeSlot(cp, kind);
  if (slot === null) throw new Error(`No free ${kind} slot (the radio holds ${capacity(cp, kind)})`);
  if (cp[kind].some(r => r.slot === slot)) throw new Error(`${kind} slot ${slot} is already in use`);
  let rec;
  switch (kind) {
    case 'channels': rec = { slot, name: '', rxFreq: 145500000, txFreq: 145500000, mode: 0, bandwidth: 1, rxTone: '', txTone: '', timeslot: 0, contact: 0, groupList: 0, tot: 0, rxOnly: 0, vox: 0 };
      if (isStock(cp.fw)) Object.assign(rec, { power: 1, rxCC: 1, txCC: 1, scanList: 0, admit: 0, totRekey: 0, talkaround: 0 });
      else Object.assign(rec, { power: 0, colorCode: 1, squelch: 0, scanSkip: 0, zoneSkip: 0, noBeep: 0, noEco: 0 });
      break;
    case 'contacts': rec = { slot, name: '', dmrId: 0, callType: 0 };
      if (isStock(cp.fw)) Object.assign(rec, { ringTone: 0, ringStyle: 0 });
      else rec.tsOverride = 1;
      break;
    case 'zones': case 'groupLists': rec = { slot, name: '', members: [] }; break;
    case 'scanLists': {
      if (!L.scanLists) throw new Error('This firmware has no scan lists');
      rec = { slot, name: '', members: [], plType: 3, talkback: 1, channelMark: 1, prio1: 0, prio2: 0, txChannel: 0, holdTime: 40, sampleTime: 8 };
      break;
    }
    case 'dtmf': rec = { slot, name: '', code: '' }; break;
    default: throw new Error('Unknown table ' + kind);
  }
  Object.assign(rec, values, { slot });
  cp[kind].push(rec);
  sortBySlot(cp[kind]);
  return rec;
}

export function deleteRecords(cp, kind, slots) {
  const gone = new Set(slots);
  cp[kind] = cp[kind].filter(r => !gone.has(r.slot));
  const dropMembers = list => { for (const r of list) { const m = r.members.filter(x => !gone.has(x)); if (m.length !== r.members.length) r.members = m; } };
  if (kind === 'channels') {
    dropMembers(cp.zones);
    // Scan-list member value 0 is "the selected channel", never a slot.
    for (const s of cp.scanLists) {
      const m = s.members.filter(x => x === 0 || !gone.has(x));
      if (m.length !== s.members.length) s.members = m;
      for (const k of ['prio1', 'prio2', 'txChannel']) if (s[k] > 1 && gone.has(s[k] - 1)) s[k] = 0;
    }
  } else if (kind === 'contacts') {
    dropMembers(cp.groupLists);
    for (const ch of cp.channels) if (gone.has(ch.contact)) ch.contact = 0;
  } else if (kind === 'groupLists') {
    for (const ch of cp.channels) if (gone.has(ch.groupList)) ch.groupList = 0;
  } else if (kind === 'scanLists') {
    for (const ch of cp.channels) if (ch.scanList !== undefined && gone.has(ch.scanList)) ch.scanList = 0;
  }
}

// Clone a channel into the next free slot: everything but the slot and the
// change-tracking, so encode() writes it as a fresh record.
export function duplicateChannel(cp, slot) {
  const src = cp.channels.find(r => r.slot === slot);
  if (!src) throw new Error('No channel ' + slot);
  const { _orig, slot: _s, ...vals } = src;
  return newRecord(cp, 'channels', { ...vals, name: vals.name.slice(0, 14) + '+' });
}

export function nameOf(cp, kind, slot) {
  const r = cp[kind].find(x => x.slot === slot);
  return r ? r.name : null;
}
