// Memory maps for the two firmwares. Every address and bit here comes from a
// reference implementation, cited inline; docs/protocol.md has the longer
// story and the places where the sources disagree. Anything not listed is
// never decoded and is written back exactly as it was read.
//
// Field types (see codec.js): ascii, u8, u16le, bcd8be, bcd4le, freq (BCD8
// little-endian in 10 Hz units), bit, bits, tone, ref8/ref16 (1-based record
// number, 0 = none), bcdstamp (read-only).

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

const TOT_OPTIONS = range(34, i => [i, i === 0 ? 'Off' : `${i * 15} s`]);
const CC_OPTIONS = range(16, i => [i, String(i)]);
const MODE_OPTIONS = [[0, 'FM'], [1, 'DMR']];
const TS_OPTIONS = [[0, 'TS1'], [1, 'TS2']];
const BW_OPTIONS = [[0, '12.5 kHz'], [1, '25 kHz']];
const CALL_TYPES = [[0, 'Group'], [1, 'Private'], [2, 'All']];

// ---------------------------------------------------------------------------
// Stock Radioddity firmware (identifies as "MD-760P"). Map per qdmr
// lib/gd77_codeplug.hh (firmware 4.03.06), cross-checked against dmrconfig
// gd77.c (firmware 3.1.1+).

