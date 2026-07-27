/**
 * keys.ts — encode a browser keydown into the raw bytes a PTY expects, matching
 * xterm's default (non-application) keymap. Returned bytes go out as a webterm
 * `InputMsg`; `null` means "not ours — let the browser handle it".
 *
 * Modifiers on navigation/editing keys use xterm's parameterized CSI form:
 * `CSI 1 ; <mod> <letter>` for arrows/Home/End and `CSI <n> ; <mod> ~` for the
 * tilde keys, where `<mod> = 1 + Shift(1) + Alt(2) + Ctrl(4)`. Shift-Tab is the
 * back-tab (CBT) sequence `CSI Z`, which apps like Claude Code read to cycle
 * modes — without it, Shift-Tab would collapse to a plain Tab.
 *
 * The clipboard chords are deliberately *not* encoded. Returning `null` is what
 * lets the caller skip `preventDefault`, so the browser still handles the chord
 * itself. For `Ctrl+Shift+V` (and `Cmd+V`, which falls out of the blanket meta
 * bail-out) that means a native `paste` event fires and the clipboard reaches the
 * PTY as a `PasteMsg`, bracketed by the server, instead of as a run of keystrokes.
 * `Ctrl+Shift+C` is excluded for a blunter reason: the control-byte branch below
 * would encode it as `\x03`, so the copy chord would send SIGINT and interrupt
 * whatever the pane is running — no terminal maps it that way. Both cases must
 * therefore sit ahead of that branch.
 *
 * The unshifted forms are unaffected: plain `Ctrl+V` (`\x16`, literal-next) and
 * `Ctrl+C` (`\x03`, SIGINT) are real terminal control bytes and not the chords.
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
  readonly shiftKey: boolean;
}

/** Navigation keys whose CSI form ends in a letter (base row 1). */
const CSI_LETTER: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};

/** Editing keys whose CSI form is `<code> ~`. */
const CSI_TILDE: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
};

/**
 * Fixed-byte keys with no modifier-parameterized form in xterm's default keymap;
 * Alt meta-prefixes them with ESC. (Shift-Tab is special-cased in `encodeKeyEvent`.)
 */
const SIMPLE: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Escape: "\x1b",
  Tab: "\t",
};

/** Keys that form a clipboard chord with Ctrl+Shift, left to the browser. */
const CLIPBOARD_CHORD_KEYS = new Set(["V", "C"]);

/** xterm modifier code: 1 + Shift(1) + Alt(2) + Ctrl(4). Meta never reaches here. */
function modCode(e: KeyEventLike): number {
  return 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
}

export function encodeKeyEvent(e: KeyEventLike): string | null {
  // Leave Cmd/Win shortcuts (copy, paste, tab switching…) to the browser.
  if (e.metaKey) return null;

  // Back-tab (CBT). Checked before the plain-Tab byte below, which ignores Shift.
  if (e.key === "Tab" && e.shiftKey) return "\x1b[Z";

  // `key` is the shifted character, so these are "V"/"C" in practice; matched
  // case-insensitively because CapsLock inverts them.
  if (e.ctrlKey && e.shiftKey && CLIPBOARD_CHORD_KEYS.has(e.key.toUpperCase())) return null;

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

  const mod = modCode(e);

  const letter = CSI_LETTER[e.key];
  if (letter) return mod === 1 ? "\x1b[" + letter : "\x1b[1;" + mod + letter;

  const code = CSI_TILDE[e.key];
  if (code !== undefined) return mod === 1 ? "\x1b[" + code + "~" : "\x1b[" + code + ";" + mod + "~";

  const simple = SIMPLE[e.key];
  if (simple) return e.altKey ? "\x1b" + simple : simple;

  // Printable single character; Alt sends it as a meta-prefixed (ESC-led) key.
  if (e.key.length === 1) return e.altKey ? "\x1b" + e.key : e.key;

  // Modifiers alone (Shift, CapsLock…), F-keys, and anything unmapped: no-op.
  return null;
}
