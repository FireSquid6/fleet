import { ATTR, type GridMsg, type WireCell, type WireColor } from "webterm/protocol";

const ESC = "\x1b[";

/** SGR parameters for a foreground (`38`) or background (`48`) color. */
function colorParams(color: WireColor | undefined, base: 38 | 48): string {
  const def = base === 38 ? "39" : "49";
  if (color === undefined) return def;
  if (typeof color === "number") return `${base};5;${color}`;
  return `${base};2;${color[0]};${color[1]};${color[2]}`;
}

function cellSgr(cell: Exclude<WireCell, 0>): string {
  const params: string[] = ["0"];
  const attrs = cell.a ?? 0;

  if (attrs & ATTR.bold) params.push("1");
  if (attrs & ATTR.faint) params.push("2");
  if (attrs & ATTR.italic) params.push("3");
  if (cell.u) params.push("4");
  if (attrs & ATTR.blink) params.push("5");
  if (attrs & ATTR.inverse) params.push("7");
  if (attrs & ATTR.invisible) params.push("8");
  if (attrs & ATTR.strikethrough) params.push("9");
  if (attrs & ATTR.overline) params.push("53");

  params.push(colorParams(cell.f, 38));
  params.push(colorParams(cell.b, 48));

  return `${ESC}${params.join(";")}m`;
}

/** DECSCUSR parameter for a cursor shape (`ESC[{n} q`). Steady variants. */
function cursorShapeSeq(shape: GridMsg["cursor"]["shape"]): string {
  switch (shape) {
    case "underline":
      return `${ESC}4 q`;
    case "bar":
      return `${ESC}6 q`;
    default:
      return `${ESC}2 q`;
  }
}

/**
 * Repaints every row from the home position (`ESC[H`) using clear-to-EOL
 * (`ESC[K`) rather than a full-screen clear, which avoids flicker. Each
 * `GridMsg` is a complete snapshot, so a full repaint is always correct.
 */
export function renderGrid(grid: GridMsg): string {
  let out = `${ESC}?25l${ESC}H`; // hide cursor while painting, home

  for (let r = 0; r < grid.rows; r++) {
    const row = grid.cells[r] ?? [];
    for (let c = 0; c < grid.cols; c++) {
      const cell = row[c];
      if (cell === 0 || cell === undefined) {
        out += `${ESC}0m `;
        continue;
      }
      // A wide glyph occupies two columns: the trailing spacer cell (w=2/3)
      // carries no character. Emit nothing for it so the real cursor stays
      // aligned — the wide glyph before it already advanced two columns.
      if (cell.w === 2 || cell.w === 3) continue;
      out += cellSgr(cell) + (cell.t ?? " ");
    }
    out += `${ESC}0m${ESC}K`;
    if (r < grid.rows - 1) out += "\r\n";
  }

  const { cursor } = grid;
  out += `${ESC}${cursor.y + 1};${cursor.x + 1}H`;
  if (cursor.visible) {
    out += cursorShapeSeq(cursor.shape) + `${ESC}?25h`;
  }
  return out;
}
