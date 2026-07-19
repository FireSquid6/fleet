/**
 * palette.ts — resolve a `WireColor` (the wire form from `webterm/protocol`) to a
 * CSS color string for the canvas renderer.
 *
 * The 256-color table is the xterm standard: 16 ANSI colors, then a 6×6×6 color
 * cube (indices 16–231), then a 24-step grayscale ramp (232–255). The first 16
 * are tuned to the app's terminal palette (see `--color-term-*` in globals.css)
 * so agent output sits in the same hues as the surrounding chrome.
 */

import type { WireColor } from "webterm/protocol";

/** ANSI 0–15: 8 normal + 8 bright, matched to the `--color-term-*` design hues. */
const ANSI_16 = [
  "#0a0d10", // black       (term-bg)
  "#f85149", // red         (term-err)
  "#3fb950", // green       (term-cmd)
  "#d29922", // yellow      (term-warn)
  "#58a6ff", // blue        (term-agent)
  "#bc8cff", // magenta
  "#39c5cf", // cyan
  "#c9d1d9", // white       (term-out)
  "#6e7681", // bright black (term-sys)
  "#ff7b72", // bright red
  "#56d364", // bright green
  "#e3b341", // bright yellow
  "#79c0ff", // bright blue
  "#d2a8ff", // bright magenta
  "#56d4dd", // bright cyan
  "#f0f6fc", // bright white
];

/** The six per-channel levels of the 6×6×6 xterm color cube. */
const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

function buildPalette(): string[] {
  const table = [...ANSI_16];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        table.push(`rgb(${CUBE_STEPS[r]},${CUBE_STEPS[g]},${CUBE_STEPS[b]})`);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    table.push(`rgb(${v},${v},${v})`);
  }
  return table;
}

export const PALETTE_256 = buildPalette();

/**
 * Resolve a cell color to CSS. An absent color (`undefined`) falls back to the
 * terminal's default fg/bg; a `number` indexes {@link PALETTE_256}; a `[r,g,b]`
 * tuple is true color.
 */
export function resolveColor(
  color: WireColor | undefined,
  fallback: string,
): string {
  if (color === undefined) return fallback;
  if (typeof color === "number") return PALETTE_256[color] ?? fallback;
  const [r, g, b] = color;
  return `rgb(${r},${g},${b})`;
}
