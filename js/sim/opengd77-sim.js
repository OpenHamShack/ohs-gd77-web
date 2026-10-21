// A simulated GD-77 running OpenGD77, presented as a Web Serial SerialPort.
// The firmware side of qdmr's opengd77_interface protocol is implemented
// on raw bytes: requests may arrive split or joined, replies go out in
// randomly sized chunks, and the radio behaves like the real one in the
// ways that have bitten real CPS software (it goes deaf if spoken to too
// soon after DTR, and flash is only changed by a sector commit).

import { sampleImage } from './sample.js';
import { prng, concat } from '../util.js';

const EEPROM_SIZE = 0x10000, FLASH_SIZE = 0x100000;

export class SimulatedOpenGD77Port extends EventTarget {
  // options: radioType (0), settleMs (250: requests sooner than this after
  // DTR make the radio go deaf), chunkSeed (split replies), strayAckAt
  // (address: put a stray 0x2D before that read's reply), failWriteAt
  // ({bank, addr}: reject), silentWriteAt (same: no answer),
  // dropReadAt (address: drop the first reply), image
  constructor(options = {}) {
    super();
    this.opts = { radioType: 0, settleMs: 250, chunkSeed: 3, ...options };
    this.eeprom = new Uint8Array(EEPROM_SIZE).fill(0xff);
    this.flash = new Uint8Array(FLASH_SIZE).fill(0xff);
    // STM32-family radios (type 5-10) have no EEPROM: an EEPROM request is a
    // protocol violation, and their codeplug sits at the shifted addresses.
    this.stm32 = this.opts.radioType >= 5;
    const img = this.opts.image ?? sampleImage(this.stm32 ? 'opengd77-stm32' : 'opengd77');
    for (const s of img.segs) (s.bank === 'flash' ? this.flash : this.eeprom).set(s.data, s.addr);
    this.readable = null; this.writable = null;
    this.rx = new Uint8Array(0);
    this.inCPS = false;
    this.deaf = false;
    this.dtrAt = null;
    this.sector = null;
    this.sectorBuf = null;
    this.violations = [];
    this.commands = [];
    this.flashCommits = 0;
    this.eepromWrites = 0;
    this.outsideCPS = 0;
    this.used = new Set();
    this.replies = 0;
    this.pending = [];
    this.flushScheduled = false;
    this.rand = prng(this.opts.chunkSeed);
  }

  getInfo() { return { usbVendorId: 0x1fc9, usbProductId: 0x0094 }; }

  async open(opts) {
    if (this.readable) throw new DOMException('Port already open', 'InvalidStateError');
    if (opts.baudRate !== 115200) this.violations.push('baud rate ' + opts.baudRate);
    this.readable = new ReadableStream({ start: c => { this.out = c; }, cancel: () => { this.out = null; } });
    this.writable = new WritableStream({ write: chunk => this._receive(new Uint8Array(chunk)) });
    this.dtrAt = null;
  }

  async setSignals(s) { if (s.dataTerminalReady) this.dtrAt = Date.now(); }

  async close() {
    try { this.out?.close(); } catch { /* reader cancelled */ }
    this.out = null; this.readable = null; this.writable = null;
  }

