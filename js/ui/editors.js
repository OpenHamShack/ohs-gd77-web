// Field editors shared by the tables and the settings form. Each editor
// validates as you type and only puts a value into the model when it is
// valid, so encode() rarely has anything to complain about.

import { h, formatMHz, parseMHz, inGD77Band } from './dom.js';
import { encodeTone } from '../codeplug/codec.js';

export const CTCSS = ['67.0', '69.3', '71.9', '74.4', '77.0', '79.7', '82.5', '85.4', '88.5', '91.5', '94.8', '97.4', '100.0', '103.5', '107.2', '110.9', '114.8', '118.8', '123.0', '127.3', '131.8', '136.5', '141.3', '146.2', '151.4', '156.7', '159.8', '162.2', '165.5', '167.9', '171.3', '173.8', '177.3', '179.9', '183.5', '186.2', '189.9', '192.8', '196.6', '199.5', '203.5', '206.5', '210.7', '218.1', '225.7', '229.1', '233.6', '241.8', '250.3', '254.1'];

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

export function isChanged(rec, key) {
  return !rec._orig || !sameValue(rec[key], rec._orig[key]);
}

function checkAscii(v, len) {
  if (v.length > len) throw new Error(`At most ${len} characters`);
  if (/[^\x20-\x7e]/.test(v)) throw new Error('Plain ASCII letters, digits and punctuation only');
  return v;
}

// refOptions(kind) -> [[slot, label], ...]
export function fieldEditor(f, rec, { refOptions, onChange, compact = false }) {
  const v = rec[f.key];
  let el;
  const mark = (err) => {
    el.classList.toggle('invalid', !!err);
    el.title = err ? err.message : '';
    el.closest('td, .field')?.classList.toggle('changed', !err && isChanged(rec, f.key));
  };
  const commit = (parse) => {
    try {
      const nv = parse();
      rec[f.key] = nv;
      mark(null);
      onChange?.(rec, f.key, nv);
    } catch (e) { mark(e); onChange?.(rec, f.key, undefined, e); }
  };

  if (f.readonly) {
    el = h('output', { class: 'ro' }, v === '' || v === null ? '—' : String(v));
    return el;
  }
  if (f.type === 'bit' && !f.options) {
    el = h('input', { type: 'checkbox', checked: !!v, 'aria-label': f.label });
    el.addEventListener('change', () => commit(() => (el.checked ? 1 : 0)));
  } else if (f.options || f.type === 'ref8' || f.type === 'ref16') {
    const opts = f.options ? f.options.slice() : [[0, '—'], ...refOptions(f.ref)];
    if (!opts.some(o => o[0] === v)) opts.push([v, f.options ? `raw ${v}` : `#${v} (missing)`]);
    el = h('select', { 'aria-label': f.label }, opts.map(([val, label]) => h('option', { value: String(val), selected: val === v }, label)));
    el.addEventListener('change', () => commit(() => Number(el.value)));
  } else if (f.type === 'freq') {
    el = h('input', { type: 'text', inputmode: 'decimal', value: formatMHz(v), size: 10, 'aria-label': f.label, class: 'num' });
    el.addEventListener('change', () => commit(() => {
      const hz = parseMHz(el.value);
      if (hz !== null) el.value = formatMHz(hz);
      el.classList.toggle('warn', !inGD77Band(hz));
      return hz;
    }));
    el.classList.toggle('warn', !inGD77Band(v));
  } else if (f.type === 'tone') {
    el = h('input', { type: 'text', value: v, size: 6, list: 'ctcss-list', placeholder: 'off', 'aria-label': f.label, class: 'num' });
    el.addEventListener('change', () => commit(() => {
      const t = el.value.trim().toUpperCase();
      encodeTone(t); // throws with a readable message
      const norm = /^\d+(\.\d)?$/.test(t) ? Number(t).toFixed(1) : t;
      el.value = norm;
      return norm;
    }));
  } else if (f.type === 'ascii') {
    el = h('input', { type: 'text', value: v, maxlength: f.len, size: compact ? Math.min(f.len, 14) : f.len + 2, 'aria-label': f.label, spellcheck: 'false' });
    el.addEventListener('input', () => commit(() => checkAscii(el.value, f.len)));
  } else {
    // Plain numbers (u8, u16, BCD IDs, band limits).
    el = h('input', { type: 'number', value: v === null ? '' : v, min: f.min ?? 0, max: f.max ?? 255, step: 1, 'aria-label': f.label, class: 'num' });
    el.addEventListener('change', () => commit(() => {
      if (el.value.trim() === '') throw new Error('Required');
      const n = Number(el.value);
      if (!Number.isInteger(n)) throw new Error('Whole numbers only');
      const lo = f.min ?? 0, hi = f.max ?? (f.type === 'u16le' ? 65535 : f.type === 'bcd8be' ? 99999999 : 255);
      if (n < lo || n > hi) throw new Error(`${lo} to ${hi}`);
      return n;
    }));
  }
  return el;
}
