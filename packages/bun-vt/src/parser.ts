/**
 * src/parser.ts — a VT500-series escape-sequence parser.
 *
 * This is a faithful implementation of Paul Williams' DEC-compatible parser
 * state machine (the same design libghostty's `Parser.zig` is built on),
 * extended with:
 *   - UTF-8 decoding in the ground state (so `print` delivers Unicode scalars,
 *     not raw bytes), and
 *   - colon-separated CSI sub-parameters (needed for SGR forms like `4:3` and
 *     `38:2::r:g:b`).
 *
 * The parser is a pure byte→action translator: it never touches terminal state.
 * It drives a `Handler` via callbacks, exactly like a SAX parser. All terminal
 * semantics live in the handler (see terminal.ts).
 *
 * Robustness: the machine is hardened against arbitrary/malformed input — every
 * byte has a defined transition and nothing throws. This matches the guarantee
 * libghostty-vt makes about untrusted data.
 */

export interface CsiSequence {
  /** Numeric parameters. An omitted parameter is 0 (handlers apply defaults). */
  readonly params: readonly number[];
  /**
   * `true` at index i means params[i] was separated from params[i-1] by a colon
   * (a sub-parameter of the same group) rather than a semicolon. Index 0 is
   * always `false`.
   */
  readonly colon: readonly boolean[];
  /** Intermediate bytes (0x20–0x2F), e.g. " " in `CSI SP q`. */
  readonly intermediates: string;
  /** Private-marker prefix byte (`?`, `<`, `=`, `>`), or "" if none. */
  readonly prefix: string;
  /** Final byte (0x40–0x7E) that dispatched the sequence. */
  readonly final: string;
}

export interface EscSequence {
  readonly intermediates: string;
  readonly final: string;
}

export interface Handler {
  /** A printable Unicode scalar value reached the ground state. */
  print(cp: number): void;
  /** A C0 control byte should be executed (LF, CR, BS, HT, BEL, …). */
  execute(control: number): void;
  csiDispatch(seq: CsiSequence): void;
  escDispatch(seq: EscSequence): void;
  /** A completed OSC string (already UTF-8 decoded), without the introducer/terminator. */
  oscDispatch(data: string): void;
  /** DCS hook — start of a device control string. Optional. */
  dcsHook?(seq: CsiSequence): void;
  dcsPut?(byte: number): void;
  dcsUnhook?(): void;
}

const enum S {
  GROUND,
  ESCAPE,
  ESCAPE_INTERMEDIATE,
  CSI_ENTRY,
  CSI_PARAM,
  CSI_INTERMEDIATE,
  CSI_IGNORE,
  DCS_ENTRY,
  DCS_PARAM,
  DCS_INTERMEDIATE,
  DCS_PASSTHROUGH,
  DCS_IGNORE,
  OSC_STRING,
  SOS_PM_APC_STRING,
}

const MAX_PARAMS = 32;
const REPLACEMENT = 0xfffd;

/** A C0 control that is "executed" without leaving the current state. */
function isExecutable(b: number): boolean {
  return (b <= 0x17 && b !== 0x1b) || b === 0x19 || (b >= 0x1c && b <= 0x1f);
}

export class Parser {
  #state: S = S.GROUND;

  // -- CSI / escape accumulators --
  // `#params`/`#colon` hold already-finalized parameters. `#curParam` is the
  // in-progress parameter being accumulated; `#curColon` records the separator
  // that preceded it (a colon makes it a sub-parameter of the prior group).
  #params: number[] = [];
  #colon: boolean[] = [];
  #curParam = 0;
  #hasDigits = false;
  #curColon = false;
  #intermediates = "";
  #prefix = "";
  #overflow = false; // too many params → dispatch is dropped

  // -- OSC accumulator (raw bytes, decoded as UTF-8 at completion) --
  #osc: number[] = [];

  // -- UTF-8 ground decoder --
  #utf8Remaining = 0;
  #utf8Cp = 0;

  constructor(private readonly h: Handler) {}

  reset(): void {
    this.#state = S.GROUND;
    this.#clear();
    this.#osc.length = 0;
    this.#utf8Remaining = 0;
    this.#utf8Cp = 0;
  }

  /** Feed a whole buffer. */
  write(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.next(bytes[i]!);
  }