  _send(bytes) {
    // Split replies the way a USB CDC link may deliver them. Pieces queue
    // up and are flushed in order: scheduling each piece on its own could
    // let a microtask overtake a timer and reorder the stream.
    let o = 0;
    while (o < bytes.length) {
      const n = Math.min(bytes.length - o, 1 + (this.rand() % 40));
      this.pending.push(bytes.slice(o, o + n));
      o += n;
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const flush = () => {
      this.flushScheduled = false;
      const p = this.pending; this.pending = [];
      for (const piece of p) { try { this.out?.enqueue(piece); } catch { /* closed */ } }
    };
    // See stock-sim.js: fast, but with the odd real timer for repaints.
    if (++this.replies % 32) queueMicrotask(flush); else setTimeout(flush, 0);
  }

  _violate(msg) { this.violations.push(msg); }

  _receive(chunk) {
    if (this.deaf) return;
    if (this.dtrAt === null || Date.now() - this.dtrAt < this.opts.settleMs) {
      // The real firmware's listener is not armed yet; it never recovers.
      this.deaf = true;
      this._violate('request sent before the post-DTR settle time; the radio is now deaf');
      return;
    }
    this.rx = concat(this.rx, chunk);
    for (;;) {
      const n = this._frameLength(this.rx);
      if (n === 0 || this.rx.length < n) return;
      const f = this.rx.slice(0, n);
      this.rx = this.rx.slice(n);
      this._handle(f);
    }
  }

  _frameLength(b) {
    if (!b.length) return 0;
    switch (b[0]) {
      case 0x52: return 8;
      case 0x43: return 23;
      case 0x57: case 0x58:
        if (b.length < 2) return 0;
        if (b[1] === 1) return 5;
        if (b[1] === 3) return 2;
        if (b.length < 8) return 0;
        return 8 + ((b[6] << 8) | b[7]);
      default:
        this._violate('unknown frame type 0x' + b[0].toString(16));
        return 1;
    }
  }

  _handle(f) {
    const addr = ((f[2] << 24) | (f[3] << 16) | (f[4] << 8) | f[5]) >>> 0;
    if (f[0] === 0x43) {
      this.commands.push(f[1] === 6 ? `6:${f[2]}` : String(f[1]));
      if (f[1] === 0) this.inCPS = true;
      if (f[1] === 5) this.inCPS = false;
      return this._send(Uint8Array.of(0x2d));
    }
    if (f[0] === 0x52) {
      const len = (f[6] << 8) | f[7];
      if (f[1] === 9) {
        const p = new Uint8Array(46);
        p[0] = 3; p[4] = this.opts.radioType;
        p.set(Uint8Array.from(this.opts.git ?? 'R20240101', c => c.charCodeAt(0)), 8);
        p.set(Uint8Array.from('20240101120000', c => c.charCodeAt(0)), 0x18);
        return this._send(concat(Uint8Array.of(0x52, 0, 46), p));
      }
      if (!this.inCPS) this.outsideCPS++;
      if (len !== 32) this._violate('read length ' + len);
      if (f[1] === 2 && this.stm32) this._violate('EEPROM read on an STM32 radio');
      const mem = f[1] === 1 ? this.flash : f[1] === 2 ? this.eeprom : null;
      if (!mem) return this._violate('read source ' + f[1]);
      if (addr + len > mem.length) return this._violate('read past end of memory');
      this.used.add((f[1] === 1 ? 'flash:' : 'eeprom:') + addr.toString(16));
      if (this.opts.dropReadAt === addr && !this._dropped) { this._dropped = true; return; }
      const reply = concat(Uint8Array.of(0x52, len >> 8, len & 0xff), mem.slice(addr, addr + len));
      if (this.opts.strayAckAt === addr && !this._strayed) { this._strayed = true; return this._send(concat(Uint8Array.of(0x2d), reply)); }
      return this._send(reply);
    }
    // 'W' (MK22) or 'X' (STM32) write family.
    if (f[0] === 0x58 && this.opts.radioType <= 4) this._violate("'X' write sent to an MK22 radio");
    if (f[0] === 0x57 && this.opts.radioType > 4) this._violate("'W' write sent to an STM32 radio");
    if (!this.inCPS) this.outsideCPS++;
    const bank = f[1] === 4 ? 'eeprom' : 'flash';
    const fault = o => o && o.bank === bank && (o.addr === addr || (f[1] === 1 && o.addr === ((f[2] << 16) | (f[3] << 8) | f[4]) * 4096));
    if (fault(this.opts.silentWriteAt)) return;
    if (fault(this.opts.failWriteAt)) return this._send(Uint8Array.of(f[0], 0xff));
    const ok = () => this._send(Uint8Array.of(f[0], f[1]));
    switch (f[1]) {
      case 4: {
        if (this.stm32) this._violate('EEPROM write on an STM32 radio');
        const len = (f[6] << 8) | f[7];
        if (addr + len > EEPROM_SIZE) return this._violate('EEPROM write past end');
        this.eeprom.set(f.slice(8, 8 + len), addr);
        this.eepromWrites++;
        return ok();
      }
      case 1: {
        this.sector = (f[2] << 16) | (f[3] << 8) | f[4];
        // The buffer starts as the sector's current content.
        this.sectorBuf = this.flash.slice(this.sector * 4096, this.sector * 4096 + 4096);
        return ok();
      }
      case 2: {
        const len = (f[6] << 8) | f[7];
        if (this.sector === null || Math.floor(addr / 4096) !== this.sector) {
          this._violate(`sector buffer write at 0x${addr.toString(16)} outside selected sector`);
          return this._send(Uint8Array.of(f[0], 0xff));
        }
        this.sectorBuf.set(f.slice(8, 8 + len), addr % 4096);
        return ok();
      }
      case 3: {
        if (this.sector === null) { this._violate('commit without a selected sector'); return this._send(Uint8Array.of(f[0], 0xff)); }
        this.flash.set(this.sectorBuf, this.sector * 4096);
        this.flashCommits++;
        this.sector = null;
        return ok();
      }
      default:
        return this._violate('unknown write command ' + f[1]);
    }
  }
}
