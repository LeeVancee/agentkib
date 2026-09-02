/** @jsxImportSource octane */

type Dictionary = Record<string, unknown>;

function isPlainObject(value: unknown): value is Dictionary {
  if (value === null || Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function merge(target: Dictionary, source: Dictionary, deep: boolean) {
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined || target === value) continue;

    if (deep && (Array.isArray(value) || isPlainObject(value))) {
      const current = target[key];
      const next = Array.isArray(value)
        ? Array.isArray(current)
          ? current
          : []
        : isPlainObject(current)
          ? current
          : {};
      target[key] = merge(next as Dictionary, value as Dictionary, true);
    } else {
      target[key] = value;
    }
  }
  return target;
}

export default function extend(...arguments_: unknown[]) {
  let index = 0;
  let deep = false;
  if (typeof arguments_[0] === "boolean") {
    deep = arguments_[0];
    index = 1;
  }

  const target =
    arguments_[index] &&
    (typeof arguments_[index] === "object" || typeof arguments_[index] === "function")
      ? (arguments_[index] as Dictionary)
      : {};

  for (index += 1; index < arguments_.length; index += 1) {
    const source = arguments_[index];
    if (source && (typeof source === "object" || typeof source === "function")) {
      merge(target, source as Dictionary, deep);
    }
  }

  return target;
}
