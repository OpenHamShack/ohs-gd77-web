// Stock Radioddity GD-77 firmware over USB HID (WebHID).
//
// Protocol per dmrconfig hid.c / hid-libusb.c and qdmr radioddity_interface.cc:
// every exchange is one 42-byte frame out and one 42-byte frame back.
//   out: 01 00 <len lo> <len hi> <payload...> zero padding
//   in:  03 00 <len> 00 <payload...>
// The frames' first bytes (01 / 03) are HID report IDs on Windows and macOS
// and plain data on libusb, which sends report ID 0 and puts the 01 in the
// buffer. WebHID needs to know which; open() asks the device's own report
// descriptor (device.collections) instead of guessing.

import { RadioError, TimeoutError, DesyncError } from './errors.js';
import { Image } from '../codeplug/image.js';
import { STOCK } from '../codeplug/layouts.js';
import { sleep, hex, hexdump } from '../util.js';
import { Trace } from './trace.js';

export const STOCK_USB_FILTER = { vendorId: 0x15a2, productId: 0x0073 };
export const STOCK_MODEL_ID = 'MD-760P';

const enc = s => Uint8Array.from(s, c => c.charCodeAt(0));
const CMD_PRG = enc('\x02PROGRA');
const CMD_PRG2 = enc('M\x02');
const CMD_ACK = enc('A');
const CMD_ENDR = enc('ENDR');
const CMD_ENDW = enc('ENDW');
const CMD_CWB0 = enc('CWB\x04\x00\x00\x00\x00'); // select 0x00000-0x0ffff
const CMD_CWB1 = enc('CWB\x04\x00\x01\x00\x00'); // select 0x10000-0x1ffff
const ACK = 0x41;
const FRAME = 42;
const BLOCK = 32;

// dmrconfig waits 500 ms per reply and resends forever; we wait a little
// longer and give up after a few tries so a dead radio surfaces as an error.
const REPLY_TIMEOUT_MS = 1000;
const READ_ATTEMPTS = 3;

function reportBytes(report) {
  let bits = 0;
  for (const it of report.items || []) bits += (it.reportSize || 0) * (it.reportCount || 0);
  return bits / 8;
}

export class StockRadio {
  constructor(device, { log = () => {} } = {}) {
    this.device = device;
    this.log = log;
    this.queue = [];
    this.waiter = null;
    this.bank = null;
    this.inProgramMode = false;
    this.echoChecked = null; // null until the first read tells us whether replies echo the request
    this.trace = new Trace();
    this.idRaw = null;
    this.onReport = ev => this._onReport(ev);
  }

  get firmware() { return 'stock'; }

  async open() {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener('inputreport', this.onReport);
    // Find the output report. A non-zero report ID means the leading 0x01
    // is that ID and travels separately; zero means it is part of the data.
    this.outId = 1; this.outLen = FRAME - 1;
    for (const c of this.device.collections || []) {
      for (const r of c.outputReports || []) {
        this.outId = r.reportId;
        const n = reportBytes(r);
        this.outLen = n || (r.reportId ? FRAME - 1 : FRAME);
      }
    }
    this.log(`HID output report id ${this.outId}, ${this.outLen} bytes`);
  }

  async close() {
    try { this.device.removeEventListener('inputreport', this.onReport); } catch { /* already gone */ }
    try { if (this.device.opened) await this.device.close(); } catch { /* unplugged */ }
  }

