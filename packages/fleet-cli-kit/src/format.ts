/** With no rows, only the header row is returned. */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map((row) => (row[col] ?? "").length)),
  );

  const formatRow = (cells: readonly string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join("  ").trimEnd();

  return [formatRow(headers), ...rows.map((row) => formatRow(row))].join("\n");
}
