/*
 * ghostty_vt_shim.c
 *
 * Implementation of the flat FFI shim. See ghostty_vt_shim.h for the rationale
 * and ownership contract. This file includes the REAL libghostty-vt headers and
 * translates the by-value struct ABI into scalar/pointer signatures.
 *
 * Built against ghostty-org/ghostty pinned at commit
 *   8642142a3d62beda7b1a9733c23bf11b80c720eb
 * The C API there is explicitly documented as a work-in-progress and unstable;
 * do not assume ABI stability across commits.
 */

/* Static linkage: no dllimport/visibility decoration on the vt symbols, since
 * we link libghostty-vt.a directly into this shared object. */
#define GHOSTTY_STATIC
#include <ghostty/vt.h>

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "ghostty_vt_shim.h"

/* Only our gt_* functions are exported from the shared object; everything from
 * libghostty-vt stays internal (the shim is compiled with -fvisibility=hidden). */
#define GT_EXPORT __attribute__((visibility("default")))

/* Compile-time guarantee that our flat cell struct is exactly 32 bytes so the
 * TypeScript DataView offsets in src/raw.ts stay in sync. */
_Static_assert(sizeof(GtCellInfo) == 32, "GtCellInfo must be 32 bytes");

/* ---- Lifecycle ---------------------------------------------------------- */

GT_EXPORT GtTerminal gt_terminal_new(uint16_t cols, uint16_t rows, size_t max_scrollback) {
  GhosttyTerminal term = NULL;
  GhosttyTerminalOptions opts;
  memset(&opts, 0, sizeof(opts));
  opts.cols = cols;
  opts.rows = rows;
  opts.max_scrollback = max_scrollback;

  GhosttyResult r = ghostty_terminal_new(NULL, &term, opts);
  if (r != GHOSTTY_SUCCESS) return NULL;
  return (GtTerminal)term;
}

GT_EXPORT void gt_terminal_free(GtTerminal term) {
  ghostty_terminal_free((GhosttyTerminal)term);
}

GT_EXPORT void gt_terminal_reset(GtTerminal term) {
  ghostty_terminal_reset((GhosttyTerminal)term);
}

/* ---- Mutation ----------------------------------------------------------- */

GT_EXPORT void gt_terminal_write(GtTerminal term, const uint8_t* data, size_t len) {
  ghostty_terminal_vt_write((GhosttyTerminal)term, data, len);
}

GT_EXPORT int gt_terminal_resize(GtTerminal term,
                                 uint16_t cols,
                                 uint16_t rows,
                                 uint32_t cell_width_px,
                                 uint32_t cell_height_px) {
  return (int)ghostty_terminal_resize((GhosttyTerminal)term, cols, rows,
                                      cell_width_px, cell_height_px);
}

/* ---- Scalar reads ------------------------------------------------------- */

static uint16_t get_u16(GhosttyTerminal term, GhosttyTerminalData key) {
  uint16_t v = 0;
  ghostty_terminal_get(term, key, &v);
  return v;
}

static int get_bool(GhosttyTerminal term, GhosttyTerminalData key) {
  bool v = false;
  ghostty_terminal_get(term, key, &v);
  return v ? 1 : 0;
}

GT_EXPORT uint16_t gt_cols(GtTerminal term) {
  return get_u16((GhosttyTerminal)term, GHOSTTY_TERMINAL_DATA_COLS);
}

GT_EXPORT uint16_t gt_rows(GtTerminal term) {
  return get_u16((GhosttyTerminal)term, GHOSTTY_TERMINAL_DATA_ROWS);
}

GT_EXPORT uint16_t gt_cursor_x(GtTerminal term) {
  return get_u16((GhosttyTerminal)term, GHOSTTY_TERMINAL_DATA_CURSOR_X);
}

GT_EXPORT uint16_t gt_cursor_y(GtTerminal term) {
  return get_u16((GhosttyTerminal)term, GHOSTTY_TERMINAL_DATA_CURSOR_Y);
}

