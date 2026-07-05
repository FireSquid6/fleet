/*
 * ghostty_vt_shim.h
 *
 * A thin C shim over libghostty-vt's C API, exposing a *flat*, FFI-friendly
 * surface that bun:ffi can bind directly.
 *
 * Why a shim?
 * -----------
 * The real libghostty-vt C API passes several structs *by value*:
 *   - ghostty_terminal_new() takes GhosttyTerminalOptions by value
 *   - ghostty_terminal_grid_ref() takes GhosttyPoint by value
 * bun:ffi's dlopen cannot pass or return structs by value; it only handles
 * scalars and pointers. This shim absorbs the by-value ABI on the C side and
 * re-exports only scalar/pointer signatures, so the TypeScript bindings never
 * have to reconstruct a C struct layout across the FFI boundary.
 *
 * This is the sanctioned "thin C shim that statically links vt and re-exports
 * the needed symbols" fallback. It links libghostty-vt statically, so the
 * produced shared library is self-contained.
 *
 * Ownership summary (see each function for details):
 *   - gt_terminal_new()  returns an OWNED handle. Caller must gt_terminal_free().
 *   - All other pointers/handles are borrowed and owned by the terminal or the
 *     caller-provided buffer; nothing else must be freed across the boundary.
 */

#ifndef GHOSTTY_VT_SHIM_H
#define GHOSTTY_VT_SHIM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Opaque terminal handle. This is exactly GhosttyTerminal (an opaque pointer),
 * re-typed to void* so the header has no dependency on the vt headers for
 * consumers that only read this file.
 */
typedef void* GtTerminal;

/*
 * Flat, fixed-layout cell snapshot filled by gt_read_cell().
 *
 * IMPORTANT: This layout is defined by THIS shim (not by libghostty-vt) using
 * only fixed-width fields with explicit padding, so it is ABI-stable across
 * platforms and can be parsed byte-for-byte by a DataView in TypeScript. The
 * matching offsets are mirrored in src/raw.ts (CELL_INFO_* constants).
 *
 * Total size: 32 bytes.
 *
 * Color fields: a style color is a tagged union in libghostty-vt. `*_tag` is
 * one of GtStyleColorTag. When tag == GT_COLOR_PALETTE only `*_palette` is
 * meaningful; when tag == GT_COLOR_RGB only `*_r/_g/_b` are meaningful. Because
 * palette and rgb overlap in the source union, `*_palette` and `*_r` alias the
 * same source byte; always branch on the tag.
 */
typedef struct {
  uint32_t codepoint;     /* offset 0:  primary Unicode scalar (0 if empty)      */
  uint8_t  has_text;      /* offset 4:  1 if the cell has renderable text        */
  uint8_t  wide;          /* offset 5:  GtCellWide (0 narrow,1 wide,2/3 spacer)  */
  uint8_t  content_tag;   /* offset 6:  GtCellContentTag                         */
  uint8_t  _pad0;         /* offset 7                                            */

  uint8_t  fg_tag;        /* offset 8:  GtStyleColorTag                          */
  uint8_t  fg_palette;    /* offset 9:  palette index (tag==palette)             */
  uint8_t  fg_r;          /* offset 10: red   (tag==rgb)                         */
  uint8_t  fg_g;          /* offset 11: green (tag==rgb)                         */
  uint8_t  fg_b;          /* offset 12: blue  (tag==rgb)                         */

  uint8_t  bg_tag;        /* offset 13: GtStyleColorTag                          */
  uint8_t  bg_palette;    /* offset 14                                          */
  uint8_t  bg_r;          /* offset 15                                          */
  uint8_t  bg_g;          /* offset 16                                          */
  uint8_t  bg_b;          /* offset 17                                          */

  uint8_t  bold;          /* offset 18 */
  uint8_t  italic;        /* offset 19 */
  uint8_t  faint;         /* offset 20 */
  uint8_t  blink;         /* offset 21 */
  uint8_t  inverse;       /* offset 22 */
  uint8_t  invisible;     /* offset 23 */
  uint8_t  strikethrough; /* offset 24 */
  uint8_t  overline;      /* offset 25 */
  uint8_t  underline;     /* offset 26: SGR underline style (0..5)               */
  uint8_t  _pad[5];       /* offset 27..31 */
} GtCellInfo;

