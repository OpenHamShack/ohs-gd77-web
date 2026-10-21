#!/usr/bin/env node
// Read-only codeplug read of a real OpenGD77 radio, from the command line,
// through the same js/radio/opengd77-serial.js and codec the page uses.
//
//   node tools/real-read.mjs [--sim] [--save-settings] [--out DIR] [/dev/serial/by-id/...opengd77...]
//
// - The serial port is reached through tools/serial-bridge.py under sudo,
//   which only accepts an OpenGD77 /dev/serial/by-id link.
// - Every frame passes js/radio/readonly-guard.js first: writes, sector and
//   flash commands, and SAVE_SETTINGS_AND_VFOS are refused before a byte is
//   sent. --save-settings is the only way to let the last one through, for
//   the case where a read does not work without it.
// - CLOSE_CPS_SCREEN is sent on every exit path (OpenGD77Radio.readImage).
// - The image and a .gd77backup go to DIR (default ~/build/<model>-read/),
//   mode 0600: they hold the owner's callsign and contacts, so never into
//   the repository.
// - --sim reads the simulated MD-UV380 instead, to rehearse the run.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenGD77Radio } from '../js/radio/opengd77-serial.js';
import { readOnlyPort } from '../js/radio/readonly-guard.js';
import { SimulatedOpenGD77Port } from '../js/sim/opengd77-sim.js';
import { decode } from '../js/codeplug/codec.js';
import { openGD77ToBackup } from '../js/files.js';
import { summarize } from '../js/codeplug/checks.js';
import { timestamp } from '../js/util.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = f => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = f => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const sim = flag('--sim');
const saveSettings = flag('--save-settings');
const outArg = opt('--out');

