import { describe, expect, test } from "bun:test";
import { Terminal } from "bun-vt";
import { encodeCell, serializeGrid } from "webterm";

describe("encode", () => {
  test("a blank default cell serializes to 0", () => {
    using term = new Terminal({ cols: 4, rows: 1 });
    expect(encodeCell(term.cell(0, 0))).toBe(0);
  });

  test("a plain character serializes to just { t }", () => {
    using term = new Terminal({ cols: 4, rows: 1 });
    term.write("A");
    expect(encodeCell(term.cell(0, 0))).toEqual({ t: "A" });
  });

  test("a spaced-out styled cell keeps styling but omits t", () => {
    using term = new Terminal({ cols: 4, rows: 1 });
    // Red background, then a space: draws nothing but has a non-default bg.
    term.write("\x1b[41m \x1b[0m");
    const cell = encodeCell(term.cell(0, 0)) as Record<string, unknown>;
    expect(cell.t).toBeUndefined();
    expect(cell.b).toBe(1); // palette index 1 = red
  });

  test("foreground color maps to a palette index", () => {
    using term = new Terminal({ cols: 4, rows: 1 });
    term.write("\x1b[31mZ");
    const cell = encodeCell(term.cell(0, 0)) as Record<string, unknown>;
    expect(cell.t).toBe("Z");
    expect(cell.f).toBe(1);
  });

  test("bold sets the ATTR.bold bit", () => {
    using term = new Terminal({ cols: 4, rows: 1 });
    term.write("\x1b[1mB");
    const cell = encodeCell(term.cell(0, 0)) as Record<string, unknown>;
    expect(cell.a).toBe(1);
  });

  test("serializeGrid returns a full rows×cols snapshot", () => {
    using term = new Terminal({ cols: 3, rows: 2 });
    term.write("hi");
    const grid = serializeGrid(term);
    expect(grid.type).toBe("grid");
    expect(grid.cols).toBe(3);
    expect(grid.rows).toBe(2);
    expect(grid.cells.length).toBe(2);
    expect(grid.cells[0]!.length).toBe(3);
    expect(grid.cells[0]![0]).toEqual({ t: "h" });
    expect(grid.cells[0]![1]).toEqual({ t: "i" });
    expect(grid.cells[0]![2]).toBe(0);
  });
});
