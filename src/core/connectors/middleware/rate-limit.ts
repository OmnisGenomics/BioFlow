export interface RateLimiter {
  acquire(key: string, rps: number): Promise<void>;
}

export class InMemoryTokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, BucketState>();

  constructor(private readonly capacity = 1) {
    if (!(capacity >= 1)) throw new Error(`capacity must be >= 1; got ${capacity}`);
  }

  async acquire(key: string, rps: number): Promise<void> {
    if (!(rps > 0)) throw new Error(`rps must be > 0; got ${rps}`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const bucket = this.getBucket(key, rps);
      this.refill(bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - bucket.tokens) / bucket.rps) * 1000);
      await sleep(waitMs);
    }
  }

  private getBucket(key: string, rps: number): BucketState {
    const existing = this.buckets.get(key);
    if (existing) {
      existing.rps = rps;
      return existing;
    }
    const now = Date.now();
    const bucket: BucketState = {
      rps,
      capacity: this.capacity,
      tokens: this.capacity,
      lastRefillMs: now
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  private refill(bucket: BucketState): void {
    const now = Date.now();
    const elapsedSec = (now - bucket.lastRefillMs) / 1000;
    bucket.lastRefillMs = now;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSec * bucket.rps);
  }
}

interface BucketState {
  rps: number;
  capacity: number;
  tokens: number;
  lastRefillMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
