// OpenGD77 firmware over USB CDC serial (Web Serial).
//
// Framing per qdmr lib/opengd77_interface.{hh,cc}; the transport
// mitigations below are adapted from ReallyOpenGD77 WebCPSd
// (frontend/js/app.js), which found each of them on real hardware:
//
//   ReallyOpenGD77 WebCPSd - MIT License
//   Copyright (c) 2026 Chip Cuccio, W0CHP
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to
//   the following conditions: The above copyright notice and this
//   permission notice shall be included in all copies or substantial
//   portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
//   WARRANTY OF ANY KIND.
//
// What was taken from it, and why:
//  - one reader loop for the life of the port, feeding a buffer. Racing a
//    reader.read() against a timeout leaves the losing read queued inside
//    Chrome, and it later swallows the reply to a different request;
//  - DTR/RTS up, then 300 ms before the first request. Without the pause
//    the firmware can stop answering until the USB cable is replugged;
//  - skip up to 4 stray bytes looking for a reply's first byte (a late ACK
//    byte has been seen prepended to the next reply on macOS);
//  - reject a read reply whose length is not the one requested;
//  - retry a read or command 3 times, 250 ms apart, flushing whatever
//    arrived late before resending;
//  - always send CLOSE_CPS_SCREEN on the way out, even after a failure,
//    or the radio sits on "Reading/Writing codeplug" until power-cycled.
// Unlike WebCPSd we do not retry writes: a write the radio did not confirm
// stops the transfer, and the user is told how to recover.

import { RadioError, TimeoutError, DesyncError } from './errors.js';
import { Image } from '../codeplug/image.js';
import { OPENGD77, OPENGD77_STM32 } from '../codeplug/layouts.js';
import { sleep, hex, hexdump, readAscii, concat } from '../util.js';
import { Trace } from './trace.js';

export const OGD_USB_FILTER = { usbVendorId: 0x1fc9, usbProductId: 0x0094 };

// FirmwareInfo.radioType (qdmr opengd77_interface.hh). qdmr's identifier()
// gives types 0-4 (MK22: written with 'W') its OpenGD77 codeplug and types
// 5-10 (STM32: written with 'X') its OpenUV380 codeplug, so within each
// family one memory layout serves every model.
export const RADIO_TYPES = [
  'Radioddity GD-77', 'Radioddity GD-77S', 'Baofeng DM-1801', 'Baofeng RD-5R', 'Baofeng DM-1801A',
  'TYT MD-9600', 'TYT MD-UV380', 'TYT MD-380', 'Baofeng DM-1701', 'TYT MD-2017', 'Baofeng DM-1701 RGB',
];
export const familyOf = radioType => (radioType >= 0 && radioType <= 4 ? 'W' : radioType >= 5 && radioType <= 10 ? 'X' : null);

const SRC_FLASH = 1, SRC_EEPROM = 2, SRC_INFO = 9;
const W_SET_SECTOR = 1, W_SECTOR_BUFFER = 2, W_COMMIT_SECTOR = 3, W_EEPROM = 4;
const C_SHOW = 0, C_CLEAR = 1, C_DISPLAY = 2, C_RENDER = 3, C_CLOSE = 5, C_COMMAND = 6;
const OPT_SAVE_SETTINGS_AND_VFOS = 2, OPT_GREEN_LED = 3, OPT_RED_LED = 4;
const BLOCK = 32, SECTOR = 4096;
const CMD_ACK = 0x2d;
const TIMEOUT_MS = 2000;

class SerialLink {
  constructor(port, log, trace) { this.port = port; this.log = log; this.trace = trace; this.buf = new Uint8Array(0); this.wake = null; this.running = false; }

