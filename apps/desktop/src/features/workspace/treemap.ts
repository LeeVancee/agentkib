/** @jsxImportSource octane */

export interface TreemapInput {
  id: string;
  value: number;
}

export interface TreemapRect extends TreemapInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SizedInput extends TreemapInput {
  area: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function squarifyTreemap(values: TreemapInput[], width = 100, height = 100): TreemapRect[] {
  const positive = values
    .filter((item) => item.value > 0)
    .sort((left, right) => right.value - left.value);
  const total = positive.reduce((sum, item) => sum + item.value, 0);
  if (!total || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const remaining = positive.map((item) => ({ ...item, area: item.value * scale }));
  const output: TreemapRect[] = [];
  let bounds: Rect = { x: 0, y: 0, width, height };
  let row: SizedInput[] = [];

  while (remaining.length) {
    const next = remaining[0];
    const shortSide = Math.min(bounds.width, bounds.height);
    if (!row.length || worst([...row, next], shortSide) <= worst(row, shortSide)) {
      row.push(next);
      remaining.shift();
    } else {
      bounds = layoutRow(row, bounds, output);
      row = [];
    }
  }
  if (row.length) layoutRow(row, bounds, output);
  return output;
}

function worst(row: SizedInput[], side: number) {
  if (!row.length || side <= 0) return Number.POSITIVE_INFINITY;
  const sum = row.reduce((value, item) => value + item.area, 0);
  const largest = Math.max(...row.map((item) => item.area));
  const smallest = Math.min(...row.map((item) => item.area));
  const sideSquared = side * side;
  return Math.max((sideSquared * largest) / (sum * sum), (sum * sum) / (sideSquared * smallest));
}

function layoutRow(row: SizedInput[], bounds: Rect, output: TreemapRect[]): Rect {
  const area = row.reduce((sum, item) => sum + item.area, 0);
  if (bounds.width >= bounds.height) {
    const rowHeight = bounds.width ? area / bounds.width : 0;
    let x = bounds.x;
    for (const item of row) {
      const itemWidth = rowHeight ? item.area / rowHeight : 0;
      output.push({
        id: item.id,
        value: item.value,
        x,
        y: bounds.y,
        width: itemWidth,
        height: rowHeight,
      });
      x += itemWidth;
    }
    return {
      x: bounds.x,
      y: bounds.y + rowHeight,
      width: bounds.width,
      height: Math.max(0, bounds.height - rowHeight),
    };
  }
  const rowWidth = bounds.height ? area / bounds.height : 0;
  let y = bounds.y;
  for (const item of row) {
    const itemHeight = rowWidth ? item.area / rowWidth : 0;
    output.push({
      id: item.id,
      value: item.value,
      x: bounds.x,
      y,
      width: rowWidth,
      height: itemHeight,
    });
    y += itemHeight;
  }
  return {
    x: bounds.x + rowWidth,
    y: bounds.y,
    width: Math.max(0, bounds.width - rowWidth),
    height: bounds.height,
  };
}
