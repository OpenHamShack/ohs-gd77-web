// Made-up firmware files with the real files' structure, for the simulated
// bootloader and for tests that must run without TYT's or OpenGD77's
// files. Keys are pseudo-random and plaintext is skewed the way firmware
// is (mostly 0x00, some 0xFF) so that key recovery works on them exactly as
// it does on the real thing. Nothing here is derived from vendor data.

import { prng } from '../util.js';
import { CODEC_ADDR, CODEC_SIZE } from '../firmware/plan.js';
import { APP_BASE, START_MAGIC, END_MAGIC } from '../firmware/tyt.js';

export function syntheticKey(seed) {
  const r = prng(seed);
  return Uint8Array.from({ length: 1024 }, () => r());
}

export const SIM_KEYS = { UV3X0: syntheticKey(380), MD9600: syntheticKey(9600), MD2017: syntheticKey(2017) };

function firmwareLike(len, seed) {
  const r = prng(seed);
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const x = r();
    b[i] = x < 110 ? 0 : x < 140 ? 0xff : r();
  }
  return b;
}

function program(len, seed) {
  const b = firmwareLike(len, seed);
  const sp = 0x2001fff0, reset = APP_BASE + 0x1001;
  b.set([sp & 0xff, (sp >> 8) & 0xff, (sp >> 16) & 0xff, sp >>> 24, reset & 0xff, (reset >> 8) & 0xff, (reset >> 16) & 0xff, reset >>> 24]);
  b.fill(0xff, len - 900);
  return b;
}

// A TYT container. `codec` (plaintext) is placed at CODEC_ADDR if given.
export function syntheticTyt({ magic = [0x02, 0x17, 0x0c], key = SIM_KEYS.UV3X0, appLen = 0xdd800, seed = 1, codec = null } = {}) {
  const r0 = firmwareLike(0x5d400, seed + 1);
  const app = program(appLen, seed + 2);
  if (codec) app.set(codec, CODEC_ADDR - APP_BASE);
  const stream = new Uint8Array(r0.length + app.length);
  stream.set(r0); stream.set(app, r0.length);
  for (let i = 0; i < stream.length; i++) stream[i] ^= key[i & 1023];
  const out = new Uint8Array(0x100 + stream.length + 256).fill(0xff);
  out.set(Uint8Array.from(START_MAGIC, c => c.charCodeAt(0)));
  out.set(Uint8Array.from('MD-9600\0\0', c => c.charCodeAt(0)), 0x10);
  out.set(magic, 0x30);
  const w32 = (o, v) => out.set([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24], o);
  w32(0x7c, 2);
  w32(0x80, 0x00060000); w32(0x84, r0.length);
  w32(0x88, APP_BASE); w32(0x8c, app.length);
  out.set(stream, 0x100);
  out.set(Uint8Array.from(END_MAGIC, c => c.charCodeAt(0)), out.length - 16);
  return { file: out, appPlain: app };
}

export const SIM_CODEC = firmwareLike(CODEC_SIZE, 77);

export function syntheticDonor() {
  return syntheticTyt({ magic: [0x01, 0x14], key: SIM_KEYS.MD9600, appLen: 0xb2000, seed: 9, codec: SIM_CODEC });
}

export function syntheticOpenGD77(len = 807256) {
  const b = program(len, 5);
  b.fill(0xff, CODEC_ADDR - APP_BASE, CODEC_ADDR - APP_BASE + CODEC_SIZE);
  return b;
}
