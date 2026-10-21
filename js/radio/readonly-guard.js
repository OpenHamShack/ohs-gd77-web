// A read-only fence for a SerialPort, for tools that must never change a
// real radio. It wraps the port's writable stream and refuses, before any
// byte leaves, every frame that is not a read or a harmless screen/LED
// command. OpenGD77Radio sends exactly one frame per write() call, so
// checking each write checks each frame.
//
// Allowed: 'R' reads of flash (1), EEPROM (2) and firmware info (9);
// 'C' commands 0 show CPS screen, 1 clear, 2 draw text, 3 render, 5 close
// CPS screen, and 6 with option 3 (flash the green LED).
// Refused: every 'W'/'X' write, erase and sector command, 'C' 6 options
// such as SAVE_SETTINGS_AND_VFOS (2) or REBOOT (1), and anything unknown.

export function checkReadOnlyFrame(f) {
  if (f.length === 8 && f[0] === 0x52 && [1, 2, 9].includes(f[1])) return;
  if (f.length === 23 && f[0] === 0x43 && [0, 1, 2, 3, 5].includes(f[1])) return;
  if (f.length === 23 && f[0] === 0x43 && f[1] === 6 && f[2] === 3) return;
  const hex = Array.from(f.slice(0, 8), b => b.toString(16).padStart(2, '0')).join(' ');
  throw new Error(`Read-only guard refused a frame (${hex}): only reads and screen commands may reach this radio`);
}

// A refused frame rejects that one write() and leaves the port usable, so
// the caller can still send CLOSE_CPS on its way out. (A WritableStream
// would be errored for good by one rejected write, which is why this hands
// out a writer-shaped object instead; OpenGD77Radio only ever uses
// getWriter(), write(), close() and releaseLock().)
export function readOnlyPort(port, onFrame = () => {}) {
  let inner = null;
  return {
    get readable() { return port.readable; },
    get writable() {
      return port.writable && {
        getWriter() {
          inner = port.writable.getWriter();
          return {
            async write(chunk) {
              const f = new Uint8Array(chunk);
              checkReadOnlyFrame(f);
              onFrame(f);
              await inner.write(f);
            },
            close: () => inner.close(),
            releaseLock: () => inner.releaseLock(),
          };
        },
      };
    },
    open: opts => port.open(opts),
    setSignals: s => port.setSignals(s),
    close: () => port.close(),
    getInfo: () => port.getInfo?.() ?? {},
  };
}
