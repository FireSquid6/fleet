/**
 * test/modes.test.ts — DEC private modes: autowrap, origin, cursor visibility,
 * alternate screen; plus RIS reset.
 */

import { test, expect, describe } from "bun:test";
import { Terminal } from "../src/index";

describe("autowrap (DECAWM, mode 7)", () => {
  test("printing past the last column wraps to the next row", () => {
    const t = new Terminal({ cols: 5, rows: 3 });
    t.write("ABCDE");
    expect(t.cursor()).toMatchObject({ x: 4, y: 0, pendingWrap: true });
    t.write("F");
    expect(t.rowText(0)).toBe("ABCDE");
    expect(t.rowText(1)).toBe("F");
    expect(t.cursor()).toMatchObject({ x: 1, y: 1, pendingWrap: false });
  });

  test("with autowrap off, the last column is overwritten", () => {
    const t = new Terminal({ cols: 5, rows: 3 });
    t.write("\x1b[?7l");
    t.write("ABCDEFG");
    expect(t.rowText(0)).toBe("ABCDG");
    expect(t.cursor()).toMatchObject({ x: 4, y: 0 });
    expect(t.rowText(1)).toBe("");
  });
});

describe("origin mode (DECOM, mode 6)", () => {
  test("CUP is relative to the scroll region and clamps to it", () => {
    const t = new Terminal({ cols: 10, rows: 6 });
    t.write("\x1b[2;4r"); // region rows 2..4 → indices 1..3
    t.write("\x1b[?6h"); // origin mode on (homes to region top)
    expect(t.cursor().y).toBe(1);

    t.write("\x1b[2;1HX"); // row 2 within region → index 2
    expect(t.cell(2, 0).char).toBe("X");

    t.write("\x1b[99;1H"); // clamp to region bottom
    expect(t.cursor().y).toBe(3);
  });
});

describe("cursor visibility (DECTCEM, mode 25)", () => {
  test("?25l hides and ?25h shows", () => {
    const t = new Terminal({ cols: 10, rows: 3 });
    expect(t.cursor().visible).toBe(true);
    t.write("\x1b[?25l");
    expect(t.cursor().visible).toBe(false);
    t.write("\x1b[?25h");
    expect(t.cursor().visible).toBe(true);
  });
});

describe("alternate screen (mode 1049)", () => {
  test("switches to a cleared alt buffer and restores the primary", () => {
    const t = new Terminal({ cols: 10, rows: 3 });
    t.write("primary");
    expect(t.rowText(0)).toBe("primary");

    t.write("\x1b[?1049h");
    expect(t.rowText(0)).toBe(""); // alt buffer starts blank
    expect(t.cursor()).toMatchObject({ x: 0, y: 0 });
    t.write("altbuf");
    expect(t.rowText(0)).toBe("altbuf");

    t.write("\x1b[?1049l");
    expect(t.rowText(0)).toBe("primary"); // primary content preserved
    expect(t.cursor().x).toBe(7); // cursor restored to end of "primary"
  });
});

describe("RIS (ESC c)", () => {
  test("full reset clears content and homes the cursor, keeping dimensions", () => {
    const t = new Terminal({ cols: 10, rows: 3 });
    t.write("\x1b[31mhello\r\nworld\x1b[?25l");
    t.write("\x1bc");
    expect(t.rowText(0)).toBe("");
    expect(t.rowText(1)).toBe("");
    expect(t.cursor()).toMatchObject({ x: 0, y: 0, visible: true });
    expect(t.cols).toBe(10);
    expect(t.rows).toBe(3);
    // Pen was reset too: subsequent text is default-colored.
    t.write("Z");
    expect(t.cell(0, 0).fg).toEqual({ type: "default" });
  });
});
