/**
 * encode.ts — turn a bun-vt `Terminal`'s current grid into a `GridMsg`
 * snapshot, using the compact per-cell encoding from `protocol.ts`.
 */

import type { Cell, CellStyle, Color, Terminal } from "bun-vt";
import {
  ATTR,
  UNDERLINE,
  WIDTH,
  type GridMsg,
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

/** Serialize the terminal's whole active screen into a `GridMsg`. */
export function serializeGrid(term: Terminal): GridMsg {
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
  return {
    type: "grid",
    cols,
    rows,
    cursor: { x: cursor.x, y: cursor.y, visible: cursor.visible },
    cells,
  };
}
