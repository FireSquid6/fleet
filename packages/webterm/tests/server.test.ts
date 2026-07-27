import { describe, expect, test } from "bun:test";
import { FrameSequencer } from "webterm";
import type { FrameDecision, GridMsg, PatchMsg, WireCell, WireCursor } from "webterm";

function grid(rows: string[], cursor: Partial<WireCursor> = {}, cols = rows[0]?.length ?? 0): GridMsg {
  const cells: WireCell[][] = rows.map((row) =>
    Array.from({ length: cols }, (_, c) => {
      const char = row[c] ?? " ";
      return char === " " ? 0 : { t: char };
    }),
  );
  return {
    type: "grid",
    // Deliberately not 0: the sequencer stamps its own `seq` and must ignore this one.
    seq: 99,
    cols,
    rows: rows.length,
    cursor: { x: 0, y: 0, visible: true, ...cursor },
    cells,
  };
}

function sent(decision: FrameDecision): GridMsg | PatchMsg {
  if (decision.kind !== "send") throw new Error(`expected a frame, got "${decision.kind}"`);
  return decision.msg;
}

describe("FrameSequencer", () => {
  test("sends the first frame as a full grid, stamped from zero", () => {
    const sequencer = new FrameSequencer();
    const msg = sent(sequencer.next(grid(["ab"])));
    expect(msg.type).toBe("grid");
    expect(msg.seq).toBe(0);
  });

  test("an unchanged grid is idle and consumes no seq", () => {
    const sequencer = new FrameSequencer();
    sequencer.next(grid(["ab"]));
    expect(sequencer.next(grid(["ab"])).kind).toBe("idle");

    sequencer.ack(0);
    const msg = sent(sequencer.next(grid(["ac"])));
    expect(msg.seq).toBe(1);
  });

  test("a changed grid is a patch carrying only the changed run", () => {
    const sequencer = new FrameSequencer();
    sequencer.next(grid(["abc", "def"]));
    const msg = sent(sequencer.next(grid(["abc", "dXf"])));
    expect(msg).toEqual({
      type: "patch",
      seq: 1,
      cols: 3,
      rows: 2,
      cursor: { x: 0, y: 0, visible: true },
      runs: [[1, 1, [{ t: "X" }]]],
    });
  });

  test("a cursor-only move is a patch with no runs, not idle", () => {
    const sequencer = new FrameSequencer();
    sequencer.next(grid(["ab"]));
    const msg = sent(sequencer.next(grid(["ab"], { x: 1 })));
    expect(msg).toMatchObject({ type: "patch", seq: 1, runs: [], cursor: { x: 1, y: 0, visible: true } });
  });

  test("a cursor color change is a change even when the position holds", () => {
    const sequencer = new FrameSequencer();
    sequencer.next(grid(["ab"], { color: [1, 2, 3] }));
    expect(sequencer.next(grid(["ab"], { color: [1, 2, 4] })).kind).toBe("send");
  });

  test("a dimension change forces a full grid, because applyPatch cannot cross it", () => {
    const sequencer = new FrameSequencer();
    sequencer.next(grid(["ab"]));
    const wider = sent(sequencer.next(grid(["abc"])));
    expect(wider).toMatchObject({ type: "grid", seq: 1, cols: 3, rows: 1 });

    sequencer.ack(1);
    const taller = sent(sequencer.next(grid(["abc", "def"])));
    expect(taller).toMatchObject({ type: "grid", seq: 2, cols: 3, rows: 2 });
  });

  test("blocks once maxUnackedFrames are in flight, and an ack releases it", () => {
    const sequencer = new FrameSequencer({ maxUnackedFrames: 2 });
    expect(sequencer.next(grid(["a."])).kind).toBe("send");
    expect(sequencer.next(grid(["b."])).kind).toBe("send");
    expect(sequencer.next(grid(["c."])).kind).toBe("blocked");
    expect(sequencer.next(grid(["d."])).kind).toBe("blocked");

    sequencer.ack(0);
    const msg = sent(sequencer.next(grid(["e."])));
    // Blocked frames are skipped, not queued: the client gets the newest state.
    expect(msg).toMatchObject({ type: "patch", seq: 2, runs: [[0, 0, [{ t: "e" }]]] });
  });

  test("ignores an ack for a frame that was never sent, and a stale one", () => {
    const sequencer = new FrameSequencer({ maxUnackedFrames: 1 });
    sequencer.next(grid(["a."]));
    sequencer.ack(7);
    expect(sequencer.next(grid(["b."])).kind).toBe("blocked");

    sequencer.ack(0);
    expect(sequencer.next(grid(["b."])).kind).toBe("send");
    sequencer.ack(0);
    expect(sequencer.next(grid(["c."])).kind).toBe("blocked");
  });

  test("blocks while the transport reports congestion", () => {
    let congested = true;
    const sequencer = new FrameSequencer({ congested: () => congested });
    expect(sequencer.next(grid(["a."])).kind).toBe("blocked");
    congested = false;
    expect(sent(sequencer.next(grid(["a."]))).type).toBe("grid");
  });

  test("requestResync forces a full grid and reopens a closed window", () => {
    const sequencer = new FrameSequencer({ maxUnackedFrames: 1 });
    sequencer.next(grid(["a."]));
    expect(sequencer.next(grid(["b."])).kind).toBe("blocked");

    // Without reopening the window this would stay blocked forever: a client
    // that lost sequence has stopped acking.
    sequencer.requestResync();
    expect(sent(sequencer.next(grid(["b."])))).toMatchObject({ type: "grid", seq: 1 });
  });

  test("the ack timeout sends one full snapshot rather than freezing forever", () => {
    let clock = 1_000;
    const sequencer = new FrameSequencer({ maxUnackedFrames: 1, ackTimeoutMs: 5_000, now: () => clock });
    sequencer.next(grid(["a."]));

    clock += 4_999;
    expect(sequencer.next(grid(["b."])).kind).toBe("blocked");

    clock += 1;
    expect(sent(sequencer.next(grid(["b."])))).toMatchObject({ type: "grid", seq: 1 });
    // The valve reopened the window, so the next frame is paced normally again.
    expect(sequencer.next(grid(["c."])).kind).toBe("blocked");
  });
});
