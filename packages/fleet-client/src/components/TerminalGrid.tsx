import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ClipboardEvent, type FocusEvent } from "react";
import { ATTR, type GridMsg, type WireCellObject } from "webterm/protocol";
import { resolveColor } from "@/lib/webterm/palette";
import { drawCellGlyph } from "@/lib/webterm/glyphs";
import { encodeKeyEvent } from "@/lib/webterm/keys";
import { useWebterm } from "@/data/useWebterm";

const FONT_SIZE = 13;
// The "Mono" Nerd Font variant keeps icon/powerline glyphs single-cell, so the
// grid stays aligned. Falls back to plain JetBrains Mono if it isn't installed.
const FONT_FAMILY = '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", ui-monospace, monospace';
const LINE_HEIGHT = 1.4;
const CURSOR_BLINK_MS = 530;

interface CellMetrics {
  width: number;
  height: number;
}

interface TermColors {
  fg: string;
  bg: string;
  cursor: string;
}

function readColors(el: HTMLElement): TermColors {
  const s = getComputedStyle(el);
  const get = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    fg: get("--color-term-out", "#c9d1d9"),
    bg: get("--color-term-bg", "#0a0d10"),
    cursor: get("--color-term-cmd", "#3fb950"),
  };
}

function baseFont(bold: boolean, italic: boolean): string {
  return `${italic ? "italic " : ""}${bold ? "bold " : ""}${FONT_SIZE}px ${FONT_FAMILY}`;
}

/**
 * Only keys aimed at the container itself belong to the PTY: without this guard,
 * Enter/Space on the takeover button would be swallowed (`encodeKeyEvent` maps
 * them, and the `preventDefault` cancels the button's synthesized click).
 */
function ownEvent(e: { target: EventTarget; currentTarget: EventTarget }): boolean {
  return e.target === e.currentTarget;
}

export type CursorRender = "hidden" | "solid" | "outline";

/**
 * The single source of truth for the blink condition: both the renderer and the
 * blink timer ask this, so a timer tick can never disagree with what the next
 * frame would paint. `blinking` is optional on the wire and defaults to on.
 */
export function cursorBlinks(cursor: GridMsg["cursor"], focused: boolean): boolean {
  return cursor.visible && focused && (cursor.blinking ?? true);
}

/**
 * Decide the cursor's appearance. The outline signals "this terminal does not
 * have keyboard focus", so it wins over the terminal's own blink/shape settings
 * — but never over `visible`: an app that hid the cursor (DECTCEM) stays hidden
 * whether or not we are focused.
 */
export function cursorRender(
  cursor: GridMsg["cursor"],
  focused: boolean,
  cursorOn: boolean,
): CursorRender {
  if (!cursor.visible) return "hidden";
  if (!focused) return "outline";
  if (!cursorBlinks(cursor, focused)) return "solid";
  return cursorOn ? "solid" : "hidden";
}

