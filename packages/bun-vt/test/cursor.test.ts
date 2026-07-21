/**
 * test/cursor.test.ts — cursor movement, editing, and erasing.
 */

import { test, expect, describe } from "bun:test";
import { Terminal } from "../src/index";

function grid(cols: number, rows: number): Terminal {
  return new Terminal({ cols, rows });
}

describe("cursor movement", () => {
  test("CUU/CUD/CUF/CUB relative moves", () => {
    const t = grid(20, 10);
    t.write("\x1b[5;5H"); // row 5 col 5 (1-based) → (4,4)
    t.write("\x1b[2A");
    expect(t.cursor()).toMatchObject({ x: 4, y: 2 });
    t.write("\x1b[3B");
    expect(t.cursor()).toMatchObject({ x: 4, y: 5 });
    t.write("\x1b[2C");
    expect(t.cursor()).toMatchObject({ x: 6, y: 5 });
    t.write("\x1b[4D");
    expect(t.cursor()).toMatchObject({ x: 2, y: 5 });
  });

  test("moves clamp at grid edges", () => {
    const t = grid(10, 5);
    t.write("\x1b[100A");
    expect(t.cursor().y).toBe(0);
    t.write("\x1b[100D");
    expect(t.cursor().x).toBe(0);
    t.write("\x1b[100C");
    expect(t.cursor().x).toBe(9);
    t.write("\x1b[100B");
    expect(t.cursor().y).toBe(4);
  });

  test("CHA / VPA absolute column and row", () => {
    const t = grid(20, 10);
    t.write("\x1b[10G");
    expect(t.cursor().x).toBe(9);
    t.write("\x1b[7d");
    expect(t.cursor().y).toBe(6);
  });

  test("CUP with missing params homes the cursor", () => {
    const t = grid(20, 10);
    t.write("\x1b[5;5H\x1b[H");
    expect(t.cursor()).toMatchObject({ x: 0, y: 0 });
  });

  test("CNL / CPL move to column 0", () => {
    const t = grid(20, 10);
    t.write("\x1b[5;5H\x1b[2E");
    expect(t.cursor()).toMatchObject({ x: 0, y: 6 });
    t.write("\x1b[5;5H\x1b[2F");
    expect(t.cursor()).toMatchObject({ x: 0, y: 2 });
  });

  test("backspace and carriage return", () => {
    const t = grid(20, 3);
    t.write("abc\b");
    expect(t.cursor().x).toBe(2);
    t.write("\r");
    expect(t.cursor().x).toBe(0);
  });
});

describe("tabs", () => {
  test("HT advances to 8-column tab stops", () => {
    const t = grid(40, 3);
    t.write("\t");
    expect(t.cursor().x).toBe(8);
    t.write("\t");
    expect(t.cursor().x).toBe(16);
  });

  test("CBT moves back to previous tab stop", () => {
    const t = grid(40, 3);
    t.write("\x1b[20G\x1b[Z");
    expect(t.cursor().x).toBe(16);
  });

  test("HTS sets and TBC clears a custom stop", () => {
    const t = grid(40, 3);
    t.write("\x1b[3G\x1bH"); // set stop at col 2 (0-based)
    t.write("\x1b[1G\t");
    expect(t.cursor().x).toBe(2);
    t.write("\x1b[3G\x1b[0g"); // clear stop at col 2
    t.write("\x1b[1G\t");
    expect(t.cursor().x).toBe(8);
  });
});

