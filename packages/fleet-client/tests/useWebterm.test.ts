import { describe, expect, test } from "bun:test";
import {
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
} from "webterm/protocol";
import { handleServerFrame, terminalPath } from "../src/data/useWebterm";

describe("browser server-message handling", () => {
  test("encodes each terminal identifier as one URL path segment", () => {
    expect(terminalPath("repo ?#% 雪", "work ?#% λ")).toBe(
      "/workspaces/repo%20%3F%23%25%20%E9%9B%AA/work%20%3F%23%25%20%CE%BB/terminal",
    );
  });

  test("dispatches valid grid and exit messages", () => {
    const grids: unknown[] = [];
    const exits: number[] = [];
    const close = () => {
      throw new Error("unexpected close");
    };
    handleServerFrame(
      JSON.stringify({
        type: "grid",
        cols: 1,
        rows: 1,
        cursor: { x: 0, y: 0, visible: true },
        cells: [[0]],
      }),
      { onGrid: (grid) => grids.push(grid), onExit: (code) => exits.push(code) },
      close,
    );
    handleServerFrame('{"type":"exit","code":7}', { onExit: (code) => exits.push(code) }, close);
    expect(grids).toHaveLength(1);
    expect(exits).toEqual([7]);
  });

  test("closes malformed, unknown, and binary messages with fixed reasons", () => {
    const closes: Array<[number, string]> = [];
    const close = (code: number, reason: string) => closes.push([code, reason]);
    handleServerFrame("{", {}, close);
    handleServerFrame('{"type":"unknown"}', {}, close);
    handleServerFrame(new Blob(["binary"]), {}, close);
    expect(closes).toEqual([
      [INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON],
      [INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON],
      [BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON],
    ]);
  });
});
