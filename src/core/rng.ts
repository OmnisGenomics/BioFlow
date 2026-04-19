import { sha256Hex } from "./hash.js";

export interface DeterministicRng {
  nextFloat(): number; // [0, 1)
  nextInt(maxExclusive: number): number;
}

export function createDeterministicRng(seed: string): DeterministicRng {
  const seed32 = seedToUint32(seed);
  let state = seed32 >>> 0;

  // mulberry32
  function nextFloat(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt expects maxExclusive > 0; got ${maxExclusive}`);
    }
    return Math.floor(nextFloat() * maxExclusive);
  }

  return { nextFloat, nextInt };
}

function seedToUint32(seed: string): number {
  const hex = sha256Hex(seed).slice(0, 8);
  return Number.parseInt(hex, 16) >>> 0;
}

