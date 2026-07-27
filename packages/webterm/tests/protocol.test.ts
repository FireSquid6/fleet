import { describe, expect, test } from "bun:test";
import {
  clampTerminalSize,
  decodeClientMessage,
  decodeServerMessage,
  MAX_INPUT_BYTES,
  PASTE_END,
  PASTE_START,
  pasteBytes,
  splitInput,
  TERMINAL_CONFLICT_CLOSE_CODE,
  TERMINAL_CONFLICT_CLOSE_REASON,
  TERMINAL_TAKEOVER_CLOSE_CODE,
  TERMINAL_TAKEOVER_CLOSE_REASON,
  utf8ByteLength,
} from "../protocol";
import type { GridMsg } from "../protocol";

describe("terminal protocol decoders", () => {
  test("accepts dimension boundaries and rejects values outside them", () => {
    expect(decodeClientMessage('{"type":"init","cols":1,"rows":1}')).toEqual({ type: "init", cols: 1, rows: 1 });
    expect(decodeClientMessage('{"type":"resize","cols":1024,"rows":512}')).toEqual({
      type: "resize",
      cols: 1024,
      rows: 512,
    });
    for (const frame of [
      '{"type":"init","cols":0,"rows":1}',
      '{"type":"init","cols":1025,"rows":1}',
      '{"type":"init","cols":1,"rows":513}',
      '{"type":"init","cols":1.5,"rows":2}',
    ]) {
      expect(() => decodeClientMessage(frame)).toThrow();
    }
  });

  test("measures input as UTF-8 and enforces the byte boundary", () => {
    const atLimit = "é".repeat(MAX_INPUT_BYTES / 2);
    expect(decodeClientMessage(JSON.stringify({ type: "input", data: atLimit }))).toEqual({ type: "input", data: atLimit });
    expect(() => decodeClientMessage(JSON.stringify({ type: "input", data: `${atLimit}a` }))).toThrow();
  });

  test("accepts paste frames under the same byte bound as input", () => {
    expect(decodeClientMessage('{"type":"paste","data":"a\\nb"}')).toEqual({ type: "paste", data: "a\nb" });
    const atLimit = "é".repeat(MAX_INPUT_BYTES / 2);
    expect(decodeClientMessage(JSON.stringify({ type: "paste", data: atLimit }))).toEqual({
      type: "paste",
      data: atLimit,
    });
    expect(() => decodeClientMessage(JSON.stringify({ type: "paste", data: `${atLimit}a` }))).toThrow();
  });

  test("rejects malformed, unknown, missing, extra, scalar, array, and binary frames", () => {
    for (const frame of [
      "{",
      '{"type":"wat"}',
      '{"type":"input"}',
      '{"type":"input","data":"x","extra":true}',
      '{"type":"paste"}',
      '{"type":"paste","data":"x","extra":true}',
      '{"type":"paste","data":"x","cols":80}',
      "null",
      "42",
      "[]",
      new Uint8Array([1]),
    ]) {
      expect(() => decodeClientMessage(frame)).toThrow();
    }
  });

  test("strictly decodes server grid and exit messages", () => {
    const grid: GridMsg = {
      type: "grid",
      cols: 2,
      rows: 1,
      cursor: { x: 1, y: 0, visible: true },
      cells: [[0, { t: "x", f: [1, 2, 3] }]],
    };
    expect(decodeServerMessage(JSON.stringify(grid))).toEqual(grid);
    expect(decodeServerMessage('{"type":"exit","code":0}')).toEqual({ type: "exit", code: 0 });
    for (const invalid of [
      { ...grid, extra: true },
      { ...grid, cells: [[0]] },
      { ...grid, cursor: { x: 2, y: 0, visible: true } },
      { type: "exit", code: 0, extra: true },
      { type: "other" },
    ]) {
      expect(() => decodeServerMessage(JSON.stringify(invalid))).toThrow();
    }
    expect(() => decodeServerMessage(new ArrayBuffer(1))).toThrow();
  });
});

describe("browser protocol helpers", () => {
  test("clamps and truncates generated dimensions", () => {
    expect(clampTerminalSize(-1, Number.NaN)).toEqual({ cols: 1, rows: 1 });
    expect(clampTerminalSize(5000.8, 513.2)).toEqual({ cols: 1024, rows: 512 });
  });

  test("splits input without breaking multibyte characters", () => {
    const input = `${"a".repeat(MAX_INPUT_BYTES - 1)}éz`;
    const chunks = splitInput(input);
    expect(chunks.join("")).toBe(input);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => utf8ByteLength(chunk) <= MAX_INPUT_BYTES)).toBe(true);
    expect(chunks[1]).toBe("éz");
  });
});

