/**
 * src/wcwidth.ts — display width of a Unicode scalar value.
 *
 * Returns the number of terminal cells a codepoint occupies:
 *   - 0 for combining marks / zero-width characters,
 *   - 2 for East Asian wide & fullwidth characters and most emoji,
 *   - 1 otherwise.
 *
 * This is a compact implementation covering the ranges that matter for terminal
 * rendering. It is not a full Unicode grapheme segmenter (Ghostty ships a
 * generated table); it is faithful for the common cases — ASCII, CJK, combining
 * marks and emoji — which is what the terminal grid needs to place cells.
 */

type Range = readonly [number, number];

// Zero-width: C0/C1 handled by the caller. These are combining marks and other
// nonspacing/enclosing/format characters that occupy no cell of their own.
const ZERO_WIDTH: readonly Range[] = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0711, 0x0711],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x07eb, 0x07f3],
  [0x0816, 0x0819],
  [0x081b, 0x0823],
  [0x0825, 0x0827],
  [0x0829, 0x082d],
  [0x0859, 0x085b],
  [0x08e3, 0x0902],
  [0x093a, 0x093a],
  [0x093c, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0951, 0x0957],
  [0x0962, 0x0963],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f], // zero-width space, ZWNJ, ZWJ, LRM/RLM
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20f0], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xe0100, 0xe01ef], // variation selectors supplement
];

// Wide (East Asian Wide / Fullwidth) and most emoji presentation ranges.
const WIDE: readonly Range[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a],
  [0x2e80, 0x303e], // CJK radicals, Kangxi, etc.
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK symbols
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f004, 0x1f004], // mahjong red dragon
  [0x1f0cf, 0x1f0cf], // playing card black joker
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f300, 0x1f5ff], // Misc symbols & pictographs
  [0x1f600, 0x1f64f], // emoticons
  [0x1f680, 0x1f6ff], // transport & map
  [0x1f900, 0x1f9ff], // supplemental symbols & pictographs
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // CJK Ext B+
  [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: readonly Range[]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

export function wcwidth(cp: number): 0 | 1 | 2 {
  if (cp === 0) return 0;
  // C0 / C1 controls are not printable; callers handle them, but be safe.
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}
