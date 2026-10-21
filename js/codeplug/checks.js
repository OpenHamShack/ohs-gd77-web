// Plausibility checks on a decoded codeplug. They do not judge the user's
// choices; they look for the signs of a wrong memory map or byte order
// (frequencies off the radio's bands, tones that are not BCD, contact IDs
// too big for DMR's 24 bits, members pointing at nothing), which is what a
// diagnostic report or a first read of a new radio model needs to show.

const inBand = hz => hz !== null && ((hz >= 136e6 && hz <= 174e6) || (hz >= 400e6 && hz <= 480e6));

export function summarize(cp) {
  const counts = {
    channels: cp.channels.length, zones: cp.zones.length, contacts: cp.contacts.length,
    groupLists: cp.groupLists.length, scanLists: cp.scanLists.length, dtmf: cp.dtmf.length,
  };
  const warnings = [];
  const outOfBand = cp.channels.filter(c => !inBand(c.rxFreq) || !inBand(c.txFreq));
  if (outOfBand.length) warnings.push({ kind: 'out-of-band', count: outOfBand.length, slots: outOfBand.slice(0, 20).map(c => c.slot) });
  const rawTones = cp.channels.filter(c => /^raw:/.test(c.rxTone) || /^raw:/.test(c.txTone));
  if (rawTones.length) warnings.push({ kind: 'undecodable-tone', count: rawTones.length, slots: rawTones.slice(0, 20).map(c => c.slot) });
  const ids = cp.contacts.map(c => c.dmrId);
  const notBcd = ids.filter(v => v === null).length;
  if (notBcd) warnings.push({ kind: 'contact-id-not-bcd', count: notBcd });
  const tooBig = ids.filter(v => v !== null && v > 16777215).length;
  if (tooBig) warnings.push({ kind: 'contact-id-over-24-bits', count: tooBig });
  const channelSlots = new Set(cp.channels.map(c => c.slot));
  const contactSlots = new Set(cp.contacts.map(c => c.slot));
  const dz = cp.zones.flatMap(z => z.members).filter(m => !channelSlots.has(m)).length;
  if (dz) warnings.push({ kind: 'zone-member-missing', count: dz });
  const dg = cp.groupLists.flatMap(g => g.members).filter(m => !contactSlots.has(m)).length;
  if (dg) warnings.push({ kind: 'group-list-member-missing', count: dg });
  const dc = cp.channels.filter(c => c.contact && !contactSlots.has(c.contact)).length;
  if (dc) warnings.push({ kind: 'channel-contact-missing', count: dc });
  const personalIds = ids.filter(v => v !== null && v >= 1000000 && v <= 9999999).length;
  return { counts, personalIds, warnings };
}
