import { describe, expect, test } from "bun:test";
import {
  clampTerminalSize,
  decodeClientMessage,
  decodeServerMessage,
  MAX_INPUT_BYTES,
  splitInput,
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

  test("rejects malformed, unknown, missing, extra, scalar, array, and binary frames", () => {
    for (const frame of [
      "{",
      '{"type":"wat"}',
      '{"type":"input"}',
      '{"type":"input","data":"x","extra":true}',
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
