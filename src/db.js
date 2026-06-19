import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.DATABASE_URL || './data/signals.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// WAL mode: much better concurrent read/write performance
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

// Schema
db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  payload       TEXT    NOT NULL,
  idempotency_key TEXT  UNIQUE,
  created_at    INTEGER NOT NULL
);

-- Index for listing by user, sorted by time
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at DESC);

-- Sliding-window rate-limit counters (atomic, survives restarts)
CREATE TABLE IF NOT EXISTS rate_buckets (
  user_id    TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, window_start)
);
`);

// ---------------------------------------------------------------------------
// Failure simulation
// ---------------------------------------------------------------------------
function maybeFail() {
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error('simulated_db_failure');
    err.code = 'SQLITE_BUSY';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Retry / backoff helper (exponential + full jitter)
// ---------------------------------------------------------------------------
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 30;

export async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      const isTransient =
        err.code === 'SQLITE_BUSY' ||
        err.code === 'SQLITE_LOCKED' ||
        (err.message && err.message.includes('simulated_db_failure'));
      if (!isTransient) throw err;
      // Full-jitter backoff: sleep random(0, base * 2^attempt)
      const cap = BASE_DELAY_MS * Math.pow(2, attempt);
      const delay = Math.random() * cap;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Prepared statements (created once, reused for performance)
// ---------------------------------------------------------------------------
const stmtInsertOrIgnore = db.prepare(
  `INSERT OR IGNORE INTO signals
     (user_id, type, payload, idempotency_key, created_at)
   VALUES (?, ?, ?, ?, ?)`
);

const stmtGetByIdem = db.prepare(
  `SELECT id,
          user_id       AS userId,
          type,
          payload,
          idempotency_key AS idempotencyKey,
          created_at    AS createdAt
   FROM signals
   WHERE idempotency_key = ?`
);

const stmtList = db.prepare(
  `SELECT id,
          user_id       AS userId,
          type,
          payload,
          idempotency_key AS idempotencyKey,
          created_at    AS createdAt
   FROM signals
   WHERE user_id = ?
   ORDER BY created_at DESC
   LIMIT ?`
);

// Atomic upsert for rate-limit bucket
const stmtRateUpsert = db.prepare(
  `INSERT INTO rate_buckets (user_id, window_start, count)
   VALUES (?, ?, 1)
   ON CONFLICT(user_id, window_start) DO UPDATE SET count = count + 1
   RETURNING count`
);

// Clean up old buckets (called opportunistically)
const stmtRateClean = db.prepare(
  `DELETE FROM rate_buckets WHERE window_start < ?`
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Atomically insert a signal, returning the existing row if the
 * idempotency_key already exists (INSERT OR IGNORE + SELECT pattern).
 *
 * Returns { created: boolean, row: object }
 */
export function upsertSignal(userId, type, payload, idemKey, nowMs) {
  maybeFail();

  if (idemKey) {
    // Atomic: INSERT OR IGNORE ensures no duplicate even under concurrency.
    // The UNIQUE constraint on idempotency_key is the DB-level guard.
    const info = stmtInsertOrIgnore.run(userId, type, String(payload), idemKey, nowMs);
    if (info.changes === 1) {
      // Newly created
      return {
        created: true,
        row: {
          id: info.lastInsertRowid,
          userId,
          type,
          payload: String(payload),
          idempotencyKey: idemKey,
          createdAt: nowMs,
        },
      };
    }
    // Already existed — return the original row
    const existing = stmtGetByIdem.get(idemKey);
    return { created: false, row: existing };
  }

  // No idempotency key — plain insert
  const info = stmtInsertOrIgnore.run(userId, type, String(payload), null, nowMs);
  return {
    created: true,
    row: {
      id: info.lastInsertRowid,
      userId,
      type,
      payload: String(payload),
      idempotencyKey: null,
      createdAt: nowMs,
    },
  };
}

/**
 * Atomically increment the rate-limit counter for (userId, windowStart).
 * Returns the new count for that window.
 */
export function incrementRateCounter(userId, windowStart) {
  // Opportunistic cleanup of windows older than 2 minutes
  stmtRateClean.run(windowStart - 120_000);
  const row = stmtRateUpsert.get(userId, windowStart);
  return row.count;
}

export function listSignals(userId, limit) {
  maybeFail();
  return stmtList.all(userId, limit);
}
