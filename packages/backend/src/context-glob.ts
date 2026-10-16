export class GlobMatchBudgetExceeded extends Error {
  constructor(message = "Glob matching work budget exceeded") {
    super(message);
    this.name = "GlobMatchBudgetExceeded";
  }
}

// A caller can share one budget across all exclusions and files in a request.
export class GlobMatchBudget {
  private remaining: number;

  constructor(limit = 100_000) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid glob work budget");
    this.remaining = limit;
  }

  spend(amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new RangeError("Invalid glob work amount");
    if (amount > this.remaining) {
      this.remaining = -1;
      throw new GlobMatchBudgetExceeded();
    }
    this.remaining -= amount;
  }
}

// Preserve the original 128-variant limit for callers without a work budget.
export function braceVariants(pattern: string, budget?: GlobMatchBudget): string[] {
  const output: string[] = [];
  const expand = (value: string) => {
    budget?.spend();
    if (output.length >= 128) {
      if (budget) throw new GlobMatchBudgetExceeded("Glob brace expansion limit exceeded");
      return;
    }
    let start = -1,
      depth = 0,
      escaped = false;
    for (let i = 0; i < value.length; i++) {
      budget?.spend();
      const char = value[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (char === "}" && depth > 0) {
        depth--;
        if (depth !== 0) continue;
        budget?.spend(i - start);
        const body = value.slice(start + 1, i),
          choices: string[] = [];
        let nested = 0,
          skip = false,
          mark = 0;
        for (let n = 0; n < body.length; n++) {
          budget?.spend();
          const c = body[n];
          if (skip) {
            skip = false;
            continue;
          }
          if (c === "\\") skip = true;
          else if (c === "{") nested++;
          else if (c === "}") nested--;
          else if (c === "," && nested === 0) {
            budget?.spend(n - mark + 1);
            choices.push(body.slice(mark, n));
            mark = n + 1;
          }
        }
        if (!choices.length) {
          start = -1;
          continue;
        }
        budget?.spend(body.length - mark + 1);
        choices.push(body.slice(mark));
        for (const choice of choices) {
          if (output.length >= 128) {
            if (budget) throw new GlobMatchBudgetExceeded("Glob brace expansion limit exceeded");
            break;
          }
          budget?.spend(value.length);
          expand(value.slice(0, start) + choice + value.slice(i + 1));
        }
        return;
      }
    }
    output.push(value);
  };
  expand(pattern);
  return output;
}

type Atom =
  | { kind: "literal"; value: string }
  | { kind: "any" | "star" }
  | { kind: "class"; negated: boolean; ranges: [number, number][] }
  | { kind: "extglob"; operator: string; alternatives: Atom[][] };

// Match Unicode scalar values, including malformed-pattern rejection and
// the original extglob depth limit. JS glob libraries differ on these rules.
function parse(pattern: string, budget?: GlobMatchBudget): Atom[] | null {
  budget?.spend(pattern.length + 1);
  const chars = [...pattern];
  let index = 0;
  const sequence = (depth: number): Atom[] | null => {
    budget?.spend();
    if (depth > 128) {
      if (budget) throw new GlobMatchBudgetExceeded("Glob parsing depth limit exceeded");
      return null;
    }
    const atoms: Atom[] = [];
    while (index < chars.length && ![")", "|"].includes(chars[index]!)) {
      budget?.spend();
      const char = chars[index]!;
      if (["@", "?", "+", "*", "!"].includes(char) && chars[index + 1] === "(") {
        index += 2;
        const alternatives: Atom[][] = [];
        for (;;) {
          budget?.spend();
          const branch = sequence(depth + 1);
          if (!branch) return null;
          alternatives.push(branch);
          if (chars[index] === "|") index++;
          else if (chars[index] === ")") {
            index++;
            break;
          } else return null;
        }
        atoms.push({ kind: "extglob", operator: char, alternatives });
        continue;
      }
      index++;
      if (char === "\\") {
        const value = chars[index++];
        if (value === undefined) return null;
        atoms.push({ kind: "literal", value });
      } else if (char === "?") atoms.push({ kind: "any" });
      else if (char === "*") {
        if (atoms.at(-1)?.kind !== "star") atoms.push({ kind: "star" });
      } else if (char === "[") {
        const negated = ["!", "^"].includes(chars[index]!);
        if (negated) index++;
        const ranges: [number, number][] = [];
        while (index < chars.length && chars[index] !== "]") {
          budget?.spend();
          let first = chars[index++];
          if (first === "\\") first = chars[index++];
          if (first === undefined) return null;
          let last = first;
          if (chars[index] === "-" && chars[index + 1] !== undefined && chars[index + 1] !== "]") {
            index++;
            last = chars[index++]!;
            if (last === "\\") last = chars[index++]!;
            if (last === undefined) return null;
          }
          ranges.push([first.codePointAt(0)!, last.codePointAt(0)!]);
        }
        if (!ranges.length || chars[index++] !== "]") return null;
        atoms.push({ kind: "class", negated, ranges });
      } else atoms.push({ kind: "literal", value: char });
    }
    return atoms;
  };
  const atoms = sequence(0);
  return index === chars.length ? atoms : null;
}
function segmentMatches(pattern: string, target: string, budget?: GlobMatchBudget): boolean {
  const atoms = parse(pattern, budget);
  if (!atoms) return false;
  budget?.spend(target.length + 1);
  const chars = [...target];
  // Include depth because the legacy matcher limits recursion. Bound retained
  // positions as well as entries; the cache is discarded after this segment.
  const memo = new Map<Atom[], Map<string, Set<number>>>();
  let memoSize = 0;
  const alternatives = (
    branches: Atom[][],
    start: number,
    end: number,
    depth: number,
  ): Set<number> => {
    const result = new Set<number>();
    for (const branch of branches) {
      budget?.spend();
      for (const position of sequence(branch, start, end, depth)) {
        budget?.spend();
        result.add(position);
      }
    }
    return result;
  };
  const repeat = (
    branches: Atom[][],
    starts: Set<number>,
    end: number,
    depth: number,
  ): Set<number> => {
    budget?.spend(starts.size + 1);
    const reached = new Set(starts);
    let frontier = starts;
    while (frontier.size) {
      budget?.spend();
      const next = new Set<number>();
      for (const position of frontier) {
        budget?.spend();
        for (const value of alternatives(branches, position, end, depth + 1)) {
          budget?.spend();
          if (value > position && !reached.has(value)) {
            reached.add(value);
            next.add(value);
          }
        }
      }
      frontier = next;
    }
    return reached;
  };
  const apply = (atom: Atom, start: number, end: number, depth: number): Set<number> => {
    budget?.spend();
    switch (atom.kind) {
      case "literal":
        return start < end && chars[start] === atom.value ? new Set([start + 1]) : new Set();
      case "any":
        return start < end ? new Set([start + 1]) : new Set();
      case "star": {
        budget?.spend(end - start + 1);
        return new Set(Array.from({ length: end - start + 1 }, (_, index) => start + index));
      }
      case "class": {
        const value = chars[start]?.codePointAt(0);
        return start < end &&
          value !== undefined &&
          atom.ranges.some(([first, last]) => {
            budget?.spend();
            return first <= value && value <= last;
          }) !== atom.negated
          ? new Set([start + 1])
          : new Set();
      }
      case "extglob":
        switch (atom.operator) {
          case "@":
            return alternatives(atom.alternatives, start, end, depth + 1);
          case "?": {
            const positions = alternatives(atom.alternatives, start, end, depth + 1);
            budget?.spend(positions.size + 1);
            return new Set([start, ...positions]);
          }
          case "+":
            return repeat(
              atom.alternatives,
              alternatives(atom.alternatives, start, end, depth + 1),
              end,
              depth + 1,
            );
          case "*":
            return repeat(atom.alternatives, new Set([start]), end, depth + 1);
          case "!": {
            const positions = new Set<number>();
            for (let position = start; position <= end; position++) {
              budget?.spend();
              if (!alternatives(atom.alternatives, start, position, depth + 1).has(position))
                positions.add(position);
            }
            return positions;
          }
        }
    }
    return new Set();
  };
  const sequence = (atoms: Atom[], start: number, end: number, depth: number): Set<number> => {
    budget?.spend();
    if (depth > 32) {
      if (budget) throw new GlobMatchBudgetExceeded("Glob matching depth limit exceeded");
      return new Set();
    }
    const key = `${start}:${end}:${depth}`;
    const cached = memo.get(atoms)?.get(key);
    if (cached) return cached;
    let positions = new Set([start]);
    for (const atom of atoms) {
      budget?.spend();
      const next = new Set<number>();
      for (const position of positions) {
        budget?.spend();
        for (const value of apply(atom, position, end, depth + 1)) {
          budget?.spend();
          next.add(value);
        }
      }
      positions = next;
      if (!next.size) break;
    }
    if (memoSize + positions.size + 1 <= 4096) {
      let entries = memo.get(atoms);
      if (!entries) memo.set(atoms, (entries = new Map()));
      entries.set(key, positions);
      memoSize += positions.size + 1;
    }
    return positions;
  };
  return sequence(atoms, 0, chars.length, 0).has(chars.length);
}
export function globMatches(pattern: string, target: string, budget?: GlobMatchBudget): boolean {
  budget?.spend(target.length + 1);
  const parts = target.split("/");
  return braceVariants(pattern, budget).some((variant) => {
    budget?.spend(variant.length + 1);
    const patterns = variant.split("/");
    let pi = 0,
      ti = 0,
      star = -1,
      starTarget = 0;
    while (ti < parts.length) {
      budget?.spend();
      if (
        pi < patterns.length &&
        patterns[pi] !== "**" &&
        segmentMatches(patterns[pi]!, parts[ti]!, budget)
      ) {
        pi++;
        ti++;
      } else if (patterns[pi] === "**") {
        star = pi++;
        starTarget = ti;
      } else if (star >= 0) {
        ti = ++starTarget;
        pi = star + 1;
      } else return false;
    }
    while (patterns[pi] === "**") {
      budget?.spend();
      pi++;
    }
    return pi === patterns.length;
  });
}