// A SerialPort look-alike over the bridge's stdin/stdout.
class BridgePort {
  constructor(path) { this.path = path; this.readable = null; this.writable = null; }
  async open() {
    const child = spawn('sudo', ['-n', 'python3', join(here, 'serial-bridge.py'), this.path], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    await new Promise((resolve, reject) => {
      let err = '';
      child.stderr.on('data', d => { err += d; if (err.includes('READY')) resolve(); });
      child.on('exit', code => reject(new Error(`serial bridge exited (${code}): ${err.trim()}`)));
    });
    this.readable = new ReadableStream({
      start: c => {
        child.stdout.on('data', d => c.enqueue(new Uint8Array(d)));
        child.stdout.on('end', () => { try { c.close(); } catch { /* cancelled */ } });
      },
      cancel: () => child.stdout.destroy(),
    });
    this.writable = new WritableStream({
      write: chunk => new Promise((res, rej) => child.stdin.write(Buffer.from(chunk), e => (e ? rej(e) : res()))),
      close: () => new Promise(res => child.stdin.end(res)),
    });
  }
  async setSignals() { /* the bridge raised DTR and RTS before READY */ }
  async close() {
    try { this.child.stdin.end(); } catch { /* already closed */ }
    await new Promise(res => { if (this.child.exitCode !== null) res(); else { this.child.on('exit', res); setTimeout(res, 3000); } });
  }
  getInfo() { return {}; }
}

function findRadio() {
  const dir = '/dev/serial/by-id';
  const hits = readdirSync(dir).filter(n => /opengd77/i.test(n));
  if (hits.length !== 1) throw new Error(`Expected exactly one OpenGD77 radio in ${dir}, found ${hits.length}: ${hits.join(', ')}`);
  return join(dir, hits[0]);
}

const mhz = hz => (hz === null ? '(erased)' : (hz / 1e6).toFixed(5));

async function main() {
  const path = sim ? null : (args[0] ?? findRadio());
  if (path && !(path.startsWith('/dev/serial/by-id/') && /opengd77/i.test(path))) throw new Error(`Refusing ${path}: not an OpenGD77 /dev/serial/by-id link`);
  if (path) console.log(`Radio port: ${path} -> ${realpathSync(path)}`);
  const frames = { R: 0, C: 0 };
  const raw = sim ? new SimulatedOpenGD77Port({ radioType: 6 }) : new BridgePort(path);
  const port = readOnlyPort(raw, f => { frames[String.fromCharCode(f[0])]++; });
  const radio = new OpenGD77Radio(port, { log: m => console.log('  ' + m), settleMs: 400 });
  let img, info;
  const t0 = Date.now();
  try {
    await radio.open();
    info = await radio.identify();
    console.log(`Identified: ${info.model}, layout ${info.firmware}, write family ${info.family}`);
    let last = -1;
    img = await radio.readImage(p => { const pc = Math.floor(p * 10); if (pc !== last) { last = pc; process.stdout.write(` ${pc * 10}%`); } }, { saveSettings });
    process.stdout.write('\n');
  } finally {
    await radio.close();
  }
  console.log(`Read ${img.segs.reduce((n, s) => n + s.data.length, 0)} bytes in ${((Date.now() - t0) / 1000).toFixed(1)} s; frames sent: ${frames.R} read, ${frames.C} command, 0 write (guarded)`);

  const out = outArg ?? join(homedir(), 'build', sim ? 'uv380-sim-read' : `${info.model.split(' ').pop().toLowerCase()}-read`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const stamp = timestamp();
  writeFileSync(join(out, `read-${stamp}.gd77backup`), openGD77ToBackup(img, { radioName: info.model }), { mode: 0o600 });
  for (const s of img.segs) writeFileSync(join(out, `read-${stamp}-${s.bank}-${s.addr.toString(16)}.bin`), s.data, { mode: 0o600 });
  console.log(`Saved to ${out}/read-${stamp}.*`);

  const cp = decode(img);
  const g = cp.general;
  console.log(`\nCallsign ${JSON.stringify(g.callsign)}, DMR ID ${g.dmrId}, intro ${JSON.stringify(g.intro1)} / ${JSON.stringify(g.intro2)}, band limits VHF ${g.vhfMin}-${g.vhfMax} UHF ${g.uhfMin}-${g.uhfMax}`);
  console.log(`Channels ${cp.channels.length}, zones ${cp.zones.length}, contacts ${cp.contacts.length}, RX group lists ${cp.groupLists.length}, DTMF ${cp.dtmf.length}`);
  const cname = s => cp.contacts.find(c => c.slot === s)?.name ?? (s ? `#${s}?` : '');
  console.log('\nFirst channels:');
  for (const c of cp.channels.slice(0, 10)) {
    console.log(`  ${String(c.slot).padStart(4)} ${c.name.padEnd(16)} RX ${mhz(c.rxFreq)} TX ${mhz(c.txFreq)} ${c.mode ? 'DMR' : 'FM '} ` +
      (c.mode ? `CC${c.colorCode} TS${c.timeslot + 1} ${cname(c.contact)}` : `${c.bandwidth ? '25' : '12.5'}k tones ${c.rxTone || '-'}/${c.txTone || '-'}`) + ` pwr ${c.power} sq ${c.squelch}`);
  }
  console.log('\nFirst contacts:');
  for (const c of cp.contacts.slice(0, 10)) console.log(`  ${String(c.slot).padStart(4)} ${c.name.padEnd(16)} ${String(c.dmrId).padStart(8)} ${['Group', 'Private', 'All'][c.callType] ?? c.callType}`);
  console.log('\nZones:', cp.zones.slice(0, 10).map(z => `${z.name} (${z.members.length})`).join(', '));
  console.log('RX group lists:', cp.groupLists.slice(0, 10).map(z => `${z.name} (${z.members.length})`).join(', '));

  // Sanity checks on the decode (js/codeplug/checks.js). DMR IDs are 24-bit;
  // read with the wrong BCD byte order a 7-digit ID such as 2351234 becomes
  // 34123502, so IDs that all fit in 24 bits settle the byte order.
  const sum = summarize(cp);
  console.log(`\nContacts with 7-digit (personal) IDs: ${sum.personalIds}`);
  const problems = sum.warnings.map(w => `${w.kind}: ${w.count}${w.slots ? ' (slots ' + w.slots.join(', ') + ')' : ''}`);
  console.log(problems.length ? 'DECODE PROBLEMS:\n  ' + problems.join('\n  ') : 'Decode sanity checks: all passed');
}

main().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