/* ---- Lifecycle ---------------------------------------------------------- */

/*
 * Create a terminal of `cols` x `rows` with `max_scrollback` scrollback lines.
 * Uses the default allocator (NULL).
 *
 * Returns an OWNED handle on success, or NULL on failure (bad args / OOM).
 * The caller owns the returned handle and MUST release it with
 * gt_terminal_free(). Pairs 1:1 with gt_terminal_free().
 */
GtTerminal gt_terminal_new(uint16_t cols, uint16_t rows, size_t max_scrollback);

/*
 * Free a terminal handle previously returned by gt_terminal_new().
 * Safe to call with NULL (no-op). After this call the handle is invalid.
 */
void gt_terminal_free(GtTerminal term);

/* Full reset (RIS). Dimensions are preserved. NULL is a no-op. */
void gt_terminal_reset(GtTerminal term);

/* ---- Mutation ----------------------------------------------------------- */

/*
 * Feed raw VT bytes to the parser. `data` is BORROWED for the duration of the
 * call only; the shim/vt copies whatever it needs into terminal state. The
 * caller retains ownership of `data` and may free/reuse it after this returns.
 * Never fails (malformed input is handled internally).
 */
void gt_terminal_write(GtTerminal term, const uint8_t* data, size_t len);

/*
 * Resize the terminal. `cell_width_px`/`cell_height_px` are the pixel size of a
 * single cell (used for image/size reports; pass e.g. 1x1 if you don't care).
 * Returns a GtResult code (0 == success).
 */
int gt_terminal_resize(GtTerminal term,
                       uint16_t cols,
                       uint16_t rows,
                       uint32_t cell_width_px,
                       uint32_t cell_height_px);

/* ---- Scalar reads ------------------------------------------------------- */

/* Current column count (width in cells). */
uint16_t gt_cols(GtTerminal term);
/* Current row count (height in cells). */
uint16_t gt_rows(GtTerminal term);
/* Cursor column (0-indexed) within the active area. */
uint16_t gt_cursor_x(GtTerminal term);
/* Cursor row (0-indexed) within the active area. */
uint16_t gt_cursor_y(GtTerminal term);
/* 1 if the cursor is visible (DEC mode 25), else 0. */
int gt_cursor_visible(GtTerminal term);
/* 1 if the next print will soft-wrap (pending wrap), else 0. */
int gt_cursor_pending_wrap(GtTerminal term);

/* ---- Cell read ---------------------------------------------------------- */

/*
 * Read the cell at active-area coordinate (x=col, y=row) into `out`.
 * `out` is a CALLER-OWNED buffer of at least sizeof(GtCellInfo) (32) bytes;
 * the shim fills it in place and borrows nothing. Returns a GtResult (0 ==
 * success). On any error the fields of `out` are zeroed.
 *
 * The underlying grid reference is an untracked snapshot used only within this
 * call, so there is no dangling reference after return.
 */
int gt_read_cell(GtTerminal term, uint16_t x, uint32_t y, GtCellInfo* out);

/* ---- Build info --------------------------------------------------------- */

/*
 * Returns a pointer to a static, NUL-terminated string describing struct
 * layouts for the current target (libghostty-vt's ghostty_type_json()).
 * The pointer is valid for the process lifetime and MUST NOT be freed.
 * Exposed for debugging / ABI verification in tests.
 */
const char* gt_type_json(void);

#ifdef __cplusplus
}
#endif

#endif /* GHOSTTY_VT_SHIM_H */