describe("editing", () => {
  test("ICH inserts blanks, shifting right", () => {
    const t = grid(10, 2);
    t.write("ABCDE\x1b[1;3H\x1b[2@");
    expect(t.rowText(0)).toBe("AB  CDE");
  });

  test("DCH deletes chars, shifting left", () => {
    const t = grid(10, 2);
    t.write("ABCDE\x1b[1;2H\x1b[2P");
    expect(t.rowText(0)).toBe("ADE");
  });

  test("ECH erases in place without shifting", () => {
    const t = grid(10, 2);
    t.write("ABCDE\x1b[1;2H\x1b[2X");
    expect(t.rowText(0)).toBe("A  DE");
  });

  test("IL inserts blank lines below cursor within region", () => {
    const t = grid(10, 4);
    t.write("L0\r\nL1\r\nL2\r\nL3");
    t.write("\x1b[2;1H\x1b[1L");
    expect(t.rowText(0)).toBe("L0");
    expect(t.rowText(1)).toBe("");
    expect(t.rowText(2)).toBe("L1");
    expect(t.rowText(3)).toBe("L2");
  });

  test("DL deletes lines, pulling lines up", () => {
    const t = grid(10, 4);
    t.write("L0\r\nL1\r\nL2\r\nL3");
    t.write("\x1b[2;1H\x1b[1M");
    expect(t.rowText(0)).toBe("L0");
    expect(t.rowText(1)).toBe("L2");
    expect(t.rowText(2)).toBe("L3");
    expect(t.rowText(3)).toBe("");
  });
});

describe("erasing", () => {
  test("EL 0 erases cursor to end of line", () => {
    const t = grid(10, 2);
    t.write("ABCDE\x1b[1;3H\x1b[0K");
    expect(t.rowText(0)).toBe("AB");
  });

  test("EL 1 erases start of line to cursor", () => {
    const t = grid(10, 2);
    t.write("ABCDE\x1b[1;3H\x1b[1K");
    expect(t.rowText(0)).toBe("   DE");
  });

  test("EL 2 erases whole line", () => {
    const t = grid(10, 2);
    t.write("ABCDE\x1b[2K");
    expect(t.rowText(0)).toBe("");
  });

  test("ED 2 clears the whole screen", () => {
    const t = grid(10, 3);
    t.write("A\r\nB\r\nC\x1b[2J");
    expect(t.rowText(0)).toBe("");
    expect(t.rowText(1)).toBe("");
    expect(t.rowText(2)).toBe("");
  });

  test("ED 0 clears from cursor to end of screen", () => {
    const t = grid(10, 3);
    t.write("AAA\r\nBBB\r\nCCC");
    t.write("\x1b[2;2H\x1b[0J");
    expect(t.rowText(0)).toBe("AAA");
    expect(t.rowText(1)).toBe("B");
    expect(t.rowText(2)).toBe("");
  });

  test("ED 1 clears from start of screen to cursor", () => {
    const t = grid(10, 3);
    t.write("AAA\r\nBBB\r\nCCC");
    t.write("\x1b[2;2H\x1b[1J");
    expect(t.rowText(0)).toBe("");
    expect(t.rowText(1)).toBe("  B");
    expect(t.rowText(2)).toBe("CCC");
  });
});

describe("save / restore cursor", () => {
  test("DECSC / DECRC round-trip position and pen", () => {
    const t = grid(20, 5);
    t.write("\x1b[3;4H\x1b[31m\x1b7"); // save at (2,3) with red pen
    t.write("\x1b[10;10H\x1b[0m"); // move + reset pen
    t.write("\x1b8A"); // restore, then print A
    expect(t.cursor()).toMatchObject({ x: 4, y: 2 }); // x advanced by the 'A'
    expect(t.cell(2, 3).char).toBe("A");
    expect(t.cell(2, 3).fg).toEqual({ type: "palette", index: 1 });
  });

  test("resize adjusts a saved cursor for removed top rows", () => {
    const t = grid(5, 4);
    t.write("\x1b[4;5H\x1b[31m\x1b7");
    t.resize(5, 2);
    t.write("\x1b[H\x1b[0m\x1b8");

    expect(t.cursor()).toMatchObject({ x: 4, y: 1, pendingWrap: false });
    t.write("X");
    expect(t.cell(1, 4).char).toBe("X");
    expect(t.cell(1, 4).fg).toEqual({ type: "palette", index: 1 });
  });

  test("width growth clamps and clears pending wrap on a saved cursor", () => {
    const t = grid(3, 2);
    t.write("\x1b[31mabc\x1b7");
    t.resize(5, 2);
    t.write("\x1b[2;1H\x1b[0m\x1b8X");

    expect(t.rowText(0)).toBe("abX");
    expect(t.cursor()).toMatchObject({ x: 3, y: 0, pendingWrap: false });
    expect(t.cell(0, 2).fg).toEqual({ type: "palette", index: 1 });
  });
});
