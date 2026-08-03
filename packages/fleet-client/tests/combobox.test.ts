/**
 * combobox.test.ts — the pure parts of the picker: where the highlight moves,
 * what Enter means, where the portalled list is placed against the input, and how
 * a matched string is cut in two for a row that styles its halves differently.
 * The component around them cannot be rendered here — this package has no DOM
 * harness — so everything that can be a function is one.
 */

import { describe, expect, test } from "bun:test";
import { enterAction, moveActive, placeList, placementStyle, splitRanges } from "../src/components/ui/combobox";

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

describe("placeList", () => {
  /** An input 300px wide, 36px tall, with its top edge at `top`. */
  const inputAt = (top: number) => ({ top, bottom: top + 36, left: 40, width: 300 });

  test("sits below the input, matching its width and left edge", () => {
    const placement = placeList(inputAt(100), 800);

    expect(placement).toEqual({ anchor: "below", offset: 142, left: 40, width: 300, maxHeight: 200 });
  });

  test("flips above when the room below is short and there is more above", () => {
    // 700px down a 800px viewport: 58px below, 686px above.
    const placement = placeList(inputAt(700), 800);

    expect(placement.anchor).toBe("above");
    // Measured from the viewport's bottom edge, so the list ends above the input.
    expect(placement.offset).toBe(106);
    expect(placement.maxHeight).toBe(200);
  });

  test("stays below when neither side fits but below is the roomier one", () => {
    const placement = placeList(inputAt(120), 300);

    expect(placement.anchor).toBe("below");
    expect(placement.maxHeight).toBeGreaterThan(0);
  });

  test("takes only the room it has, and never less than a usable minimum", () => {
    // Near the top of a short viewport: flipping would be worse, so it takes
    // what is below — 170px of it, not the full 200.
    expect(placeList(inputAt(20), 240)).toMatchObject({ anchor: "below", maxHeight: 170 });

    // Cramped on both sides: still a usable list rather than a zero-height one.
    expect(placeList(inputAt(20), 100).maxHeight).toBe(96);
  });

  test("style anchors by the top going down and by the bottom going up", () => {
    // A flipped list cannot be anchored by its top: its height is not known
    // until it has rendered.
    const below = placementStyle(placeList(inputAt(100), 800));
    expect(below).toEqual({ left: 40, width: 300, maxHeight: 200, top: 142 });
    expect("bottom" in below).toBe(false);

    const above = placementStyle(placeList(inputAt(700), 800));
    expect(above).toEqual({ left: 40, width: 300, maxHeight: 200, bottom: 106 });
    expect("top" in above).toBe(false);
  });

  test("a tall viewport never flips", () => {
    for (let top = 0; top < 900; top += 50) {
      expect(placeList(inputAt(top), 1000).anchor).toBe(top + 36 + 14 + 200 <= 1000 ? "below" : "above");
    }
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