export const STOCK = {
  fw: 'stock',
  title: 'GD-77, stock Radioddity firmware',
  // The image is dmrconfig's 128 KiB file layout; address == file offset.
  segments: [{ bank: 'mem', addr: 0, size: 0x20000 }],
  // What actually travels over the wire. qdmr reads 0x00080-0x07c00 and
  // 0x08000-0x1eb00. dmrconfig stops at 0x1e2a0, which cuts the RX group
  // list table short (it needs 0x1d620+0x1480 = 0x1eaa0), so qdmr's range
  // is used. 0x07c00-0x08000 is skipped by both and never touched.
  wireRanges: [
    { bank: 'mem', addr: 0x00080, size: 0x07b80 },
    { bank: 'mem', addr: 0x08000, size: 0x16b00 },
  ],
  // A dmrconfig image only has real data below this address.
  dmrconfigEnd: 0x1e2a0,

  general: [
    { key: 'radioName', label: 'Radio name', bank: 'mem', addr: 0xe0, type: 'ascii', len: 8 },
    { key: 'dmrId', label: 'DMR ID', bank: 'mem', addr: 0xe8, type: 'bcd8be', min: 0, max: 16777215 },
    { key: 'intro1', label: 'Intro line 1', bank: 'mem', addr: 0x7540, type: 'ascii', len: 16 },
    { key: 'intro2', label: 'Intro line 2', bank: 'mem', addr: 0x7550, type: 'ascii', len: 16 },
    { key: 'bootDisplay', label: 'Boot screen', bank: 'mem', addr: 0x7518, type: 'u8', options: [[0, 'Image'], [1, 'Text']] },
    { key: 'preamble', label: 'TX preamble', bank: 'mem', addr: 0xf1, type: 'u8', unit: '× 60 ms', min: 0, max: 255 },
    { key: 'monitorType', label: 'Monitor type', bank: 'mem', addr: 0xf2, type: 'u8', options: [[0, 'Open squelch'], [1, 'Silent']] },
    { key: 'voxSensitivity', label: 'VOX sensitivity', bank: 'mem', addr: 0xf3, type: 'u8', min: 1, max: 10 },
    { key: 'lowBatteryInterval', label: 'Low battery warning interval', bank: 'mem', addr: 0xf4, type: 'u8', unit: '× 5 s', min: 0, max: 255 },
    { key: 'callAlertDuration', label: 'Call alert duration', bank: 'mem', addr: 0xf5, type: 'u8', unit: '× 5 s', min: 0, max: 255 },
    { key: 'groupHang', label: 'Group call hang time', bank: 'mem', addr: 0xf8, type: 'u8', unit: '× 500 ms', min: 0, max: 255 },
    { key: 'privateHang', label: 'Private call hang time', bank: 'mem', addr: 0xf9, type: 'u8', unit: '× 500 ms', min: 0, max: 255 },
    { key: 'digitalTPT', label: 'Talk permit tone (digital)', bank: 'mem', addr: 0xfb, type: 'bit', bit: 0 },
    { key: 'analogTPT', label: 'Talk permit tone (analogue)', bank: 'mem', addr: 0xfb, type: 'bit', bit: 1 },
    { key: 'selftestTone', label: 'Self-test pass tone', bank: 'mem', addr: 0xfb, type: 'bit', bit: 2 },
    { key: 'freeTone', label: 'Channel free indication tone', bank: 'mem', addr: 0xfb, type: 'bit', bit: 3 },
    { key: 'allTonesOff', label: 'Disable all tones', bank: 'mem', addr: 0xfb, type: 'bit', bit: 5 },
    { key: 'allLedsOff', label: 'Disable all LEDs', bank: 'mem', addr: 0xfc, type: 'bit', bit: 5 },
    { key: 'txExitTone', label: 'TX exit tone', bank: 'mem', addr: 0xfd, type: 'bit', bit: 3 },
    { key: 'animation', label: 'Power-on animation', bank: 'mem', addr: 0xfd, type: 'bit', bit: 5 },
    { key: 'scanMode', label: 'Scan mode', bank: 'mem', addr: 0xfd, type: 'bits', shift: 6, width: 2, options: [[0, 'Time'], [1, 'Carrier'], [2, 'Search']] },
    { key: 'progPassword', label: 'Programming password', bank: 'mem', addr: 0x100, type: 'ascii', len: 8 },
    { key: 'lastProgrammed', label: 'Last programmed (as stored)', bank: 'mem', addr: 0x88, type: 'bcdstamp', readonly: true },
  ],

  channels: {
    count: 1024, perBank: 128, recSize: 0x38, bitmapLen: 0x10,
    bankAddr: b => ({ bank: 'mem', addr: b === 0 ? 0x03780 : 0x0b1b0 + (b - 1) * 0x1c10 }),
    // New-channel bytes per qdmr RadioddityCodeplug::ChannelElement::clear():
    // name 0xFF, 0x1e = 0x50 and 0x28 = 0x16 as the stock CPS leaves them,
    // tones off (0xFFFF), everything else zero.
    template() {
      const b = new Uint8Array(0x38);
      b.fill(0xff, 0, 16); b[0x1e] = 0x50; b.fill(0xff, 0x20, 0x24); b[0x28] = 0x16;
      return b;
    },
    fields: [
      { key: 'name', label: 'Name', off: 0x00, type: 'ascii', len: 16 },
      { key: 'rxFreq', label: 'RX MHz', off: 0x10, type: 'freq' },
      { key: 'txFreq', label: 'TX MHz', off: 0x14, type: 'freq' },
      { key: 'mode', label: 'Mode', off: 0x18, type: 'u8', options: MODE_OPTIONS },
      { key: 'power', label: 'Power', off: 0x33, type: 'bit', bit: 7, options: [[0, 'Low'], [1, 'High']] },
      { key: 'bandwidth', label: 'BW', off: 0x33, type: 'bit', bit: 1, options: BW_OPTIONS },
      { key: 'rxTone', label: 'RX tone', off: 0x20, type: 'tone' },
      { key: 'txTone', label: 'TX tone', off: 0x22, type: 'tone' },
      { key: 'timeslot', label: 'TS', off: 0x31, type: 'bit', bit: 6, options: TS_OPTIONS },
      { key: 'rxCC', label: 'RX CC', off: 0x2c, type: 'u8', options: CC_OPTIONS },
      { key: 'txCC', label: 'TX CC', off: 0x2a, type: 'u8', options: CC_OPTIONS },
      { key: 'contact', label: 'TX contact', off: 0x2e, type: 'ref16', ref: 'contacts' },
      { key: 'groupList', label: 'RX group list', off: 0x2b, type: 'ref8', ref: 'groupLists' },
      { key: 'scanList', label: 'Scan list', off: 0x1f, type: 'ref8', ref: 'scanLists' },
      { key: 'admit', label: 'Admit', off: 0x1d, type: 'u8', options: [[0, 'Always'], [1, 'Channel free'], [2, 'Color code']] },
      { key: 'tot', label: 'TOT', off: 0x1b, type: 'u8', options: TOT_OPTIONS },
      { key: 'totRekey', label: 'TOT rekey (s)', off: 0x1c, type: 'u8', min: 0, max: 255 },
      { key: 'rxOnly', label: 'RX only', off: 0x33, type: 'bit', bit: 2 },
      { key: 'talkaround', label: 'Talkaround', off: 0x33, type: 'bit', bit: 3 },
      { key: 'vox', label: 'VOX', off: 0x33, type: 'bit', bit: 6 },
    ],
  },

  zones: {
    bank: 'mem', addr: 0x8010, bitmapLen: 0x20, count: 250, recSize: 0x30,
    nameLen: 16, memberOff: 0x10, members: 16, memberBias: 0, ref: 'channels',
  },

  contacts: {
    bank: 'mem', addr: 0x17620, count: 1024, recSize: 0x18,
    // qdmr GD77Codeplug::ContactElement: valid iff the name is set and
    // byte 0x17 is not 0x00 (written 0xFF for a used entry).
    validFlag: 0x17,
    template() { const b = new Uint8Array(0x18).fill(0); b.fill(0xff, 0, 16); b[0x17] = 0xff; return b; },
    fields: [
      { key: 'name', label: 'Name', off: 0x00, type: 'ascii', len: 16 },
      // Big-endian BCD in qdmr's code (getBCD8_be) and dmrconfig's GET_ID,
      // although qdmr's gd77_contact.txt diagram says little-endian.
      { key: 'dmrId', label: 'DMR ID', off: 0x10, type: 'bcd8be', min: 0, max: 16777215 },
      { key: 'callType', label: 'Call type', off: 0x14, type: 'u8', options: CALL_TYPES },
      { key: 'ringTone', label: 'RX tone', off: 0x15, type: 'u8', options: [[0, 'Off'], [1, 'On']] },
      { key: 'ringStyle', label: 'Ring style', off: 0x16, type: 'u8', min: 0, max: 10 },
    ],
  },

  groupLists: {
    // qdmr GD77Codeplug::GroupListBankElement: 0x80 count bytes (members+1,
    // 0 = unused) then 64 lists. dmrconfig says 76, which would not fit in
    // the range either tool reads.
    bank: 'mem', addr: 0x1d620, hdrLen: 0x80, count: 64, recSize: 0x50,
    nameLen: 16, memberOff: 0x10, members: 32, memberBias: 0, ref: 'contacts',
  },

  scanLists: {
    bank: 'mem', addr: 0x1790, hdrLen: 0x40, count: 64, recSize: 0x58,
    nameLen: 15, memberOff: 0x10, members: 32,
    // Scan-list members are channel number + 1; raw 1 means "the selected
    // channel" (dmrconfig CHAN_SELECTED, qdmr ScanListElement::member()).
    memberBias: 1, ref: 'channels',
    template() {
      const b = new Uint8Array(0x58).fill(0);
      b.fill(0xff, 0, 15);
      b[0x0f] = 0xf1;       // talkback, PL type 3, channel mark, low nibble 1 (qdmr diagram)
      b[0x56] = 40; b[0x57] = 8; // 1000 ms / 2000 ms, dmrconfig's defaults
      return b;
    },
    fields: [
      // Bit positions from dmrconfig's scanlist_t and qdmr's diagram. qdmr's
      // code reads the PL type at bit 6, which would overlap talkback; the
      // diagram and dmrconfig agree on bits 5-6.
      { key: 'plType', label: 'Priority', off: 0x0f, type: 'bits', shift: 5, width: 2, options: [[0, 'Non-priority only'], [1, 'Disabled'], [2, 'Priority only'], [3, 'Priority + non-priority']] },
      { key: 'talkback', label: 'Talkback', off: 0x0f, type: 'bit', bit: 7 },
      { key: 'channelMark', label: 'Channel mark', off: 0x0f, type: 'bit', bit: 4 },
      { key: 'prio1', label: 'Priority channel 1', off: 0x50, type: 'u16le' },
      { key: 'prio2', label: 'Priority channel 2', off: 0x52, type: 'u16le' },
      { key: 'txChannel', label: 'TX designated channel', off: 0x54, type: 'u16le' },
      { key: 'holdTime', label: 'Signalling hold time', off: 0x56, type: 'u8', unit: '× 25 ms', min: 0, max: 255 },
      { key: 'sampleTime', label: 'Priority sample time', off: 0x57, type: 'u8', unit: '× 250 ms', min: 0, max: 255 },
    ],
  },

  dtmf: { bank: 'mem', addr: 0x2f88, count: 32, recSize: 0x20 },
};