describe("pasteBytes", () => {
  test("normalizes CRLF and LF line breaks to CR", () => {
    expect(pasteBytes("a\r\nb", true)).toBe(`${PASTE_START}a\rb${PASTE_END}`);
    expect(pasteBytes("a\nb", false)).toBe("a\rb");
    expect(pasteBytes("a\r\n\nb\r", false)).toBe("a\r\rb\r");
  });

  test("wraps in the markers only when the application asked for bracketing", () => {
    expect(pasteBytes("plain", true)).toBe(`${PASTE_START}plain${PASTE_END}`);
    expect(pasteBytes("plain", false)).toBe("plain");
    expect(pasteBytes("", true)).toBe(`${PASTE_START}${PASTE_END}`);
    expect(pasteBytes("", false)).toBe("");
  });

  test("strips embedded closing markers in both modes", () => {
    expect(pasteBytes(`a${PASTE_END}b`, true)).toBe(`${PASTE_START}ab${PASTE_END}`);
    expect(pasteBytes(`a${PASTE_END}b`, false)).toBe("ab");
    // Overlapping payload: removing the inner marker must not splice a new one
    // out of the surrounding text.
    expect(pasteBytes(`\x1b[20${PASTE_END}1~`, false)).toBe("");
    expect(pasteBytes(`x${PASTE_END}${PASTE_END}y`, false)).toBe("xy");
  });

  // The size is the point of this test, not the value: nesting is what a
  // re-scan-until-clean stripper pays quadratically for, and at this depth (a
  // payload still under MAX_INPUT_BYTES, so the schema accepts it) that costs
  // ~1.4s of blocking CPU in the server's message handler versus ~5ms here.
  test("collapses deeply nested closing markers without rescanning per level", () => {
    const depth = 43_000;
    const nested = "\x1b[20".repeat(depth) + PASTE_END + "1~".repeat(depth);
    expect(utf8ByteLength(nested)).toBeLessThan(MAX_INPUT_BYTES);
    expect(pasteBytes(nested, false)).toBe("");
    expect(pasteBytes(nested, true)).toBe(`${PASTE_START}${PASTE_END}`);
  });

  // `TerminalBridge.paste` decides "there is nothing to write" by comparing its
  // output against these two values, so a payload that strips to nothing must
  // produce exactly them, and a payload that does not must never collide with
  // them. A clipboard of nothing but closing markers is the case the client's own
  // empty-string guard cannot see.
  test("marks an empty paste by output value alone", () => {
    for (const nothing of ["", PASTE_END, PASTE_END + PASTE_END, `\x1b[20${PASTE_END}1~`]) {
      expect(pasteBytes(nothing, false)).toBe("");
      expect(pasteBytes(nothing, true)).toBe(`${PASTE_START}${PASTE_END}`);
    }
    for (const something of ["\n", " ", "a", `a${PASTE_END}`, PASTE_START, "\x1b[201", "~"]) {
      expect(pasteBytes(something, false)).not.toBe("");
      expect(pasteBytes(something, true)).not.toBe(`${PASTE_START}${PASTE_END}`);
    }
  });

  test("passes every other escape sequence through unmodified, opening marker included", () => {
    // Only the closing marker can escape the bracketed region, so only it is
    // removed; an embedded opening marker is literal payload.
    expect(pasteBytes(`${PASTE_START}hi`, false)).toBe(`${PASTE_START}hi`);
    expect(pasteBytes(`${PASTE_START}hi`, true)).toBe(`${PASTE_START}${PASTE_START}hi${PASTE_END}`);
    expect(pasteBytes("\x1b[31m", false)).toBe("\x1b[31m");
    expect(pasteBytes("\x1b[31m", true)).toBe(`${PASTE_START}\x1b[31m${PASTE_END}`);
  });
});

describe("terminal takeover signalling", () => {
  test("keeps the conflict codes proxy-safe and the reasons wire-legal", () => {
    for (const code of [TERMINAL_CONFLICT_CLOSE_CODE, TERMINAL_TAKEOVER_CLOSE_CODE]) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
    expect(TERMINAL_CONFLICT_CLOSE_CODE).not.toBe(TERMINAL_TAKEOVER_CLOSE_CODE);
    for (const reason of [TERMINAL_CONFLICT_CLOSE_REASON, TERMINAL_TAKEOVER_CLOSE_REASON]) {
      expect(utf8ByteLength(reason)).toBeLessThanOrEqual(123);
    }
  });
});
