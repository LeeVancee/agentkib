/** @jsxImportSource octane */

export type DiffLine = { type: "same" | "added" | "removed"; content: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const table = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push({ type: "same", content: left[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ type: "removed", content: left[i] });
      i += 1;
    } else {
      lines.push({ type: "added", content: right[j] });
      j += 1;
    }
  }
  while (i < left.length) lines.push({ type: "removed", content: left[i++] });
  while (j < right.length) lines.push({ type: "added", content: right[j++] });
  return lines;
}
