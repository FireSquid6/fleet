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

// Kept as a class (not an object literal) so rows are arrays of homogeneous
// instances; the grid reuses these in place rather than reallocating.
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
