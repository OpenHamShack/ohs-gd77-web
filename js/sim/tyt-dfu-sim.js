// A simulated MD-UV380 in its TYT bootloader, presented as a WebUSB
// USBDevice (0483:df11). It implements the DfuSe requests and TYT commands
// the flasher uses, decrypts written blocks with its own key the way the
// real bootloader does, and keeps the whole 1 MiB of internal flash so a
// test can check exactly which bytes landed. It is strict: erasing or
// writing below 0x0800C000, writing to a sector that was not erased, a
// write before 0x91 0x31, or a block number out of sequence is recorded in
// `violations` (and refused, as a real bootloader would fail it).

import { SIM_KEYS } from './synthetic-firmware.js';

const STATE = { IDLE: 2, DNBUSY: 4, DNLOAD_IDLE: 5, MANIFEST: 7, UPLOAD_IDLE: 9, ERROR: 10 };
const FLASH = 0x08000000, SIZE = 0x100000, APP = 0x0800c000;
const SECTORS = [[0x08000000, 0x4000], [0x08004000, 0x4000], [0x08008000, 0x4000], [0x0800c000, 0x4000], [0x08010000, 0x10000],
  ...[0x08020000, 0x08040000, 0x08060000, 0x08080000, 0x080a0000, 0x080c0000, 0x080e0000].map(a => [a, 0x20000])];

export class SimulatedTytDfu {
  // options: model (bootloader string, 'MD-UV390'), key (bootloader key,
  // the synthetic UV3X0 one), failEraseAt / failWriteAt (address), unplugAt (address)
  constructor(options = {}) {
    this.opts = { model: 'MD-UV390', key: SIM_KEYS.UV3X0, ...options };
    this.vendorId = 0x0483; this.productId = 0xdf11;
    this.productName = 'STM32 BOOTLOADER (simulated)'; this.manufacturerName = 'STMicroelectronics';
    this.simulated = true;
    this.opened = false; this.configuration = null; this.gone = false;
    this.flash = new Uint8Array(SIZE).fill(0x5a);          // old firmware
    this.flash.fill(0xb0, 0, APP - FLASH);                    // the bootloader itself
    this.erased = []; this.erasedSet = new Set();
    this.violations = []; this.commands = [];
    this.state = STATE.IDLE; this.pending = null; this.pointer = null;
    this.upgradeArmed = false; this.programmingMode = false;
    this.nextBlock = null; this.upload = null; this.rebooted = false;
  }

  async open() { this._alive(); this.opened = true; }
  async close() { this.opened = false; }
  async selectConfiguration(n) { this.configuration = { configurationValue: n }; }
  async claimInterface() {}

  _alive() { if (this.gone) throw new DOMException('The device was disconnected.', 'NetworkError'); }
  _violate(m) { this.violations.push(m); this.state = STATE.ERROR; }
  _sector(addr) { return SECTORS.find(([a, s]) => addr >= a && addr < a + s); }

  async controlTransferOut(setup, data) {
    this._alive();
    const d = new Uint8Array(data?.buffer ?? new ArrayBuffer(0), data?.byteOffset ?? 0, data?.byteLength ?? 0).slice();
    switch (setup.request) {
      case 0x01: // DNLOAD
        if (this.state !== STATE.IDLE && this.state !== STATE.DNLOAD_IDLE) { this._violate('DNLOAD in state ' + this.state); break; }
        this.pending = { value: setup.value, data: d };
        this.state = STATE.DNLOAD_IDLE; // becomes busy when status is asked for
        break;
      case 0x04: if (this.state === STATE.ERROR) this.state = STATE.IDLE; break; // CLRSTATUS
      case 0x06: this.state = STATE.IDLE; this.pending = null; break;           // ABORT
      default: this._violate('unexpected OUT request ' + setup.request);
    }
    return { status: 'ok', bytesWritten: d.length };
  }

