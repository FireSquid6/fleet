import { describe, expect, test } from "bun:test";
import {
  applyPatch,
  clampTerminalSize,
  decodeClientMessage,
  decodeServerMessage,
  MAX_INPUT_BYTES,
  splitInput,
  TERMINAL_CONFLICT_CLOSE_CODE,
  TERMINAL_CONFLICT_CLOSE_REASON,
  TERMINAL_TAKEOVER_CLOSE_CODE,
  TERMINAL_TAKEOVER_CLOSE_REASON,
  utf8ByteLength,
} from "../protocol";
import type { GridMsg, PatchMsg } from "../protocol";

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
      seq: 3,
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
      { ...grid, seq: undefined },
      { type: "exit", code: 0, extra: true },
      { type: "other" },
    ]) {
      expect(() => decodeServerMessage(JSON.stringify(invalid))).toThrow();
    }
    expect(() => decodeServerMessage(new ArrayBuffer(1))).toThrow();
  });

  test("strictly decodes patch messages and rejects out-of-bounds runs", () => {
    const patch: PatchMsg = {
      type: "patch",
      seq: 4,
      cols: 3,
      rows: 2,
      cursor: { x: 2, y: 1, visible: true },
      runs: [
        [0, 1, [{ t: "a" }, 0]],
        [1, 0, [{ t: "b" }]],
      ],
    };
    expect(decodeServerMessage(JSON.stringify(patch))).toEqual(patch);
    expect(decodeServerMessage(JSON.stringify({ ...patch, runs: [] }))).toEqual({ ...patch, runs: [] });
    for (const invalid of [
      { ...patch, runs: [[0, 2, [0, 0]]] },
      { ...patch, runs: [[2, 0, [0]]] },
      { ...patch, runs: [[0, 0, []]] },
      { ...patch, runs: [[-1, 0, [0]]] },
      { ...patch, runs: [[0, 0]] },
      { ...patch, extra: true },
    ]) {
      expect(() => decodeServerMessage(JSON.stringify(invalid))).toThrow();
    }
  });

  test("decodes ack and resync, rejecting non-sequence numbers", () => {
    expect(decodeClientMessage('{"type":"ack","seq":0}')).toEqual({ type: "ack", seq: 0 });
    expect(decodeClientMessage('{"type":"resync"}')).toEqual({ type: "resync" });
    for (const frame of [
      '{"type":"ack","seq":-1}',
      '{"type":"ack","seq":1.5}',
      '{"type":"ack"}',
      '{"type":"resync","seq":1}',
    ]) {
      expect(() => decodeClientMessage(frame)).toThrow();
    }
  });
});

describe("applyPatch", () => {
  const prev: GridMsg = {
    type: "grid",
    seq: 1,
    cols: 3,
    rows: 2,
    cursor: { x: 0, y: 0, visible: true },
    cells: [
      [0, 0, 0],
      [{ t: "x" }, 0, 0],
    ],
  };

  test("writes runs at their coordinates and carries seq and cursor through", () => {
    const next = applyPatch(prev, {
      type: "patch",
      seq: 2,
      cols: 3,
      rows: 2,
      cursor: { x: 2, y: 1, visible: false },
      runs: [[0, 1, [{ t: "a" }, { t: "b" }]]],
    });
    expect(next.seq).toBe(2);
    expect(next.cursor).toEqual({ x: 2, y: 1, visible: false });
    expect(next.cells[0]).toEqual([0, { t: "a" }, { t: "b" }]);
  });

  test("leaves prev untouched and shares the rows no run wrote to", () => {
    const before = structuredClone(prev.cells);
    const next = applyPatch(prev, {
      type: "patch",
      seq: 2,
      cols: 3,
      rows: 2,
      cursor: prev.cursor,
      runs: [[1, 2, [{ t: "z" }]]],
    });
    expect(prev.cells).toEqual(before);
    expect(next.cells[0]).toBe(prev.cells[0]!);
    expect(next.cells[1]).not.toBe(prev.cells[1]!);
  });

  test("throws on a dimension mismatch", () => {
    expect(() =>
      applyPatch(prev, {
        type: "patch",
        seq: 2,
        cols: 4,
        rows: 2,
        cursor: prev.cursor,
        runs: [],
      }),
    ).toThrow(TypeError);
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
