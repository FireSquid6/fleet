/**
 * src/screen.ts — the terminal grid and all mutating operations.
 *
 * A `Screen` owns:
 *   - the visible grid (`rows` × `cols` of `Pen` cells),
 *   - the cursor (position, pending-wrap flag, and the active graphic rendition),
 *   - a scroll region (DECSTBM) and tab stops,
 *   - scrollback (lines that scroll off the top of a full-screen scroll),
 *   - a primary/alternate buffer pair (DEC modes 47/1047/1049).
 *
 * Every editing primitive a VT terminal needs lives here as a method; the
 * Terminal handler (terminal.ts) translates parsed escape sequences into these
 * calls. This mirrors the split in libghostty between the parser/stream and
 * `Screen`/`Terminal`.
 *
 * Coordinates are 0-indexed. Erasing uses the current background color (BCE),
 * matching xterm/Ghostty: a blank produced by an erase keeps the pen's `bg`.
 */

import { Pen, Wide } from "./cell";
import { wcwidth } from "./wcwidth";

type Row = Pen[];

export interface Cursor {
  x: number;
  y: number;
  /** Set after writing the last column; the next print wraps first. */
  pendingWrap: boolean;
  /** Active graphic rendition template printed cells copy from. */
  pen: Pen;
}

interface SavedCursor {
  x: number;
  y: number;
  pen: Pen;
  originMode: boolean;
  pendingWrap: boolean;
}

const TAB_WIDTH = 8;

function makeRow(cols: number): Row {
  const row: Row = new Array(cols);
  for (let i = 0; i < cols; i++) row[i] = new Pen();
  return row;
}

export class Screen {
  cols: number;
  rows: number;
  maxScrollback: number;

  grid: Row[];
  scrollback: Row[] = [];

  cursor: Cursor;

  // Scroll region (DECSTBM), inclusive, 0-indexed.
  scrollTop = 0;
  scrollBottom: number;

  // DEC private modes.
  cursorVisible = true;
  autowrap = true;
  originMode = false;
  onAlt = false;

  tabStops: boolean[];

  #saved: SavedCursor | null = null;
  #altGrid: Row[] | null = null;
  #savedForAlt: SavedCursor | null = null;

  constructor(cols: number, rows: number, maxScrollback: number) {
    this.cols = cols;
    this.rows = rows;
    this.maxScrollback = maxScrollback;
    this.grid = Array.from({ length: rows }, () => makeRow(cols));
    this.scrollBottom = rows - 1;
    this.cursor = { x: 0, y: 0, pendingWrap: false, pen: new Pen() };
    this.tabStops = this.#defaultTabStops(cols);
  }

