/**
 * test/terminal.test.ts
 *
 * Run with:  bun test
 * (Build the native lib first:  bun run scripts/build.ts)
 */

import { test, expect, describe } from "bun:test";
import { Terminal } from "../src/index";

describe("acceptance criteria", () => {
  test('fresh 24x80: "\\x1b[31mhi" → red "hi" at (0,0)/(0,1), cursor at col 2', () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    try {
      term.write("\x1b[31mhi");

      const a = term.cell(0, 0);
      const b = term.cell(0, 1);

      expect(a.char).toBe("h");
      expect(a.codepoint).toBe(0x68); // 'h'
      expect(b.char).toBe("i");
      expect(b.codepoint).toBe(0x69); // 'i'

      // Both have red foreground. SGR 31 sets the foreground to ANSI palette
      // index 1, which is red (GHOSTTY_COLOR_NAMED_RED == 1).
      expect(a.fg).toEqual({ type: "palette", index: 1 });
      expect(b.fg).toEqual({ type: "palette", index: 1 });

      // Cursor advanced to column 2 (after printing 2 chars on row 0).
      const cur = term.cursor();
      expect(cur.x).toBe(2);
      expect(cur.y).toBe(0);
    } finally {
      term.free();
    }
  });

  test("cursor-move + overwrite reflects correctly in the grid", () => {
    using term = new Terminal({ cols: 80, rows: 24 });

    term.write("AAAAA");
    expect(term.rowText(0)).toBe("AAAAA");

    // CUP to row 1, col 3 (1-based) == grid (row 0, col 2), overwrite with "XY".
    term.write("\x1b[1;3H");
    term.write("XY");

    expect(term.cell(0, 0).char).toBe("A");
    expect(term.cell(0, 1).char).toBe("A");
    expect(term.cell(0, 2).char).toBe("X"); // overwritten
    expect(term.cell(0, 3).char).toBe("Y"); // overwritten
    expect(term.cell(0, 4).char).toBe("A");
    expect(term.rowText(0)).toBe("AAXYA");

    // Absolute cursor move lands where expected.
    term.write("\x1b[5;10H");
    const cur = term.cursor();
    expect(cur.y).toBe(4); // row 5 (1-based) → 4
    expect(cur.x).toBe(9); // col 10 (1-based) → 9
  });

  test("no leaks / no dangling reads across repeated create/feed/free cycles", () => {
    Bun.gc(true);
    const before = process.memoryUsage().rss;

    const CYCLES = 5000;
    for (let n = 0; n < CYCLES; n++) {
      const t = new Terminal({ cols: 80, rows: 24 });
      t.write("\x1b[31mhi\x1b[0m world");
      // Read cells back each cycle (exercises grid_ref snapshot → fully decoded
      // before free, so no read of freed C memory).
      expect(t.cell(0, 0).char).toBe("h");
      expect(t.cell(0, 3).char).toBe("w"); // "hi world" → col 3 is 'w'
      t.free();

      // Every method must throw after free (no dangling handle use).
      expect(() => t.cell(0, 0)).toThrow();
      expect(() => t.write("x")).toThrow();
      // free() is idempotent.
      t.free();
    }

    Bun.gc(true);
    const after = process.memoryUsage().rss;
    const growthMB = (after - before) / (1024 * 1024);
    // If handles leaked, 5000 terminals (each with scrollback buffers) would
    // balloon RSS by hundreds of MB. Allow generous slack for allocator noise.
    expect(growthMB).toBeLessThan(50);
  });
});

describe("api behaviour", () => {
  test("true-color (RGB) foreground is decoded", () => {
    using term = new Terminal({ cols: 20, rows: 5 });
    // SGR 38;2;r;g;b sets RGB foreground.
    term.write("\x1b[38;2;10;20;30mZ");
    expect(term.cell(0, 0).fg).toEqual({ type: "rgb", r: 10, g: 20, b: 30 });
  });

  test("style flags: bold + underline", () => {
    using term = new Terminal({ cols: 20, rows: 5 });
    term.write("\x1b[1;4mB"); // bold + single underline
    const c = term.cell(0, 0);
    expect(c.style.bold).toBe(true);
    expect(c.style.underline).toBe("single");
    expect(c.style.italic).toBe(false);
  });

  test("empty cell reads as blank with default colors", () => {
    using term = new Terminal({ cols: 20, rows: 5 });
    const c = term.cell(2, 10);
    expect(c.char).toBe("");
    expect(c.codepoint).toBe(0);
    expect(c.hasText).toBe(false);
    expect(c.fg).toEqual({ type: "default" });
  });

  test("resize changes dimensions and preserves content", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.write("hello");
    expect(term.cols).toBe(80);

    term.resize(100, 30);
    expect(term.cols).toBe(100);
    expect(term.rows).toBe(30);
    // Content on row 0 survives a widen.
    expect(term.rowText(0)).toBe("hello");
  });

  test("accepts raw byte buffers as well as strings", () => {
    using term = new Terminal({ cols: 20, rows: 5 });
    term.write(new Uint8Array([0x41, 0x42, 0x43])); // "ABC"
    expect(term.rowText(0)).toBe("ABC");
  });

  test("newline / carriage return move the cursor between rows", () => {
    using term = new Terminal({ cols: 20, rows: 5 });
    term.write("ab\r\ncd");
    expect(term.rowText(0)).toBe("ab");
    expect(term.rowText(1)).toBe("cd");
    const cur = term.cursor();
    expect(cur.y).toBe(1);
    expect(cur.x).toBe(2);
  });

  test("out-of-bounds cell read throws", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    expect(() => term.cell(999, 999)).toThrow(RangeError);
  });

  test("invalid constructor args throw", () => {
    expect(() => new Terminal({ cols: 0, rows: 24 })).toThrow(RangeError);
    expect(() => new Terminal({ cols: 80, rows: -1 })).toThrow(RangeError);
  });
});