  async open() {
    if (!this.port.readable) await this.port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.running = true;
    this.loop = (async () => {
      try {
        while (this.running) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) { this.trace.add('rx', value); this.buf = concat(this.buf, value); this._notify(); }
        }
      } catch (e) {
        if (this.running) this.log('Serial read loop ended: ' + e.message);
      }
      this.running = false; this._notify();
    })();
  }

  _notify() { if (this.wake) { const w = this.wake; this.wake = null; w(); } }

  async write(bytes) { this.trace.add('tx', bytes); await this.writer.write(bytes); }

  flush() { this.buf = new Uint8Array(0); }

  async read(n, timeoutMs = TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      if (!this.running) throw new RadioError('The serial port closed (radio unplugged?)', { radioState: 'unknown' });
      const left = deadline - Date.now();
      if (left <= 0) throw new TimeoutError(`Timed out waiting for ${n} byte(s) from the radio`);
      await new Promise(resolve => {
        const t = setTimeout(() => { this.wake = null; resolve(); }, left);
        this.wake = () => { clearTimeout(t); resolve(); };
      });
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  async readAligned(marker, maxDiscard = 4) {
    const skipped = [];
    for (let i = 0; i <= maxDiscard; i++) {
      const [b] = await this.read(1);
      if (b === marker) { if (skipped.length) { this.trace.count('resyncs'); this.log('Resynced after discarding ' + hexdump(skipped)); } return; }
      skipped.push(b);
    }
    throw new DesyncError(`Out of step with the radio: expected ${hex(marker)}, got ${hexdump(skipped)}`);
  }

  async close() {
    this.running = false;
    try { await this.reader.cancel(); } catch { /* port gone */ }
    try { this.reader.releaseLock(); } catch { /* already released */ }
    try { await this.writer.close(); } catch { /* port gone */ }
    try { this.writer.releaseLock(); } catch { /* already released */ }
    try { await this.port.close(); } catch { /* port gone */ }
  }
}

export class OpenGD77Radio {
  constructor(port, { log = () => {}, settleMs = 300 } = {}) {
    this.port = port;
    this.log = log;
    this.settleMs = settleMs;
    this.trace = new Trace();
    this.infoRaw = null;
    this.link = new SerialLink(port, log, this.trace);
    this.writeType = null; // 'W' or 'X', set from radioType by identify()
    this.layout = null;
    this.inCPS = false;
  }

  // Unknown until identify() has asked the radio which family it is.
  get firmware() { return this.layout ? this.layout.fw : 'opengd77'; }

  async open() {
    await this.link.open();
    try { await this.port.setSignals({ dataTerminalReady: true, requestToSend: true }); }
    catch (e) { this.log('setSignals: ' + e.message); }
    await sleep(this.settleMs);
  }

  async close() { await this.link.close(); }

