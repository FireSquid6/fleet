/**
 * test/sgr.test.ts — Select Graphic Rendition: colors and attributes.
 */

import { test, expect, describe } from "bun:test";
import { Terminal } from "../src/index";

function cellAfter(seq: string): ReturnType<Terminal["cell"]> {
  const t = new Terminal({ cols: 20, rows: 3 });
  t.write(seq + "X");
  return t.cell(0, 0);
}

describe("colors", () => {
  test("SGR 30-37 set ANSI palette foreground", () => {
    expect(cellAfter("\x1b[30m").fg).toEqual({ type: "palette", index: 0 });
    expect(cellAfter("\x1b[31m").fg).toEqual({ type: "palette", index: 1 });
    expect(cellAfter("\x1b[37m").fg).toEqual({ type: "palette", index: 7 });
  });

  test("SGR 40-47 set ANSI palette background", () => {
    expect(cellAfter("\x1b[42m").bg).toEqual({ type: "palette", index: 2 });
  });

  test("SGR 90-97 set bright foreground (8-15)", () => {
    expect(cellAfter("\x1b[91m").fg).toEqual({ type: "palette", index: 9 });
    expect(cellAfter("\x1b[100m").bg).toEqual({ type: "palette", index: 8 });
  });

  test("SGR 38;5;n sets 256-color palette (semicolon)", () => {
    expect(cellAfter("\x1b[38;5;196m").fg).toEqual({ type: "palette", index: 196 });
  });

  test("SGR 38;2;r;g;b sets RGB (semicolon)", () => {
    expect(cellAfter("\x1b[38;2;1;2;3m").fg).toEqual({ type: "rgb", r: 1, g: 2, b: 3 });
    expect(cellAfter("\x1b[48;2;4;5;6m").bg).toEqual({ type: "rgb", r: 4, g: 5, b: 6 });
  });

  test("SGR 38:5:n and 38:2::r:g:b (colon / ISO 8613-6)", () => {
    expect(cellAfter("\x1b[38:5:200m").fg).toEqual({ type: "palette", index: 200 });
    expect(cellAfter("\x1b[38:2::7:8:9m").fg).toEqual({ type: "rgb", r: 7, g: 8, b: 9 });
    // colon form without the empty colorspace slot
    expect(cellAfter("\x1b[38:2:7:8:9m").fg).toEqual({ type: "rgb", r: 7, g: 8, b: 9 });
  });

  test("SGR 39 / 49 reset to default color", () => {
    const t = new Terminal({ cols: 10, rows: 2 });
    t.write("\x1b[31;42m\x1b[39mA\x1b[49mB");
    expect(t.cell(0, 0).fg).toEqual({ type: "default" });
    expect(t.cell(0, 0).bg).toEqual({ type: "palette", index: 2 });
    expect(t.cell(0, 1).bg).toEqual({ type: "default" });
  });

  test("compound RGB fg + palette bg in one SGR", () => {
    const c = cellAfter("\x1b[38;2;10;20;30;41m");
    expect(c.fg).toEqual({ type: "rgb", r: 10, g: 20, b: 30 });
    expect(c.bg).toEqual({ type: "palette", index: 1 });
  });
});

describe("attributes", () => {
  test("individual flags", () => {
    expect(cellAfter("\x1b[1m").style.bold).toBe(true);
    expect(cellAfter("\x1b[2m").style.faint).toBe(true);
    expect(cellAfter("\x1b[3m").style.italic).toBe(true);
    expect(cellAfter("\x1b[5m").style.blink).toBe(true);
    expect(cellAfter("\x1b[7m").style.inverse).toBe(true);
    expect(cellAfter("\x1b[8m").style.invisible).toBe(true);
    expect(cellAfter("\x1b[9m").style.strikethrough).toBe(true);
    expect(cellAfter("\x1b[53m").style.overline).toBe(true);
  });

  test("underline styles via colon sub-param", () => {
    expect(cellAfter("\x1b[4m").style.underline).toBe("single");
    expect(cellAfter("\x1b[4:0m").style.underline).toBe("none");
    expect(cellAfter("\x1b[4:2m").style.underline).toBe("double");
    expect(cellAfter("\x1b[4:3m").style.underline).toBe("curly");
    expect(cellAfter("\x1b[4:4m").style.underline).toBe("dotted");
    expect(cellAfter("\x1b[4:5m").style.underline).toBe("dashed");
    expect(cellAfter("\x1b[21m").style.underline).toBe("double");
  });

  test("reset codes turn flags off", () => {
    expect(cellAfter("\x1b[1m\x1b[22m").style.bold).toBe(false);
    expect(cellAfter("\x1b[3m\x1b[23m").style.italic).toBe(false);
    expect(cellAfter("\x1b[4m\x1b[24m").style.underline).toBe("none");
    expect(cellAfter("\x1b[7m\x1b[27m").style.inverse).toBe(false);
  });

  test("SGR 0 resets everything", () => {
    const t = new Terminal({ cols: 10, rows: 2 });
    t.write("\x1b[1;4;31;42m\x1b[0mA");
    const c = t.cell(0, 0);
    expect(c.style.bold).toBe(false);
    expect(c.style.underline).toBe("none");
    expect(c.fg).toEqual({ type: "default" });
    expect(c.bg).toEqual({ type: "default" });
  });

  test("empty SGR (CSI m) is a reset", () => {
    expect(cellAfter("\x1b[1m\x1b[m").style.bold).toBe(false);
  });

  test("attributes persist across cells until changed", () => {
    const t = new Terminal({ cols: 10, rows: 2 });
    t.write("\x1b[1mAB\x1b[22mC");
    expect(t.cell(0, 0).style.bold).toBe(true);
    expect(t.cell(0, 1).style.bold).toBe(true);
    expect(t.cell(0, 2).style.bold).toBe(false);
  });
});
