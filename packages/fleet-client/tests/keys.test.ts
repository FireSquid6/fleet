import { test, expect } from "bun:test";
import { encodeKeyEvent, type KeyEventLike } from "../src/lib/webterm/keys";

function ev(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...partial };
}

test("printable characters pass through", () => {
  expect(encodeKeyEvent(ev({ key: "a" }))).toBe("a");
  expect(encodeKeyEvent(ev({ key: "$" }))).toBe("$");
});

test("named keys map to their escape sequences", () => {
  expect(encodeKeyEvent(ev({ key: "Enter" }))).toBe("\r");
  expect(encodeKeyEvent(ev({ key: "Backspace" }))).toBe("\x7f");
  expect(encodeKeyEvent(ev({ key: "ArrowUp" }))).toBe("\x1b[A");
  expect(encodeKeyEvent(ev({ key: "Home" }))).toBe("\x1b[H");
});

test("Ctrl-letters produce control bytes", () => {
  expect(encodeKeyEvent(ev({ key: "c", ctrlKey: true }))).toBe("\x03");
  expect(encodeKeyEvent(ev({ key: "a", ctrlKey: true }))).toBe("\x01");
});

test("Ctrl with space and symbols produce their control bytes", () => {
  expect(encodeKeyEvent(ev({ key: " ", ctrlKey: true }))).toBe("\x00"); // Ctrl-Space → NUL
  expect(encodeKeyEvent(ev({ key: "@", ctrlKey: true }))).toBe("\x00"); // Ctrl-@ → NUL
  expect(encodeKeyEvent(ev({ key: "[", ctrlKey: true }))).toBe("\x1b"); // Ctrl-[ → ESC
  expect(encodeKeyEvent(ev({ key: "?", ctrlKey: true }))).toBe("\x7f"); // Ctrl-? → DEL
});

test("Alt prefixes printable and simple keys with ESC", () => {
  expect(encodeKeyEvent(ev({ key: "b", altKey: true }))).toBe("\x1bb");
  expect(encodeKeyEvent(ev({ key: "Enter", altKey: true }))).toBe("\x1b\r");
});

test("Shift-Tab is back-tab (CBT), not a plain Tab", () => {
  expect(encodeKeyEvent(ev({ key: "Tab" }))).toBe("\t");
  expect(encodeKeyEvent(ev({ key: "Tab", shiftKey: true }))).toBe("\x1b[Z");
});

test("modified navigation keys use xterm's CSI modifier form", () => {
  expect(encodeKeyEvent(ev({ key: "ArrowLeft", altKey: true }))).toBe("\x1b[1;3D"); // Alt = 3
  expect(encodeKeyEvent(ev({ key: "ArrowUp", shiftKey: true }))).toBe("\x1b[1;2A"); // Shift = 2
  expect(encodeKeyEvent(ev({ key: "End", ctrlKey: true }))).toBe("\x1b[1;5F"); // Ctrl = 5
  expect(encodeKeyEvent(ev({ key: "ArrowRight", ctrlKey: true, shiftKey: true }))).toBe("\x1b[1;6C"); // Ctrl+Shift = 6
});

test("modified tilde keys carry the modifier parameter", () => {
  expect(encodeKeyEvent(ev({ key: "Delete" }))).toBe("\x1b[3~");
  expect(encodeKeyEvent(ev({ key: "Delete", ctrlKey: true }))).toBe("\x1b[3;5~");
  expect(encodeKeyEvent(ev({ key: "PageUp", shiftKey: true }))).toBe("\x1b[5;2~");
});

test("Meta shortcuts and unmapped keys are left to the browser", () => {
  expect(encodeKeyEvent(ev({ key: "v", metaKey: true }))).toBeNull();
  expect(encodeKeyEvent(ev({ key: "Shift" }))).toBeNull();
  expect(encodeKeyEvent(ev({ key: "F5" }))).toBeNull();
});
