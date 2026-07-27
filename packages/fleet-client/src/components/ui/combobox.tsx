import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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
 * The list is **portalled into `document.body` and positioned `fixed`** against
 * the input's viewport rect. Its only home is inside a `Modal`, and the two
 * simpler options each break there: absolutely positioned inside the panel it is
 * clipped, because the panel is `overflow-hidden` and its body `overflow-y-auto`
 * and any non-`visible` overflow ancestor clips an out-of-flow descendant; laid
 * out in normal flow it is not clipped, but then its *presence* sets the height
 * of everything below it, so unmounting it on blur reflows the panel between a
 * mousedown and its mouseup and the click lands somewhere else entirely — on the
 * backdrop, in the worst case, discarding the form. Portalled and fixed, it is
 * neither clipped nor part of any layout.
 *
 * Two consequences of the portal, both relied upon:
 * - React routes events through the *React* tree, not the DOM tree, so a click on
 *   a row still passes through `Modal`'s panel handler and is stopped there — it
 *   cannot reach the backdrop's `onClose`.
 * - The rows are no longer inside the `<label>` that wraps the field, so nothing
 *   forwards a row click on to the input.
 *
 * Rows are chosen on `click`, not `mousedown`: the list-level mousedown guard
 * keeps focus on the input, so the list is guaranteed to still be mounted when
 * mouseup arrives and the click resolves to the row itself.
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
  /**
   * Shown in place of the list when nothing matches. Leaving it undefined keeps
   * the list off screen entirely, which is how a caller that is still loading
   * says "I have nothing to report yet".
   */
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
  const [placement, setPlacement] = useState<ListPlacement | null>(null);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Whether the current active row was reached by keyboard; see the scroll effect. */
  const arrowedRef = useRef(false);
  /** Last pointer position seen over the list, so hover reacts to movement only. */
  const pointerRef = useRef({ x: -1, y: -1 });

  const matches = useMemo(() => fuzzySearch(items, value, toText), [items, value, toText]);
  const activeIndex = active < 0 || matches.length === 0 ? -1 : Math.min(active, matches.length - 1);
  const showList = open && (matches.length > 0 || (!allowFreeText && emptyMessage !== undefined));

  useEffect(() => {
    if (!showList) {
      setPlacement(null);
      return;
    }
    const update = () => {
      const input = inputRef.current;
      if (!input) return;
      const next = placeList(input.getBoundingClientRect(), window.innerHeight);
      // Keeping the old object when nothing moved matters: this runs on every
      // scroll event, and `placement` is what re-renders the list and re-triggers
      // the scroll-into-view effect below.
      setPlacement((previous) => (previous && samePlacement(previous, next) ? previous : next));
    };
    update();
    // Capture phase: `scroll` does not bubble, and the modal's own body is a
    // scroll container, so a listener on `window` only sees it on the way down.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [showList]);

  useEffect(() => {
    // Only arrow keys scroll. Doing it on hover too makes a partially visible row
    // slide out from under a stationary pointer, whose hover on the row that
    // replaced it scrolls again — the list walks itself to the end.
    if (!arrowedRef.current) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, placement]);

  /** Close the list, leaving no keyboard state behind to fire on the next open. */
  const close = useCallback(() => {
    arrowedRef.current = false;
    setOpen(false);
  }, []);

  const resetActive = useCallback(() => {
    arrowedRef.current = false;
    setActive(defaultActive(allowFreeText));
  }, [allowFreeText]);

  const select = useCallback(
    (item: T) => {
      close();
      onSelect(item);
    },
    [close, onSelect],
  );

  /** Hover follows the pointer, but only once the pointer has actually moved. */
  const hover = (event: MouseEvent, index: number) => {
    const { clientX, clientY } = event;
    if (pointerRef.current.x === clientX && pointerRef.current.y === clientY) return;
    pointerRef.current = { x: clientX, y: clientY };
    arrowedRef.current = false;
    setActive(index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") {
      close();
      return;
    }
    // Escape and Enter are only claimed while the list is actually on screen, so
    // that a key with nothing to act on still reaches the modal and the form.
    if (event.key === "Escape") {
      if (!showList) return;
      event.preventDefault();
      event.stopPropagation();
      close();
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
      close();
    }
  };

  return (
    <>
      <Input
        ref={inputRef}
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
          resetActive();
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onKeyDown={onKeyDown}
        // Mono only: the size stays whatever `Input` sets, so the field lines up
        // with the plain inputs above it.
        className="font-mono"
      />

      {showList &&
        placement &&
        createPortal(
          <ul
            id={listId}
            role="listbox"
            ref={listRef}
            style={placementStyle(placement)}
            // On the list rather than each row: a mousedown anywhere in it —
            // including on its scrollbar — would otherwise blur the input, and
            // unmount the list out from under the click that is still coming.
            onMouseDown={(event) => event.preventDefault()}
            onMouseLeave={resetActive}
            // Above the modal backdrop's own z-50; as a later sibling of the app
            // root it would otherwise still lose to a positioned z-indexed layer.
            className="fixed z-[60] overflow-y-auto rounded-md border border-line bg-panel py-1 shadow-xl"
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
                  onClick={() => select(match.item)}
                  onMouseMove={(event) => hover(event, index)}
                  className={cn(
                    "cursor-pointer px-3 py-[5px] font-mono text-[11.5px] text-dim",
                    index === activeIndex && "bg-panel2 text-text",
                  )}
                >
                  {renderItem ? renderItem(match.item, match.ranges) : highlight(toText(match.item), match.ranges)}
                </li>
              ))
            )}
          </ul>,
          document.body,
        )}
    </>
  );
}

