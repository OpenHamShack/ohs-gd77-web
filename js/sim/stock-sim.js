// A simulated GD-77 on the stock firmware, presented as a WebHID HIDDevice.
// It speaks the protocol at the HID report level, so the real StockRadio
// code is what talks to it. It is deliberately strict: anything a real
// radio would choke on (a frame with the wrong header, a read before the
// programming handshake, a write to the never-touched 0x7c00-0x7fff gap)
// throws inside the simulator and is recorded in `violations`, which the
// tests assert stays empty.

import { sampleImage } from './sample.js';
import { STOCK_MODEL_ID } from '../radio/stock-hid.js';

const enc = s => Uint8Array.from(s, c => c.charCodeAt(0));
const startsWith = (a, s) => s.length <= a.length && [...s].every((c, i) => a[i] === c.charCodeAt(0));

export class SimulatedStockHID extends EventTarget {
  // options: model ('MD-760P'), numberedReports (true), echo (true),
  // failWriteAt (address: answer NAK), silentWriteAt (address: no answer),
  // dropReadAt (address: drop the first reply), image (an Image to start with)
  constructor(options = {}) {
    super();
    this.opts = { model: STOCK_MODEL_ID, numberedReports: true, echo: true, ...options };
    this.vendorId = 0x15a2;
    this.productId = 0x0073;
    this.productName = 'Simulated GD-77 (stock firmware)';
    this.opened = false;
    this.mem = (this.opts.image ?? sampleImage('stock')).segs[0].data.slice();
    // dmrconfig's file tag is not radio content; a real radio has 0xFF there.
    this.mem.fill(0xff, 0, 0x80);
    this.state = 'idle';
    this.bank = null;
    this.violations = [];
    this.log = [];
    this.writes = 0;
    this.dropped = new Set();
    this.replies = 0;
    this.oninputreport = null;
    const id = this.opts.numberedReports;
    this.collections = [{
      usagePage: 0xff00, usage: 1,
      outputReports: [{ reportId: id ? 1 : 0, items: [{ reportSize: 8, reportCount: id ? 41 : 42 }] }],
      inputReports: [{ reportId: id ? 3 : 0, items: [{ reportSize: 8, reportCount: id ? 41 : 42 }] }],
    }];
  }

  async open() { this.opened = true; }
  async close() { this.opened = false; }

  get inProgramMode() { return this.state === 'prog'; }

  async sendReport(reportId, data) {
    if (!this.opened) throw new DOMException('Device is not open', 'InvalidStateError');
    const bytes = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
    const frame = this.opts.numberedReports ? Uint8Array.from([reportId, ...bytes]) : bytes;
    if (this.opts.numberedReports && reportId !== 1) return this._violate(`output report id ${reportId}, expected 1`);
    if (!this.opts.numberedReports && reportId !== 0) return this._violate(`output report id ${reportId}, expected 0`);
    if (frame.length !== 42) return this._violate(`frame of ${frame.length} bytes, expected 42`);
    if (frame[0] !== 1 || frame[1] !== 0) return this._violate('bad frame header');
    const len = frame[2] | (frame[3] << 8);
    this._handle(frame.slice(4, 4 + len));
  }

  _violate(msg) { this.violations.push(msg); throw new Error('Simulator: ' + msg); }

  _reply(payload) {
    if (payload === null) return;
    const full = new Uint8Array(42);
    full[0] = 3; full[1] = 0; full[2] = payload.length; full[3] = 0;
    full.set(payload, 4);
    const id = this.opts.numberedReports ? 3 : 0;
    const body = this.opts.numberedReports ? full.slice(1) : full;
    const deliver = () => {
      const ev = new Event('inputreport');
      ev.reportId = id; ev.device = this; ev.data = new DataView(body.buffer);
      this.dispatchEvent(ev);
      if (this.oninputreport) this.oninputreport(ev);
    };
    // Mostly microtasks, so a full read takes well under a second; every
    // 32nd reply goes through a real timer so a page can repaint its
    // progress bar.
    if (++this.replies % 32) queueMicrotask(deliver); else setTimeout(deliver, 0);
  }

  _handle(p) {
    const ack = () => this._reply(Uint8Array.of(0x41));
    this.log.push(String.fromCharCode(p[0]));
    if (startsWith(p, '\x02PROGRA') && p.length === 7) { this.state = 'prg1'; return ack(); }
    if (this.state === 'prg1' && startsWith(p, 'M\x02') && p.length === 2) {
      this.state = 'prg2';
      const id = new Uint8Array(16).fill(0xff);
      id.set(enc(this.opts.model));
      id.set([0x56, 0x34, 0x30, 0x33, 0x00, 0x04, 0x80, 0x04], 8); // "V403" + version bytes
      return this._reply(id);
    }
    if (this.state === 'prg2' && p.length === 1 && p[0] === 0x41) { this.state = 'prog'; return ack(); }
    if (this.state !== 'prog') return this._violate(`command ${JSON.stringify(String.fromCharCode(...p.slice(0, 4)))} outside programming mode`);

    if (startsWith(p, 'CWB') && p.length === 8) {
      if (p[3] !== 4 || p[4] !== 0 || p[6] !== 0 || p[7] !== 0 || p[5] > 1) return this._violate('unexpected CWB ' + Array.from(p).join(','));
      this.bank = p[5];
      return ack();
    }
    if ((startsWith(p, 'ENDR') || startsWith(p, 'ENDW')) && p.length === 4) { this.state = 'idle'; this.bank = null; return ack(); }
    if (p[0] === 0x52 || p[0] === 0x57) {
      if (this.bank === null) return this._violate('read/write before a memory bank was selected');
      if (p[3] !== 32) return this._violate('block length ' + p[3]);
      const addr = (this.bank << 16) | (p[1] << 8) | p[2];
      const inRange = (addr >= 0x80 && addr + 32 <= 0x7c00) || (addr >= 0x8000 && addr + 32 <= 0x1eb00);
      if (!inRange) return this._violate(`access outside the codeplug ranges at 0x${addr.toString(16)}`);
      if (p[0] === 0x52) {
        if (p.length !== 4) return this._violate('read request length ' + p.length);
        if (this.opts.dropReadAt === addr && !this.dropped.has(addr)) { this.dropped.add(addr); return; }
        const r = new Uint8Array(36);
        if (this.opts.echo) r.set(p.slice(0, 4));
        r.set(this.mem.subarray(addr, addr + 32), 4);
        return this._reply(r);
      }
      if (p.length !== 36) return this._violate('write request length ' + p.length);
      if (this.opts.silentWriteAt === addr) return;
      if (this.opts.failWriteAt === addr) return this._reply(Uint8Array.of(0x4e));
      this.mem.set(p.slice(4, 36), addr);
      this.writes++;
      return ack();
    }
    return this._violate('unknown command ' + Array.from(p.slice(0, 8)).join(','));
  }
}
