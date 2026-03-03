/**
 * Shared runtime state for health checks and rate limiting.
 * Lives here (not in index.ts) to avoid circular dependencies.
 */

// ─── Last message tracking ────────────────────────────────────────────────────

let _lastMessageProcessed: Date | null = null;
let _dbConnected = false;
let _pendingMessages = 0;

export function markMessageProcessed(): void {
  _lastMessageProcessed = new Date();
}

export function setDbConnected(ok: boolean): void {
  _dbConnected = ok;
}

/** @deprecated Use setDbConnected instead */
export function setNotionConnected(ok: boolean): void {
  _dbConnected = ok;
}

export function incrementPending(): void {
  _pendingMessages++;
}

export function decrementPending(): void {
  _pendingMessages = Math.max(0, _pendingMessages - 1);
}

export function getHealthState(): {
  lastMessageProcessed: string | null;
  dbConnected: boolean;
  pendingMessages: number;
} {
  return {
    lastMessageProcessed: _lastMessageProcessed?.toISOString() ?? null,
    dbConnected: _dbConnected,
    pendingMessages: _pendingMessages,
  };
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const rateLimitBuckets = new Map<string, { count: number; windowStart: number }>();

export function checkRateLimit(chatId: string): boolean {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(chatId);

  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(chatId, { count: 1, windowStart: now });
    return true;
  }

  if (bucket.count >= RATE_LIMIT_MAX) {
    return false;
  }

  bucket.count++;
  return true;
}
