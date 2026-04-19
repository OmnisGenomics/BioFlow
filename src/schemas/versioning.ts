import { z } from "zod";

const SemverPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export const SchemaSemverSchema = z.string().regex(SemverPattern, "Expected schema semver x.y.z");
export type SchemaSemver = z.infer<typeof SchemaSemverSchema>;

export interface ParsedSchemaSemver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSchemaSemver(value: string): ParsedSchemaSemver {
  SchemaSemverSchema.parse(value);
  const [majorRaw, minorRaw, patchRaw] = value.split(".");
  return {
    major: Number.parseInt(majorRaw ?? "", 10),
    minor: Number.parseInt(minorRaw ?? "", 10),
    patch: Number.parseInt(patchRaw ?? "", 10)
  };
}

export function isSchemaMajorCompatible(expected: string, actual: string): boolean {
  const expectedParsed = parseSchemaSemver(expected);
  const actualParsed = parseSchemaSemver(actual);
  return expectedParsed.major === actualParsed.major;
}

export function assertSchemaMajorCompatible(expected: string, actual: string): void {
  if (isSchemaMajorCompatible(expected, actual)) return;
  throw new Error(`Incompatible schema major version: expected ${expected}, got ${actual}`);
}
