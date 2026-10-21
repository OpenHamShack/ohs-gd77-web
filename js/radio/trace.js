// What a transport keeps for a diagnostic report: the last raw exchanges in
// a ring buffer, counters for the recoveries that hide trouble (retries,
// resyncs, timeouts), and how long each region took. Kept small and always
// on, because the useful moment is the failure nobody expected to record.

const HEX_BYTES = 48; // per exchange; enough to see headers and the start of data

export class Trace {
  constructor(size = 200) {
    this.size = size;
    this.ring = [];
    this.total = 0;
    this.counters = { retries: 0, resyncs: 0, timeouts: 0, desyncs: 0 };
    this.timings = [];
    this.t0 = Date.now();
  }

  // dir: 'tx' (to the radio) or 'rx' (from it)
  add(dir, bytes, note) {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const e = {
      t: Date.now() - this.t0,
      dir,
      len: b.length,
      hex: Array.from(b.subarray(0, HEX_BYTES), x => x.toString(16).padStart(2, '0')).join(' ') + (b.length > HEX_BYTES ? ' …' : ''),
    };
    if (note) e.note = note;
    this.ring.push(e);
    this.total++;
    if (this.ring.length > this.size) this.ring.shift();
  }

  count(what) { this.counters[what] = (this.counters[what] || 0) + 1; }

  // Times one region of a read or write: await trace.time('read flash 0x9b000+0x14000', fn)
  async time(label, fn) {
    const start = Date.now();
    let ok = false;
    try { const r = await fn(); ok = true; return r; }
    finally { this.timings.push({ label, ms: Date.now() - start, ok }); }
  }

  snapshot() {
    return { exchangesKept: this.ring.length, exchangesTotal: this.total, exchanges: this.ring.slice(), counters: { ...this.counters }, timings: this.timings.slice() };
  }
}
