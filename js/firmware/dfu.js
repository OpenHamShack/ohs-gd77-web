// The TYT bootloader (ST DfuSe, USB 0483:df11) over WebUSB, for the
// MD-UV380 family. Protocol per docs/firmware.md §2, reimplemented from that
// description (radio_tool is GPLv3 and grid.radio unlicensed; no code from
// either). Every control transfer goes through the Trace ring so a
// diagnostic report shows the last USB exchanges.
//
// Sequence of a flash: read register 0x01 (the bootloader's model string)
// and refuse a radio that does not match the file; 0x91 0x01 then 0x91 0x31;
// erase every sector the image covers; per sector SetAddress then 1024-byte
// blocks with wValue 2, 3, ...; finally SetAddress(0x08000000) and an empty
// DNLOAD, after which the radio reboots and vanishes from USB - that
// disappearance is the success signal, and only then.

import { Trace } from '../radio/trace.js';
import { BOOTLOADER_NAMES } from './tyt.js';

export const DFU_FILTER = { vendorId: 0x0483, productId: 0xdf11 };

const DNLOAD = 0x01, UPLOAD = 0x02, GETSTATUS = 0x03, CLRSTATUS = 0x04, GETSTATE = 0x05, ABORT = 0x06;
export const STATE = { IDLE: 2, DNLOAD_SYNC: 3, DNBUSY: 4, DNLOAD_IDLE: 5, MANIFEST_SYNC: 6, MANIFEST: 7, UPLOAD_IDLE: 9, ERROR: 10 };
const BLOCK = 1024;

export class DfuError extends Error {
  constructor(message, { stage = null, radioState = 'clean' } = {}) { super(message); this.name = 'DfuError'; this.stage = stage; this.radioState = radioState; }
}

const isGone = e => e && (e.name === 'NotFoundError' || e.name === 'NetworkError' || /disconnect|lost|no device/i.test(e.message));

export class TytDfu {
  constructor(device, { log = () => {} } = {}) {
    this.device = device;
    this.log = log;
    this.trace = new Trace();
    this.bootloaderName = null;
  }

  async open() {
    if (!this.device.opened) await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    await this.device.claimInterface(0);
  }

  async close() { try { if (this.device.opened) await this.device.close(); } catch { /* already gone */ } }

  async _out(request, value, data) {
    const d = data ?? new Uint8Array(0);
    this.trace.add('tx', Uint8Array.of(request, value & 0xff, value >> 8, ...d.subarray(0, 45)), `out req ${request} wValue ${value} len ${d.length}`);
    const r = await this.device.controlTransferOut({ requestType: 'class', recipient: 'interface', request, value, index: 0 }, d);
    if (r.status !== 'ok') throw new DfuError(`USB transfer ${request} failed: ${r.status}`);
  }

  async _in(request, value, length) {
    const r = await this.device.controlTransferIn({ requestType: 'class', recipient: 'interface', request, value, index: 0 }, length);
    if (r.status !== 'ok') throw new DfuError(`USB transfer ${request} failed: ${r.status}`);
    const b = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    this.trace.add('rx', b.subarray(0, 48), `in req ${request}`);
    return b;
  }

  async status() {
    const b = await this._in(GETSTATUS, 0, 6);
    return { status: b[0], poll: b[1] | (b[2] << 8) | (b[3] << 16), state: b[4] };
  }

  async state() { return (await this._in(GETSTATE, 0, 1))[0]; }

  // Leave whatever state the bootloader is in for one that accepts `want`.
  async _ready(ok) {
    for (let i = 0; i < 5; i++) {
      const s = await this.state();
      if (ok.includes(s)) return;
      if (s === STATE.ERROR) await this._out(CLRSTATUS, 0); else await this._out(ABORT, 0);
    }
    throw new DfuError('The bootloader will not return to idle');
  }

