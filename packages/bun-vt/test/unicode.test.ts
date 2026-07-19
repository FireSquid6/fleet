/**
 * test/unicode.test.ts — UTF-8 decoding, wide characters, combining marks.
 *
 * Characters are written with explicit \u/\u{} escapes so the test is immune to
 * whatever normalization form the editor stores the source file in.
 */

import { test, expect, describe } from "bun:test";
import { Terminal, wcwidth } from "../src/index";

const SHI = "世"; // 世 (CJK, wide)
const ZHONG = "中"; // 中 (CJK, wide)
const PARTY = "\u{1f389}"; // 🎉 (emoji, wide)
const E_ACUTE = "\u00e9"; // precomposed é (single narrow scalar)
const COMBINING = "e\u0301"; // e + U+0301 combining acute accent

describe("wcwidth", () => {
  test("ASCII is width 1", () => {
    expect(wcwidth(0x41)).toBe(1);
  });
  test("combining marks are width 0", () => {
    expect(wcwidth(0x0301)).toBe(0); // combining acute
    expect(wcwidth(0x200b)).toBe(0); // zero-width space
  });
  test("CJK and emoji are width 2", () => {
    expect(wcwidth(0x4e16)).toBe(2); // 世
    expect(wcwidth(0x1f389)).toBe(2); // 🎉
    expect(wcwidth(0xff21)).toBe(2); // fullwidth A
  });
});

describe("wide characters in the grid", () => {
  test("a wide glyph occupies two cells (head + spacer tail)", () => {
    const t = new Terminal({ cols: 10, rows: 2 });
    t.write("a" + SHI + "b");
    expect(t.cell(0, 0).char).toBe("a");
    expect(t.cell(0, 1).char).toBe(SHI);
    expect(t.cell(0, 1).width).toBe("wide");
    expect(t.cell(0, 2).width).toBe("spacer_tail");
    expect(t.cell(0, 3).char).toBe("b");
    expect(t.rowText(0)).toBe("a" + SHI + "b");
    expect(t.cursor().x).toBe(4);
  });

  test("emoji are wide", () => {
    const t = new Terminal({ cols: 10, rows: 2 });
    t.write(PARTY);
    expect(t.cell(0, 0).char).toBe(PARTY);
    expect(t.cell(0, 0).width).toBe("wide");
    expect(t.cursor().x).toBe(2);
  });

  test("a wide glyph that does not fit the last column wraps", () => {
    const t = new Terminal({ cols: 3, rows: 2 });
    t.write("AB" + SHI);
    expect(t.rowText(0)).toBe("AB");
    expect(t.rowText(1)).toBe(SHI);
    expect(t.cursor()).toMatchObject({ x: 2, y: 1 });
  });

  test("overwriting one half of a wide pair clears the orphaned half", () => {
    const t = new Terminal({ cols: 10, rows: 2 });
    t.write(SHI);
    t.write("\x1b[1;1HX"); // overwrite the wide head
    expect(t.cell(0, 0).char).toBe("X");
    expect(t.cell(0, 1).char).toBe(""); // orphaned tail cleared
    expect(t.cell(0, 1).width).toBe("narrow");
  });
});

describe("combining marks", () => {
  test("combining mark attaches without advancing the cursor", () => {
    const t = new Terminal({ cols: 10, rows: 2 });
    t.write(COMBINING);
    expect(t.cell(0, 0).char).toBe("e");
    expect(t.cursor().x).toBe(1);
  });
});

describe("UTF-8 multi-byte input", () => {
  test("decodes 2/3/4-byte sequences fed as raw bytes", () => {
    const t = new Terminal({ cols: 10, rows: 2 });
    t.write(new TextEncoder().encode(E_ACUTE + ZHONG + PARTY));
    expect(t.cell(0, 0).char).toBe(E_ACUTE);
    expect(t.cell(0, 1).char).toBe(ZHONG);
    expect(t.cell(0, 3).char).toBe(PARTY); // ZHONG is wide, so PARTY lands at col 3
  });

  test("split multi-byte sequence across two writes still decodes", () => {
    const t = new Terminal({ cols: 10, rows: 2 });
    const bytes = new TextEncoder().encode(SHI);
    t.write(bytes.slice(0, 1));
    t.write(bytes.slice(1));
    expect(t.cell(0, 0).char).toBe(SHI);
  });
});
