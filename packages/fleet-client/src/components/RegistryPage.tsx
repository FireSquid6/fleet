import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Trash2 } from "lucide-react";

export const COLS = "1fr 1.6fr 110px 34px";

export function RegistryPage<T>({
  glyph,
  title,
  blurb,
  newLabel,
  onNew,
  columns,
  cols,
  empty,
  rows,
  rowKey,
  onDelete,
  renderRow,
  children,
}: {
  glyph: string;
  title: string;
  blurb: string;
  newLabel: string;
  onNew?: () => void;
  columns: ReactNode;
  cols: string;
  empty: string;
  rows: readonly T[];
  rowKey: (row: T) => string;
  onDelete?: (row: T) => void;
  renderRow: (row: T) => ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="px-4 pb-16 pt-5 sm:px-[30px] sm:pb-[60px] sm:pt-[28px]">
      <Link to="/" className="font-mono text-[11px] font-medium text-dim transition-colors hover:text-text">
        ← bridge
      </Link>

      <div className="mb-[22px] mt-[14px] flex flex-wrap items-start justify-between gap-[18px]">
        <div>
          <h1 className="font-mono text-[22px] font-bold text-text">{`${glyph} ${title}`}</h1>
          <p className="mt-2 font-prose text-[12.5px] text-dim">{blurb}</p>
        </div>
        {onNew && (
          <button
            type="button"
            onClick={onNew}
            className="rounded-md border border-line bg-panel px-[14px] py-[8px] font-mono text-[11px] font-semibold text-text transition-colors hover:bg-panel2"
          >
            {newLabel}
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-md border border-line bg-panel">
        <div
          className="hidden gap-3 bg-bg px-4 py-[10px] font-mono text-[9px] font-semibold tracking-[.14em] text-dim2 md:grid"
          style={{ gridTemplateColumns: cols }}
        >
          {columns}
          <span />
        </div>

        {rows.length === 0 && (
          <div className="border-t border-line px-4 py-[18px] font-mono text-[11px] text-dim2">{empty}</div>
        )}

        {rows.map((row) => {
          const key = rowKey(row);
          return (
            <div
              key={key}
              className="relative flex flex-col gap-1.5 border-t border-line px-4 py-[13px] font-mono md:grid md:items-center md:gap-3"
              style={{ gridTemplateColumns: cols }}
            >
              {renderRow(row)}
              {onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(row)}
                  aria-label={`Delete ${key}`}
                  className="absolute right-2 top-2 flex items-center justify-center rounded p-2 text-dim2 transition-colors hover:bg-panel2 hover:text-red-400 md:static md:p-[5px]"
                >
                  <Trash2 className="size-[15px]" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {children}
    </div>
  );
}