  next(b: number): void {
    // --- UTF-8 continuation handling (only meaningful in the ground state) ---
    if (this.#utf8Remaining > 0) {
      if (b >= 0x80 && b <= 0xbf) {
        this.#utf8Cp = (this.#utf8Cp << 6) | (b & 0x3f);
        if (--this.#utf8Remaining === 0) this.#emitCodepoint(this.#utf8Cp);
        return;
      }
      // Malformed sequence: emit a replacement char and reprocess this byte.
      this.#utf8Remaining = 0;
      this.h.print(REPLACEMENT);
      // fall through
    }

    // --- Anywhere transitions ---
    if (b === 0x18 || b === 0x1a) {
      // CAN / SUB abort any sequence.
      if (this.#state === S.DCS_PASSTHROUGH) this.h.dcsUnhook?.();
      this.#state = S.GROUND;
      this.#clear();
      return;
    }
    if (b === 0x1b) {
      if (this.#state === S.DCS_PASSTHROUGH) this.h.dcsUnhook?.();
      if (this.#state === S.OSC_STRING) this.#oscEnd();
      this.#state = S.ESCAPE;
      this.#clear();
      return;
    }

    switch (this.#state) {
      case S.GROUND:
        return this.#ground(b);
      case S.ESCAPE:
        return this.#escape(b);
      case S.ESCAPE_INTERMEDIATE:
        return this.#escapeIntermediate(b);
      case S.CSI_ENTRY:
        return this.#csiEntry(b);
      case S.CSI_PARAM:
        return this.#csiParam(b);
      case S.CSI_INTERMEDIATE:
        return this.#csiIntermediate(b);
      case S.CSI_IGNORE:
        return this.#csiIgnore(b);
      case S.DCS_ENTRY:
        return this.#dcsEntry(b);
      case S.DCS_PARAM:
        return this.#dcsParam(b);
      case S.DCS_INTERMEDIATE:
        return this.#dcsIntermediate(b);
      case S.DCS_PASSTHROUGH:
        return this.#dcsPassthrough(b);
      case S.DCS_IGNORE:
        return this.#dcsIgnore(b);
      case S.OSC_STRING:
        return this.#oscString(b);
      case S.SOS_PM_APC_STRING:
        return this.#sosPmApc(b);
    }
  }

  // --- ground -------------------------------------------------------------

  #ground(b: number): void {
    if (isExecutable(b)) {
      this.h.execute(b);
      return;
    }
    if (b < 0x80) {
      if (b === 0x7f) return; // DEL is ignored on print
      this.h.print(b);
      return;
    }
    // UTF-8 lead byte.
    if (b >= 0xc2 && b <= 0xdf) {
      this.#utf8Remaining = 1;
      this.#utf8Cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      this.#utf8Remaining = 2;
      this.#utf8Cp = b & 0x0f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      this.#utf8Remaining = 3;
      this.#utf8Cp = b & 0x07;
    } else {
      // Invalid lead (continuation byte in isolation, 0xC0/0xC1, 0xF5+).
      this.h.print(REPLACEMENT);
    }
  }

  #emitCodepoint(cp: number): void {
    // Reject surrogates and out-of-range values.
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      this.h.print(REPLACEMENT);
      return;
    }
    this.h.print(cp);
  }

  // --- escape -------------------------------------------------------------

  #escape(b: number): void {
    if (isExecutable(b)) return this.h.execute(b);
    if (b === 0x7f) return;
    if (b >= 0x20 && b <= 0x2f) {
      this.#intermediates += String.fromCharCode(b);
      this.#state = S.ESCAPE_INTERMEDIATE;
      return;
    }
    switch (b) {
      case 0x5b: // '['
        this.#state = S.CSI_ENTRY;
        return;
      case 0x5d: // ']'
        this.#state = S.OSC_STRING;
        this.#osc.length = 0;
        return;
      case 0x50: // 'P'
        this.#state = S.DCS_ENTRY;
        return;
      case 0x58: // 'X' SOS
      case 0x5e: // '^' PM
      case 0x5f: // '_' APC
        this.#state = S.SOS_PM_APC_STRING;
        return;
      case 0x5c: // '\' — String Terminator (ESC \). Terminates strings; no-op otherwise.
        this.#state = S.GROUND;
        this.#clear();
        return;
    }
    if (b >= 0x30 && b <= 0x7e) {
      this.h.escDispatch({ intermediates: this.#intermediates, final: String.fromCharCode(b) });
      this.#state = S.GROUND;
      this.#clear();
      return;
    }
    // Anything else: back to ground.
    this.#state = S.GROUND;
    this.#clear();
  }

  #escapeIntermediate(b: number): void {
    if (isExecutable(b)) return this.h.execute(b);
    if (b === 0x7f) return;
    if (b >= 0x20 && b <= 0x2f) {
      this.#intermediates += String.fromCharCode(b);
      return;
    }
    if (b >= 0x30 && b <= 0x7e) {
      this.h.escDispatch({ intermediates: this.#intermediates, final: String.fromCharCode(b) });
    }
    this.#state = S.GROUND;
    this.#clear();
  }

  // --- CSI ----------------------------------------------------------------

  #csiEntry(b: number): void {
    if (isExecutable(b)) return this.h.execute(b);
    if (b === 0x7f) return;
    if (b >= 0x40 && b <= 0x7e) return this.#csiDispatch(b);
    if (b >= 0x30 && b <= 0x39) {
      this.#pushDigit(b);
      this.#state = S.CSI_PARAM;
      return;
    }
    if (b === 0x3a) {
      // leading colon → sub-param of an (empty) first param
      this.#nextParam(true);
      this.#state = S.CSI_PARAM;
      return;
    }
    if (b === 0x3b) {
      this.#nextParam(false);
      this.#state = S.CSI_PARAM;
      return;
    }
    if (b >= 0x3c && b <= 0x3f) {
      this.#prefix = String.fromCharCode(b);
      this.#state = S.CSI_PARAM;
      return;
    }
    if (b >= 0x20 && b <= 0x2f) {
      this.#intermediates += String.fromCharCode(b);
      this.#state = S.CSI_INTERMEDIATE;
      return;
    }
    this.#state = S.CSI_IGNORE;
  }

  #csiParam(b: number): void {
    if (isExecutable(b)) return this.h.execute(b);
    if (b === 0x7f) return;
    if (b >= 0x30 && b <= 0x39) return this.#pushDigit(b);
    if (b === 0x3a) return this.#nextParam(true);
    if (b === 0x3b) return this.#nextParam(false);
    if (b >= 0x40 && b <= 0x7e) return this.#csiDispatch(b);
    if (b >= 0x20 && b <= 0x2f) {
      // Trailing param stays pending in #curParam; it is finalized at dispatch.
      this.#intermediates += String.fromCharCode(b);
      this.#state = S.CSI_INTERMEDIATE;
      return;
    }
    // 0x3C–0x3F here is illegal.
    this.#state = S.CSI_IGNORE;
  }

  #csiIntermediate(b: number): void {
    if (isExecutable(b)) return this.h.execute(b);
    if (b === 0x7f) return;
    if (b >= 0x20 && b <= 0x2f) {
      this.#intermediates += String.fromCharCode(b);
      return;
    }
    if (b >= 0x40 && b <= 0x7e) return this.#csiDispatch(b);
    this.#state = S.CSI_IGNORE;
  }

