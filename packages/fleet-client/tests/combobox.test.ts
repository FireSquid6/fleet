/**
 * combobox.test.ts — the pure parts of the picker: where the highlight moves,
 * what Enter means, and how a matched string is cut in two for a row that styles
 * its halves differently. The component around them cannot be rendered here —
 * this package has no DOM harness — so everything that can be a function is one.
 */

import { describe, expect, test } from "bun:test";
import { enterAction, moveActive, splitRanges } from "../src/components/ui/combobox";

describe("moveActive", () => {
  test("arrives at the first row going down and the last going up", () => {
    expect(moveActive(-1, 4, 1)).toBe(0);
    expect(moveActive(-1, 4, -1)).toBe(3);
  });

  test("wraps at both ends", () => {
    expect(moveActive(3, 4, 1)).toBe(0);
    expect(moveActive(0, 4, -1)).toBe(3);
  });

  test("steps one row at a time in between", () => {
    expect(moveActive(1, 4, 1)).toBe(2);
    expect(moveActive(2, 4, -1)).toBe(1);
  });

  test("an index left over from a longer list is clamped before it moves", () => {
    expect(moveActive(9, 3, -1)).toBe(1);
    expect(moveActive(9, 3, 1)).toBe(0);
  });

  test("an empty list has nothing to highlight", () => {
    expect(moveActive(-1, 0, 1)).toBe(-1);
    expect(moveActive(2, 0, -1)).toBe(-1);
  });
});

describe("enterAction", () => {
  test("takes the highlighted row when there is one", () => {
    expect(enterAction(0, 3, true)).toBe("select");
    expect(enterAction(2, 3, false)).toBe("select");
  });

  test("with nothing highlighted, free text submits what was typed", () => {
    // The bug this prevents: with a row pre-highlighted, typing a branch name
    // that does not exist yet and pressing Enter silently swaps in the closest
    // existing branch, and the next Enter creates a workspace on *that*.
    expect(enterAction(-1, 3, true)).toBe("submit");
    expect(enterAction(-1, 0, true)).toBe("submit");
  });

  test("with nothing highlighted and no free text, Enter only dismisses", () => {
    expect(enterAction(-1, 3, false)).toBe("dismiss");
    expect(enterAction(-1, 0, false)).toBe("dismiss");
  });
});

describe("splitRanges", () => {
  test("sends each range to its side and rebases the right one", () => {
    expect(
      splitRanges(
        [
          [0, 2],
          [5, 7],
        ],
        3,
      ),
    ).toEqual([[[0, 2]], [[2, 4]]]);
  });

  test("a range straddling the cut appears on both sides", () => {
    expect(splitRanges([[1, 5]], 3)).toEqual([[[1, 3]], [[0, 2]]]);
  });

  test("a range touching the cut stays whole, with no zero-width leftover", () => {
    // What `IssueRow` hits when the query matches the space after the number.
    expect(splitRanges([[3, 5]], 3)).toEqual([[], [[0, 2]]]);
    expect(splitRanges([[1, 3]], 3)).toEqual([[[1, 3]], []]);
  });

  test("a cut past the end or at zero leaves one side empty", () => {
    expect(splitRanges([[1, 3]], 10)).toEqual([[[1, 3]], []]);
    expect(splitRanges([[1, 3]], 0)).toEqual([[], [[1, 3]]]);
  });
});