  #defaultTabStops(cols: number): boolean[] {
    const stops = new Array(cols).fill(false);
    for (let i = TAB_WIDTH; i < cols; i += TAB_WIDTH) stops[i] = true;
    return stops;
  }

  // --- cell access --------------------------------------------------------

  /** The cell at (row, col) in the visible area, or null if out of bounds. */
  cellAt(row: number, col: number): Pen | null {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return null;
    return this.grid[row]![col]!;
  }

  #blank(cell: Pen): void {
    cell.reset();
    // Background-color erase: the erased cell keeps the current background.
    cell.bg = this.cursor.pen.bg;
  }

  #blankRow(cols = this.cols): Row {
    const row = makeRow(cols);
    for (const c of row) this.#blank(c);
    return row;
  }

  // --- printing -----------------------------------------------------------

  print(cp: number): void {
    const w = wcwidth(cp);

    // Zero-width (combining) characters attach to the previous cell without
    // moving the cursor. Our cell model stores a single scalar, so we keep the
    // base character and drop the combining mark's own placement.
    if (w === 0) return;

    if (this.cursor.pendingWrap && this.autowrap) {
      this.cursor.x = 0;
      this.#index();
      this.cursor.pendingWrap = false;
    }

    // A wide glyph that cannot fit in the last column wraps (or is dropped when
    // autowrap is off).
    if (w === 2 && this.cursor.x === this.cols - 1) {
      if (this.autowrap) {
        this.cursor.x = 0;
        this.#index();
      } else {
        return;
      }
    }

    const row = this.grid[this.cursor.y]!;
    const cell = row[this.cursor.x]!;

    // If we overwrite the head of an existing wide pair, clear its orphaned tail.
    this.#clearWideNeighbors(row, this.cursor.x);

    cell.copyAttributesFrom(this.cursor.pen);
    cell.cp = cp;
    cell.wide = w === 2 ? Wide.WIDE : Wide.NARROW;

    if (w === 2) {
      const tail = row[this.cursor.x + 1]!;
      this.#clearWideNeighbors(row, this.cursor.x + 1);
      tail.copyAttributesFrom(this.cursor.pen);
      tail.cp = 0;
      tail.wide = Wide.SPACER_TAIL;
    }

    const newX = this.cursor.x + w;
    if (newX >= this.cols) {
      this.cursor.x = this.cols - 1;
      this.cursor.pendingWrap = this.autowrap;
    } else {
      this.cursor.x = newX;
      this.cursor.pendingWrap = false;
    }
  }

  /** When overwriting one half of a wide pair, blank the now-orphaned other half. */
  #clearWideNeighbors(row: Row, x: number): void {
    const cell = row[x]!;
    if (cell.wide === Wide.WIDE) {
      const tail = row[x + 1];
      if (tail && tail.wide === Wide.SPACER_TAIL) this.#blank(tail);
    } else if (cell.wide === Wide.SPACER_TAIL) {
      const head = row[x - 1];
      if (head && head.wide === Wide.WIDE) this.#blank(head);
    }
  }

  // --- cursor movement ----------------------------------------------------

  #index(): void {
    // Line feed within the scroll region.
    if (this.cursor.y === this.scrollBottom) {
      this.scrollUp(1);
    } else if (this.cursor.y < this.rows - 1) {
      this.cursor.y++;
    }
  }

  lineFeed(): void {
    this.#index();
    this.cursor.pendingWrap = false;
  }

  reverseIndex(): void {
    if (this.cursor.y === this.scrollTop) {
      this.scrollDown(1);
    } else if (this.cursor.y > 0) {
      this.cursor.y--;
    }
    this.cursor.pendingWrap = false;
  }

  carriageReturn(): void {
    this.cursor.x = 0;
    this.cursor.pendingWrap = false;
  }

  nextLine(): void {
    this.carriageReturn();
    this.lineFeed();
  }

  backspace(): void {
    if (this.cursor.x > 0) this.cursor.x--;
    this.cursor.pendingWrap = false;
  }

  cursorUp(n: number): void {
    // Stops at the top margin when the cursor is already within the region.
    const limit = this.cursor.y >= this.scrollTop ? this.scrollTop : 0;
    this.cursor.y = Math.max(limit, this.cursor.y - n);
    this.cursor.pendingWrap = false;
  }

  cursorDown(n: number): void {
    const limit = this.cursor.y <= this.scrollBottom ? this.scrollBottom : this.rows - 1;
    this.cursor.y = Math.min(limit, this.cursor.y + n);
    this.cursor.pendingWrap = false;
  }

  cursorLeft(n: number): void {
    this.cursor.x = Math.max(0, this.cursor.x - n);
    this.cursor.pendingWrap = false;
  }

  cursorRight(n: number): void {
    this.cursor.x = Math.min(this.cols - 1, this.cursor.x + n);
    this.cursor.pendingWrap = false;
  }

  setCursorCol(x: number): void {
    this.cursor.x = Math.min(this.cols - 1, Math.max(0, x));
    this.cursor.pendingWrap = false;
  }

  setCursorRow(y: number): void {
    this.cursor.y = this.#clampRow(y);
    this.cursor.pendingWrap = false;
  }

  /** DEC/absolute cursor position. Coordinates already 0-indexed. */
  setCursor(x: number, y: number): void {
    if (this.originMode) {
      y = this.scrollTop + y;
      this.cursor.y = Math.min(this.scrollBottom, Math.max(this.scrollTop, y));
    } else {
      this.cursor.y = this.#clampRow(y);
    }
    this.cursor.x = Math.min(this.cols - 1, Math.max(0, x));
    this.cursor.pendingWrap = false;
  }

  #clampRow(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, y));
  }

  // --- scrolling ----------------------------------------------------------

  /** Scroll the scroll region up by `n` lines (content moves up). */
  scrollUp(n: number): void {
    const top = this.scrollTop;
    const bottom = this.scrollBottom;
    const count = Math.min(n, bottom - top + 1);
    if (count <= 0) return;

    // Lines leaving the top of a full-height region enter scrollback.
    const intoScrollback = top === 0 && !this.onAlt;
    for (let i = 0; i < count; i++) {
      const leaving = this.grid[top + i]!;
      if (intoScrollback) this.#pushScrollback(leaving);
    }

    // Shift rows up within the region.
    for (let y = top; y <= bottom - count; y++) {
      this.grid[y] = this.grid[y + count]!;
    }
    // Fill the vacated bottom rows with blanks.
    for (let y = bottom - count + 1; y <= bottom; y++) {
      this.grid[y] = this.#blankRow();
    }
  }

  /** Scroll the scroll region down by `n` lines (content moves down). */
  scrollDown(n: number): void {
    const top = this.scrollTop;
    const bottom = this.scrollBottom;
    const count = Math.min(n, bottom - top + 1);
    if (count <= 0) return;

    for (let y = bottom; y >= top + count; y--) {
      this.grid[y] = this.grid[y - count]!;
    }
    for (let y = top; y < top + count; y++) {
      this.grid[y] = this.#blankRow();
    }
  }

  #pushScrollback(row: Row): void {
    if (this.maxScrollback <= 0) return;
    this.scrollback.push(row);
    while (this.scrollback.length > this.maxScrollback) this.scrollback.shift();
  }

  setScrollRegion(top: number, bottom: number): void {
    // Empty/invalid → full screen.
    if (top < 0) top = 0;
    if (bottom <= 0 || bottom > this.rows) bottom = this.rows;
    if (top >= bottom) {
      top = 0;
      bottom = this.rows;
    }
    this.scrollTop = top;
    this.scrollBottom = bottom - 1;
    // DECSTBM homes the cursor (respecting origin mode).
    this.setCursor(0, 0);
  }

  // --- line/char editing --------------------------------------------------

  insertLines(n: number): void {
    if (this.cursor.y < this.scrollTop || this.cursor.y > this.scrollBottom) return;
    const bottom = this.scrollBottom;
    const count = Math.min(n, bottom - this.cursor.y + 1);
    for (let y = bottom; y >= this.cursor.y + count; y--) {
      this.grid[y] = this.grid[y - count]!;
    }
    for (let y = this.cursor.y; y < this.cursor.y + count; y++) {
      this.grid[y] = this.#blankRow();
    }
    this.cursor.x = 0;
    this.cursor.pendingWrap = false;
  }

  deleteLines(n: number): void {
    if (this.cursor.y < this.scrollTop || this.cursor.y > this.scrollBottom) return;
    const bottom = this.scrollBottom;
    const count = Math.min(n, bottom - this.cursor.y + 1);
    for (let y = this.cursor.y; y <= bottom - count; y++) {
      this.grid[y] = this.grid[y + count]!;
    }
    for (let y = bottom - count + 1; y <= bottom; y++) {
      this.grid[y] = this.#blankRow();
    }
    this.cursor.x = 0;
    this.cursor.pendingWrap = false;
  }

  insertChars(n: number): void {
    const row = this.grid[this.cursor.y]!;
    const start = this.cursor.x;
    const count = Math.min(n, this.cols - start);
    for (let x = this.cols - 1; x >= start + count; x--) {
      row[x]!.copyFrom(row[x - count]!);
    }
    for (let x = start; x < start + count; x++) this.#blank(row[x]!);
    this.cursor.pendingWrap = false;
  }

  deleteChars(n: number): void {
    const row = this.grid[this.cursor.y]!;
    const start = this.cursor.x;
    const count = Math.min(n, this.cols - start);
    for (let x = start; x < this.cols - count; x++) {
      row[x]!.copyFrom(row[x + count]!);
    }
    for (let x = this.cols - count; x < this.cols; x++) this.#blank(row[x]!);
    this.cursor.pendingWrap = false;
  }

  eraseChars(n: number): void {
    const row = this.grid[this.cursor.y]!;
    const end = Math.min(this.cols, this.cursor.x + n);
    for (let x = this.cursor.x; x < end; x++) this.#blank(row[x]!);
    this.cursor.pendingWrap = false;
  }

  // --- erasing ------------------------------------------------------------

  eraseLine(mode: number): void {
    const row = this.grid[this.cursor.y]!;
    let from = 0;
    let to = this.cols - 1;
    if (mode === 0) from = this.cursor.x;
    else if (mode === 1) to = this.cursor.x;
    for (let x = from; x <= to; x++) this.#blank(row[x]!);
    this.cursor.pendingWrap = false;
  }

  eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      for (let y = 0; y < this.rows; y++) {
        for (const c of this.grid[y]!) this.#blank(c);
      }
      if (mode === 3) this.scrollback = [];
      this.cursor.pendingWrap = false;
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      for (let y = this.cursor.y + 1; y < this.rows; y++) {
        for (const c of this.grid[y]!) this.#blank(c);
      }
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let y = 0; y < this.cursor.y; y++) {
        for (const c of this.grid[y]!) this.#blank(c);
      }
    }
    this.cursor.pendingWrap = false;
  }

  // --- tabs ---------------------------------------------------------------

  tab(n = 1): void {
    for (let i = 0; i < n; i++) {
      let x = this.cursor.x + 1;
      while (x < this.cols - 1 && !this.tabStops[x]) x++;
      this.cursor.x = Math.min(x, this.cols - 1);
    }
    this.cursor.pendingWrap = false;
  }

  backTab(n = 1): void {
    for (let i = 0; i < n; i++) {
      let x = this.cursor.x - 1;
      while (x > 0 && !this.tabStops[x]) x--;
      this.cursor.x = Math.max(x, 0);
    }
    this.cursor.pendingWrap = false;
  }

  setTabStop(): void {
    if (this.cursor.x < this.cols) this.tabStops[this.cursor.x] = true;
  }

  clearTabStop(mode: number): void {
    if (mode === 3) this.tabStops.fill(false);
    else if (this.cursor.x < this.cols) this.tabStops[this.cursor.x] = false;
  }

  // --- saved cursor (DECSC/DECRC) -----------------------------------------

  saveCursor(): void {
    this.#saved = this.#snapshotCursor();
  }

  restoreCursor(): void {
    this.#applyCursor(this.#saved);
  }

  #snapshotCursor(): SavedCursor {
    const pen = new Pen();
    pen.copyFrom(this.cursor.pen);
    return {
      x: this.cursor.x,
      y: this.cursor.y,
      pen,
      originMode: this.originMode,
      pendingWrap: this.cursor.pendingWrap,
    };
  }

  #applyCursor(s: SavedCursor | null): void {
    if (!s) {
      this.cursor.x = 0;
      this.cursor.y = 0;
      this.cursor.pen.reset();
      this.cursor.pendingWrap = false;
      return;
    }
    this.cursor.x = Math.min(this.cols - 1, s.x);
    this.cursor.y = Math.min(this.rows - 1, s.y);
    this.cursor.pen.copyFrom(s.pen);
    this.originMode = s.originMode;
    this.cursor.pendingWrap = s.pendingWrap;
  }

  // --- alternate screen ---------------------------------------------------

  enterAlt(saveCursor: boolean, clear: boolean): void {
    if (this.onAlt) return;
    if (saveCursor) this.#savedForAlt = this.#snapshotCursor();
    this.#altGrid = Array.from({ length: this.rows }, () => this.#blankRow());
    // Swap the primary grid out; keep it referenced for restoreAlt.
    this.#primaryGrid = this.grid;
    this.grid = this.#altGrid;
    this.onAlt = true;
    if (clear) this.eraseDisplay(2);
    if (saveCursor) {
      this.cursor.x = 0;
      this.cursor.y = 0;
    }
  }

  #primaryGrid: Row[] | null = null;

  leaveAlt(restoreCursor: boolean): void {
    if (!this.onAlt) return;
    this.grid = this.#primaryGrid!;
    this.#primaryGrid = null;
    this.#altGrid = null;
    this.onAlt = false;
    if (restoreCursor) this.#applyCursor(this.#savedForAlt);
    this.#savedForAlt = null;
  }

  // --- reset --------------------------------------------------------------

  reset(): void {
    if (this.onAlt) this.leaveAlt(false);
    this.grid = Array.from({ length: this.rows }, () => makeRow(this.cols));
    this.scrollback = [];
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.cursorVisible = true;
    this.autowrap = true;
    this.originMode = false;
    this.tabStops = this.#defaultTabStops(this.cols);
    this.#saved = null;
    this.cursor.x = 0;
    this.cursor.y = 0;
    this.cursor.pendingWrap = false;
    this.cursor.pen.reset();
  }

  // --- resize -------------------------------------------------------------

  /**
   * Resize the grid to `cols` × `rows`. Rows are padded/truncated in place
   * (no reflow), extra bottom rows are added blank, and surplus rows above are
   * pushed into scrollback so on-screen content near the top is preserved.
   */
  resize(cols: number, rows: number): void {
    if (cols !== this.cols) {
      for (const row of this.grid) this.#resizeRow(row, cols);
      for (const row of this.scrollback) this.#resizeRow(row, cols);
      this.tabStops = this.#defaultTabStops(cols);
      this.cols = cols;
    }

    if (rows !== this.rows) {
      if (rows > this.rows) {
        for (let i = this.rows; i < rows; i++) this.grid.push(makeRow(cols));
      } else {
        // Remove rows from the top (into scrollback) so recent output stays.
        const remove = this.rows - rows;
        for (let i = 0; i < remove; i++) {
          const r = this.grid.shift()!;
          if (!this.onAlt) this.#pushScrollback(r);
        }
        this.cursor.y = Math.max(0, this.cursor.y - remove);
      }
      this.rows = rows;
      this.scrollTop = 0;
      this.scrollBottom = rows - 1;
    }

    this.cursor.x = Math.min(this.cursor.x, cols - 1);
    this.cursor.y = Math.min(this.cursor.y, rows - 1);
    this.cursor.pendingWrap = false;
  }

  #resizeRow(row: Row, cols: number): void {
    if (cols > row.length) {
      while (row.length < cols) {
        const c = new Pen();
        this.#blank(c);
        row.push(c);
      }
    } else if (cols < row.length) {
      row.length = cols;
    }
  }
}
