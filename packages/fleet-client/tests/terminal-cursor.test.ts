import { test, expect } from "bun:test";
import type { WireCursor, WireCursorShape } from "webterm/protocol";
import { cursorRender } from "../src/components/TerminalGrid";

const SHAPES: (WireCursorShape | undefined)[] = [undefined, "block", "underline", "bar"];

function cursor(partial: Partial<WireCursor> = {}): WireCursor {
  return { x: 0, y: 0, visible: true, ...partial };
}

test("a hidden cursor draws nothing in either focus state", () => {
  for (const focused of [true, false]) {
    for (const cursorOn of [true, false]) {
      expect(cursorRender(cursor({ visible: false }), focused, cursorOn)).toBe("hidden");
      expect(cursorRender(cursor({ visible: false, blinking: false }), focused, cursorOn)).toBe("hidden");
    }
  }
});

test("an unfocused visible cursor is always an outline, whatever its shape", () => {
  for (const shape of SHAPES) {
    for (const blinking of [true, false, undefined]) {
      for (const cursorOn of [true, false]) {
        expect(cursorRender(cursor({ shape, blinking }), false, cursorOn)).toBe("outline");
      }
    }
  }
});

test("a focused blinking cursor follows the blink phase", () => {
  expect(cursorRender(cursor({ blinking: true }), true, true)).toBe("solid");
  expect(cursorRender(cursor({ blinking: true }), true, false)).toBe("hidden");
});

test("blinking defaults to true when the server omits it", () => {
  expect(cursorRender(cursor(), true, true)).toBe("solid");
  expect(cursorRender(cursor(), true, false)).toBe("hidden");
});

test("a focused non-blinking cursor is solid in both blink phases", () => {
  for (const shape of SHAPES) {
    expect(cursorRender(cursor({ shape, blinking: false }), true, true)).toBe("solid");
    expect(cursorRender(cursor({ shape, blinking: false }), true, false)).toBe("solid");
  }
});

test("focus never resurrects a hidden cursor and blur never hides a visible one", () => {
  expect(cursorRender(cursor({ visible: false }), true, true)).toBe("hidden");
  expect(cursorRender(cursor({ visible: true, blinking: true }), false, false)).toBe("outline");
});
