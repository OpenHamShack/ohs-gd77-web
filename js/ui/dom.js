// Minimal DOM helpers. No framework: the page must work as plain static
// files with nothing fetched from elsewhere.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function $(sel, root = document) { return root.querySelector(sel); }

// MHz text <-> Hz. Frequencies are stored in 10 Hz units on the radio.
export function formatMHz(hz) {
  if (hz === null || hz === undefined) return '';
  const s = (hz / 1e6).toFixed(5);
  return s.replace(/(\.\d{4}\d*?)0+$/, '$1');
}

export function parseMHz(text) {
  const t = String(text).trim();
  if (t === '') return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`"${text}" is not a frequency in MHz`);
  const hz = Math.round(v * 1e5) * 10;
  if (hz % 10) throw new Error('Frequencies are stored in 10 Hz steps');
  return hz;
}

export function inGD77Band(hz) {
  return hz === null || (hz >= 136e6 && hz <= 174e6) || (hz >= 400e6 && hz <= 470e6);
}