// ---------------------------------------------------------------------------
// Stock firmware 2.x: the older layout, the one dmrconfig calls "old
// Radioddity GD-77 v2.6" and refuses. Contacts (256) sit low at 0x1788 and
// scan lists high at 0x17620 - the arrangement of the RD-5R (dmrconfig
// rd5r.c, qdmr rd5r_codeplug.hh), and of a real .g77 from a GD-77 on
// V2.06.05 (21/10/2026), whose 238 contacts are exactly there. Channels,
// settings and boot text are where firmware 3/4 keeps them; zones are at
// the same address but in OpenGD77's 68 x 80 shape. The RX
// group list shape (64 lists of 16 members) is the RD-5R's; the real file
// had no lists to confirm it, so this layout is read and saved but never
// written to a radio.

export const STOCK_V2 = {
  ...STOCK,
  fw: 'stock-v2',
  title: 'GD-77, stock firmware 2.x (old layout)',
  readOnly: 'This codeplug uses the old firmware 2.x layout, which this page can read and save but not yet write to a radio: part of it (the RX group lists) is inferred from the RD-5R and has not been checked against a real radio.',
  contacts: { ...STOCK.contacts, addr: 0x1788, count: 256, validFlag: null },
  // 68 zones of 80 channels (0xB0 each), not 250 of 16: the real file's
  // zone names sit every 0xB0 bytes from 0x8030, as qdmr's GD-77 map table
  // also lists them.
  zones: { ...STOCK.zones, count: 68, recSize: 0xb0, members: 80 },
  scanLists: { ...STOCK.scanLists, addr: 0x17620, hdrLen: 0x100, count: 250 },
  groupLists: { ...STOCK.groupLists, addr: 0x1d620, hdrLen: 0x80, count: 64, recSize: 0x30, members: 16 },
};

