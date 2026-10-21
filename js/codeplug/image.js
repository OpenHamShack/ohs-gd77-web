// A codeplug image is a set of byte segments, each living in a named memory
// bank. The stock firmware has a single linear 128 KiB space ('mem'); the
// OpenGD77 firmware addresses an EEPROM and a separate SPI flash through the
// same wire protocol, and the same numeric address means different bytes in
// each. Keeping the bank explicit everywhere is what stops an OpenGD77 flash
// address being written into EEPROM.

export class Image {
  constructor(fw, segs) {
    this.fw = fw;
    this.segs = segs.map(s => ({ bank: s.bank, addr: s.addr, data: s.data ?? new Uint8Array(s.size).fill(0xff) }));
  }

  static blank(layout) {
    return new Image(layout.fw, layout.segments.map(s => ({ bank: s.bank, addr: s.addr, size: s.size })));
  }

  clone() {
    return new Image(this.fw, this.segs.map(s => ({ bank: s.bank, addr: s.addr, data: s.data.slice() })));
  }

  find(bank, addr, len) {
    for (const s of this.segs) {
      if (s.bank === bank && addr >= s.addr && addr + len <= s.addr + s.data.length) return s;
    }
    return null;
  }

  has(bank, addr, len) { return !!this.find(bank, addr, len); }

  // A live view: writes through it change the image.
  view(bank, addr, len) {
    const s = this.find(bank, addr, len);
    if (!s) throw new Error(`Address ${bank}:0x${addr.toString(16)}+${len} is outside this codeplug image`);
    return s.data.subarray(addr - s.addr, addr - s.addr + len);
  }

  equals(other) {
    if (this.fw !== other.fw || this.segs.length !== other.segs.length) return false;
    return this.segs.every((s, i) => {
      const o = other.segs[i];
      if (s.bank !== o.bank || s.addr !== o.addr || s.data.length !== o.data.length) return false;
      for (let k = 0; k < s.data.length; k++) if (s.data[k] !== o.data[k]) return false;
      return true;
    });
  }
}
