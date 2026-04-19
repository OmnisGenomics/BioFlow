import type { ConnectorResult } from "../connector.js";

export interface IdempotencyStore {
  get(key: string): Promise<ConnectorResult | undefined>;
  set(key: string, result: ConnectorResult, ttlMs: number): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly items = new Map<
    string,
    { expiresAtMs: number; value: ConnectorResult }
  >();

  async get(key: string): Promise<ConnectorResult | undefined> {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (Date.now() >= item.expiresAtMs) {
      this.items.delete(key);
      return undefined;
    }
    return item.value;
  }

  async set(key: string, result: ConnectorResult, ttlMs: number): Promise<void> {
    this.items.set(key, { expiresAtMs: Date.now() + ttlMs, value: result });
  }
}