// ---------------------------------------------------------------------------
// OpenGD77 firmware on a GD-77/GD-77S (MK22 family). Map per qdmr
// lib/opengd77_codeplug.hh + opengd77base_codeplug.{hh,cc}, and
// ReallyOpenGD77 WebCPSd's working codec (frontend/js/app.js).

const SQUELCH_OPTIONS = [[0, 'Default'], [1, 'Open'], ...range(13, i => [i + 2, `${Math.round(((i + 1) * 10) / 14 * 10)}%`]), [15, 'Closed']];

export const OPENGD77 = {
  fw: 'opengd77',
  family: 'W',
  title: 'OpenGD77 firmware (GD-77, GD-77S, DM-1801, RD-5R)',
  // The segments WebCPSd reads and writes (OGD_EEPROM_SEGS/OGD_FLASH_SEGS).
  // The flash ones are whole 4 KiB sectors, because flash is written a
  // sector at a time and a partial sector would erase the bytes after it.
  // `json` is the list each segment belongs to in a .gd77backup file.
  segments: [
    { bank: 'eeprom', addr: 0x000080, size: 0x05fe0, json: 'eeprom' },
    { bank: 'eeprom', addr: 0x007500, size: 0x03b00, json: 'eeprom' },
    { bank: 'flash', addr: 0x07b000, size: 0x14000, json: 'flash' },
    { bank: 'flash', addr: 0x000000, size: 0x02000, json: 'flash' },
  ],

  general: [
    { key: 'callsign', label: 'Callsign', bank: 'eeprom', addr: 0xe0, type: 'ascii', len: 8 },
    { key: 'dmrId', label: 'DMR ID', bank: 'eeprom', addr: 0xe8, type: 'bcd8be', min: 0, max: 16777215 },
    { key: 'intro1', label: 'Intro line 1', bank: 'eeprom', addr: 0x7518 + 0x28, type: 'ascii', len: 16 },
    { key: 'intro2', label: 'Intro line 2', bank: 'eeprom', addr: 0x7518 + 0x38, type: 'ascii', len: 16 },
    { key: 'bootDisplay', label: 'Boot screen', bank: 'eeprom', addr: 0x7518, type: 'u8', options: [[0, 'Image'], [1, 'Text']] },
    { key: 'vhfMin', label: 'VHF lower limit', bank: 'eeprom', addr: 0x84, type: 'bcd4le', unit: 'MHz', min: 0, max: 9999 },
    { key: 'vhfMax', label: 'VHF upper limit', bank: 'eeprom', addr: 0x86, type: 'bcd4le', unit: 'MHz', min: 0, max: 9999 },
    { key: 'uhfMin', label: 'UHF lower limit', bank: 'eeprom', addr: 0x80, type: 'bcd4le', unit: 'MHz', min: 0, max: 9999 },
    { key: 'uhfMax', label: 'UHF upper limit', bank: 'eeprom', addr: 0x82, type: 'bcd4le', unit: 'MHz', min: 0, max: 9999 },
  ],

  channels: {
    count: 1024, perBank: 128, recSize: 0x38, bitmapLen: 0x10,
    bankAddr: b => (b === 0 ? { bank: 'eeprom', addr: 0x003780 } : { bank: 'flash', addr: 0x07b1b0 + (b - 1) * 0x1c10 }),
    // qdmr OpenGD77BaseCodeplug::ChannelElement::clear(): tones off,
    // per-channel DMR ID placeholder 0x001600 with its override bit clear,
    // power 0 (= use the radio's setting), squelch 0 (= global).
    template() {
      const b = new Uint8Array(0x38).fill(0);
      b.fill(0xff, 0, 16); b.fill(0xff, 0x20, 0x24);
      b[0x27] = 0x00; b[0x28] = 0x16; b[0x29] = 0x00;
      return b;
    },
    fields: [
      { key: 'name', label: 'Name', off: 0x00, type: 'ascii', len: 16 },
      { key: 'rxFreq', label: 'RX MHz', off: 0x10, type: 'freq' },
      { key: 'txFreq', label: 'TX MHz', off: 0x14, type: 'freq' },
      { key: 'mode', label: 'Mode', off: 0x18, type: 'u8', options: MODE_OPTIONS },
      { key: 'power', label: 'Power', off: 0x19, type: 'u8', options: range(11, i => [i, i === 0 ? 'Master' : String(i)]) },
      { key: 'bandwidth', label: 'BW', off: 0x33, type: 'bit', bit: 1, options: BW_OPTIONS },
      { key: 'rxTone', label: 'RX tone', off: 0x20, type: 'tone' },
      { key: 'txTone', label: 'TX tone', off: 0x22, type: 'tone' },
      { key: 'timeslot', label: 'TS', off: 0x31, type: 'bit', bit: 6, options: TS_OPTIONS },
      { key: 'colorCode', label: 'CC', off: 0x2c, type: 'u8', options: CC_OPTIONS },
      { key: 'contact', label: 'TX contact', off: 0x2e, type: 'ref16', ref: 'contacts' },
      { key: 'groupList', label: 'RX group list', off: 0x2b, type: 'ref8', ref: 'groupLists' },
      { key: 'squelch', label: 'Squelch', off: 0x37, type: 'u8', options: SQUELCH_OPTIONS },
      { key: 'tot', label: 'TOT', off: 0x1b, type: 'u8', options: TOT_OPTIONS },
      { key: 'rxOnly', label: 'RX only', off: 0x33, type: 'bit', bit: 2 },
      { key: 'vox', label: 'VOX', off: 0x33, type: 'bit', bit: 6 },
      { key: 'scanSkip', label: 'Skip (all)', off: 0x33, type: 'bit', bit: 4 },
      { key: 'zoneSkip', label: 'Skip (zone)', off: 0x33, type: 'bit', bit: 5 },
      { key: 'noBeep', label: 'No beep', off: 0x26, type: 'bit', bit: 6 },
      { key: 'noEco', label: 'No power save', off: 0x26, type: 'bit', bit: 5 },
    ],
  },

  zones: {
    bank: 'eeprom', addr: 0x8010, bitmapLen: 0x20, count: 68, recSize: 0xb0,
    nameLen: 16, memberOff: 0x10, members: 80, memberBias: 0, ref: 'channels',
  },

  contacts: {
    bank: 'flash', addr: 0x087620, count: 1024, recSize: 0x18,
    // No validity byte: a contact exists iff its name is set (WebCPSd).
    validFlag: null,
    template() { const b = new Uint8Array(0x18).fill(0); b.fill(0xff, 0, 16); b[0x17] = 0x01; return b; },
    fields: [
      { key: 'name', label: 'Name', off: 0x00, type: 'ascii', len: 16 },
      // getBCD8_be in qdmr OpenGD77BaseCodeplug::ContactElement::number(),
      // ogdGetBCD8BE in WebCPSd: big-endian, the same as stock.
      { key: 'dmrId', label: 'DMR ID', off: 0x10, type: 'bcd8be', min: 0, max: 16777215 },
      { key: 'callType', label: 'Call type', off: 0x14, type: 'u8', options: CALL_TYPES },
      // 0x01 = no override, 0x00 = force TS1, 0x02 = force TS2 (qdmr).
      { key: 'tsOverride', label: 'TS override', off: 0x17, type: 'u8', options: [[1, 'None'], [0, 'TS1'], [2, 'TS2']] },
    ],
  },

  groupLists: {
    bank: 'flash', addr: 0x08d620, hdrLen: 0x80, count: 76, recSize: 0x50,
    nameLen: 15, memberOff: 0x10, members: 32, memberBias: 0, ref: 'contacts',
  },

  // OpenGD77 scans zones, not stock-style scan lists; qdmr does not model
  // them for this firmware, so the bytes are left alone.
  scanLists: null,

  dtmf: { bank: 'eeprom', addr: 0x2f88, count: 32, recSize: 0x20 },
};