GT_EXPORT int gt_cursor_visible(GtTerminal term) {
  return get_bool((GhosttyTerminal)term, GHOSTTY_TERMINAL_DATA_CURSOR_VISIBLE);
}

GT_EXPORT int gt_cursor_pending_wrap(GtTerminal term) {
  return get_bool((GhosttyTerminal)term, GHOSTTY_TERMINAL_DATA_CURSOR_PENDING_WRAP);
}

/* ---- Cell read ---------------------------------------------------------- */

GT_EXPORT int gt_read_cell(GtTerminal term_, uint16_t x, uint32_t y, GtCellInfo* out) {
  if (out == NULL) return GHOSTTY_INVALID_VALUE;
  memset(out, 0, sizeof(*out));

  GhosttyTerminal term = (GhosttyTerminal)term_;

  /* Resolve an untracked grid reference for the active-area point. */
  GhosttyPoint pt;
  memset(&pt, 0, sizeof(pt));
  pt.tag = GHOSTTY_POINT_TAG_ACTIVE;
  pt.value.coordinate.x = x;
  pt.value.coordinate.y = y;

  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyResult r = ghostty_terminal_grid_ref(term, pt, &ref);
  if (r != GHOSTTY_SUCCESS) return (int)r;

  GhosttyCell cell = 0;
  r = ghostty_grid_ref_cell(&ref, &cell);
  if (r != GHOSTTY_SUCCESS) return (int)r;

  /* Content. */
  uint32_t cp = 0;
  ghostty_cell_get(cell, GHOSTTY_CELL_DATA_CODEPOINT, &cp);
  out->codepoint = cp;

  bool has_text = false;
  ghostty_cell_get(cell, GHOSTTY_CELL_DATA_HAS_TEXT, &has_text);
  out->has_text = has_text ? 1 : 0;

  GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
  ghostty_cell_get(cell, GHOSTTY_CELL_DATA_WIDE, &wide);
  out->wide = (uint8_t)wide;

  GhosttyCellContentTag ctag = GHOSTTY_CELL_CONTENT_CODEPOINT;
  ghostty_cell_get(cell, GHOSTTY_CELL_DATA_CONTENT_TAG, &ctag);
  out->content_tag = (uint8_t)ctag;

  /* Style (fg/bg color + flags). The grid ref is only valid until the next
   * mutating terminal call, but we read it fully right here. */
  GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
  r = ghostty_grid_ref_style(&ref, &style);
  if (r == GHOSTTY_SUCCESS) {
    out->fg_tag     = (uint8_t)style.fg_color.tag;
    out->fg_palette = style.fg_color.value.palette;
    out->fg_r       = style.fg_color.value.rgb.r;
    out->fg_g       = style.fg_color.value.rgb.g;
    out->fg_b       = style.fg_color.value.rgb.b;

    out->bg_tag     = (uint8_t)style.bg_color.tag;
    out->bg_palette = style.bg_color.value.palette;
    out->bg_r       = style.bg_color.value.rgb.r;
    out->bg_g       = style.bg_color.value.rgb.g;
    out->bg_b       = style.bg_color.value.rgb.b;

    out->bold          = style.bold ? 1 : 0;
    out->italic        = style.italic ? 1 : 0;
    out->faint         = style.faint ? 1 : 0;
    out->blink         = style.blink ? 1 : 0;
    out->inverse       = style.inverse ? 1 : 0;
    out->invisible     = style.invisible ? 1 : 0;
    out->strikethrough = style.strikethrough ? 1 : 0;
    out->overline      = style.overline ? 1 : 0;
    out->underline     = (uint8_t)style.underline;
  }

  return GHOSTTY_SUCCESS;
}

/* ---- Build info --------------------------------------------------------- */

GT_EXPORT const char* gt_type_json(void) {
  return ghostty_type_json();
}
