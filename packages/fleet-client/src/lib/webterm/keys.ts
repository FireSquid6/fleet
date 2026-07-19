/**
 * keys.ts — encode a browser keydown into the raw bytes a PTY expects, matching
 * xterm's default (non-application) keymap. Returned bytes go out as a webterm
 * `InputMsg`; `null` means "not ours — let the browser handle it".
 *
 * Known gap: no IME/composition handling (`compositionstart`/`end`), so composed
 * CJK input won't work. Acceptable for an ASCII-dominated agent/ops console.
 */

/** The subset of `KeyboardEvent` this encoder reads. */
export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/** Non-printable keys with a fixed escape sequence. */
const NAMED: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  Delete: "\x1b[3~",
  Insert: "\x1b[2~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
};

export function encodeKeyEvent(e: KeyEventLike): string | null {
  // Leave Cmd/Win shortcuts (copy, paste, tab switching…) to the browser.
  if (e.metaKey) return null;

  if (e.ctrlKey && e.key.length === 1) {
    // Ctrl-Space sends NUL — its key is a literal space, below the range below.
    if (e.key === " ") return "\x00";
    // Ctrl-@ (0x00), Ctrl-A..Z (0x01–0x1a), Ctrl-[ \ ] ^ _ (0x1b–0x1f): the byte
    // is the (upper-cased) character's code minus 0x40.
    const code = e.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
    if (e.key === "?") return "\x7f";
    return null;
  }

  const named = NAMED[e.key];
  if (named) return e.altKey ? "\x1b" + named : named;

  // Printable single character; Alt sends it as a meta-prefixed (ESC-led) key.
  if (e.key.length === 1) return e.altKey ? "\x1b" + e.key : e.key;

  // Modifiers alone (Shift, CapsLock…), F-keys, and anything unmapped: no-op.
  return null;
}
