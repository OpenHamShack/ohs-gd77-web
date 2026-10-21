// Connection, read and write, with the write safety gate. No DOM here, so the
// node tests drive exactly the code the page uses.
//
// The gate: a write is only possible after a complete, successful read of
// the radio that is connected now, in this session, and only once that read
// has been handed to saveFile() as a backup. Reconnecting closes the gate.
// A failed write closes it too, because the radio's contents are no longer
// known; reading again reopens it.

import { StockRadio } from './radio/stock-hid.js';
import { OpenGD77Radio } from './radio/opengd77-serial.js';
import { RadioError } from './radio/errors.js';
import { codeplugFile, fillMissing } from './files.js';
import { timestamp } from './util.js';
import { detectStockLayout } from './g77.js';
import { LAYOUTS } from './codeplug/layouts.js';

export class Session {
  constructor({ log = () => {}, saveFile, settleMs } = {}) {
    if (!saveFile) throw new Error('Session needs a saveFile(name, data, mime) function for backups');
    // Everything a diagnostic report needs, kept even after a failure or a
    // disconnect has cleared the live state.
    this.logLines = [];
    this.diag = { kind: null, device: null, radio: null, info: null, readImage: null, writeImage: null, error: null };
    this.log = m => { this.logLines.push({ t: new Date().toISOString(), m: String(m) }); if (this.logLines.length > 2000) this.logLines.shift(); log(m); };
    this.saveFile = saveFile;
    this.settleMs = settleMs;
    this.radio = null;
    this.info = null;
    this.readImage = null;
    this.backupName = null;
    this.busy = false;
  }

  get connected() { return !!this.radio; }
  get firmware() { return this.radio ? this.radio.firmware : null; }
  get canWrite() { return !!(this.radio && this.readImage && !this.busy); }

  async _guard(fn) {
    if (this.busy) throw new Error('The radio is busy');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  async connect(kind, device) {
    await this.disconnect();
    const radio = kind === 'stock'
      ? new StockRadio(device, { log: this.log })
      : new OpenGD77Radio(device, { log: this.log, ...(this.settleMs !== undefined ? { settleMs: this.settleMs } : {}) });
    this.diag = { kind, device, radio, info: null, readImage: null, writeImage: null, error: null };
    await this._guard(async () => {
      try {
        await radio.open();
        this.info = await radio.identify();
        this.diag.info = this.info;
      } catch (e) {
        this.diag.error = e;
        await radio.close();
        throw e;
      }
    });
    this.radio = radio;
    this.readImage = null;
    this.backupName = null;
    this.log(`Connected: ${this.info.model} (${kind === 'stock' ? 'stock firmware, USB HID' : 'OpenGD77, USB serial'})`);
    return this.info;
  }

  async disconnect() {
    const r = this.radio;
    this.radio = null; this.info = null; this.readImage = null; this.backupName = null;
    if (r) await r.close();
  }

  // Unplugging closes the gate at once; the page calls this from the
  // browser's disconnect event.
  lost() {
    if (!this.radio) return;
    this.log('The radio was disconnected');
    this.radio = null; this.info = null; this.readImage = null;
  }

  async read(onProgress) {
    if (!this.radio) throw new Error('No radio connected');
    return this._guard(async () => {
      this.readImage = null;
      this.diag.error = null;
      let image;
      try { image = await this.radio.readImage(onProgress); }
      catch (e) { this.diag.error = e; throw e; }
      // A stock radio on firmware 2.x keeps an older layout in the same memory.
      if (image.fw === 'stock') {
        const layout = detectStockLayout(image.segs[0].data);
        image.fw = layout.fw;
        if (layout.fw !== 'stock') this.log(`This radio uses the ${LAYOUTS[layout.fw].title} layout (${layout.evidence})`);
      }
      this.diag.readImage = image;
      const f = codeplugFile(image, { radioName: this.info?.model });
      const name = `gd77-${image.fw}-backup-${timestamp()}.${f.ext}`;
      // The backup must be handed over before the gate opens; if saving
      // fails, writing stays disabled.
      await this.saveFile(name, f.data, f.mime);
      this.backupName = name;
      this.readImage = image;
      this.log(`Read complete; backup saved as ${name}. Writing is now enabled.`);
      return image;
    });
  }

  // `missing`: byte ranges the source file did not contain (see files.js).
  async write(image, { missing = [], onProgress } = {}) {
    if (!this.radio) throw new Error('No radio connected');
    if (!this.readImage) throw new Error('Read this radio first: writing is only enabled after a complete read in this session');
    if (LAYOUTS[image.fw]?.readOnly) throw new RadioError(LAYOUTS[image.fw].readOnly);
    if (image.fw !== this.radio.firmware) {
      const what = { 'stock-v2': 'the stock GD-77 firmware 2.x', stock: 'the stock GD-77 firmware', opengd77: 'OpenGD77 on an MK22 radio (GD-77 type)', 'opengd77-stm32': 'OpenGD77 on an STM32 radio (MD-UV380 type)' };
      throw new RadioError(`This codeplug is for ${what[image.fw]} and the connected radio runs ${what[this.radio.firmware]}. Converting between them is not supported.`);
    }
    const full = fillMissing(image, missing, this.readImage);
    this.diag.writeImage = full;
    this.diag.error = null;
    return this._guard(async () => {
      try {
        const r = await this.radio.writeImage(full, this.readImage, onProgress);
        this.readImage = full;
        this.log(`Write complete (${r.blocks} block(s) changed)`);
        return r;
      } catch (e) {
        this.readImage = null;
        this.diag.error = e;
        throw e;
      }
    });
  }
}

// What to tell the user after a failure, in order.
export function recoveryAdvice(err, backupName) {
  const state = err?.radioState ?? 'unknown';
  const backup = backupName ? `the backup file ${backupName}` : 'your most recent backup file';
  if (state === 'partial') {
    return [
      'The write stopped part way: the radio now holds a mix of old and new settings. Do not use it on air until this is fixed.',
      'Switch the radio off and on again.',
      'Reconnect, then Read the radio (this re-enables writing).',
      `Open ${backup} and write it back to restore the radio, or write your edited codeplug again.`,
    ];
  }
  if (state === 'unknown') {
    return [
      'Contact with the radio was lost and it may still be in programming mode.',
      'Switch the radio off and on again, then reconnect.',
      'Nothing was written, so the radio\'s settings are unchanged.',
    ];
  }
  return ['Nothing on the radio was changed. Check the cable and try again.'];
}
