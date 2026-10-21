// The editable record tables (channels, contacts, DTMF) and the
// list-with-members editor (zones, RX group lists, scan lists).

import { h, clear } from './dom.js';
import { fieldEditor, isChanged } from './editors.js';
import { newRecord, deleteRecords, duplicateChannel, capacity } from '../codeplug/ops.js';

// ---------------------------------------------------------------------------
// Table of records, one row each, one editor per field.

export function recordTable({ cp, kind, fields, title, refOptions, onChange, onStructure, extraTools = [], allowDuplicate = false, notify }) {
  const selected = new Set();
  let filter = '';
  const wrap = h('div', { class: 'table-wrap' });
  const count = h('span', { class: 'muted' });
  const filterInput = h('input', { type: 'search', placeholder: 'Filter by name', 'aria-label': 'Filter by name', class: 'filter' });
  filterInput.addEventListener('input', () => { filter = filterInput.value.toLowerCase(); draw(); });

  const act = fn => () => { try { fn(); onStructure(); } catch (e) { notify(e.message, 'error'); } };
  const tools = h('div', { class: 'toolbar' },
    h('button', { type: 'button', onclick: act(() => { const r = newRecord(cp, kind, { name: kind === 'channels' ? 'NEW CHANNEL' : kind === 'contacts' ? 'NEW CONTACT' : 'NEW' }); selected.clear(); selected.add(r.slot); }) }, 'Add'),
    allowDuplicate ? h('button', { type: 'button', onclick: act(() => { if (!selected.size) throw new Error('Tick the channels to duplicate first'); for (const s of [...selected]) duplicateChannel(cp, s); }) }, 'Duplicate') : null,
    h('button', { type: 'button', class: 'danger', onclick: act(() => {
      if (!selected.size) throw new Error('Tick the rows to delete first');
      deleteRecords(cp, kind, [...selected]);
      notify(`Deleted ${selected.size} ${title.toLowerCase()}; references to them were cleared`, 'info');
      selected.clear();
    }) }, 'Delete selected'),
    ...extraTools,
    filterInput, count,
  );

  function draw() {
    const rows = cp[kind].filter(r => !filter || (r.name || '').toLowerCase().includes(filter));
    count.textContent = `${cp[kind].length} of ${capacity(cp, kind)} used`;
    const all = h('input', { type: 'checkbox', 'aria-label': 'Select all', checked: rows.length > 0 && rows.every(r => selected.has(r.slot)) });
    all.addEventListener('change', () => { for (const r of rows) all.checked ? selected.add(r.slot) : selected.delete(r.slot); draw(); });
    const table = h('table', { class: 'grid', dataset: { kind } },
      h('thead', {}, h('tr', {}, h('th', { class: 'sel' }, all), h('th', { class: 'slot' }, '#'), fields.map(f => h('th', { title: f.label }, f.label)))),
      h('tbody', {}, rows.map(rec => {
        const box = h('input', { type: 'checkbox', checked: selected.has(rec.slot), 'aria-label': `Select ${rec.name}` });
        box.addEventListener('change', () => { box.checked ? selected.add(rec.slot) : selected.delete(rec.slot); });
        return h('tr', { class: rec._orig ? '' : 'new', dataset: { slot: rec.slot } },
          h('td', { class: 'sel' }, box),
          h('td', { class: 'slot' }, rec.slot),
          fields.map(f => h('td', { class: (isChanged(rec, f.key) ? 'changed ' : '') + 'f-' + f.key }, fieldEditor(f, rec, { refOptions, onChange, compact: true }))));
      })),
    );
    clear(wrap).append(rows.length ? table : h('p', { class: 'empty' }, filter ? 'Nothing matches the filter.' : `No ${title.toLowerCase()} yet.`));
  }
  draw();
  return h('div', { class: 'panel-body' }, tools, wrap);
}

// ---------------------------------------------------------------------------
// Zones, RX group lists and scan lists: pick a list on the left, edit its
// name, settings and ordered members on the right.