  #csiIgnore(b: number): void {
    if (isExecutable(b)) return this.h.execute(b);
    if (b >= 0x40 && b <= 0x7e) {
      this.#state = S.GROUND;
      this.#clear();
    }
  }

  #csiDispatch(final: number): void {
    this.#commitParam();
    if (!this.#overflow) {
      this.h.csiDispatch({
        params: this.#params.slice(),
        colon: this.#colon.slice(),
        intermediates: this.#intermediates,
        prefix: this.#prefix,
        final: String.fromCharCode(final),
      });
    }
    this.#state = S.GROUND;
    this.#clear();
  }

  // --- DCS ----------------------------------------------------------------

  #dcsEntry(b: number): void {
    if (b === 0x7f) return;
    if (b >= 0x40 && b <= 0x7e) return this.#dcsHook(b);
    if (b >= 0x30 && b <= 0x39) {
      this.#pushDigit(b);
      this.#state = S.DCS_PARAM;
      return;
    }
    if (b === 0x3a) {
      this.#nextParam(true);
      this.#state = S.DCS_PARAM;
      return;
    }
    if (b === 0x3b) {
      this.#nextParam(false);
      this.#state = S.DCS_PARAM;
      return;
    }
    if (b >= 0x3c && b <= 0x3f) {
      this.#prefix = String.fromCharCode(b);
      this.#state = S.DCS_PARAM;
      return;
    }
    if (b >= 0x20 && b <= 0x2f) {
      this.#intermediates += String.fromCharCode(b);
      this.#state = S.DCS_INTERMEDIATE;
      return;
    }
    this.#state = S.DCS_IGNORE;
  }

  #dcsParam(b: number): void {
    if (b === 0x7f) return;
    if (b >= 0x30 && b <= 0x39) return this.#pushDigit(b);
    if (b === 0x3a) return this.#nextParam(true);
    if (b === 0x3b) return this.#nextParam(false);
    if (b >= 0x40 && b <= 0x7e) return this.#dcsHook(b);
    if (b >= 0x20 && b <= 0x2f) {
      this.#intermediates += String.fromCharCode(b);
      this.#state = S.DCS_INTERMEDIATE;
      return;
    }
    this.#state = S.DCS_IGNORE;
  }

  #dcsIntermediate(b: number): void {
    if (b === 0x7f) return;
    if (b >= 0x20 && b <= 0x2f) {
      this.#intermediates += String.fromCharCode(b);
      return;
    }
    if (b >= 0x40 && b <= 0x7e) return this.#dcsHook(b);
    this.#state = S.DCS_IGNORE;
  }

  #dcsHook(final: number): void {
    this.#commitParam();
    this.h.dcsHook?.({
      params: this.#params.slice(),
      colon: this.#colon.slice(),
      intermediates: this.#intermediates,
      prefix: this.#prefix,
      final: String.fromCharCode(final),
    });
    this.#state = S.DCS_PASSTHROUGH;
  }

  #dcsPassthrough(b: number): void {
    if (b === 0x9c) {
      this.h.dcsUnhook?.();
      this.#state = S.GROUND;
      this.#clear();
      return;
    }
    if (b === 0x7f) return;
    this.h.dcsPut?.(b);
  }

  #dcsIgnore(b: number): void {
    if (b === 0x9c) {
      this.#state = S.GROUND;
      this.#clear();
    }
  }

  // --- OSC ----------------------------------------------------------------

  #oscString(b: number): void {
    if (b === 0x07) {
      // BEL terminator
      this.#oscEnd();
      this.#state = S.GROUND;
      return;
    }
    if (b === 0x9c) {
      // C1 ST terminator
      this.#oscEnd();
      this.#state = S.GROUND;
      return;
    }
    if (b < 0x20 && b !== 0x08) return; // ignore most controls inside OSC
    this.#osc.push(b);
  }

  #oscEnd(): void {
    if (this.#osc.length === 0) {
      this.h.oscDispatch("");
      return;
    }
    const data = new TextDecoder("utf-8").decode(Uint8Array.from(this.#osc));
    this.#osc.length = 0;
    this.h.oscDispatch(data);
  }

  // --- SOS/PM/APC (consumed and ignored) ----------------------------------

  #sosPmApc(b: number): void {
    if (b === 0x9c) {
      this.#state = S.GROUND;
      this.#clear();
    }
    // ESC handled by the anywhere transition (→ escape, then ST no-ops).
  }

  // --- param helpers ------------------------------------------------------

  #pushDigit(b: number): void {
    if (this.#overflow) return;
    this.#hasDigits = true;
    this.#curParam = this.#curParam * 10 + (b - 0x30);
    if (this.#curParam > 0xffff) this.#curParam = 0xffff; // clamp, matches xterm
  }

  /** Finalize the current parameter and open a new one after a separator. */
  #nextParam(isColon: boolean): void {
    if (this.#overflow) return;
    if (this.#params.length >= MAX_PARAMS) {
      this.#overflow = true;
      return;
    }
    this.#params.push(this.#hasDigits ? this.#curParam : 0);
    this.#colon.push(this.#curColon);
    this.#curParam = 0;
    this.#hasDigits = false;
    this.#curColon = isColon;
  }

  /** Finalize the trailing parameter at dispatch time. */
  #commitParam(): void {
    if (this.#overflow) return;
    // Push the final parameter unless the whole sequence was empty (e.g. `CSI m`).
    if (this.#hasDigits || this.#params.length > 0) {
      if (this.#params.length >= MAX_PARAMS) {
        this.#overflow = true;
        return;
      }
      this.#params.push(this.#hasDigits ? this.#curParam : 0);
      this.#colon.push(this.#curColon);
    }
  }

  #clear(): void {
    this.#params = [];
    this.#colon = [];
    this.#curParam = 0;
    this.#hasDigits = false;
    this.#curColon = false;
    this.#intermediates = "";
    this.#prefix = "";
    this.#overflow = false;
  }
}
