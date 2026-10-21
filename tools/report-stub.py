#!/usr/bin/env python3
"""Stand-in for server/gd77-report.php when no PHP is available.

Serves <workdir>/public_html and accepts report uploads at any path ending
in /api/report.php with the same validation and reply shape as the PHP
endpoint ({"id": ...}, 201), storing them gzipped in <workdir>/gd77-reports.
It only lets the page's send path be exercised; it is not the endpoint and
does none of the rate limiting or admin calls.
"""
import gzip, http.server, json, os, secrets, sys, time
from functools import partial

work, port = sys.argv[1], int(sys.argv[2])
store = os.path.join(work, 'gd77-reports')
os.makedirs(store, mode=0o700, exist_ok=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if not self.path.split('?')[0].endswith('/api/report.php'):
            return self.reply(405, {'error': 'method not allowed'})
        n = int(self.headers.get('Content-Length', '0'))
        if n > 3 * 1024 * 1024:
            return self.reply(413, {'error': 'report too large'})
        try:
            r = json.loads(self.rfile.read(n))
            ok = r.get('format') == 'gd77-web-diagnostic-report' and all(k in r for k in ('createdAt', 'page', 'environment', 'session'))
        except ValueError:
            ok = False
        if not ok:
            return self.reply(422, {'error': 'not a GD-77 diagnostic report'})
        rid = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(4)
        with gzip.open(os.path.join(store, rid + '.json.gz'), 'wb') as f:
            f.write(json.dumps(r).encode())
        self.reply(201, {'id': rid})

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(('127.0.0.1', port), partial(Handler, directory=os.path.join(work, 'public_html'))).serve_forever()
