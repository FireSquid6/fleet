import { describe, expect, test } from "bun:test";
import {
  TERMINAL_CONFLICT_CLOSE_CODE,
  TERMINAL_TAKEOVER_CLOSE_CODE,
  INVALID_MESSAGE_CLOSE_CODE,
} from "webterm/protocol";
import { attachCloseOutcome } from "../src/attach";

describe("attach close reporting", () => {
  test("explains a refused attach and fails the command", () => {
    const outcome = attachCloseOutcome(TERMINAL_CONFLICT_CLOSE_CODE, "repo/ws-1");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.message).toContain("repo/ws-1");
    expect(outcome.message).toContain("already attached elsewhere");
  });

  test("explains being evicted by another client", () => {
    const outcome = attachCloseOutcome(TERMINAL_TAKEOVER_CLOSE_CODE, "repo/ws-1");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.message).toContain("took over repo/ws-1");
  });

  test("stays silent and succeeds on an ordinary close", () => {
    for (const code of [1000, 1001, 1006, INVALID_MESSAGE_CLOSE_CODE]) {
      expect(attachCloseOutcome(code, "repo/ws-1")).toEqual({ exitCode: 0 });
    }
  });
});
