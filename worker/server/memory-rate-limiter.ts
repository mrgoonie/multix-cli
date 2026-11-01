/**
 * In-process stand-in for the Workers rate limiting binding
 * (`limit({ key }) → { success }`): a fixed window per key. Like the
 * Cloudflare binding it is an approximate abuse guard, not a billing budget;
 * counts live in memory, so a restart resets them (single replica only).
 */

import type { RateLimiter } from "../src/config.js";

const MAX_TRACKED_KEYS = 100_000;

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limitPerPeriod: number,
    private readonly periodSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const now = this.now();
    const periodMs = this.periodSeconds * 1000;
    let window = this.windows.get(key);
    if (!window || now - window.start >= periodMs) {
      if (!window && this.windows.size >= MAX_TRACKED_KEYS) this.prune(now, periodMs);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count++;
    return { success: window.count <= this.limitPerPeriod };
  }

  private prune(now: number, periodMs: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= periodMs) this.windows.delete(key);
    }
    // Still full (a flood of distinct keys): drop the oldest half rather than grow without bound.
    if (this.windows.size >= MAX_TRACKED_KEYS) {
      let drop = Math.floor(this.windows.size / 2);
      for (const key of this.windows.keys()) {
        if (drop-- <= 0) break;
        this.windows.delete(key);
      }
    }
  }
}
