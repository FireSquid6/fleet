/**
 * lib/fuzzy.ts — the subsequence matcher behind every type-to-filter list.
 *
 * Hand-rolled because the client carries no search dependency and this is the
 * only place that needs one. Matching is greedy from a fixed starting point, but
 * every occurrence of the query's first character is tried as that starting
 * point and the best-scoring alignment wins. Purely greedy scanning gets the
 * headline case of this feature wrong — `main` against `chore/remove-main-shim`
 * consumes the `m` of "re*m*ove" and scores the branch below one that merely
 * contains those letters scattered — while restarting costs one pass per
 * occurrence of a single character over lists of tens of short strings.
 *
 * It is still not fzf: the alignment after each start is greedy, so a query
 * whose *later* characters could align better elsewhere can be scored low
 * (`ab` against `a-b ab`). That residue is accepted.
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

/**
 * Every candidate is scored against the same query, so a per-character reward
 * would be the same constant on all of them and could not order anything. There
 * is deliberately none: only the bonuses and penalties below decide.
 */
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
  const haystack = text.toLowerCase();
  const first = [...needle][0]!;

  let best: { score: number; spans: [number, number][] } | null = null;
  for (let at = haystack.indexOf(first); at !== -1; at = haystack.indexOf(first, at + 1)) {
    const candidate = alignFrom(haystack, needle, at);
    if (candidate && (best === null || candidate.score > best.score)) best = candidate;
  }
  if (!best) return null;

  // Spans index the lowercased copy, which addresses `text` only while case
  // folding preserves length — U+0130 lowercases to two units and shifts
  // everything after it. Where it does not, the item still ranks; it just
  // highlights nothing, rather than emphasising the wrong characters.
  const ranges = haystack.length === text.length ? mergeSpans(best.spans) : [];
  return { score: best.score - text.length * LENGTH_PENALTY, ranges };
}

/** Greedily place `needle` with its first character pinned at `start`. */
function alignFrom(haystack: string, needle: string, start: number): { score: number; spans: [number, number][] } | null {
  const spans: [number, number][] = [];
  let score = 0;
  // Distance is measured from the last consumed position, starting at the head of
  // the string, so a match far into the text pays for the run-up as well.
  let from = 0;

  for (const character of needle) {
    const at = spans.length === 0 ? start : haystack.indexOf(character, from);
    if (at === -1) return null;

    if (at === from && spans.length > 0) score += CONTIGUOUS_BONUS;
    else score -= Math.min(at - from, MAX_GAP) * GAP_PENALTY;
    if (at === 0) score += START_BONUS;
    else if (SEPARATORS.has(haystack[at - 1]!)) score += SEPARATOR_BONUS;

    // A span, not an index: an astral character is two code units, and half of a
    // surrogate pair renders as U+FFFD.
    spans.push([at, at + character.length]);
    from = at + character.length;
  }

  return { score, spans };
}

/** Collapse ascending, non-overlapping spans into `[start, end)` runs. */
function mergeSpans(spans: [number, number][]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === start) last[1] = end;
    else ranges.push([start, end]);
  }
  return ranges;
}
