// The PHP report endpoint, run for real under PHP 8.3 (the local
// php:8.3-cli container image, via tools/dev-server.sh) in the directory
// layout it will have on openhamshack.com. Skipped, with the reason, when
// that image or podman is missing; PHP is never installed on the host.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, statSync, utimesSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'server-test-key-' + process.pid + '-abcdef';
const havePhp = spawnSync('podman', ['image', 'exists', 'docker.io/library/php:8.3-cli']).status === 0;
const skip = havePhp ? false : 'no php:8.3-cli podman image here, so the PHP endpoint is not exercised';

let work, server, base;
const report = (extra = {}) => JSON.stringify({ format: 'gd77-web-diagnostic-report', formatVersion: 1, createdAt: new Date().toISOString(), page: { version: 'test' }, environment: {}, session: { log: [] }, radio: { identified: { model: 'Radioddity GD-77', firmware: 'stock' } }, error: null, ...extra });
const post = (body, { ip = '198.51.100.1', type = 'application/json', query = '', key } = {}) =>
  fetch(base + query, { method: 'POST', headers: { 'Content-Type': type, 'X-Forwarded-For': ip, ...(key ? { 'X-Report-Key': key } : {}) }, body });
const get = (query, key, ip = '198.51.100.9') => fetch(base + query, { headers: { ...(key ? { 'X-Report-Key': key } : {}), 'X-Forwarded-For': ip } });

test('PHP report endpoint', { skip }, async t => {
  mkdirSync(join(homedir(), 'build'), { recursive: true });
  work = mkdtempSync(join(homedir(), 'build', 'gd77-php-test-'));
  const port = 19000 + (process.pid % 900);
  base = `http://127.0.0.1:${port}/gd77/api/report.php`;
  server = spawn('sh', [join(root, 'tools/dev-server.sh'), work, String(port)], { env: { ...process.env, GD77_TEST_KEY: KEY }, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    for (let i = 0; ; i++) {
      try { await fetch(`http://127.0.0.1:${port}/gd77/index.html`); break; }
      catch { if (i > 100) throw new Error('PHP server did not start'); await new Promise(r => setTimeout(r, 100)); }
    }
    const store = join(work, 'gd77-reports');

    await t.test('upload stores gzipped JSON, mode 0600 in a 0700 dir outside public_html, and returns an id', async () => {
      const body = report({ user: { name: 'Bob', message: 'hello' } });
      const r = await post(body);
      assert.equal(r.status, 201);
      const { id } = await r.json();
      assert.match(id, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
      const f = join(store, id + '.json.gz');
      assert.equal(gunzipSync(readFileSync(f)).toString(), body);
      assert.equal(statSync(f).mode & 0o777, 0o600);
      assert.equal(statSync(store).mode & 0o777, 0o700);
      assert.ok(!existsSync(join(work, 'public_html', 'gd77-reports')));
    });

    await t.test('bad bodies are refused without PHP errors leaking', async () => {
      for (const [body, type, status] of [['{nope', 'application/json', 400], ['{"format":"other"}', 'application/json', 422], [report(), 'text/plain', 415]]) {
        const r = await post(body, { type, ip: '198.51.100.2' });
        assert.equal(r.status, status, body);
        const j = await r.json();
        assert.ok(j.error && !/php|stack|line \d/i.test(JSON.stringify(j)));
      }
      const big = await post('{"pad":"' + 'x'.repeat(3 * 1024 * 1024) + '"}', { ip: '198.51.100.3' });
      assert.equal(big.status, 413);
      assert.equal((await fetch(base, { method: 'PUT' })).status, 405);
    });

    await t.test('rate limit: 10 uploads per hour per address, then 429', async () => {
      const codes = [];
      for (let i = 0; i < 11; i++) codes.push((await post(report(), { ip: '203.0.113.7' })).status);
      assert.deepEqual(codes, [...Array(10).fill(201), 429]);
      assert.equal((await post(report(), { ip: '203.0.113.8' })).status, 201, 'another address is unaffected');
    });

    await t.test('admin: list, get and delete need the key; wrong keys are refused and rate limited', async () => {
      assert.equal((await get('?list')).status, 403);
      assert.equal((await get('?list', 'wrong-key-wrong-key')).status, 403);
      const list = await (await get('?list', KEY)).json();
      assert.ok(list.reports.length >= 12);
      const id = list.reports[0].id;
      const one = await get('?get=' + encodeURIComponent(id), KEY);
      assert.equal(one.status, 200);
      assert.equal(one.headers.get('content-type'), 'application/gzip');
      assert.equal(JSON.parse(gunzipSync(Buffer.from(await one.arrayBuffer()))).format, 'gd77-web-diagnostic-report');
      assert.equal((await get('?get=../../gd77-config', KEY)).status, 400);
      assert.equal((await post('', { query: '?delete=' + id })).status, 403);
      assert.equal((await post('', { query: '?delete=' + id, key: KEY })).status, 200);
      assert.equal((await get('?get=' + id, KEY)).status, 404);
      const codes = [];
      for (let i = 0; i < 11; i++) codes.push((await get('?list', 'guess-guess-guess-' + i, '192.0.2.50')).status);
      assert.equal(codes.at(-1), 429);
    });

    await t.test('reports older than 90 days are purged on the next upload', async () => {
      const old = join(store, '20200101T000000Z-deadbeef.json.gz');
      writeFileSync(old, gzipSync('{}'), { mode: 0o600 });
      const t91 = Date.now() / 1000 - 91 * 86400;
      utimesSync(old, t91, t91);
      const recent = join(store, '20200101T000000Z-cafef00d.json.gz');
      writeFileSync(recent, gzipSync('{}'), { mode: 0o600 });
      assert.equal((await post(report(), { ip: '198.51.100.77' })).status, 201);
      assert.ok(!existsSync(old));
      assert.ok(existsSync(recent));
    });

    await t.test('tools/fetch-reports.sh downloads new reports once and notifies once each', async () => {
      const home = join(work, 'home');
      mkdirSync(join(home, '.config', 'gd77-reports'), { recursive: true });
      writeFileSync(join(home, '.config', 'gd77-reports', 'key'), KEY, { mode: 0o600 });
      const notes = join(work, 'notes');
      const notify = join(work, 'notify.sh');
      writeFileSync(notify, `#!/bin/sh\necho "$*" >> ${notes}\n`, { mode: 0o755 });
      const run = () => spawnSync('bash', [join(root, 'tools/fetch-reports.sh')], { env: { ...process.env, HOME: home, GD77_REPORTS_URL: base, GD77_NOTIFY: notify }, encoding: 'utf8' });
      const a = run();
      assert.equal(a.status, 0, a.stderr);
      const files = readdirSync(join(home, 'build', 'gd77-reports')).filter(f => f.endsWith('.json.gz'));
      const n = readFileSync(notes, 'utf8').trim().split('\n');
      assert.equal(n.length, files.length);
      assert.ok(n.some(l => /^GD-77 report \S+: Radioddity GD-77 stock ok$/.test(l)), n.join('\n'));
      assert.ok(n.some(l => /^GD-77 report 20200101T000000Z-cafef00d: no radio ok$/.test(l)), 'a bare report still gets a line');
      const b = run();
      assert.equal(b.status, 0, b.stderr);
      assert.equal(readFileSync(notes, 'utf8').trim().split('\n').length, n.length, 'nothing new, no new notifications');
    });
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => server.on('exit', r));
    rmSync(work, { recursive: true, force: true });
  }
});