/** The context transform already accounts for DPR. */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  grid: GridMsg,
  metrics: CellMetrics,
  colors: TermColors,
  cursorOn: boolean,
  focused: boolean,
  dpr: number,
) {
  const { width: cw, height: ch } = metrics;

  // Snap every cell boundary to a whole device pixel. Cell widths are fractional
  // (a glyph advance is rarely a round number), so drawing rects at `col * cw`
  // lands their edges mid-pixel; the anti-aliased edges of two abutting rects
  // don't sum to full coverage and the background bleeds through as a hairline
  // seam. Sharing one rounded edge between neighbours makes them tile exactly.
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const colEdge = (c: number) => snap(c * cw);
  const rowEdge = (r: number) => snap(r * ch);

  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, colEdge(grid.cols), rowEdge(grid.rows));
  ctx.textBaseline = "top";

  for (let r = 0; r < grid.rows; r++) {
    const row = grid.cells[r];
    if (!row) continue;
    const y = rowEdge(r);
    const h = rowEdge(r + 1) - y;
    for (let c = 0; c < grid.cols; c++) {
      const cell = row[c];
      if (cell === 0 || cell === undefined) continue;
      const x = colEdge(c);
      paintCell(ctx, cell, x, y, colEdge(c + 1) - x, h, colors, dpr);
    }
  }

  const render = cursorRender(grid.cursor, focused, cursorOn);
  if (render !== "hidden") {
    const x = colEdge(grid.cursor.x);
    const y = rowEdge(grid.cursor.y);
    const w = colEdge(grid.cursor.x + 1) - x;
    const h = rowEdge(grid.cursor.y + 1) - y;
    const px = (size: number) => Math.max(1, Math.round(size * dpr)) / dpr;
    const cursorColor = resolveColor(grid.cursor.color, colors.cursor);

    if (render === "outline") {
      const thickness = px(1);
      ctx.strokeStyle = cursorColor;
      ctx.lineWidth = thickness;
      // `strokeRect` centers the stroke on the path, so a rect on the exact cell
      // edges would spill half its width into the neighbouring cells. Insetting
      // by half the (whole-device-pixel) thickness lands it inside the cell and
      // on pixel boundaries, so it stays crisp at any DPR.
      ctx.strokeRect(x + thickness / 2, y + thickness / 2, w - thickness, h - thickness);
    } else {
      ctx.fillStyle = cursorColor;
      switch (grid.cursor.shape ?? "block") {
        case "block": {
          ctx.fillRect(x, y, w, h);
          const cell = grid.cells[grid.cursor.y]?.[grid.cursor.x];
          if (cell) {
            const { bg } = cellColors(cell, colors);
            paintCellGlyph(ctx, cell, x, y, w, h, bg, dpr);
          }
          break;
        }
        case "underline": {
          const thickness = px(h / 10);
          ctx.fillRect(x, y + h - thickness, w, thickness);
          break;
        }
        case "bar": {
          const thickness = px(w / 6);
          ctx.fillRect(x, y, thickness, h);
          break;
        }
      }
    }
  }
}

function cellColors(cell: WireCellObject, colors: TermColors): { fg: string; bg: string } {
  const inverse = ((cell.a ?? 0) & ATTR.inverse) !== 0;
  let fg = resolveColor(cell.f, colors.fg);
  let bg = resolveColor(cell.b, colors.bg);
  if (inverse) [fg, bg] = [bg, fg];
  return { fg, bg };
}

function paintCell(
  ctx: CanvasRenderingContext2D,
  cell: WireCellObject,
  x: number,
  y: number,
  cw: number,
  ch: number,
  colors: TermColors,
  dpr: number,
) {
  const { fg, bg } = cellColors(cell, colors);

  if (bg !== colors.bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, cw, ch);
  }

  paintCellGlyph(ctx, cell, x, y, cw, ch, fg, dpr);
}

function paintCellGlyph(
  ctx: CanvasRenderingContext2D,
  cell: WireCellObject,
  x: number,
  y: number,
  cw: number,
  ch: number,
  fg: string,
  dpr: number,
) {
  const attrs = cell.a ?? 0;

  if ((attrs & ATTR.invisible) !== 0 || !cell.t) {
    return;
  }

  ctx.globalAlpha = (attrs & ATTR.faint) !== 0 ? 0.55 : 1;
  ctx.fillStyle = fg;

  const code = cell.t.codePointAt(0);
  if (code !== undefined && drawCellGlyph(ctx, code, x, y, cw, ch, dpr)) {
    ctx.globalAlpha = 1;
    return;
  }

  ctx.font = baseFont((attrs & ATTR.bold) !== 0, (attrs & ATTR.italic) !== 0);
  ctx.fillText(cell.t, x, y + (ch - FONT_SIZE) / 2);

  if (cell.u || (attrs & ATTR.strikethrough) !== 0 || (attrs & ATTR.overline) !== 0) {
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1;
    if (cell.u) line(ctx, x, y + ch - 1.5, cw);
    if ((attrs & ATTR.strikethrough) !== 0) line(ctx, x, y + ch / 2, cw);
    if ((attrs & ATTR.overline) !== 0) line(ctx, x, y + 0.5, cw);
  }
  ctx.globalAlpha = 1;
}