  async _retry(what, fn, attempts = 3) {
    for (let i = 1; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (e instanceof TimeoutError) this.trace.count('timeouts');
        if (e instanceof DesyncError) this.trace.count('desyncs');
        if (!(e instanceof TimeoutError || e instanceof DesyncError) || i >= attempts) throw e;
        this.trace.count('retries');
        this.log(`${what}: ${e.message}; retrying (${i + 1}/${attempts})`);
        await sleep(250);
        this.link.flush();
      }
    }
  }

  async readInfo() {
    return this._retry('Firmware info', async () => {
      this.link.flush();
      await this.link.write(Uint8Array.of(0x52, SRC_INFO, 0, 0, 0, 0, 0, 46));
      await this.link.readAligned(0x52);
      const h = await this.link.read(2);
      const len = (h[0] << 8) | h[1];
      if (len < 8 || len > 256) throw new DesyncError('Firmware info length ' + len);
      const p = await this.link.read(len);
      this.infoRaw = p.slice();
      const u32 = o => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;
      return {
        structVersion: u32(0),
        radioType: u32(4),
        gitVersion: len >= 0x18 ? readAscii(p, 8, 16) : '',
        buildDate: len >= 0x28 ? readAscii(p, 0x18, 16) : '',
        flashId: len >= 0x2c ? u32(0x28) : null,
        features: len >= 0x2e ? (p[0x2c] | (p[0x2d] << 8)) : null,
      };
    });
  }

  async identify() {
    const info = await this.readInfo();
    const name = RADIO_TYPES[info.radioType] ?? `unknown radio type ${info.radioType}`;
    this.log(`OpenGD77 firmware ${info.gitVersion || '?'} built ${info.buildDate || '?'} on a ${name}`);
    const family = familyOf(info.radioType);
    if (!family) throw new RadioError(`This OpenGD77 radio reports type ${info.radioType}, which this page does not know. Nothing was changed.`);
    this.writeType = family === 'X' ? 0x58 : 0x57;
    this.layout = family === 'X' ? OPENGD77_STM32 : OPENGD77;
    return { model: name, firmware: this.layout.fw, family, info };
  }

  async _command(cmd, opt = {}) {
    const b = new Uint8Array(23);
    b[0] = 0x43; b[1] = cmd; b[2] = opt.x ?? 0; b[3] = opt.y ?? 0; b[4] = 3; b[5] = 0; b[6] = 0;
    if (opt.text) for (let i = 0; i < Math.min(16, opt.text.length); i++) b[7 + i] = opt.text.charCodeAt(i);
    await this._retry('Command ' + cmd, async () => {
      this.link.flush();
      await this.link.write(b);
      await this.link.readAligned(CMD_ACK);
    });
  }

  // The sequence WebCPSd and qdmr both use, in their order.
  // saveSettings: the radio's own SAVE_SETTINGS_AND_VFOS, which both
  // reference CPSs send so the codeplug read includes the current VFOs.
  async enterCPS(label, { saveSettings = true } = {}) {
    await this._command(C_SHOW);
    this.inCPS = true;
    await this._command(C_CLEAR);
    await this._command(C_DISPLAY, { y: 0, text: 'GD-77 web CPS' });
    await this._command(C_DISPLAY, { y: 16, text: label });
    await this._command(C_DISPLAY, { y: 32, text: 'Codeplug' });
    await this._command(C_RENDER);
    await this._command(C_COMMAND, { x: label === 'Writing' ? OPT_RED_LED : OPT_GREEN_LED });
    if (saveSettings) await this._command(C_COMMAND, { x: OPT_SAVE_SETTINGS_AND_VFOS });
  }

  async exitCPS() {
    if (!this.inCPS) return;
    await this._command(C_CLOSE);
    this.inCPS = false;
  }

  async _exitQuiet() {
    try { await this.exitCPS(); return true; }
    catch (e) { this.log('Could not close CPS mode on the radio: ' + e.message); return false; }
  }

  async _readBlock(bank, addr) {
    return this._retry(`Read ${bank} ${hex(addr, 6)}`, async () => {
      this.link.flush();
      await this.link.write(Uint8Array.of(0x52, bank === 'flash' ? SRC_FLASH : SRC_EEPROM,
        (addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff, 0, BLOCK));
      await this.link.readAligned(0x52);
      const h = await this.link.read(2);
      const len = (h[0] << 8) | h[1];
      if (len !== BLOCK) throw new DesyncError(`Reply length ${len} for a ${BLOCK}-byte read`);
      return this.link.read(len);
    });
  }

  async _writeFrame(frame, what, addr) {
    this.link.flush();
    await this.link.write(frame);
    let r;
    try { r = await this.link.read(2); }
    catch (e) { if (e instanceof TimeoutError) this.trace.count('timeouts'); throw new RadioError(`No confirmation for ${what} at ${hex(addr, 6)} (${e.message})`, { addr, cause: e }); }
    if (r[0] !== frame[0] || r[1] !== frame[1]) throw new RadioError(`The radio rejected ${what} at ${hex(addr, 6)} (answered ${hexdump(r)})`, { addr });
  }

  async readImage(onProgress = () => {}, { saveSettings = true } = {}) {
    if (!this.layout) await this.identify();
    const img = Image.blank(this.layout);
    const total = img.segs.reduce((n, s) => n + s.data.length, 0);
    let done = 0;
    try {
      const id = await this.identify();
      await this.enterCPS('Reading', { saveSettings });
      for (const s of img.segs) {
        await this.trace.time(`read ${s.bank} ${hex(s.addr, 6)}+${hex(s.data.length, 5)}`, async () => {
          for (let off = 0; off < s.data.length; off += BLOCK) {
            s.data.set(await this._readBlock(s.bank, s.addr + off), off);
            done += BLOCK;
            if ((done & 0x7ff) === 0) onProgress(done / total);
          }
        });
      }
      await this.exitCPS();
      void id;
    } catch (e) {
      const ok = await this._exitQuiet();
      throw wrap(e, 'Read failed', ok ? 'clean' : 'unknown');
    }
    onProgress(1);
    return img;
  }

  // EEPROM: every changed 32-byte block. Flash: every 4 KiB sector that
  // holds a change is rewritten: select the sector, stage its blocks,
  // commit. A sector only partly covered by the codeplug (the STM32
  // radios keep the settings at 0x80, not on a sector boundary) is staged
  // with just the blocks we read; the firmware fills its sector buffer
  // from flash when the sector is selected, which is what qdmr's partial
  // sector writes rely on, so the rest of the sector is kept.
  async writeImage(image, base, onProgress = () => {}) {
    if (!this.layout) await this.identify();
    if (image.fw !== this.layout.fw) {
      throw new RadioError(image.fw === 'stock'
        ? 'This is a stock-firmware codeplug; it cannot be written to a radio running OpenGD77'
        : `This codeplug is for ${image.fw === 'opengd77' ? 'an MK22 (GD-77 type)' : 'an STM32 (MD-UV380 type)'} OpenGD77 radio, and the connected radio is the other family`);
    }
    const jobs = [];
    for (const s of image.segs) {
      const b = base ? base.find(s.bank, s.addr, s.data.length) : null;
      const differs = (from, len) => {
        if (!b) return true;
        const bo = s.addr - b.addr;
        for (let i = from; i < from + len; i++) if (s.data[i] !== b.data[bo + i]) return true;
        return false;
      };
      if (s.bank === 'eeprom') {
        for (let off = 0; off < s.data.length; off += BLOCK) {
          if (differs(off, BLOCK)) jobs.push({ bank: 'eeprom', addr: s.addr + off, blocks: [{ addr: s.addr + off, data: s.data.subarray(off, off + BLOCK) }] });
        }
        continue;
      }
      if (s.addr % BLOCK || s.data.length % BLOCK) throw new RadioError('Flash segment is not block aligned');
      const end = s.addr + s.data.length;
      for (let sec = Math.floor(s.addr / SECTOR) * SECTOR; sec < end; sec += SECTOR) {
        const from = Math.max(sec, s.addr), to = Math.min(sec + SECTOR, end);
        if (!differs(from - s.addr, to - from)) continue;
        const blocks = [];
        for (let a = from; a < to; a += BLOCK) blocks.push({ addr: a, data: s.data.subarray(a - s.addr, a - s.addr + BLOCK) });
        jobs.push({ bank: 'flash', addr: sec, blocks });
      }
    }
    this.log(`Writing ${jobs.filter(j => j.bank === 'eeprom').length} EEPROM block(s) and ${jobs.filter(j => j.bank === 'flash').length} flash sector(s)`);
    let started = false;
    const T = this.writeType;
    try {
      await this.identify();
      await this.enterCPS('Writing');
      const t0 = Date.now();
      this.trace.timings.push({ label: `write ${jobs.length} job(s)`, ms: 0, ok: false });
      const timing = this.trace.timings.at(-1);
      for (let i = 0; i < jobs.length; i++) {
        timing.ms = Date.now() - t0;
        const { bank, addr, blocks } = jobs[i];
        started = true;
        const frame = (cmd, a, data) => {
          const f = new Uint8Array(8 + BLOCK);
          f.set([T, cmd, (a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff, 0, BLOCK]);
          f.set(data, 8);
          return f;
        };
        if (bank === 'eeprom') {
          await this._writeFrame(frame(W_EEPROM, addr, blocks[0].data), 'EEPROM write', addr);
        } else {
          const sector = addr / SECTOR;
          await this._writeFrame(Uint8Array.of(T, W_SET_SECTOR, (sector >> 16) & 0xff, (sector >> 8) & 0xff, sector & 0xff), 'flash sector select', addr);
          for (const blk of blocks) await this._writeFrame(frame(W_SECTOR_BUFFER, blk.addr, blk.data), 'flash buffer write', blk.addr);
          await this._writeFrame(Uint8Array.of(T, W_COMMIT_SECTOR), 'flash sector commit', addr);
        }
        onProgress((i + 1) / jobs.length);
      }
      timing.ms = Date.now() - t0; timing.ok = true;
      await this.exitCPS();
    } catch (e) {
      await this._exitQuiet();
      throw wrap(e, 'Write failed', started ? 'partial' : 'clean');
    }
    onProgress(1);
    return { blocks: jobs.length };
  }
}

function wrap(e, prefix, radioState) {
  if (e instanceof RadioError) { if (e.radioState === 'clean') e.radioState = radioState; e.message = `${prefix}: ${e.message}`; return e; }
  return new RadioError(`${prefix}: ${e.message}`, { radioState, cause: e });
}