  async controlTransferIn(setup, length) {
    this._alive();
    let out;
    switch (setup.request) {
      case 0x03: { // GETSTATUS
        let st = this.state;
        if (this.pending) { this._execute(this.pending); this.pending = null; st = this.state === STATE.ERROR ? STATE.ERROR : STATE.DNBUSY; }
        if (this.rebooted) { this.gone = true; throw new DOMException('The device was disconnected.', 'NetworkError'); }
        out = Uint8Array.of(st === STATE.ERROR ? 0x0a : 0, 1, 0, 0, st, 0);
        break;
      }
      case 0x05: out = Uint8Array.of(this.state); break;
      case 0x02: // UPLOAD
        if (!this.upload || this.state !== STATE.IDLE) { this._violate('UPLOAD without a register request'); out = new Uint8Array(0); break; }
        out = this.upload.slice(0, length); this.upload = null; this.state = STATE.IDLE;
        break;
      default: this._violate('unexpected IN request ' + setup.request); out = new Uint8Array(0);
    }
    return { status: 'ok', data: new DataView(out.buffer, out.byteOffset, out.byteLength) };
  }

  _execute({ value, data }) {
    const addrOf = b => (b[1] | (b[2] << 8) | (b[3] << 16) | (b[4] << 24)) >>> 0;
    if (value === 0) {
      if (data.length === 0) {
        // Leave the bootloader: jump to the address last set.
        this.commands.push('reset 0x' + (this.pointer >>> 0).toString(16));
        if (this.pointer !== FLASH) this._violate('reset without SetAddress(0x08000000)');
        this.rebooted = true; this.state = STATE.MANIFEST;
        return;
      }
      const c = data[0];
      if (c === 0x21 && data.length === 5) { this.pointer = addrOf(data); this.nextBlock = 2; this.commands.push('addr 0x' + this.pointer.toString(16)); }
      else if (c === 0x41 && data.length === 5) {
        const a = addrOf(data);
        this.commands.push('erase 0x' + a.toString(16));
        if (!this.upgradeArmed) return this._violate('erase before 0x91 0x31');
        const s = this._sector(a);
        if (!s || a < APP) return this._violate(`erase at 0x${a.toString(16)} (bootloader or outside flash)`);
        if (this.opts.failEraseAt === a) return this._violate('erase failure injected');
        this.flash.fill(0xff, s[0] - FLASH, s[0] - FLASH + s[1]);
        this.erased.push(s[0]); this.erasedSet.add(s[0]);
      } else if (c === 0x91 && data.length === 2) {
        this.commands.push('91 ' + data[1].toString(16).padStart(2, '0'));
        if (data[1] === 0x01) this.programmingMode = true;
        else if (data[1] === 0x31) { if (!this.programmingMode) return this._violate('0x91 0x31 before 0x91 0x01'); this.upgradeArmed = true; }
      } else if (c === 0xa2 && data.length === 2) {
        this.commands.push('reg ' + data[1]);
        const r = new Uint8Array(1024);
        if (data[1] === 0x01) r.set(Uint8Array.from(this.opts.model, ch => ch.charCodeAt(0)));
        this.upload = r;
      } else return this._violate('unknown command ' + Array.from(data.slice(0, 5)).join(','));
      this.state = STATE.DNLOAD_IDLE;
      return;
    }
    // A data block: placed at pointer + (wValue - 2) * 1024, decrypted with
    // the bootloader's key by its offset from 0x0800C000.
    if (!this.upgradeArmed) return this._violate('data before 0x91 0x31');
    if (this.pointer === null || value !== this.nextBlock) return this._violate(`block ${value} out of sequence (expected ${this.nextBlock})`);
    const addr = this.pointer + (value - 2) * 1024;
    const s = this._sector(addr);
    if (!s || addr < APP || addr + data.length > FLASH + SIZE) return this._violate(`write at 0x${addr.toString(16)} outside the application area`);
    if (!this.erasedSet.has(s[0])) return this._violate(`write at 0x${addr.toString(16)} into a sector that was not erased`);
    if (this.opts.unplugAt === addr) { this.gone = true; return; }
    if (this.opts.failWriteAt === addr) return this._violate('write failure injected');
    for (let i = 0; i < data.length; i++) this.flash[addr - FLASH + i] = data[i] ^ this.opts.key[(addr - APP + i) & 1023];
    this.nextBlock++;
    this.state = STATE.DNLOAD_IDLE;
  }

  // Bytes of flash at an absolute address.
  read(addr, len) { return this.flash.subarray(addr - FLASH, addr - FLASH + len); }
}