  // A DNLOAD is acted on when the host asks for status: the first answer
  // must be "busy", the next "download idle" (docs/firmware.md §2.2).
  async dnload(data, value = 0) {
    await this._ready([STATE.IDLE, STATE.DNLOAD_IDLE]);
    await this._out(DNLOAD, value, data);
    let s = await this.status();
    if (s.state === STATE.DNBUSY) {
      if (s.poll) await new Promise(r => setTimeout(r, Math.min(s.poll, 5000)));
      s = await this.status();
    }
    if (s.state !== STATE.DNLOAD_IDLE || s.status !== 0) {
      throw new DfuError(`The bootloader reported an error (status ${s.status}, state ${s.state}) after ${data.length ? 'command 0x' + data[0].toString(16) : 'an empty download'}`);
    }
  }

  async readRegister(reg) {
    await this.dnload(Uint8Array.of(0xa2, reg));
    await this._ready([STATE.IDLE, STATE.UPLOAD_IDLE]);
    return this._in(UPLOAD, 0, 1024);
  }

  async identify() {
    const b = await this.readRegister(0x01);
    const end = b.indexOf(0);
    this.bootloaderName = String.fromCharCode(...b.subarray(0, end < 0 ? b.length : end)).replace(/[^\x20-\x7e]/g, '').trim();
    this.log(`Bootloader reports "${this.bootloaderName}"`);
    return this.bootloaderName;
  }

  static matches(name, keyFamily) { return !!(BOOTLOADER_NAMES[keyFamily] && BOOTLOADER_NAMES[keyFamily].test(name)); }

  async setAddress(addr) { await this.dnload(Uint8Array.of(0x21, addr & 0xff, (addr >> 8) & 0xff, (addr >> 16) & 0xff, addr >>> 24)); }
  async erase(addr) { await this.dnload(Uint8Array.of(0x41, addr & 0xff, (addr >> 8) & 0xff, (addr >> 16) & 0xff, addr >>> 24)); }

  // plan: from plan.js. Returns when the radio has rebooted.
  async flash(plan, onProgress = () => {}) {
    const name = this.bootloaderName ?? await this.identify();
    if (!TytDfu.matches(name, plan.keyFamily)) {
      throw new DfuError(`The radio's bootloader says "${name}", which is not the ${plan.family.name} this firmware is for. Nothing was written.`, { stage: 'identify' });
    }
    const blocks = plan.writes.reduce((n, w) => n + Math.ceil(w.data.length / BLOCK), 0);
    const steps = plan.erase.length + blocks;
    let done = 0;
    let stage = 'prepare';
    try {
      await this.dnload(Uint8Array.of(0x91, 0x01));
      await this.dnload(Uint8Array.of(0x91, 0x31));
      stage = 'erase';
      for (const s of plan.erase) {
        this.log(`Erasing 0x${s.addr.toString(16)} (${s.size / 1024} KiB)`);
        await this.trace.time(`erase 0x${s.addr.toString(16)}`, () => this.erase(s.addr));
        onProgress(++done / steps);
      }
      stage = 'write';
      for (const w of plan.writes) {
        await this.trace.time(`write 0x${w.addr.toString(16)}+0x${w.data.length.toString(16)}`, async () => {
          await this.setAddress(w.addr);
          for (let off = 0, n = 2; off < w.data.length; off += BLOCK, n++) {
            const block = new Uint8Array(BLOCK).fill(0xff);
            block.set(w.data.subarray(off, off + BLOCK));
            await this.dnload(block, n);
            onProgress(++done / steps);
          }
        });
      }
    } catch (e) {
      const radioState = stage === 'prepare' ? 'clean' : 'partial';
      throw new DfuError(`Flash stopped during ${stage}: ${e.message}`, { stage, radioState });
    }
    // Leave the bootloader for the new firmware. Disconnecting here is success.
    stage = 'reboot';
    try {
      await this.setAddress(0x08000000);
      await this._ready([STATE.IDLE, STATE.DNLOAD_IDLE]);
      await this._out(DNLOAD, 0, new Uint8Array(0));
      try { await this.status(); } catch (e) { if (!isGone(e)) throw e; }
    } catch (e) {
      if (!isGone(e)) throw new DfuError(`The firmware was written but the radio did not restart: ${e.message}. Switch it off and on.`, { stage, radioState: 'written' });
    }
    this.log('Firmware written; the radio is restarting');
    onProgress(1);
  }
}
