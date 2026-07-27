/**
 * lib/fuzzy.ts — the subsequence matcher behind every type-to-filter list.
 *
 * Hand-rolled because the client carries no search dependency and this is the
 * only place that needs one. The matcher is deliberately greedy — each query
 * character takes the first position that can still hold it — rather than the
 * dynamic-programming search fzf runs. Greedy can score an alignment lower than
 * the best one that exists (`ab` against `a-b ab` matches the scattered pair),
 * but the lists it ranks here are a repo's branches and its open issues: tens of
 * short strings, where the cost of being occasionally one rank off is far below
 * the cost of the machinery that avoids it.
 */

/** One item that matched, with the ranges to highlight and its ranking score. */
export interface FuzzyMatch<T> {
  readonly item: T;
  readonly score: number;
  /** `[start, end)` index pairs over the *original* text, adjacent runs merged. */
  readonly ranges: [number, number][];
}

/** Characters after which a match reads as the start of a word. */
const SEPARATORS = new Set(["-", "_", "/", ".", " "]);

const MATCH_SCORE = 1;
/** Paid when a match directly follows the previous one — the strongest signal. */
const CONTIGUOUS_BONUS = 8;
const START_BONUS = 12;
const SEPARATOR_BONUS = 6;
const GAP_PENALTY = 1;
/** Beyond this, extra distance says nothing more than "far away". */
const MAX_GAP = 10;
/** Per haystack character, so a short name outranks a long one that matches as well. */
const LENGTH_PENALTY = 0.01;

/**
 * Rank `items` against `query` by subsequence match, best first. Items that do
 * not contain the query as a subsequence are dropped; an empty query returns
 * every item in input order with no ranges.
 *
 * Ties keep their input order — `Array.prototype.sort` is stable — so a list
 * already in a meaningful order (branches sorted by name) stays that way.
 */
export function fuzzySearch<T>(items: T[], query: string, toText: (item: T) => string): FuzzyMatch<T>[] {
  if (query.length === 0) return items.map((item) => ({ item, score: 0, ranges: [] }));

  const needle = query.toLowerCase();
  const matches: FuzzyMatch<T>[] = [];
  for (const item of items) {
    const scored = scoreText(toText(item), needle);
    if (scored) matches.push({ item, ...scored });
  }
  return matches.sort((a, b) => b.score - a.score);
}

/** Score one haystack against an already-lowercased needle; null when it does not match. */
function scoreText(text: string, needle: string): { score: number; ranges: [number, number][] } | null {
  // Indices are taken on the lowercased copy but reported against `text`, which
  // holds because case folding is length-preserving for the ASCII-ish branch
  // names and issue titles these lists carry.
  const haystack = text.toLowerCase();
  const indices: number[] = [];
  let score = -text.length * LENGTH_PENALTY;
  let from = 0;
  let previous = -1;

  for (const character of needle) {
    const at = haystack.indexOf(character, from);
    if (at === -1) return null;

    score += MATCH_SCORE;
    if (previous !== -1 && at === previous + 1) score += CONTIGUOUS_BONUS;
    else score -= Math.min(at - from, MAX_GAP) * GAP_PENALTY;
    if (at === 0) score += START_BONUS;
    else if (SEPARATORS.has(haystack[at - 1]!)) score += SEPARATOR_BONUS;

    indices.push(at);
    previous = at;
    from = at + character.length;
  }

  return { score, ranges: mergeRanges(indices) };
}

/**
 * Cut `ranges` at index `at`, rebasing the right-hand side to 0 — for a row that
 * renders one matched string as two differently styled pieces. A range straddling
 * the cut is split across both sides.
 */
export function splitRanges(
  ranges: [number, number][],
  at: number,
): [[number, number][], [number, number][]] {
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (const [start, end] of ranges) {
    if (start < at) left.push([start, Math.min(end, at)]);
    if (end > at) right.push([Math.max(start, at) - at, end - at]);
  }
  return [left, right];
}

/** Collapse ascending match indices into `[start, end)` runs. */
function mergeRanges(indices: number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const index of indices) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === index) last[1] = index + 1;
    else ranges.push([index, index + 1]);
  }
  return ranges;
}
