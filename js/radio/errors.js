// Errors carry what the user needs to recover, not just what went wrong.
// `radioState` says what we believe the radio is left in:
//   'clean'      - nothing was written, or the transfer finished properly
//   'partial'    - a write started and did not finish: the codeplug on the
//                  radio is a mix of old and new bytes
//   'unknown'    - we lost contact and could not tell it to leave CPS mode

export class RadioError extends Error {
  constructor(message, { radioState = 'clean', addr = null, cause = null } = {}) {
    super(message);
    this.name = 'RadioError';
    this.radioState = radioState;
    this.addr = addr;
    if (cause) this.cause = cause;
  }
}

export class TimeoutError extends Error {
  constructor(message) { super(message); this.name = 'TimeoutError'; }
}

export class DesyncError extends Error {
  constructor(message) { super(message); this.name = 'DesyncError'; }
}
