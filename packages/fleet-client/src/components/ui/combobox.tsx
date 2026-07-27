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
 * It lives inside a `<form>` and inside a `Modal`, both of which claim the keys a
 * dropdown needs: Enter would submit the form and Escape would close the modal
 * (whose listener is on `window`, so stopping the native event's propagation
 * inside React's handler — React dispatches from the root container, below
 * `window` — is what keeps it from firing). Both are intercepted here only while
 * the list is on screen; otherwise the form and the modal keep their own keys.
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
   * name that does not exist yet), so an empty result set closes the list quietly
   * instead of reporting that nothing was found.
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
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => fuzzySearch(items, value, toText), [items, value, toText]);
  const activeIndex = matches.length === 0 ? -1 : Math.min(active, matches.length - 1);
  const showList = open && (matches.length > 0 || (!allowFreeText && emptyMessage !== undefined));

  useEffect(() => {
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
      if (matches.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => {
        const from = Math.min(current, matches.length - 1);
        return (from + step + matches.length) % matches.length;
      });
      return;
    }
    if (event.key === "Enter" && showList) {
      event.preventDefault();
      const item = matches[activeIndex];
      if (item) select(item.item);
      else setOpen(false);
    }
  };

  return (
    <div className="relative">
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
          setActive(0);
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
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-[200px] overflow-y-auto rounded-md border border-line bg-panel py-1 shadow-xl"
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
                // mousedown, not click: it fires before the input's blur, and
                // preventing its default keeps focus (and so the list) in place
                // long enough for the selection to register.
                onMouseDown={(event) => {
                  event.preventDefault();
                  select(match.item);
                }}
                onMouseEnter={() => setActive(index)}
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
