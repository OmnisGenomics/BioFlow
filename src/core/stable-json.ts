export function stableStringify(value: unknown): string {
  return JSON.stringify(stabilize(value));
}

function stabilize(value: unknown): unknown {
  if (value === null) return null;

  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return value;

  if (Array.isArray(value)) return value.map(stabilize);

  if (type === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error(
        `stableStringify only supports plain objects; got ${Object.prototype.toString.call(value)}`
      );
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = stabilize(obj[key]);
    return out;
  }

  throw new Error(`stableStringify does not support type ${type}`);
}