  _onReport(ev) {
    const d = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
    const frame = ev.reportId ? Uint8Array.from([ev.reportId, ...d]) : d.slice();
    this.trace.add('rx', frame.subarray(0, 4 + (frame[2] || 0)));
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(frame); }
    else this.queue.push(frame);
  }

  _nextFrame(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiter = null; reject(new TimeoutError('No reply from the radio')); }, timeoutMs);
      this.waiter = f => { clearTimeout(t); resolve(f); };
    });
  }

  async _send(payload) {
    const frame = new Uint8Array(FRAME);
    frame[0] = 1; frame[1] = 0; frame[2] = payload.length & 0xff; frame[3] = payload.length >> 8;
    frame.set(payload, 4);
    this.trace.add('tx', frame.subarray(0, 4 + payload.length));
    let data = this.outId ? frame.subarray(1) : frame;
    if (data.length !== this.outLen) { const d = new Uint8Array(this.outLen); d.set(data.subarray(0, this.outLen)); data = d; }
    await this.device.sendReport(this.outId, data);
  }

  // One request, one reply. The reply's header is checked exactly as
  // dmrconfig does; a malformed reply means we are out of step with the radio.
  async _xfer(payload, rlen, timeoutMs = REPLY_TIMEOUT_MS) {
    this.queue.length = 0; // anything already queued cannot be the reply to this request
    await this._send(payload);
    const f = await this._nextFrame(timeoutMs);
    if (f[0] !== 3 || f[1] !== 0 || f[3] !== 0) throw new DesyncError('Malformed reply ' + hexdump(f, 8));
    if (f[2] !== rlen) throw new DesyncError(`Reply length ${f[2]}, expected ${rlen}`);
    return f.slice(4, 4 + rlen);
  }

  async _ack(payload, what) {
    const r = await this._xfer(payload, 1);
    if (r[0] !== ACK) throw new RadioError(`${what}: radio answered ${hex(r[0])} instead of ACK`);
  }

  // Late replies are the danger with retries: a reply that turns up after we
  // gave up would be taken as the answer to the next request. So after a
  // timeout we wait for stragglers and throw them away before resending.
  async _drain(ms = 300) { await sleep(ms); this.queue.length = 0; }

  async enterProgramMode() {
    this.bank = null;
    await this._ack(CMD_PRG, 'Enter programming mode');
    const id = await this._xfer(CMD_PRG2, 16);
    this.idRaw = id.slice();
    await this._ack(CMD_ACK, 'Confirm programming mode');
    this.inProgramMode = true;
    const end = id.indexOf(0xff);
    const model = String.fromCharCode(...id.subarray(0, end < 0 ? 16 : end)).replace(/\0.*$/, '');
    this.log(`Radio identifies as "${model}" (${hexdump(id, 16)})`);
    return { model, raw: id };
  }

  async _finish(cmd, what) {
    if (!this.inProgramMode) return;
    this.inProgramMode = false;
    await this._ack(cmd, what);
  }

  // Best effort, for finally blocks: the original error is what matters.
  async _finishQuiet(cmd) {
    try { await this._finish(cmd, 'Leave programming mode'); return true; }
    catch (e) { this.log('Could not take the radio out of programming mode: ' + e.message); return false; }
  }

  // Connect-time check. Leaves the radio in normal mode again.
  async identify() {
    try {
      const id = await this.enterProgramMode();
      if (id.model !== STOCK_MODEL_ID) {
        throw new RadioError(`This radio identifies as "${id.model}", not a GD-77 ("${STOCK_MODEL_ID}"). ` +
          'The RD-5R and DM-1801 use the same USB IDs but a different memory layout, so this page will not program them.');
      }
      return { model: 'Radioddity GD-77', firmware: 'stock', id: id.model };
    } finally {
      await this._finishQuiet(CMD_ENDR);
    }
  }

  async _selectBank(addr) {
    const want = addr >= 0x10000 ? 1 : 0;
    if (this.bank === want) return;
    await this._ack(want ? CMD_CWB1 : CMD_CWB0, 'Select memory bank');
    this.bank = want;
  }

  async _readBlock(addr) {
    for (let attempt = 1; ; attempt++) {
      try {
        const req = Uint8Array.of(0x52, (addr >> 8) & 0xff, addr & 0xff, BLOCK);
        const r = await this._xfer(req, BLOCK + 4);
        // The first 4 reply bytes are not documented by either reference.
        // If the radio echoes the request there, we use that to catch a
        // reply that belongs to a different address.
        const echoes = r[0] === req[0] && r[1] === req[1] && r[2] === req[2] && r[3] === req[3];
        if (this.echoChecked === null) {
          this.echoChecked = echoes;
          if (!echoes) this.log('Read replies do not echo the request (' + hexdump(r.subarray(0, 4)) + '); late-reply detection is off');
        } else if (this.echoChecked && !echoes) {
          throw new DesyncError(`Reply for ${hex(addr, 5)} echoed ${hexdump(r.subarray(0, 4))}`);
        }
        return r.slice(4);
      } catch (e) {
        if (e instanceof TimeoutError) this.trace.count('timeouts');
        if (e instanceof DesyncError) this.trace.count('desyncs');
        if (!(e instanceof TimeoutError || e instanceof DesyncError) || attempt >= READ_ATTEMPTS) throw e;
        this.trace.count('retries');
        this.log(`Read at ${hex(addr, 5)}: ${e.message}; retrying`);
        await this._drain();
        this.bank = null; // re-select: we cannot be sure the last switch landed
        await this._selectBank(addr);
      }
    }
  }

  async readImage(onProgress = () => {}) {
    const img = Image.blank(STOCK);
    const total = STOCK.wireRanges.reduce((n, r) => n + r.size, 0);
    let done = 0;
    try {
      const id = await this.enterProgramMode();
      if (id.model !== STOCK_MODEL_ID) throw new RadioError(`Radio identifies as "${id.model}", not a GD-77`);
      for (const r of STOCK.wireRanges) {
        const view = img.view(r.bank, r.addr, r.size);
        await this.trace.time(`read ${hex(r.addr, 5)}+${hex(r.size, 5)}`, async () => {
          for (let off = 0; off < r.size; off += BLOCK) {
            const addr = r.addr + off;
            await this._selectBank(addr);
            view.set(await this._readBlock(addr), off);
            done += BLOCK;
            if ((done & 0x7ff) === 0) onProgress(done / total);
          }
        });
      }
      await this._finish(CMD_ENDR, 'Leave programming mode after read');
    } catch (e) {
      const left = await this._finishQuiet(CMD_ENDR);
      throw wrap(e, 'Read failed', left ? 'clean' : 'unknown');
    }
    // dmrconfig's file convention: block 0 carries the model tag.
    img.view('mem', 0, 7).set(enc(STOCK_MODEL_ID));
    onProgress(1);
    return img;
  }

  // Writes every 32-byte block of `image` that differs from `base` (the
  // image read from this radio earlier in the session). Stops at the first
  // block the radio does not acknowledge: unlike a read, resending a write
  // into a radio that has stopped answering normally is not safe to assume.
  async writeImage(image, base, onProgress = () => {}) {
    if (image.fw !== 'stock') throw new RadioError('This is an OpenGD77 codeplug; it cannot be written to a radio running the stock firmware');
    const blocks = [];
    for (const r of STOCK.wireRanges) {
      const a = image.view(r.bank, r.addr, r.size), b = base ? base.view(r.bank, r.addr, r.size) : null;
      for (let off = 0; off < r.size; off += BLOCK) {
        let same = !!b;
        for (let i = 0; same && i < BLOCK; i++) if (a[off + i] !== b[off + i]) same = false;
        if (!same) blocks.push({ addr: r.addr + off, data: a.subarray(off, off + BLOCK) });
      }
    }
    this.log(`Writing ${blocks.length} changed block(s) of ${BLOCK} bytes`);
    let started = false;
    try {
      const id = await this.enterProgramMode();
      if (id.model !== STOCK_MODEL_ID) throw new RadioError(`Radio identifies as "${id.model}", not a GD-77`);
      const t0 = Date.now();
      this.trace.timings.push({ label: `write ${blocks.length} block(s)`, ms: 0, ok: false });
      const timing = this.trace.timings.at(-1);
      for (let i = 0; i < blocks.length; i++) {
        timing.ms = Date.now() - t0;
        const { addr, data } = blocks[i];
        await this._selectBank(addr);
        const req = new Uint8Array(4 + BLOCK);
        req[0] = 0x57; req[1] = (addr >> 8) & 0xff; req[2] = addr & 0xff; req[3] = BLOCK;
        req.set(data, 4);
        started = true;
        let r;
        try { r = await this._xfer(req, 1, 2000); }
        catch (e) { if (e instanceof TimeoutError) this.trace.count('timeouts'); throw new RadioError(`No acknowledgement for the write at ${hex(addr, 5)} (${e.message})`, { addr, cause: e }); }
        if (r[0] !== ACK) throw new RadioError(`The radio refused the write at ${hex(addr, 5)} (answered ${hex(r[0])})`, { addr });
        onProgress((i + 1) / blocks.length);
      }
      timing.ms = Date.now() - t0; timing.ok = true;
      await this._finish(CMD_ENDW, 'Finish write (ENDW)');
    } catch (e) {
      await this._finishQuiet(CMD_ENDW);
      throw wrap(e, 'Write failed', started ? 'partial' : 'clean');
    }
    onProgress(1);
    return { blocks: blocks.length };
  }
}

function wrap(e, prefix, radioState) {
  if (e instanceof RadioError) { e.radioState = e.radioState === 'clean' ? radioState : e.radioState; e.message = `${prefix}: ${e.message}`; return e; }
  return new RadioError(`${prefix}: ${e.message}`, { radioState, cause: e });
}
