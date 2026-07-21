/**
 * test/modes.test.ts — DEC private modes: autowrap, origin, cursor visibility,
 * alternate screen; plus RIS reset.
 */

import { test, expect, describe } from "bun:test";
import { Screen, Terminal } from "../src/index";

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

describe("cursor appearance", () => {
  test("DECSCUSR selects shape and blinking", () => {
    const t = new Terminal({ cols: 10, rows: 3 });
    const styles = [
      [0, "block", true],
      [1, "block", true],
      [2, "block", false],
      [3, "underline", true],
      [4, "underline", false],
      [5, "bar", true],
      [6, "bar", false],
    ] as const;

    for (const [value, shape, blinking] of styles) {
      t.write(`\x1b[${value} q`);
      expect(t.cursor()).toMatchObject({ shape, blinking });
    }
  });

  test("empty DECSCUSR uses the default and unsupported values are ignored", () => {
    const t = new Terminal({ cols: 10, rows: 3 });
    t.write("\x1b[4 q");
    t.write("\x1b[99 q");
    expect(t.cursor()).toMatchObject({ shape: "underline", blinking: false });
    t.write("\x1b[ q");
    expect(t.cursor()).toMatchObject({ shape: "block", blinking: true });
  });

  test("OSC 12 sets and OSC 112 resets the cursor color", () => {
    const t = new Terminal({ cols: 10, rows: 3 });
    t.write("\x1b]12;#1a2B3c\x07");
    expect(t.cursor().color).toEqual({ type: "rgb", r: 0x1a, g: 0x2b, b: 0x3c });
    t.write("\x1b]12;rgb:f/80/0000\x1b\\");
    expect(t.cursor().color).toEqual({ type: "rgb", r: 255, g: 128, b: 0 });
    t.write("\x1b]112\x07");
    expect(t.cursor().color).toEqual({ type: "default" });
  });

  test("malformed OSC 12 colors are ignored", () => {
    const t = new Terminal({ cols: 10, rows: 3 });
    t.write("\x1b]12;#123456\x07");
    t.write("\x1b]12;not-a-color\x07");
    expect(t.cursor().color).toEqual({ type: "rgb", r: 0x12, g: 0x34, b: 0x56 });
  });

  test("public reset restores cursor appearance defaults", () => {
    const t = new Terminal({ cols: 10, rows: 3 });
    t.write("\x1b[6 q\x1b]12;#123456\x07");
    t.reset();
    expect(t.cursor()).toMatchObject({ shape: "block", blinking: true, color: { type: "default" } });
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

  test("growing while active resizes and restores the primary grid", () => {
    const t = new Terminal({ cols: 4, rows: 2 });
    t.write("one\x1b[2;4H");
    t.write("\x1b[?1049h\x1b[41malt");

    t.resize(7, 4);
    expect(t.rowText(0)).toBe("alt");
    expect(t.cursor()).toMatchObject({ x: 3, y: 0, pendingWrap: false });
    expect(t.cell(0, 6).bg).toEqual({ type: "default" });
    expect(t.cell(3, 6).bg).toEqual({ type: "default" });
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 7; col++) expect(() => t.cell(row, col)).not.toThrow();
    }

    t.write("\x1b[?1049l");
    expect(t.rowText(0)).toBe("one");
    expect(t.cursor()).toMatchObject({ x: 3, y: 1, pendingWrap: false });
    expect(t.cell(0, 6).bg).toEqual({ type: "default" });
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 7; col++) expect(() => t.cell(row, col)).not.toThrow();
    }
  });

  test("shrinking removes primary rows into scrollback and clamps both cursors", () => {
    const screen = new Screen(5, 4, 10);
    for (let row = 0; row < 4; row++) {
      screen.setCursor(0, row);
      screen.print("A".charCodeAt(0) + row);
    }
    screen.setCursor(4, 3);
    screen.print("P".charCodeAt(0));
    screen.enterAlt(true, true);
    for (let row = 0; row < 4; row++) {
      screen.setCursor(0, row);
      screen.print("w".charCodeAt(0) + row);
    }
    screen.setCursor(4, 3);
    screen.print("Z".charCodeAt(0));

    screen.resize(3, 2);
    expect(screen.grid.map((row) => row.length)).toEqual([3, 3]);
    expect(screen.grid.map((row) => row[0]!.cp)).toEqual(["y".charCodeAt(0), "z".charCodeAt(0)]);
    expect(screen.cursor).toMatchObject({ x: 2, y: 1, pendingWrap: false });
    expect(screen.scrollback.map((row) => row.length)).toEqual([3, 3]);
    expect(screen.scrollback.map((row) => row[0]!.cp)).toEqual(["A".charCodeAt(0), "B".charCodeAt(0)]);

    screen.leaveAlt(true);
    expect(screen.grid.map((row) => row.length)).toEqual([3, 3]);
    expect(screen.grid.map((row) => row[0]!.cp)).toEqual(["C".charCodeAt(0), "D".charCodeAt(0)]);
    expect(screen.cursor).toMatchObject({ x: 2, y: 1, pendingWrap: false });
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) expect(screen.cellAt(row, col)).not.toBeNull();
    }
  });

  for (const mode of [47, 1047]) {
    test(`mode ${mode} restores a fully resized primary grid`, () => {
      const t = new Terminal({ cols: 3, rows: 2 });
      t.write("pri");
      t.write(`\x1b[?${mode}h\x1b[Halt`);
      t.resize(5, 3);
      expect(t.rowText(0)).toBe("alt");
      t.write(`\x1b[?${mode}l`);
      expect(t.rowText(0)).toBe("pri");
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 5; col++) expect(() => t.cell(row, col)).not.toThrow();
      }
    });
  }

  test("mode 1047 keeps its unsaved cursor state when leaving", () => {
    const t = new Terminal({ cols: 4, rows: 2 });
    t.write("pri\x1b[2;4H\x1b[31mX");
    expect(t.cursor()).toMatchObject({ x: 3, y: 1, pendingWrap: true });

    t.write("\x1b[?1047h");
    expect(t.cursor()).toMatchObject({ x: 3, y: 1, pendingWrap: false });
    t.resize(6, 3);
    expect(t.cursor()).toMatchObject({ x: 3, y: 1, pendingWrap: false });
    t.write("\x1b[2;6HZ");
    expect(t.cursor()).toMatchObject({ x: 5, y: 1, pendingWrap: true });
    expect(t.cell(1, 5).fg).toEqual({ type: "palette", index: 1 });

    t.write("\x1b[?1047l");
    expect(t.rowText(0)).toBe("pri");
    expect(t.cursor()).toMatchObject({ x: 5, y: 1, pendingWrap: true });
    t.write("Q");
    expect(t.cursor()).toMatchObject({ x: 1, y: 2, pendingWrap: false });
    expect(t.cell(2, 0).fg).toEqual({ type: "palette", index: 1 });
  });
});

describe("RIS (ESC c)", () => {
  test("full reset clears content and homes the cursor, keeping dimensions", () => {
    const t = new Terminal({ cols: 10, rows: 3 });
    t.write("\x1b[31mhello\r\nworld\x1b[?25l\x1b[6 q\x1b]12;#123456\x07");
    t.write("\x1bc");
    expect(t.rowText(0)).toBe("");
    expect(t.rowText(1)).toBe("");
    expect(t.cursor()).toMatchObject({
      x: 0,
      y: 0,
      visible: true,
      shape: "block",
      blinking: true,
      color: { type: "default" },
    });
    expect(t.cols).toBe(10);
    expect(t.rows).toBe(3);
    // Pen was reset too: subsequent text is default-colored.
    t.write("Z");
    expect(t.cell(0, 0).fg).toEqual({ type: "default" });
  });
});
