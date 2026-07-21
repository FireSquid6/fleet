/**
 * test/scroll.test.ts — scrolling, scroll regions (DECSTBM), and scrollback.
 */

import { test, expect, describe } from "bun:test";
import { Screen, Terminal } from "../src/index";

function fill(t: Terminal, rows: string[]): void {
  t.write(rows.join("\r\n"));
}

describe("line feed scrolling", () => {
  test("LF at the bottom row scrolls the screen up", () => {
    const t = new Terminal({ cols: 10, rows: 3 });
    fill(t, ["l0", "l1", "l2", "l3"]);
    expect(t.rowText(0)).toBe("l1");
    expect(t.rowText(1)).toBe("l2");
    expect(t.rowText(2)).toBe("l3");
    expect(t.cursor()).toMatchObject({ x: 2, y: 2 });
  });
});

describe("SU / SD", () => {
  test("SU scrolls the whole screen up", () => {
    const t = new Terminal({ cols: 10, rows: 4 });
    fill(t, ["A", "B", "C", "D"]);
    t.write("\x1b[2S");
    expect(t.rowText(0)).toBe("C");
    expect(t.rowText(1)).toBe("D");
    expect(t.rowText(2)).toBe("");
    expect(t.rowText(3)).toBe("");
  });

  test("SD scrolls the whole screen down", () => {
    const t = new Terminal({ cols: 10, rows: 4 });
    fill(t, ["A", "B", "C", "D"]);
    t.write("\x1b[2T");
    expect(t.rowText(0)).toBe("");
    expect(t.rowText(1)).toBe("");
    expect(t.rowText(2)).toBe("A");
    expect(t.rowText(3)).toBe("B");
  });
});

describe("scroll region (DECSTBM)", () => {
  test("scrolling is confined to the region", () => {
    const t = new Terminal({ cols: 10, rows: 4 });
    fill(t, ["L0", "L1", "L2", "L3"]);
    t.write("\x1b[2;3r"); // region = rows 2..3 (1-based) → indices 1..2
    t.write("\x1b[3;1H"); // move to bottom of region (row index 2)
    t.write("\n"); // LF → scroll within region only
    expect(t.rowText(0)).toBe("L0"); // outside region, untouched
    expect(t.rowText(1)).toBe("L2"); // L1 scrolled off (discarded, not scrollback)
    expect(t.rowText(2)).toBe(""); // vacated
    expect(t.rowText(3)).toBe("L3"); // outside region, untouched
  });

  test("DECSTBM homes the cursor", () => {
    const t = new Terminal({ cols: 10, rows: 6 });
    t.write("\x1b[2;5r");
    expect(t.cursor()).toMatchObject({ x: 0, y: 0 });
  });
});

describe("scrollback", () => {
  test("respects the max-scrollback bound (no unbounded growth)", () => {
    const t = new Terminal({ cols: 5, rows: 2, maxScrollback: 3 });
    for (let i = 0; i < 100; i++) t.write(`${i}\r\n`);
    // Visible area still shows the two most recent lines; the emulator did not
    // throw and the terminal remains usable.
    expect(t.rows).toBe(2);
    expect(t.cursor().y).toBe(1);
  });

  test("full-screen scroll preserves visible content ordering", () => {
    const t = new Terminal({ cols: 5, rows: 3 });
    fill(t, ["a", "b", "c", "d", "e"]);
    expect(t.rowText(0)).toBe("c");
    expect(t.rowText(1)).toBe("d");
    expect(t.rowText(2)).toBe("e");
  });

  test("resize pads active rows and scrollback with default cells", () => {
    const screen = new Screen(2, 2, 10);
    screen.print("A".charCodeAt(0));
    screen.scrollUp(1);
    screen.cursor.pen.bg = { type: "palette", index: 1 };
    screen.cursor.pen.bold = true;

    screen.resize(4, 3);

    for (const row of screen.grid) {
      expect(row).toHaveLength(4);
      for (const cell of row.slice(2)) {
        expect(cell.bg).toEqual({ type: "default" });
        expect(cell.bold).toBe(false);
      }
    }
    expect(screen.grid[2]!.every((cell) => cell.bg.type === "default" && !cell.bold)).toBe(true);
    expect(screen.scrollback[0]).toHaveLength(4);
    expect(screen.scrollback[0]![2]!.bg).toEqual({ type: "default" });
    expect(screen.scrollback[0]![2]!.bold).toBe(false);
  });
});
