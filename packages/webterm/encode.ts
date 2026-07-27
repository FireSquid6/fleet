/**
 * encode.ts — turn a bun-vt `Terminal`'s current grid into a `GridMsg`
 * snapshot, using the compact per-cell encoding from `protocol.ts`, and diff
 * two snapshots into the runs of a `PatchMsg`.
 */

import type { Cell, CellStyle, Color, Terminal } from "bun-vt";
import {
  ATTR,
  UNDERLINE,
  WIDTH,
  type GridMsg,
  type PatchRun,
  type WireCell,
  type WireCellObject,
  type WireColor,
} from "./protocol";

function colorToWire(color: Color): WireColor | undefined {
  switch (color.type) {
    case "default":
      return undefined;
    case "palette":
      return color.index;
    case "rgb":
      return [color.r, color.g, color.b];
  }
}

function styleToAttr(style: CellStyle): number {
  let a = 0;
  if (style.bold) a |= ATTR.bold;
  if (style.faint) a |= ATTR.faint;
  if (style.italic) a |= ATTR.italic;
  if (style.blink) a |= ATTR.blink;
  if (style.inverse) a |= ATTR.inverse;
  if (style.invisible) a |= ATTR.invisible;
  if (style.strikethrough) a |= ATTR.strikethrough;
  if (style.overline) a |= ATTR.overline;
  return a;
}

/** Encode one cell to a `WireCell` (the literal `0` for the blank-default case). */
export function encodeCell(cell: Cell): WireCell {
  // A space or empty cell draws no glyph, so `t` is omitted.
  const blankGlyph = cell.char === "" || cell.char === " ";

  const f = colorToWire(cell.fg);
  const b = colorToWire(cell.bg);
  const a = styleToAttr(cell.style);
  const u = (UNDERLINE as readonly string[]).indexOf(cell.style.underline);
  const w = (WIDTH as readonly string[]).indexOf(cell.width);

  // The overwhelmingly common case: blank space, default colors, no styling.
  if (blankGlyph && f === undefined && b === undefined && a === 0 && u <= 0 && w <= 0) {
    return 0;
  }

  const out: { -readonly [K in keyof WireCellObject]: WireCellObject[K] } = {};
  if (!blankGlyph) out.t = cell.char;
  if (f !== undefined) out.f = f;
  if (b !== undefined) out.b = b;
  if (a !== 0) out.a = a;
  if (u > 0) out.u = u;
  if (w > 0) out.w = w;
  return out;
}

/**
 * Serialize the terminal's whole active screen into a `GridMsg`. `seq` is the
 * connection's frame counter, which only the caller streaming the frames knows;
 * a one-off snapshot can leave it at the default.
 */
export function serializeGrid(term: Terminal, seq = 0): GridMsg {
  const rows = term.rows;
  const cols = term.cols;
  const cells: WireCell[][] = new Array(rows);

  for (let r = 0; r < rows; r++) {
    const row: WireCell[] = new Array(cols);
    for (let c = 0; c < cols; c++) {
      row[c] = encodeCell(term.cell(r, c));
    }
    cells[r] = row;
  }

  const cursor = term.cursor();
  const cursorColor = colorToWire(cursor.color);
  return {
    type: "grid",
    seq,
    cols,
    rows,
    cursor: {
      x: cursor.x,
      y: cursor.y,
      visible: cursor.visible,
      shape: cursor.shape,
      blinking: cursor.blinking,
      ...(cursorColor === undefined ? {} : { color: cursorColor }),
    },
    cells,
  };
}

/** Structural color comparison — a palette index only ever equals the same index. */
export function colorsEqual(a: WireColor | undefined, b: WireColor | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || typeof a === "number" || typeof b === "number") return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Structural cell comparison. Deliberately not a `JSON.stringify` comparison:
 * key order is an encoder implementation detail, and this runs over every cell
 * of every frame. The blank literal `0` only ever equals another `0` — the
 * encoder never emits an all-defaults object, so an object is assumed to differ.
 */
function cellsEqual(a: WireCell, b: WireCell): boolean {
  if (a === b) return true;
  if (a === 0 || b === 0) return false;
  return (
    a.t === b.t &&
    a.a === b.a &&
    a.u === b.u &&
    a.w === b.w &&
    colorsEqual(a.f, b.f) &&
    colorsEqual(a.b, b.b)
  );
}

/**
 * Diff two same-sized snapshots into the runs of a `PatchMsg` — empty when
 * nothing changed. Runs rather than per-cell entries because a scroll or a
 * repainted status line changes whole spans at once.
 *
 * Throws on a dimension mismatch; the caller sends a full snapshot instead.
 */
export function diffGrid(prev: GridMsg, next: GridMsg): PatchRun[] {
  if (prev.cols !== next.cols || prev.rows !== next.rows) {
    throw new TypeError("cannot diff grids of different sizes");
  }

  const runs: PatchRun[] = [];
  for (let r = 0; r < next.rows; r++) {
    const before = prev.cells[r]!;
    const after = next.cells[r]!;
    let start = -1;
    for (let c = 0; c < next.cols; c++) {
      if (cellsEqual(before[c]!, after[c]!)) {
        if (start >= 0) {
          runs.push([r, start, after.slice(start, c)]);
          start = -1;
        }
      } else if (start < 0) {
        start = c;
      }
    }
    if (start >= 0) runs.push([r, start, after.slice(start, next.cols)]);
  }
  return runs;
}
