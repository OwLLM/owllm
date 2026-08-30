/// One row of a terminal buffer, in xterm's own shape: the row's text and
/// whether it is the continuation of the row above it rather than a new line.
export type TerminalRow = { text: string; isWrapped: boolean };

/// Rebuild logical lines from a terminal buffer.
///
/// Re-deriving a hard wrap from the byte stream cannot be exact: when a CLI
/// prints a URL that happens to end on the last column, the next row is
/// indistinguishable from a continuation, and the following word gets glued
/// onto the URL. The terminal already knows the answer — it records, per row,
/// whether that row is a wrap of the previous one — so read the flag instead of
/// guessing from row widths.
export function unwrapTerminalLines(rows: TerminalRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.isWrapped && lines.length > 0) lines[lines.length - 1] += row.text;
    else lines.push(row.text);
  }
  return lines.join("\n");
}