// ---------------------------------------------------------------------------
// OpenGD77 on the STM32 radios (MD-UV380/RT3S, MD-380, DM-1701, MD-2017,
// MD-9600). Same records as above, but these radios have no EEPROM chip:
// what the GD-77 keeps in EEPROM lives in flash at the same address, and
// everything the GD-77 keeps in flash sits 0x20000 higher (qdmr
// lib/openuv380_codeplug.hh Offset, WebCPSd applyRadioFamilyMemoryMap).

function toStm32(bank, addr) {
  return bank === 'eeprom' ? { bank: 'flash', addr } : { bank: 'flash', addr: addr + 0x20000 };
}

function remapLayout(L) {
  const at = o => ({ ...o, ...toStm32(o.bank, o.addr) });
  return {
    ...L,
    fw: 'opengd77-stm32',
    family: 'X',
    title: 'OpenGD77 firmware (MD-UV380, MD-380, DM-1701, MD-2017, MD-9600)',
    segments: L.segments.map(at),
    // The band-limit fields: qdmr defines them but neither of its OpenGD77
    // codeplugs reads or writes them, and on a real MD-UV380 (firmware
    // 5797626, read 21/10/2026) all eight bytes are erased (0xFF). Not
    // offered on this family until something shows the firmware uses them.
    general: L.general.filter(f => !/^(vhf|uhf)(Min|Max)$/.test(f.key)).map(at),
    channels: { ...L.channels, bankAddr: b => { const a = L.channels.bankAddr(b); return toStm32(a.bank, a.addr); } },
    zones: at(L.zones),
    contacts: at(L.contacts),
    groupLists: at(L.groupLists),
    dtmf: at(L.dtmf),
  };
}

export const OPENGD77_STM32 = remapLayout(OPENGD77);

export const LAYOUTS = { stock: STOCK, 'stock-v2': STOCK_V2, opengd77: OPENGD77, 'opengd77-stm32': OPENGD77_STM32 };
export const isStock = fw => fw === 'stock' || fw === 'stock-v2';
export const isOpenGD77 = fw => fw === 'opengd77' || fw === 'opengd77-stm32';
