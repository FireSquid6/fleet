/**
 * examples/basic.ts — runnable demo of the libghostty-vt bindings.
 *
 *   bun run examples/basic.ts
 *
 * Requires the native lib to be built first:  bun run scripts/build.ts
 */

import { Terminal, PINNED_COMMIT } from "../src/index";

console.log(`libghostty-vt @ ${PINNED_COMMIT.slice(0, 12)}\n`);

// `using` frees the terminal automatically at end of scope.
using term = new Terminal({ cols: 80, rows: 24 });

// Feed a stream: red "hi", then move the cursor and draw a green "OK".
term.write("\x1b[31mhi");            // SGR 31 = red fg, print "hi"
term.write("\x1b[3;5H");             // CUP: move cursor to row 3, col 5 (1-based)
term.write("\x1b[32mOK\x1b[0m");     // green "OK", then reset

// Read back a couple of cells.
const h = term.cell(0, 0);
const i = term.cell(0, 1);
console.log(`cell(0,0) = ${JSON.stringify(h.char)}  fg=${fmtColor(h.fg)}`);
console.log(`cell(0,1) = ${JSON.stringify(i.char)}  fg=${fmtColor(i.fg)}`);

const o = term.cell(2, 4); // row 3 col 5, 0-based
console.log(`cell(2,4) = ${JSON.stringify(o.char)}  fg=${fmtColor(o.fg)}`);

// Cursor state.
const cur = term.cursor();
console.log(`cursor    = (row ${cur.y}, col ${cur.x})  visible=${cur.visible}`);

// Render the first three rows as text.
console.log("\nscreen (first 3 rows):");
for (let row = 0; row < 3; row++) {
  console.log(`  ${row}: ${JSON.stringify(term.rowText(row))}`);
}

// Resize works too.
term.resize(100, 30);
console.log(`\nafter resize: ${term.cols}x${term.rows}`);

function fmtColor(c: ReturnType<Terminal["cell"]>["fg"]): string {
  switch (c.type) {
    case "palette":
      return `palette(${c.index})`;
    case "rgb":
      return `rgb(${c.r},${c.g},${c.b})`;
    default:
      return "default";
  }
}
