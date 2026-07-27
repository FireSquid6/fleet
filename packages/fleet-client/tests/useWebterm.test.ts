import { describe, expect, test } from "bun:test";
import {
  BINARY_MESSAGE_CLOSE_CODE,
  BINARY_MESSAGE_CLOSE_REASON,
  GridStream,
  INVALID_MESSAGE_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_REASON,
  TERMINAL_CONFLICT_CLOSE_CODE,
  TERMINAL_TAKEOVER_CLOSE_CODE,
} from "webterm/protocol";
import type { ClientMsg, GridMsg } from "webterm/protocol";
import { closeStatus, handleServerFrame, terminalPath } from "../src/data/useWebterm";

describe("browser server-message handling", () => {
  test("encodes each terminal identifier as one URL path segment", () => {
    expect(terminalPath("repo ?#% 雪", "work ?#% λ")).toBe(
      "/workspaces/repo%20%3F%23%25%20%E9%9B%AA/work%20%3F%23%25%20%CE%BB/terminal",
    );
  });

  test("appends the takeover flag after the encoded path segments", () => {
    expect(terminalPath("repo ?#% 雪", "work ?#% λ", true)).toBe(
      "/workspaces/repo%20%3F%23%25%20%E9%9B%AA/work%20%3F%23%25%20%CE%BB/terminal?takeover=true",
    );
    expect(terminalPath("repo", "work", false)).toBe("/workspaces/repo/work/terminal");
  });

  test("maps the ship's terminal close codes to recoverable statuses", () => {
    expect(closeStatus(TERMINAL_CONFLICT_CLOSE_CODE)).toBe("conflict");
    expect(closeStatus(TERMINAL_TAKEOVER_CLOSE_CODE)).toBe("superseded");
    expect(closeStatus(1000)).toBe("closed");
    expect(closeStatus(INVALID_MESSAGE_CLOSE_CODE)).toBe("closed");
  });

  const gridFrame = (seq: number, char: string) =>
    JSON.stringify({
      type: "grid",
      seq,
      cols: 2,
      rows: 1,
      cursor: { x: 0, y: 0, visible: true },
      cells: [[{ t: char }, 0]],
    });
  const patchFrame = (seq: number, char: string) =>
    JSON.stringify({
      type: "patch",
      seq,
      cols: 2,
      rows: 1,
      cursor: { x: 1, y: 0, visible: true },
      runs: [[0, 1, [{ t: char }]]],
    });

  function harness() {
    const grids: GridMsg[] = [];
    const exits: number[] = [];
    const sent: ClientMsg[] = [];
    const closes: Array<[number, string]> = [];
    const stream = new GridStream();
    const feed = (data: unknown) =>
      handleServerFrame(
        data,
        stream,
        { onGrid: (grid) => grids.push(grid), onExit: (code) => exits.push(code) },
        (msg) => sent.push(msg),
        (code, reason) => closes.push([code, reason]),
      );
    return { grids, exits, sent, closes, feed };
  }

  test("paints and acks a grid, and reports an exit", () => {
    const { grids, exits, sent, closes, feed } = harness();
    feed(gridFrame(0, "a"));
    feed('{"type":"exit","code":7}');
    expect(grids).toHaveLength(1);
    expect(exits).toEqual([7]);
    expect(sent).toEqual([{ type: "ack", seq: 0 }]);
    expect(closes).toEqual([]);
  });

  test("paints the patched grid and acks the patch", () => {
    const { grids, sent, feed } = harness();
    feed(gridFrame(0, "a"));
    feed(patchFrame(1, "b"));
    expect(grids).toHaveLength(2);
    expect(grids[1]!.cells).toEqual([[{ t: "a" }, { t: "b" }]]);
    expect(sent).toEqual([
      { type: "ack", seq: 0 },
      { type: "ack", seq: 1 },
    ]);
  });

  test("asks for a snapshot and paints nothing when a frame was missed", () => {
    const { grids, sent, feed } = harness();
    feed(gridFrame(0, "a"));
    feed(patchFrame(2, "b"));
    feed(patchFrame(3, "c"));
    expect(grids).toHaveLength(1);
    expect(sent).toEqual([{ type: "ack", seq: 0 }, { type: "resync" }]);
  });

  test("closes malformed, unknown, and binary messages with fixed reasons", () => {
    const { sent, closes, feed } = harness();
    feed("{");
    feed('{"type":"unknown"}');
    feed(new Blob(["binary"]));
    expect(closes).toEqual([
      [INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON],
      [INVALID_MESSAGE_CLOSE_CODE, INVALID_MESSAGE_CLOSE_REASON],
      [BINARY_MESSAGE_CLOSE_CODE, BINARY_MESSAGE_CLOSE_REASON],
    ]);
    expect(sent).toEqual([]);
  });
});
