/**
 * Concurrency-safe sliding-window rate limiter.
 *
 * Strategy
 * --------
 * We use a fixed-window-per-minute approach backed by SQLite with an atomic
 * INSERT … ON CONFLICT DO UPDATE … RETURNING pattern.  This means:
 *
 *  1. Every increment is a single round-trip SQL statement — no
 *     check-then-increment races.
 *  2. Because the counter lives in SQLite (WAL mode), it survives process
 *     restarts and is correct even when the counter resets mid-window.
 *  3. Multi-instance safety: swap the SQLite call for a Redis INCR + EXPIRE
 *     (or a Lua script) and the contract is identical.  See SCALE.md.
 *
 * Window key = floor(nowMs / WINDOW_MS) * WINDOW_MS  (aligned 60-second slot)
 */

import { incrementRateCounter } from './db.js';

const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

/**
 * Check and atomically consume one token for userId.
 *
 * @param {string} userId
 * @param {number} nowMs  - current epoch ms (injectable for tests)
 * @returns {{ ok: boolean, remaining: number, resetMs: number }}
 */
export function checkAndConsume(userId, nowMs = Date.now()) {
  // Align to the current 60-second window
  const windowStart = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  const resetMs = windowStart + WINDOW_MS;

  // Single atomic SQL upsert — returns the POST-increment count
  const count = incrementRateCounter(userId, windowStart);

  const ok = count <= RATE;
  const remaining = Math.max(RATE - count, 0);

  return { ok, remaining, resetMs };
}