export function memberEditor({ cp, kind, title, memberKind, maxMembers, nameLen, fields = [], refOptions, extraMemberOptions = [], onChange, onStructure, notify, state }) {
  const left = h('div', { class: 'list-pane' });
  const right = h('div', { class: 'detail-pane' });
  if (!cp[kind].some(r => r.slot === state.sel)) state.sel = cp[kind][0]?.slot ?? null;

  const act = fn => () => { try { fn(); onStructure(); } catch (e) { notify(e.message, 'error'); } };

  function drawList() {
    clear(left).append(
      h('div', { class: 'toolbar' },
        h('button', { type: 'button', onclick: act(() => { state.sel = newRecord(cp, kind, { name: 'NEW' }).slot; }) }, 'Add'),
        h('button', { type: 'button', class: 'danger', disabled: state.sel === null, onclick: act(() => {
          deleteRecords(cp, kind, [state.sel]);
          state.sel = cp[kind][0]?.slot ?? null;
        }) }, 'Delete'),
        h('span', { class: 'muted' }, `${cp[kind].length} of ${capacity(cp, kind)}`)),
      cp[kind].length
        ? h('ul', { class: 'pick', role: 'listbox', 'aria-label': title }, cp[kind].map(r => h('li', {
          class: (r.slot === state.sel ? 'on ' : '') + (r._orig && !isChanged(r, 'name') && !isChanged(r, 'members') ? '' : 'changed'),
          role: 'option', tabindex: 0, 'aria-selected': r.slot === state.sel ? 'true' : 'false',
          onclick: () => { state.sel = r.slot; drawList(); drawDetail(); },
          onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.sel = r.slot; drawList(); drawDetail(); } },
        }, h('span', { class: 'slot' }, r.slot), ' ', r.name || '(no name)', h('span', { class: 'muted' }, ` · ${r.members.length}`))))
        : h('p', { class: 'empty' }, `No ${title.toLowerCase()} yet.`),
    );
  }

  function drawDetail() {
    clear(right);
    const rec = cp[kind].find(r => r.slot === state.sel);
    if (!rec) { right.append(h('p', { class: 'empty' }, 'Select or add one on the left.')); return; }
    const nameField = { key: 'name', label: 'Name', type: 'ascii', len: nameLen };
    const refresh = (r, key) => { onChange(r, key); if (key === 'name') drawList(); };
    const opts = [...extraMemberOptions, ...refOptions(memberKind)];
    const label = v => (opts.find(o => o[0] === v)?.[1]) ?? `#${v} (missing)`;
    const members = h('ol', { class: 'members' }, rec.members.map((m, i) => h('li', {},
      h('span', {}, label(m)),
      h('span', { class: 'row-tools' },
        h('button', { type: 'button', class: 'icon', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { const a = rec.members.slice(); [a[i - 1], a[i]] = [a[i], a[i - 1]]; rec.members = a; refresh(rec, 'members'); drawDetail(); } }, '↑'),
        h('button', { type: 'button', class: 'icon', title: 'Move down', 'aria-label': 'Move down', disabled: i === rec.members.length - 1, onclick: () => { const a = rec.members.slice(); [a[i + 1], a[i]] = [a[i], a[i + 1]]; rec.members = a; refresh(rec, 'members'); drawDetail(); } }, '↓'),
        h('button', { type: 'button', class: 'icon', title: 'Remove', 'aria-label': 'Remove', onclick: () => { rec.members = rec.members.filter((_, k) => k !== i); refresh(rec, 'members'); drawList(); drawDetail(); } }, '✕')))));
    const pick = h('select', { 'aria-label': 'Member to add' }, opts.filter(o => !rec.members.includes(o[0])).map(([v, l]) => h('option', { value: String(v) }, l)));
    const add = h('button', { type: 'button', disabled: rec.members.length >= maxMembers || !pick.options.length, onclick: () => {
      if (rec.members.length >= maxMembers) return;
      rec.members = [...rec.members, Number(pick.value)];
      refresh(rec, 'members'); drawList(); drawDetail();
    } }, 'Add');
    right.append(
      h('div', { class: 'form' },
        h('label', { class: 'field' + (isChanged(rec, 'name') ? ' changed' : '') }, h('span', {}, 'Name'), fieldEditor(nameField, rec, { refOptions, onChange: refresh })),
        fields.map(f => h('label', { class: 'field' + (isChanged(rec, f.key) ? ' changed' : '') }, h('span', {}, f.label + (f.unit ? ` (${f.unit})` : '')), fieldEditor(f, rec, { refOptions, onChange: refresh })))),
      h('h3', {}, `Members (${rec.members.length} of ${maxMembers})`),
      rec.members.length ? members : h('p', { class: 'empty' }, 'No members.'),
      h('div', { class: 'toolbar' }, pick, add),
    );
  }

  drawList(); drawDetail();
  return h('div', { class: 'panel-body split' }, left, right);
}
