import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { fuzzySearch } from "@/lib/fuzzy";
import { Input } from "@/components/ui/input";

/**
 * ui/combobox.tsx — a controlled "type to filter, pick from a list" input.
 *
 * Generic over the item because the create-workspace modal needs the same
 * behaviour twice, over branches and over issues. Filtering is
 * {@link fuzzySearch}, done once per render and handed to `renderItem` as the
 * ranges to highlight, so the list rendering never re-derives the match.
 *
 * The list is rendered **in normal flow**, not absolutely positioned. Its only
 * home is inside a `Modal`, whose panel is `overflow-hidden` and whose body is
 * `overflow-y-auto`: any non-`visible` overflow ancestor clips an out-of-flow
 * descendant, so a floating list would be cut off with no way to reach the rest
 * of it. In flow it simply lengthens the modal body, which already knows how to
 * scroll. It costs the actions below being pushed down while the list is open.
 *
 * It lives inside a `<form>` and inside that `Modal`, both of which claim the
 * keys a dropdown needs: Enter would submit the form and Escape would close the
 * modal (whose listener is on `window`, so stopping the native event's
 * propagation inside React's handler — React dispatches from the root container,
 * below `window` — is what keeps it from firing). Both are intercepted here only
 * while the list is on screen; otherwise the form and the modal keep their keys.
 *
 * Deliberately not a full ARIA dialog/listbox widget: like `Modal` it stays
 * proportionate to an app with no competing overlays.
 */

interface ComboboxProps<T> {
  /** The text in the input. Free text is the user's, not a mirror of the selection. */
  value: string;
  onValueChange: (value: string) => void;
  items: T[];
  /** What to fuzzy-match against, and what the default row renders. */
  toText: (item: T) => string;
  toKey: (item: T) => string;
  renderItem?: (item: T, ranges: [number, number][]) => ReactNode;
  onSelect: (item: T) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Shown in place of the list when nothing matches; suppressed under `allowFreeText`. */
  emptyMessage?: ReactNode;
  /**
   * Typing something no item matches is a legal value in its own right (a branch
   * name that does not exist yet). It suppresses the empty message, and it stops
   * the list from pre-highlighting a row — see {@link enterAction}.
   */
  allowFreeText?: boolean;
}

export function Combobox<T>({
  value,
  onValueChange,
  items,
  toText,
  toKey,
  renderItem,
  onSelect,
  placeholder,
  disabled,
  emptyMessage,
  allowFreeText,
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => defaultActive(allowFreeText));
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  /** Whether the current active row was reached by keyboard; see the scroll effect. */
  const arrowedRef = useRef(false);

  const matches = useMemo(() => fuzzySearch(items, value, toText), [items, value, toText]);
  const activeIndex = active < 0 || matches.length === 0 ? -1 : Math.min(active, matches.length - 1);
  const showList = open && (matches.length > 0 || (!allowFreeText && emptyMessage !== undefined));

  useEffect(() => {
    // Only arrow keys scroll. Doing it on hover too makes a partially visible row
    // slide out from under a stationary pointer, whose `mouseenter` on the row
    // that replaced it scrolls again — the list walks itself to the end.
    if (!arrowedRef.current) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, showList]);

  const select = useCallback(
    (item: T) => {
      setOpen(false);
      onSelect(item);
    },
    [onSelect],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    // Escape and Enter are only claimed while the list is actually on screen, so
    // that a key with nothing to act on still reaches the modal and the form.
    if (event.key === "Escape") {
      if (!showList) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      arrowedRef.current = true;
      setActive((current) => moveActive(current, matches.length, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter" && showList) {
      const action = enterAction(activeIndex, matches.length, Boolean(allowFreeText));
      if (action === "select") {
        event.preventDefault();
        select(matches[activeIndex]!.item);
        return;
      }
      // "submit" falls through with the list closed: the typed text is the value,
      // and swallowing the key would make the user press Enter twice.
      if (action === "dismiss") event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Input
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          onValueChange(event.target.value);
          setActive(defaultActive(allowFreeText));
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        // Mono only: the size stays whatever `Input` sets, so the field lines up
        // with the plain inputs above it.
        className="font-mono"
      />

      {showList && (
        <ul
          id={listId}
          role="listbox"
          ref={listRef}
          // On the list rather than each row: a mousedown anywhere in it —
          // including on its scrollbar, which is needed past ~7 rows — would
          // otherwise blur the input and close the list mid-drag.
          onMouseDown={(event) => event.preventDefault()}
          className="max-h-[200px] overflow-y-auto rounded-md border border-line bg-panel py-1"
        >
          {matches.length === 0 ? (
            <li role="presentation" className="px-3 py-[6px] font-mono text-[11px] text-dim2">
              {emptyMessage}
            </li>
          ) : (
            matches.map((match, index) => (
              <li
                key={toKey(match.item)}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                data-active={index === activeIndex ? "true" : undefined}
                onMouseDown={() => select(match.item)}
                onMouseEnter={() => {
                  arrowedRef.current = false;
                  setActive(index);
                }}
                className={cn(
                  "cursor-pointer px-3 py-[5px] font-mono text-[11.5px] text-dim",
                  index === activeIndex && "bg-panel2 text-text",
                )}
              >
                {renderItem ? renderItem(match.item, match.ranges) : highlight(toText(match.item), match.ranges)}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Where the highlight starts, and returns after every edit. Free text mode starts
 * at nothing highlighted (`-1`): with a row pre-selected, typing a new branch name
 * and pressing Enter would replace it with the closest existing branch instead of
 * committing what was typed.
 */
function defaultActive(allowFreeText: boolean | undefined): number {
  return allowFreeText ? -1 : 0;
}

/** Where ArrowDown/ArrowUp move from `current`; `-1` means nothing is highlighted. */
export function moveActive(current: number, count: number, step: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (Math.min(current, count - 1) + step + count) % count;
}

/**
 * What Enter means with the list on screen: take the highlighted row, let the
 * form submit the text as typed, or just close a list that has nothing to offer.
 */
export type EnterAction = "select" | "submit" | "dismiss";

export function enterAction(activeIndex: number, matchCount: number, allowFreeText: boolean): EnterAction {
  if (activeIndex >= 0 && matchCount > 0) return "select";
  return allowFreeText ? "submit" : "dismiss";
}

/** Text with the matched ranges emphasised — the default row, and reusable in a custom one. */
export function highlight(text: string, ranges: [number, number][]): ReactNode {
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <span key={start} className="font-semibold text-accent">
        {text.slice(start, end)}
      </span>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/**
 * Cut `ranges` at index `at`, rebasing the right-hand side to 0 — for a row that
 * renders one matched string as two differently styled pieces. A range straddling
 * the cut is split across both sides; one ending or starting exactly on it stays
 * whole, so neither side is handed a zero-width range to render.
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
