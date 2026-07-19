/**
 * src/color.ts — terminal color model.
 *
 * A cell foreground/background color is a tagged union, mirroring how
 * libghostty-vt models `style.Color`:
 *   - `default` — use the terminal default (no explicit color set).
 *   - `palette` — an index 0..255 into the 256-color palette. Indices 0..15 are
 *     the named ANSI colors (index 1 == red), 16..231 the 6×6×6 color cube, and
 *     232..255 the grayscale ramp.
 *   - `rgb` — a 24-bit true color.
 *
 * SGR 30–37 / 90–97 (and the bg equivalents) select *palette* colors, not RGB —
 * so `\x1b[31m` yields `{ type: "palette", index: 1 }`, matching Ghostty.
 */

export type Color =
  | { readonly type: "default" }
  | { readonly type: "palette"; readonly index: number }
  | { readonly type: "rgb"; readonly r: number; readonly g: number; readonly b: number };

export const DEFAULT_COLOR: Color = { type: "default" };

/** Named ANSI palette indices (0..15). SGR 31 (red) maps to index 1. */
export const NamedColor = {
  BLACK: 0,
  RED: 1,
  GREEN: 2,
  YELLOW: 3,
  BLUE: 4,
  MAGENTA: 5,
  CYAN: 6,
  WHITE: 7,
  BRIGHT_BLACK: 8,
  BRIGHT_RED: 9,
  BRIGHT_GREEN: 10,
  BRIGHT_YELLOW: 11,
  BRIGHT_BLUE: 12,
  BRIGHT_MAGENTA: 13,
  BRIGHT_CYAN: 14,
  BRIGHT_WHITE: 15,
} as const;

export function palette(index: number): Color {
  return { type: "palette", index: index & 0xff };
}

export function rgb(r: number, g: number, b: number): Color {
  return { type: "rgb", r: r & 0xff, g: g & 0xff, b: b & 0xff };
}

export function colorsEqual(a: Color, b: Color): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "default":
      return true;
    case "palette":
      return a.index === (b as { index: number }).index;
    case "rgb": {
      const o = b as { r: number; g: number; b: number };
      return a.r === o.r && a.g === o.g && a.b === o.b;
    }
  }
}

/**
 * The default 256-color palette as packed RGB values, matching xterm/Ghostty's
 * defaults. Index 0..15 are the standard ANSI colors, 16..231 the color cube,
 * 232..255 the grayscale ramp. Exposed for consumers that need to resolve a
 * palette index to concrete RGB; the terminal itself keeps colors symbolic.
 */
export const DEFAULT_PALETTE: readonly (readonly [number, number, number])[] = buildDefaultPalette();

function buildDefaultPalette(): (readonly [number, number, number])[] {
  const p: (readonly [number, number, number])[] = [];

  // 0..15: standard ANSI colors (xterm defaults).
  const base: [number, number, number][] = [
    [0x00, 0x00, 0x00],
    [0x80, 0x00, 0x00],
    [0x00, 0x80, 0x00],
    [0x80, 0x80, 0x00],
    [0x00, 0x00, 0x80],
    [0x80, 0x00, 0x80],
    [0x00, 0x80, 0x80],
    [0xc0, 0xc0, 0xc0],
    [0x80, 0x80, 0x80],
    [0xff, 0x00, 0x00],
    [0x00, 0xff, 0x00],
    [0xff, 0xff, 0x00],
    [0x00, 0x00, 0xff],
    [0xff, 0x00, 0xff],
    [0x00, 0xff, 0xff],
    [0xff, 0xff, 0xff],
  ];
  for (const c of base) p.push(c);

  // 16..231: 6×6×6 color cube.
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        p.push([steps[r]!, steps[g]!, steps[b]!]);
      }
    }
  }

  // 232..255: grayscale ramp.
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p.push([v, v, v]);
  }

  return p;
}
