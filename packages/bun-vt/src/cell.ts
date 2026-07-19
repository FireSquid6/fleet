/**
 * src/cell.ts — the cell model.
 *
 * `Cell` is the immutable snapshot returned by `Terminal.cell()`; it mirrors the
 * shape produced by libghostty-bun so this port is a drop-in replacement.
 *
 * `Pen` is the mutable internal storage the grid keeps per cell. It also doubles
 * as the "current graphic rendition" (the active SGR state the cursor writes
 * with): printing copies the cursor's pen into the target cell.
 */

import { type Color, DEFAULT_COLOR, colorsEqual } from "./color";

export type UnderlineStyle =
  | "none"
  | "single"
  | "double"
  | "curly"
  | "dotted"
  | "dashed";

export const UNDERLINE_STYLES: readonly UnderlineStyle[] = [
  "none",
  "single",
  "double",
  "curly",
  "dotted",
  "dashed",
];

/** Width classification of a cell. Wide chars occupy two cells. */
export type CellWidth = "narrow" | "wide" | "spacer_tail" | "spacer_head";

/** Internal wide-flag encoding, matching libghostty's GhosttyCellWide. */
export const Wide = {
  NARROW: 0,
  WIDE: 1,
  SPACER_TAIL: 2,
  SPACER_HEAD: 3,
} as const;

export const WIDE_NAMES: Record<number, CellWidth> = {
  [Wide.NARROW]: "narrow",
  [Wide.WIDE]: "wide",
  [Wide.SPACER_TAIL]: "spacer_tail",
  [Wide.SPACER_HEAD]: "spacer_head",
};

export interface CellStyle {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly faint: boolean;
  readonly blink: boolean;
  readonly inverse: boolean;
  readonly invisible: boolean;
  readonly strikethrough: boolean;
  readonly overline: boolean;
  readonly underline: UnderlineStyle;
}

/** A single terminal grid cell snapshot (public, immutable). */
export interface Cell {
  /** The primary character of the cell, or "" if the cell is empty. */
  readonly char: string;
  /** The primary Unicode scalar value, or 0 if the cell is empty. */
  readonly codepoint: number;
  readonly hasText: boolean;
  readonly width: CellWidth;
  readonly fg: Color;
  readonly bg: Color;
  readonly style: CellStyle;
}

/**
 * Mutable per-cell storage. Kept as a small class (not an object literal) so
 * rows are arrays of homogeneous instances; the grid reuses these in place.
 */
export class Pen {
  cp = 0;
  wide: number = Wide.NARROW;

  fg: Color = DEFAULT_COLOR;
  bg: Color = DEFAULT_COLOR;

  bold = false;
  italic = false;
  faint = false;
  blink = false;
  inverse = false;
  invisible = false;
  strikethrough = false;
  overline = false;
  underline = 0; // index into UNDERLINE_STYLES

  /** Reset text content (glyph + width), preserving graphic rendition. */
  clearGlyph(): void {
    this.cp = 0;
    this.wide = Wide.NARROW;
  }

  /** Reset everything to defaults (blank cell, default attributes). */
  reset(): void {
    this.cp = 0;
    this.wide = Wide.NARROW;
    this.fg = DEFAULT_COLOR;
    this.bg = DEFAULT_COLOR;
    this.bold = false;
    this.italic = false;
    this.faint = false;
    this.blink = false;
    this.inverse = false;
    this.invisible = false;
    this.strikethrough = false;
    this.overline = false;
    this.underline = 0;
  }

  /** Reset only the SGR attributes (used by SGR 0), keeping glyph/width. */
  resetAttributes(): void {
    this.fg = DEFAULT_COLOR;
    this.bg = DEFAULT_COLOR;
    this.bold = false;
    this.italic = false;
    this.faint = false;
    this.blink = false;
    this.inverse = false;
    this.invisible = false;
    this.strikethrough = false;
    this.overline = false;
    this.underline = 0;
  }

  /** Copy graphic rendition (colors + attributes) from another pen. */
  copyAttributesFrom(o: Pen): void {
    this.fg = o.fg;
    this.bg = o.bg;
    this.bold = o.bold;
    this.italic = o.italic;
    this.faint = o.faint;
    this.blink = o.blink;
    this.inverse = o.inverse;
    this.invisible = o.invisible;
    this.strikethrough = o.strikethrough;
    this.overline = o.overline;
    this.underline = o.underline;
  }

  /** Copy the full cell (glyph + width + attributes) from another pen. */
  copyFrom(o: Pen): void {
    this.cp = o.cp;
    this.wide = o.wide;
    this.copyAttributesFrom(o);
  }

  hasSameAttributes(o: Pen): boolean {
    return (
      colorsEqual(this.fg, o.fg) &&
      colorsEqual(this.bg, o.bg) &&
      this.bold === o.bold &&
      this.italic === o.italic &&
      this.faint === o.faint &&
      this.blink === o.blink &&
      this.inverse === o.inverse &&
      this.invisible === o.invisible &&
      this.strikethrough === o.strikethrough &&
      this.overline === o.overline &&
      this.underline === o.underline
    );
  }

  /** Produce the immutable public snapshot for this cell. */
  toCell(): Cell {
    const cp = this.cp;
    return {
      codepoint: cp,
      char: cp === 0 ? "" : String.fromCodePoint(cp),
      hasText: cp !== 0,
      width: WIDE_NAMES[this.wide] ?? "narrow",
      fg: this.fg,
      bg: this.bg,
      style: {
        bold: this.bold,
        italic: this.italic,
        faint: this.faint,
        blink: this.blink,
        inverse: this.inverse,
        invisible: this.invisible,
        strikethrough: this.strikethrough,
        overline: this.overline,
        underline: UNDERLINE_STYLES[this.underline] ?? "none",
      },
    };
  }
}
