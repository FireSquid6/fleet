/**
 * test/parser.test.ts — the VT500 parser state machine in isolation.
 */

import { test, expect, describe } from "bun:test";
import { Parser, type CsiSequence, type EscSequence } from "../src/parser";

interface Recorder {
  events: string[];
  parser: Parser;
  feed(s: string | number[]): void;
}

function recorder(): Recorder {
  const events: string[] = [];
  const parser = new Parser({
    print: (cp) => events.push(`print:${cp}`),
    execute: (c) => events.push(`exec:${c}`),
    csiDispatch: (s: CsiSequence) =>
      events.push(`csi:${s.prefix}|${s.params.join(",")}|${s.colon.map((b) => (b ? 1 : 0)).join(",")}|${s.intermediates}|${s.final}`),
    escDispatch: (s: EscSequence) => events.push(`esc:${s.intermediates}|${s.final}`),
    oscDispatch: (d) => events.push(`osc:${d}`),
    dcsHook: (s) => events.push(`dcs_hook:${s.params.join(",")}|${s.intermediates}|${s.final}`),
    dcsPut: (b) => events.push(`dcs_put:${b}`),
    dcsUnhook: () => events.push("dcs_unhook"),
  });
  return {
    events,
    parser,
    feed(s) {
      const bytes = typeof s === "string" ? new TextEncoder().encode(s) : Uint8Array.from(s);
      parser.write(bytes);
    },
  };
}

describe("printing & control", () => {
  test("plain ASCII prints codepoints", () => {
    const r = recorder();
    r.feed("Hi");
    expect(r.events).toEqual(["print:72", "print:105"]);
  });

  test("C0 controls execute", () => {
    const r = recorder();
    r.feed("\r\n\t\b");
    expect(r.events).toEqual(["exec:13", "exec:10", "exec:9", "exec:8"]);
  });

  test("DEL is ignored in ground", () => {
    const r = recorder();
    r.feed([0x41, 0x7f, 0x42]);
    expect(r.events).toEqual(["print:65", "print:66"]);
  });
});

describe("CSI parsing", () => {
  test("simple params and final", () => {
    const r = recorder();
    r.feed("\x1b[1;2;3m");
    expect(r.events).toEqual(["csi:|1,2,3|0,0,0||m"]);
  });

  test("empty parameter list", () => {
    const r = recorder();
    r.feed("\x1b[m");
    expect(r.events).toEqual(["csi:||||m"]);
  });

  test("empty leading param becomes 0", () => {
    const r = recorder();
    r.feed("\x1b[;5H");
    expect(r.events).toEqual(["csi:|0,5|0,0||H"]);
  });

  test("private prefix captured", () => {
    const r = recorder();
    r.feed("\x1b[?25l");
    expect(r.events).toEqual(["csi:?|25|0||l"]);
  });

  test("colon sub-parameters flagged", () => {
    const r = recorder();
    r.feed("\x1b[4:3m");
    expect(r.events).toEqual(["csi:|4,3|0,1||m"]);
  });

  test("intermediate bytes captured (DECSCUSR)", () => {
    const r = recorder();
    r.feed("\x1b[1 q");
    expect(r.events).toEqual(["csi:|1|0| |q"]);
  });

  test("control bytes execute mid-sequence without aborting", () => {
    const r = recorder();
    r.feed("\x1b[1\r2m");
    expect(r.events).toEqual(["exec:13", "csi:|12|0||m"]);
  });

  test("CAN aborts a sequence", () => {
    const r = recorder();
    r.feed("\x1b[1\x18m");
    expect(r.events).toEqual(["print:109"]); // 'm' printed in ground after abort
  });

  test("too many params → dispatch dropped", () => {
    const r = recorder();
    r.feed("\x1b[" + Array(40).fill("1").join(";") + "m");
    expect(r.events).toEqual([]);
  });
});

describe("ESC dispatch", () => {
  test("plain ESC final", () => {
    const r = recorder();
    r.feed("\x1bM");
    expect(r.events).toEqual(["esc:|M"]);
  });

  test("ESC with intermediate (charset designation)", () => {
    const r = recorder();
    r.feed("\x1b(B");
    expect(r.events).toEqual(["esc:(|B"]);
  });
});

describe("OSC", () => {
  test("BEL-terminated OSC", () => {
    const r = recorder();
    r.feed("\x1b]0;hello\x07");
    expect(r.events).toEqual(["osc:0;hello"]);
  });

  test("ST-terminated OSC (ESC \\)", () => {
    const r = recorder();
    r.feed("\x1b]2;title\x1b\\");
    expect(r.events).toEqual(["osc:2;title"]);
  });

  test("UTF-8 inside OSC decodes", () => {
    const r = recorder();
    r.feed("\x1b]0;café\x07");
    expect(r.events).toEqual(["osc:0;café"]);
  });
});

describe("DCS", () => {
  test("hook / put / unhook", () => {
    const r = recorder();
    // Fed as raw bytes so the C1 ST (0x9C) stays a single byte rather than
    // being UTF-8 encoded. Final byte of the hook is '|' (0x7C).
    r.feed([0x1b, 0x50, 0x31, 0x3b, 0x32, 0x7c, 0x61, 0x62, 0x63, 0x9c]);
    expect(r.events).toEqual([
      "dcs_hook:1,2|||",
      "dcs_put:97",
      "dcs_put:98",
      "dcs_put:99",
      "dcs_unhook",
    ]);
  });
});

describe("UTF-8 decoding", () => {
  test("2-byte and 3-byte and 4-byte scalars", () => {
    const r = recorder();
    r.feed("é世🎉"); // U+00E9, U+4E16, U+1F389
    expect(r.events).toEqual(["print:233", "print:19990", "print:127881"]);
  });

  test("invalid continuation emits replacement char", () => {
    const r = recorder();
    r.feed([0xe4, 0x41]); // lead expects 2 continuations, gets 'A'
    expect(r.events).toEqual(["print:65533", "print:65"]);
  });

  test("stray continuation byte emits replacement", () => {
    const r = recorder();
    r.feed([0x80, 0x41]);
    expect(r.events).toEqual(["print:65533", "print:65"]);
  });
});