/** Tallest the list gets before it scrolls. */
const LIST_MAX_HEIGHT = 200;
/** Shortest it is allowed to be squeezed to, rather than vanish in a cramped viewport. */
const LIST_MIN_HEIGHT = 96;
/** Breathing room between the input and the list, and against the viewport edge. */
const LIST_GAP = 6;
const VIEWPORT_MARGIN = 8;

/** Where a portalled list sits: `offset` is from the viewport's top, or its bottom when flipped. */
export interface ListPlacement {
  readonly anchor: "below" | "above";
  readonly offset: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
}

/**
 * Place the list against the input's viewport rect. It goes below unless there is
 * both too little room there and more room above — flipping on the second
 * condition alone would move the list for no gain.
 */
export function placeList(
  rect: { top: number; bottom: number; left: number; width: number },
  viewportHeight: number,
): ListPlacement {
  const below = viewportHeight - rect.bottom - LIST_GAP - VIEWPORT_MARGIN;
  const above = rect.top - LIST_GAP - VIEWPORT_MARGIN;
  const fit = (space: number) => Math.max(LIST_MIN_HEIGHT, Math.min(LIST_MAX_HEIGHT, space));

  if (below < LIST_MAX_HEIGHT && above > below) {
    return {
      anchor: "above",
      offset: viewportHeight - rect.top + LIST_GAP,
      left: rect.left,
      width: rect.width,
      maxHeight: fit(above),
    };
  }
  return {
    anchor: "below",
    offset: rect.bottom + LIST_GAP,
    left: rect.left,
    width: rect.width,
    maxHeight: fit(below),
  };
}

function samePlacement(a: ListPlacement, b: ListPlacement): boolean {
  return (
    a.anchor === b.anchor &&
    a.offset === b.offset &&
    a.left === b.left &&
    a.width === b.width &&
    a.maxHeight === b.maxHeight
  );
}

/**
 * A placement as inline style. `offset` is a different edge in each direction, so
 * which property it lands on is the whole point — the flipped list must be
 * anchored by its *bottom*, since its height is not known until it has rendered.
 */
export function placementStyle(placement: ListPlacement): CSSProperties {
  const box = { left: placement.left, width: placement.width, maxHeight: placement.maxHeight };
  return placement.anchor === "below" ? { ...box, top: placement.offset } : { ...box, bottom: placement.offset };
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
