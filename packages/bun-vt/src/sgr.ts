/**
 * src/sgr.ts — Select Graphic Rendition (CSI … m) application.
 *
 * Applies a CSI SGR parameter list to a `Pen`, supporting both the classic
 * semicolon form (`38;2;r;g;b`, `38;5;n`) and the ISO 8613-6 colon sub-parameter
 * form (`38:2::r:g:b`, `38:5:n`, `4:3` for underline styles).
 *
 * The two forms are disambiguated by first splitting the flat parameter list
 * into *groups*: consecutive parameters joined by colons form one group; a
 * semicolon starts a new group. Extended-color codes then read either the rest
 * of their own group (colon form) or the following groups (semicolon form).
 */

import { type Pen } from "./cell";
import { DEFAULT_COLOR, palette, rgb, NamedColor } from "./color";

interface Group {
  readonly parts: readonly number[];
}

function toGroups(params: readonly number[], colon: readonly boolean[]): Group[] {
  const groups: Group[] = [];
  let cur: number[] = [];
  for (let i = 0; i < params.length; i++) {
    if (i > 0 && !colon[i]) {
      groups.push({ parts: cur });
      cur = [];
    }
    cur.push(params[i]!);
  }
  if (cur.length > 0 || params.length === 0) groups.push({ parts: cur });
  return groups;
}

/** Interpret a color group's sub-parameters (everything after the 38/48/58 code). */
function colorFromSubParams(sub: readonly number[]) {
  const type = sub[0];
  if (type === 5) {
    return sub.length >= 2 ? palette(sub[1]!) : null;
  }
  if (type === 2) {
    // Either r,g,b (3 following) or colorspace,r,g,b (4 following, colorspace ignored).
    const rest = sub.slice(1);
    if (rest.length >= 4) return rgb(rest[1]!, rest[2]!, rest[3]!);
    if (rest.length >= 3) return rgb(rest[0]!, rest[1]!, rest[2]!);
  }
  return null;
}

export function applySgr(pen: Pen, params: readonly number[], colon: readonly boolean[]): void {
  const groups = toGroups(params, colon);
  // An empty SGR (`CSI m`) means reset.
  if (groups.length === 1 && groups[0]!.parts.length === 0) {
    pen.resetAttributes();
    return;
  }

  for (let gi = 0; gi < groups.length; gi++) {
    const parts = groups[gi]!.parts;
    const code = parts.length === 0 ? 0 : parts[0]!;

    switch (code) {
      case 0:
        pen.resetAttributes();
        break;
      case 1:
        pen.bold = true;
        break;
      case 2:
        pen.faint = true;
        break;
      case 3:
        pen.italic = true;
        break;
      case 4:
        // 4 = single; colon sub-param 4:n selects the underline style (0..5).
        pen.underline = parts.length > 1 ? clampUnderline(parts[1]!) : 1;
        break;
      case 5:
      case 6:
        pen.blink = true;
        break;
      case 7:
        pen.inverse = true;
        break;
      case 8:
        pen.invisible = true;
        break;
      case 9:
        pen.strikethrough = true;
        break;
      case 21:
        pen.underline = 2; // doubly underlined
        break;
      case 22:
        pen.bold = false;
        pen.faint = false;
        break;
      case 23:
        pen.italic = false;
        break;
      case 24:
        pen.underline = 0;
        break;
      case 25:
        pen.blink = false;
        break;
      case 27:
        pen.inverse = false;
        break;
      case 28:
        pen.invisible = false;
        break;
      case 29:
        pen.strikethrough = false;
        break;
      case 38: {
        const c = readExtendedColor(groups, gi, parts);
        if (c.color) pen.fg = c.color;
        gi = c.nextGi;
        break;
      }
      case 39:
        pen.fg = DEFAULT_COLOR;
        break;
      case 48: {
        const c = readExtendedColor(groups, gi, parts);
        if (c.color) pen.bg = c.color;
        gi = c.nextGi;
        break;
      }
      case 49:
        pen.bg = DEFAULT_COLOR;
        break;
      case 53:
        pen.overline = true;
        break;
      case 55:
        pen.overline = false;
        break;
      case 58: {
        // Underline color — consume params but do not store (not modelled).
        const c = readExtendedColor(groups, gi, parts);
        gi = c.nextGi;
        break;
      }
      case 59:
        break; // default underline color
      default:
        if (code >= 30 && code <= 37) pen.fg = palette(code - 30);
        else if (code >= 40 && code <= 47) pen.bg = palette(code - 40);
        else if (code >= 90 && code <= 97) pen.fg = palette(code - 90 + NamedColor.BRIGHT_BLACK);
        else if (code >= 100 && code <= 107) pen.bg = palette(code - 100 + NamedColor.BRIGHT_BLACK);
        break;
    }
  }
}

function clampUnderline(n: number): number {
  return n >= 0 && n <= 5 ? n : 1;
}

/**
 * Read an extended color starting at group `gi` (whose code is 38/48/58).
 * Colon form keeps the type/components inside the same group; semicolon form
 * spreads them across the following single-value groups.
 */
function readExtendedColor(
  groups: readonly Group[],
  gi: number,
  parts: readonly number[],
): { color: ReturnType<typeof palette> | null; nextGi: number } {
  if (parts.length > 1) {
    // Colon form: sub-params live in this group after the code.
    return { color: colorFromSubParams(parts.slice(1)), nextGi: gi };
  }
  // Semicolon form: pull following groups as flat values.
  const type = groups[gi + 1]?.parts[0];
  if (type === 5) {
    const idx = groups[gi + 2]?.parts[0];
    return { color: idx != null ? palette(idx) : null, nextGi: gi + 2 };
  }
  if (type === 2) {
    const r = groups[gi + 2]?.parts[0];
    const g = groups[gi + 3]?.parts[0];
    const b = groups[gi + 4]?.parts[0];
    if (r != null && g != null && b != null) {
      return { color: rgb(r, g, b), nextGi: gi + 4 };
    }
    return { color: null, nextGi: gi + 4 };
  }
  return { color: null, nextGi: gi };
}
