/**
 * src/terminal.ts — the public Terminal API and the parser Handler.
 *
 * `Terminal` owns a `Parser` and a `Screen`. It implements the parser's
 * `Handler` interface, translating parsed VT actions (print / execute / CSI /
 * ESC / OSC) into `Screen` mutations. The public surface intentionally mirrors
 * libghostty-bun's `Terminal` so this pure-TypeScript port is a drop-in
 * replacement — `write`, `cell`, `cursor`, `resize`, `reset`, `rowText`,
 * `cols`, `rows`, and `free`/`Symbol.dispose`.
 */

import { Parser, type CsiSequence, type EscSequence, type Handler } from "./parser";
import { Screen, type CursorShape } from "./screen";
import { applySgr } from "./sgr";
import { Wide, type Cell } from "./cell";
import { DEFAULT_COLOR, rgb, type Color } from "./color";

export type { Cell, CellStyle, CellWidth, UnderlineStyle } from "./cell";
export type { Color } from "./color";
export type { CursorShape } from "./screen";

export interface CursorState {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
  readonly pendingWrap: boolean;
  readonly shape: CursorShape;
  readonly blinking: boolean;
  readonly color: Color;
}

export interface TerminalOptions {
  readonly cols: number;
  readonly rows: number;
  /** Max scrollback lines to retain. Default 1000. */
  readonly maxScrollback?: number;
}

const encoder = new TextEncoder();

function parseOscColor(value: string): Color | null {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
  if (hex) return rgb(Number.parseInt(hex[1]!, 16), Number.parseInt(hex[2]!, 16), Number.parseInt(hex[3]!, 16));

  const x11 = /^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i.exec(value);
  if (!x11) return null;
  const component = (digits: string): number => {
    const max = 16 ** digits.length - 1;
    return Math.round((Number.parseInt(digits, 16) * 255) / max);
  };
  return rgb(component(x11[1]!), component(x11[2]!), component(x11[3]!));
}

// C0 control bytes.
const BEL = 0x07;
const BS = 0x08;
const HT = 0x09;
const LF = 0x0a;
const VT = 0x0b;
const FF = 0x0c;
const CR = 0x0d;
const SO = 0x0e;
const SI = 0x0f;

export class Terminal implements Handler {
  #screen: Screen;
  #parser: Parser;
  #freed = false;

  /** Last window/icon title set via OSC 0/2 (informational). */
  title = "";

  constructor(options: TerminalOptions) {
    const { cols, rows, maxScrollback = 1000 } = options;
    if (!Number.isInteger(cols) || cols <= 0) throw new RangeError(`cols must be a positive integer, got ${cols}`);
    if (!Number.isInteger(rows) || rows <= 0) throw new RangeError(`rows must be a positive integer, got ${rows}`);
    this.#screen = new Screen(cols, rows, maxScrollback);
    this.#parser = new Parser(this);
  }

  #assertAlive(): void {
    if (this.#freed) throw new Error("Terminal has been freed");
  }

  get cols(): number {
    this.#assertAlive();
    return this.#screen.cols;
  }

  get rows(): number {
    this.#assertAlive();
    return this.#screen.rows;
  }

  /** Feed raw VT bytes (or a UTF-8 string). Never throws on malformed input. */
  write(data: string | Uint8Array): void {
    this.#assertAlive();
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    this.#parser.write(bytes);
  }

  resize(cols: number, rows: number, _cellWidthPx = 1, _cellHeightPx = 1): void {
    this.#assertAlive();
    if (!Number.isInteger(cols) || cols <= 0) throw new RangeError(`cols must be a positive integer, got ${cols}`);
    if (!Number.isInteger(rows) || rows <= 0) throw new RangeError(`rows must be a positive integer, got ${rows}`);
    this.#screen.resize(cols, rows);
  }

