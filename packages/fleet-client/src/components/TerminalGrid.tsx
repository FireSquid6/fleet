import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ClipboardEvent } from "react";
import { ATTR, type GridMsg, type WireCellObject } from "webterm/protocol";
import { resolveColor } from "@/lib/webterm/palette";
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

/** Terminal default colors, read once from the fixed `--color-term-*` palette. */
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

/** Paint a full grid snapshot. The context transform already accounts for DPR. */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  grid: GridMsg,
  metrics: CellMetrics,
  colors: TermColors,
  cursorOn: boolean,
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
      paintCell(ctx, cell, x, y, colEdge(c + 1) - x, h, colors);
    }
  }

  if (grid.cursor.visible && cursorOn) {
    const x = colEdge(grid.cursor.x);
    const y = rowEdge(grid.cursor.y);
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = colors.cursor;
    ctx.fillRect(x, y, colEdge(grid.cursor.x + 1) - x, rowEdge(grid.cursor.y + 1) - y);
    ctx.globalAlpha = 1;
  }
}

function paintCell(
  ctx: CanvasRenderingContext2D,
  cell: WireCellObject,
  x: number,
  y: number,
  cw: number,
  ch: number,
  colors: TermColors,
) {
  const attrs = cell.a ?? 0;
  const inverse = (attrs & ATTR.inverse) !== 0;
  let fg = resolveColor(cell.f, colors.fg);
  let bg = resolveColor(cell.b, colors.bg);
  if (inverse) [fg, bg] = [bg, fg];

  if (bg !== colors.bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, cw, ch);
  }

  if ((attrs & ATTR.invisible) !== 0 || !cell.t) {
    return;
  }

  ctx.globalAlpha = (attrs & ATTR.faint) !== 0 ? 0.55 : 1;
  ctx.font = baseFont((attrs & ATTR.bold) !== 0, (attrs & ATTR.italic) !== 0);
  ctx.fillStyle = fg;
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
 * A live terminal painted on a canvas. Grid snapshots arrive at up to 60fps, so
 * they bypass React state entirely: the newest frame lives in a ref and is drawn
 * on the next animation frame (multiple frames between paints coalesce, which is
 * lossless since each `GridMsg` is a full snapshot). Only the rare status/exit
 * transitions use React state.
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
  const [exitCode, setExitCode] = useState<number | null>(null);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const grid = latestGrid.current;
    const metrics = metricsRef.current;
    const colors = colorsRef.current;
    if (!canvas || !grid || !metrics || !colors) return;
    const ctx = canvas.getContext("2d");
    if (ctx) drawGrid(ctx, grid, metrics, colors, cursorOn.current, dprRef.current);
  }, []);

  const scheduleDraw = useCallback(() => {
    if (rafScheduled.current) return;
    rafScheduled.current = true;
    requestAnimationFrame(() => {
      rafScheduled.current = false;
      paint();
    });
  }, [paint]);

  const { status, send, resize } = useWebterm(repo, name, active, {
    onGrid: (grid) => {
      latestGrid.current = grid;
      scheduleDraw();
    },
    onExit: (code) => setExitCode(code),
  });

  // Reset transient session state whenever we (re)attach.
  useEffect(() => {
    if (active) {
      setExitCode(null);
      latestGrid.current = null;
      lastSize.current = null;
    }
  }, [active, repo, name]);

  // Size the canvas to the container, tell the PTY, and repaint on any change.
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

  // Blink the cursor independently of terminal output.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      cursorOn.current = !cursorOn.current;
      scheduleDraw();
    }, CURSOR_BLINK_MS);
    return () => clearInterval(id);
  }, [active, scheduleDraw]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const bytes = encodeKeyEvent(e);
    if (bytes === null) return;
    e.preventDefault();
    send(bytes);
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    send(e.clipboardData.getData("text"));
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      className="relative min-h-0 flex-1 cursor-text overflow-hidden bg-term-bg px-3 py-2 outline-none focus:ring-1 focus:ring-inset focus:ring-term-line"
    >
      <canvas ref={canvasRef} />
      {(status === "connecting" || status === "closed" || status === "error" || exitCode !== null) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[11.5px] text-term-sys">
          {exitCode !== null
            ? `process exited (code ${exitCode})`
            : status === "connecting"
              ? "connecting…"
              : status === "error"
                ? "connection failed"
                : "disconnected"}
        </div>
      )}
    </div>
  );
}