function line(ctx: CanvasRenderingContext2D, x: number, y: number, w: number) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();
}

/**
 * Grid snapshots arrive at up to 60fps, so they bypass React state entirely: the
 * newest frame lives in a ref and is drawn on the next animation frame (multiple
 * frames between paints coalesce, which is lossless since each `GridMsg` is a
 * full snapshot). Only the rare status/exit transitions use React state.
 */
export function TerminalGrid({ repo, name, active }: { repo: string; name: string; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latestGrid = useRef<GridMsg | null>(null);
  const rafScheduled = useRef(false);
  const metricsRef = useRef<CellMetrics | null>(null);
  const colorsRef = useRef<TermColors | null>(null);
  const lastSize = useRef<{ cols: number; rows: number } | null>(null);
  const dprRef = useRef(1);
  const cursorOn = useRef(true);
  const elementFocused = useRef(false);
  const windowFocused = useRef(true);
  const [exitCode, setExitCode] = useState<number | null>(null);

  // Keystrokes only reach the PTY when this element holds focus *and* the window
  // is the one the OS is delivering keys to; a focused element in a background
  // window is exactly the "where is my typing going?" case issue #14 is about.
  //
  // The two refs are independent and combined with AND, so browsers that *also*
  // fire an element blur on window deactivation are handled by either path in
  // whichever order the events arrive; the repaints coalesce into one frame.
  const focused = useCallback(() => elementFocused.current && windowFocused.current, []);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const grid = latestGrid.current;
    const metrics = metricsRef.current;
    const colors = colorsRef.current;
    if (!canvas || !grid || !metrics || !colors) return;
    const ctx = canvas.getContext("2d");
    if (ctx) drawGrid(ctx, grid, metrics, colors, cursorOn.current, focused(), dprRef.current);
  }, [focused]);

  const scheduleDraw = useCallback(() => {
    if (rafScheduled.current) return;
    rafScheduled.current = true;
    requestAnimationFrame(() => {
      rafScheduled.current = false;
      paint();
    });
  }, [paint]);

  const { status, send, resize, takeover } = useWebterm(repo, name, active, {
    onGrid: (grid) => {
      latestGrid.current = grid;
      cursorOn.current = true;
      scheduleDraw();
    },
    onExit: (code) => setExitCode(code),
  });

  useEffect(() => {
    if (active) {
      setExitCode(null);
      latestGrid.current = null;
      lastSize.current = null;
      cursorOn.current = true;
    }
  }, [active, repo, name]);

  // Focus state that no event will tell us about: the window may already be in
  // the background on mount, and window-level focus changes never surface as
  // focusin/focusout on the element. Seeding from the DOM also keeps the element
  // half honest if a future caller autofocuses the container before this runs.
  useEffect(() => {
    elementFocused.current = document.activeElement === containerRef.current;
    windowFocused.current = document.hasFocus();

    const onWindowFocus = () => {
      // Re-read the element too: a browser that fires an element blur on window
      // deactivation but no matching focus on reactivation would otherwise leave
      // `elementFocused` stuck false. This is the only moment it can drift.
      elementFocused.current = document.activeElement === containerRef.current;
      windowFocused.current = true;
      cursorOn.current = true;
      scheduleDraw();
    };
    const onWindowBlur = () => {
      windowFocused.current = false;
      scheduleDraw();
    };
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    scheduleDraw();
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [active, scheduleDraw]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || !active) return;

    colorsRef.current = readColors(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const measure = (): CellMetrics => {
      ctx.font = baseFont(false, false);
      return { width: ctx.measureText("M").width, height: Math.ceil(FONT_SIZE * LINE_HEIGHT) };
    };

    const apply = (cssW: number, cssH: number) => {
      const metrics = measure();
      metricsRef.current = metrics;
      const cols = Math.max(1, Math.floor(cssW / metrics.width));
      const rows = Math.max(1, Math.floor(cssH / metrics.height));
      const last = lastSize.current;
      if (last && last.cols === cols && last.rows === rows) return;
      lastSize.current = { cols, rows };

      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      canvas.width = Math.round(cols * metrics.width * dpr);
      canvas.height = Math.round(rows * metrics.height * dpr);
      canvas.style.width = `${cols * metrics.width}px`;
      canvas.style.height = `${rows * metrics.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      resize(cols, rows);
      scheduleDraw();
    };

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) apply(rect.width, rect.height);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [active, resize, scheduleDraw]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      const grid = latestGrid.current;
      // Parking `cursorOn` at true (rather than just skipping the toggle) means
      // regaining focus starts a fresh blink cycle from a drawn cursor instead
      // of resuming mid-off.
      if (!grid || !cursorBlinks(grid.cursor, focused())) {
        cursorOn.current = true;
        return;
      }
      cursorOn.current = !cursorOn.current;
      scheduleDraw();
    }, CURSOR_BLINK_MS);
    return () => clearInterval(id);
  }, [active, focused, scheduleDraw]);

  // The conflict overlay owns the keyboard as well as the pointer: its button is
  // the only way out, and swallowing keys here would trap focus on the container
  // (`encodeKeyEvent` maps Tab and Shift-Tab, so `preventDefault` would cancel
  // the browser's focus move and leave the button unreachable). Only `"conflict"`
  // gets this — during `"connecting"` there is no competing control, and eating
  // Tab is the correct terminal behaviour. The socket is closed in `"conflict"`,
  // so `send` was already a no-op; the released `preventDefault` is the point.
  const keysBelongToPty = status !== "conflict";

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!ownEvent(e) || !keysBelongToPty) return;
    const bytes = encodeKeyEvent(e);
    if (bytes === null) return;
    e.preventDefault();
    send(bytes);
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!ownEvent(e) || !keysBelongToPty) return;
    e.preventDefault();
    send(e.clipboardData.getData("text"));
  };

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (!ownEvent(e)) return;
    elementFocused.current = true;
    cursorOn.current = true;
    scheduleDraw();
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!ownEvent(e)) return;
    elementFocused.current = false;
    scheduleDraw();
  };

  const statusMessage =
    exitCode !== null
      ? `process exited (code ${exitCode})`
      : status === "connecting"
        ? "connecting…"
        : status === "superseded"
          ? "this terminal was taken over by another connection"
          : status === "error"
            ? "connection failed"
            : status === "closed"
              ? "disconnected"
              : null;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={onFocus}
      onBlur={onBlur}
      className="relative min-h-0 flex-1 cursor-text overflow-hidden bg-term-bg px-3 py-2 outline-none focus:ring-1 focus:ring-inset focus:ring-term-line"
    >
      <canvas ref={canvasRef} />
      {status === "conflict" && exitCode === null ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-[15px] bg-term-bg p-10 text-center">
          <div className="max-w-[360px] font-mono text-[11.5px] leading-[1.6] text-term-sys">
            Another connection exists. Would you like to close it and connect yourself?
          </div>
          <button
            type="button"
            onClick={takeover}
            className="rounded-[4px] bg-accent px-5 py-[9px] font-mono text-[12px] font-bold text-[#06140b] transition-[filter] hover:brightness-110"
          >
            ▸ Close it and connect
          </button>
        </div>
      ) : (
        statusMessage !== null && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[11.5px] text-term-sys">
            {statusMessage}
          </div>
        )
      )}
    </div>
  );
}