  /** Full reset (RIS). Dimensions are preserved. */
  reset(): void {
    this.#assertAlive();
    this.#screen.reset();
    this.#parser.reset();
  }

  /** Read the cell at (row, col) in the active area. Throws if out of bounds. */
  cell(row: number, col: number): Cell {
    this.#assertAlive();
    const pen = this.#screen.cellAt(row, col);
    if (!pen) throw new RangeError(`cell(${row}, ${col}) out of bounds`);
    return pen.toCell();
  }

  cursor(): CursorState {
    this.#assertAlive();
    const c = this.#screen.cursor;
    return {
      x: c.x,
      y: c.y,
      visible: this.#screen.cursorVisible,
      pendingWrap: c.pendingWrap,
      shape: this.#screen.cursorShape,
      blinking: this.#screen.cursorBlinking,
      color: this.#screen.cursorColor,
    };
  }

  /** Read a whole row as text (primary codepoints, trailing blanks trimmed). */
  rowText(row: number): string {
    this.#assertAlive();
    if (row < 0 || row >= this.#screen.rows) throw new RangeError(`row ${row} out of bounds`);
    const cells = this.#screen.grid[row]!;
    let out = "";
    for (const cell of cells) {
      if (cell.wide === Wide.SPACER_TAIL) continue;
      out += cell.cp === 0 ? " " : String.fromCodePoint(cell.cp);
    }
    return out.replace(/\s+$/u, "");
  }

  free(): void {
    this.#freed = true;
  }

  [Symbol.dispose](): void {
    this.free();
  }

  // === Handler implementation ===========================================

  print(cp: number): void {
    this.#screen.print(cp);
  }

  execute(c: number): void {
    switch (c) {
      case BEL:
        break;
      case BS:
        this.#screen.backspace();
        break;
      case HT:
        this.#screen.tab();
        break;
      case LF:
      case VT:
      case FF:
        this.#screen.lineFeed();
        break;
      case CR:
        this.#screen.carriageReturn();
        break;
      case SO:
      case SI:
        break; // charset shift-out/in — not modelled
      default:
        break;
    }
  }

  escDispatch(seq: EscSequence): void {
    // Charset designators (ESC ( B, ESC ) 0, …) carry an intermediate; ignore.
    if (seq.intermediates.length > 0) return;
    switch (seq.final) {
      case "D": // IND — index (line feed keeping column)
        this.#screen.lineFeed();
        break;
      case "E": // NEL — next line
        this.#screen.nextLine();
        break;
      case "M": // RI — reverse index
        this.#screen.reverseIndex();
        break;
      case "H": // HTS — set tab stop
        this.#screen.setTabStop();
        break;
      case "7": // DECSC — save cursor
        this.#screen.saveCursor();
        break;
      case "8": // DECRC — restore cursor
        this.#screen.restoreCursor();
        break;
      case "c": // RIS — full reset
        this.#screen.reset();
        this.#parser.reset();
        break;
      default:
        break;
    }
  }

  csiDispatch(seq: CsiSequence): void {
    const p = seq.params;
    const at = (i: number): number => p[i] ?? 0;
    /** Parameter i with a minimum of 1 (the common cursor-move default). */
    const one = (i: number): number => at(i) || 1;

    if (seq.prefix === "?") {
      if (seq.final === "h") this.#setModes(p, true);
      else if (seq.final === "l") this.#setModes(p, false);
      return;
    }
    if (seq.prefix !== "") return; // '<', '=', '>' variants unsupported
    if (seq.intermediates !== "") {
      if (seq.intermediates === " " && seq.final === "q") this.#setCursorStyle(at(0));
      return;
    }

    switch (seq.final) {
      case "A":
        this.#screen.cursorUp(one(0));
        break;
      case "B":
        this.#screen.cursorDown(one(0));
        break;
      case "C":
        this.#screen.cursorRight(one(0));
        break;
      case "D":
        this.#screen.cursorLeft(one(0));
        break;
      case "E":
        this.#screen.carriageReturn();
        this.#screen.cursorDown(one(0));
        break;
      case "F":
        this.#screen.carriageReturn();
        this.#screen.cursorUp(one(0));
        break;
      case "G":
      case "`":
        this.#screen.setCursorCol(one(0) - 1);
        break;
      case "d":
        this.#screen.setCursorRow(one(0) - 1);
        break;
      case "H":
      case "f":
        this.#screen.setCursor(one(1) - 1, one(0) - 1);
        break;
      case "J":
        this.#screen.eraseDisplay(at(0));
        break;
      case "K":
        this.#screen.eraseLine(at(0));
        break;
      case "L":
        this.#screen.insertLines(one(0));
        break;
      case "M":
        this.#screen.deleteLines(one(0));
        break;
      case "P":
        this.#screen.deleteChars(one(0));
        break;
      case "@":
        this.#screen.insertChars(one(0));
        break;
      case "X":
        this.#screen.eraseChars(one(0));
        break;
      case "S":
        this.#screen.scrollUp(one(0));
        break;
      case "T":
        this.#screen.scrollDown(one(0));
        break;
      case "Z":
        this.#screen.backTab(one(0));
        break;
      case "g":
        this.#screen.clearTabStop(at(0));
        break;
      case "r":
        this.#screen.setScrollRegion(one(0) - 1, at(1));
        break;
      case "m":
        applySgr(this.#screen.cursor.pen, seq.params, seq.colon);
        break;
      case "s":
        this.#screen.saveCursor();
        break;
      case "u":
        this.#screen.restoreCursor();
        break;
      default:
        break;
    }
  }

  oscDispatch(data: string): void {
    const sep = data.indexOf(";");
    const code = sep < 0 ? data : data.slice(0, sep);
    if ((code === "0" || code === "2") && sep >= 0) {
      this.title = data.slice(sep + 1);
    } else if (code === "12" && sep >= 0) {
      const color = parseOscColor(data.slice(sep + 1));
      if (color) this.#screen.cursorColor = color;
    } else if (code === "112") {
      this.#screen.cursorColor = DEFAULT_COLOR;
    }
  }

  #setCursorStyle(style: number): void {
    switch (style) {
      case 0:
      case 1:
        this.#screen.cursorShape = "block";
        this.#screen.cursorBlinking = true;
        break;
      case 2:
        this.#screen.cursorShape = "block";
        this.#screen.cursorBlinking = false;
        break;
      case 3:
        this.#screen.cursorShape = "underline";
        this.#screen.cursorBlinking = true;
        break;
      case 4:
        this.#screen.cursorShape = "underline";
        this.#screen.cursorBlinking = false;
        break;
      case 5:
        this.#screen.cursorShape = "bar";
        this.#screen.cursorBlinking = true;
        break;
      case 6:
        this.#screen.cursorShape = "bar";
        this.#screen.cursorBlinking = false;
        break;
    }
  }

  // --- DEC private / ANSI modes ------------------------------------------

  #setModes(params: readonly number[], set: boolean): void {
    for (const mode of params) this.#setMode(mode, set);
  }

  #setMode(mode: number, set: boolean): void {
    const s = this.#screen;
    switch (mode) {
      case 6: // DECOM — origin mode
        s.originMode = set;
        s.setCursor(0, 0);
        break;
      case 7: // DECAWM — autowrap
        s.autowrap = set;
        break;
      case 25: // DECTCEM — cursor visibility
        s.cursorVisible = set;
        break;
      case 47:
      case 1047:
        if (set) s.enterAlt(false, mode === 1047);
        else s.leaveAlt(false);
        break;
      case 1048:
        if (set) s.saveCursor();
        else s.restoreCursor();
        break;
      case 1049:
        if (set) s.enterAlt(true, true);
        else s.leaveAlt(true);
        break;
      default:
        break;
    }
  }
}
