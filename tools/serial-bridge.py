#!/usr/bin/env python3
"""Relay stdin/stdout to an OpenGD77 radio's USB serial port.

tools/real-read.mjs runs this under sudo (Brian's user is not in the
dialout group) so that the node code, running unprivileged, can drive the
same js/radio/opengd77-serial.js the page uses. It only moves bytes: the
read-only frame check lives in js/radio/readonly-guard.js on the node side,
where each write is one whole frame.

It refuses any path that is not an OpenGD77 radio's /dev/serial/by-id link,
so it cannot be pointed at another device (shack has an IC-9700 and others
on USB serial).

Port setup: raw 115200 8N1, no flow control, DTR and RTS asserted, then
"READY" on stderr. The caller waits for that before starting its own
post-DTR settle time.
"""
import fcntl, os, select, sys, termios

path = sys.argv[1] if len(sys.argv) > 1 else ''
# /dev/pts/* (a pseudo-terminal, never a radio) is allowed for testing the relay.
if not ((path.startswith('/dev/serial/by-id/') and 'opengd77' in path.lower()) or path.startswith('/dev/pts/')):
    sys.exit(f'serial-bridge: refusing {path!r}: not an OpenGD77 /dev/serial/by-id path')

fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
attrs = termios.tcgetattr(fd)
iflag, oflag, cflag, lflag, ispeed, ospeed, cc = attrs
iflag = 0                                   # no CR/LF mapping, no XON/XOFF
oflag = 0
lflag = 0                                   # no echo, no canonical mode, no signals
cflag = (cflag & ~(termios.CSIZE | termios.PARENB | termios.CSTOPB | getattr(termios, 'CRTSCTS', 0))) | termios.CS8 | termios.CREAD | termios.CLOCAL
cc[termios.VMIN] = 0
cc[termios.VTIME] = 0
termios.tcsetattr(fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, termios.B115200, termios.B115200, cc])
try:
    fcntl.ioctl(fd, termios.TIOCMBIS, (termios.TIOCM_DTR | termios.TIOCM_RTS).to_bytes(4, sys.byteorder))
except OSError:
    if not path.startswith('/dev/pts/'):   # a pty has no modem lines; a radio must
        raise
termios.tcflush(fd, termios.TCIOFLUSH)
sys.stderr.write('READY\n')
sys.stderr.flush()

stdin, stdout = sys.stdin.fileno(), sys.stdout.fileno()
try:
    while True:
        r, _, _ = select.select([stdin, fd], [], [], 1.0)
        if stdin in r:
            data = os.read(stdin, 4096)
            if not data:
                break
            while data:
                try:
                    n = os.write(fd, data)
                    data = data[n:]
                except BlockingIOError:
                    select.select([], [fd], [], 1.0)
        if fd in r:
            try:
                data = os.read(fd, 4096)
            except BlockingIOError:
                data = b''
            if data:
                os.write(stdout, data)
finally:
    termios.tcdrain(fd)
    os.close(fd)
