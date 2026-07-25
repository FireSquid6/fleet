import { test, expect } from "bun:test";
import { ATTR, type GridMsg, type WireCell } from "webterm/protocol";
import { renderGrid } from "../src/render-grid";

function grid(cells: WireCell[][], cursor?: Partial<GridMsg["cursor"]>): GridMsg {
  return {
    type: "grid",
    rows: cells.length,
    cols: cells[0]?.length ?? 0,
    cursor: { x: 0, y: 0, visible: true, ...cursor },
    cells,
  };
}

test("blank cells render as spaces with reset SGR", () => {
  const out = renderGrid(grid([[0, 0]]));
  expect(out).toContain("\x1b[0m ");
  // hides cursor while painting, homes, then clears to EOL per row
  expect(out.startsWith("\x1b[?25l\x1b[H")).toBe(true);
  expect(out).toContain("\x1b[0m\x1b[K");
});

test("palette and rgb colors become 256/truecolor SGR", () => {
  const out = renderGrid(grid([[{ t: "x", f: 4, b: [10, 20, 30] }]]));
  expect(out).toContain("38;5;4");
  expect(out).toContain("48;2;10;20;30");
  expect(out).toContain("x");
});

test("attributes and underline map to SGR params", () => {
  const out = renderGrid(grid([[{ t: "A", a: ATTR.bold | ATTR.inverse, u: 1 }]]));
  const sgr = out.slice(out.indexOf("\x1b[0"), out.indexOf("A"));
  expect(sgr).toContain("1"); // bold
  expect(sgr).toContain("7"); // inverse
  expect(sgr).toContain("4"); // underline
});

test("wide-char spacer cell emits nothing", () => {
  // A wide glyph followed by its trailing spacer (w=2).
  const out = renderGrid(grid([[{ t: "世", w: 1 }, { w: 2 }]]));
  expect(out).toContain("世");
  // Only one printable content position; the row still clears to EOL.
  expect(out).toContain("\x1b[0m\x1b[K");
});

test("cursor is positioned (1-based) and shown when visible", () => {
  const out = renderGrid(grid([[0, 0], [0, 0]], { x: 1, y: 1, visible: true, shape: "bar" }));
  expect(out).toContain("\x1b[2;2H"); // row 2, col 2
  expect(out).toContain("\x1b[6 q"); // bar cursor shape
  expect(out).toContain("\x1b[?25h"); // shown
});

test("hidden cursor stays hidden", () => {
  const out = renderGrid(grid([[0]], { visible: false }));
  expect(out).not.toContain("\x1b[?25h");
});
