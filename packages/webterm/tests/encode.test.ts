import { describe, expect, test } from "bun:test";
import { Terminal } from "bun-vt";
import { applyPatch, diffGrid, encodeCell, serializeGrid } from "webterm";
import type { GridMsg, WireCell } from "webterm";

function grid(cells: WireCell[][], seq = 0): GridMsg {
  return {
    type: "grid",
    seq,
    cols: cells[0]?.length ?? 0,
    rows: cells.length,
    cursor: { x: 0, y: 0, visible: true },
    cells,
  };
}

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

  test("serializeGrid includes cursor appearance", () => {
    using term = new Terminal({ cols: 3, rows: 2 });
    term.write("\x1b[6 q\x1b]12;#123456\x07");
    expect(serializeGrid(term).cursor).toEqual({
      x: 0,
      y: 0,
      visible: true,
      shape: "bar",
      blinking: false,
      color: [0x12, 0x34, 0x56],
    });
  });

  test("serializeGrid omits the default cursor color", () => {
    using term = new Terminal({ cols: 3, rows: 2 });
    const cursor = serializeGrid(term).cursor;
    expect(cursor).toEqual({
      x: 0,
      y: 0,
      visible: true,
      shape: "block",
      blinking: true,
    });
    expect("color" in cursor).toBe(false);
  });
});

describe("diffGrid", () => {
  test("an unchanged grid produces no runs", () => {
    expect(diffGrid(grid([[0, { t: "a" }, 0]]), grid([[0, { t: "a" }, 0]]))).toEqual([]);
  });

  test("one changed cell produces one single-cell run", () => {
    expect(diffGrid(grid([[0, 0, 0]]), grid([[0, { t: "a" }, 0]]))).toEqual([[0, 1, [{ t: "a" }]]]);
  });

  test("adjacent changes coalesce into one run, separated changes do not", () => {
    expect(diffGrid(grid([[0, 0, 0, 0]]), grid([[{ t: "a" }, { t: "b" }, 0, 0]]))).toEqual([
      [0, 0, [{ t: "a" }, { t: "b" }]],
    ]);
    expect(diffGrid(grid([[0, 0, 0, 0]]), grid([[{ t: "a" }, 0, { t: "b" }, 0]]))).toEqual([
      [0, 0, [{ t: "a" }]],
      [0, 2, [{ t: "b" }]],
    ]);
  });

  test("changes at the first and last column are both reported", () => {
    expect(diffGrid(grid([[{ t: "a" }, 0, { t: "c" }]]), grid([[0, 0, 0]]))).toEqual([
      [0, 0, [0]],
      [0, 2, [0]],
    ]);
  });

  test("runs are reported per row", () => {
    const before = grid([
      [0, 0],
      [0, 0],
    ]);
    const after = grid([
      [0, { t: "a" }],
      [{ t: "b" }, 0],
    ]);
    expect(diffGrid(before, after)).toEqual([
      [0, 1, [{ t: "a" }]],
      [1, 0, [{ t: "b" }]],
    ]);
  });

  test("compares cells structurally rather than by identity", () => {
    expect(diffGrid(grid([[{ f: 1 }]]), grid([[{ f: 1 }]]))).toEqual([]);
    expect(diffGrid(grid([[{ f: [1, 2, 3] }]]), grid([[{ f: [1, 2, 3] }]]))).toEqual([]);
    expect(diffGrid(grid([[{ f: [1, 2, 3] }]]), grid([[{ f: [1, 2, 4] }]]))).toEqual([[0, 0, [{ f: [1, 2, 4] }]]]);
    expect(diffGrid(grid([[{ f: 1 }]]), grid([[{ f: 1, a: 1 }]]))).toEqual([[0, 0, [{ f: 1, a: 1 }]]]);
    expect(diffGrid(grid([[{ f: 1, a: 1 }]]), grid([[{ f: 1 }]]))).toEqual([[0, 0, [{ f: 1 }]]]);
    expect(diffGrid(grid([[0]]), grid([[{}]]))).toEqual([[0, 0, [{}]]]);
  });

  test("throws on a dimension mismatch", () => {
    expect(() => diffGrid(grid([[0, 0]]), grid([[0]]))).toThrow(TypeError);
    expect(() => diffGrid(grid([[0]]), grid([[0], [0]]))).toThrow(TypeError);
  });

  test("a patch of the diff reproduces the next grid exactly", () => {
    const before = grid(
      [
        [0, { t: "a" }, 0],
        [{ t: "b" }, 0, { t: "c" }],
      ],
      1,
    );
    const cases: WireCell[][][] = [
      [
        [0, { t: "a" }, 0],
        [{ t: "b" }, 0, { t: "c" }],
      ],
      [
        [0, { t: "z" }, 0],
        [{ t: "b" }, 0, { t: "c" }],
      ],
      [
        [{ t: "1" }, { t: "2" }, 0],
        [{ t: "b" }, { t: "3" }, { t: "c" }],
      ],
      [
        [{ t: "q", b: [9, 9, 9] }, 0, { t: "w" }],
        [0, { t: "e" }, 0],
      ],
    ];
    for (const cells of cases) {
      const next = grid(cells, 2);
      const patched = applyPatch(before, {
        type: "patch",
        seq: next.seq,
        cols: next.cols,
        rows: next.rows,
        cursor: next.cursor,
        runs: diffGrid(before, next),
      });
      expect(patched).toEqual(next);
    }
  });
});
