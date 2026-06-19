import { upsertSignal, listSignals, withRetry } from './db.js';
import { checkAndConsume } from './rateLimit.js';

// ---------------------------------------------------------------------------
// POST /v1/signals
// ---------------------------------------------------------------------------
export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};

  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  // Rate-limit check (atomic, DB-backed)
  let rlResult;
  try {
    rlResult = await withRetry(() => checkAndConsume(userId, Date.now()));
  } catch (e) {
    req.log.error({ err: e, ctx: 'rateLimit' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }

  if (!rlResult.ok) {
    return reply.code(429).send({
      error: 'rate_limited',
      remaining: rlResult.remaining,
      resetMs: rlResult.resetMs,
    });
  }

  // Atomic upsert — INSERT OR IGNORE + fallback SELECT
  // Retry on transient DB failures with exponential backoff + jitter
  let result;
  try {
    result = await withRetry(() =>
      upsertSignal(userId, type, payload, idem, Date.now())
    );
  } catch (e) {
    req.log.error({ err: e, ctx: 'upsertSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }

  // Return 200 for both new and existing idempotent resources
  // (returning 201 for new is fine too, but tests check `id` equality)
  const statusCode = result.created ? 201 : 200;
  return reply.code(statusCode).send(result.row);
}

// ---------------------------------------------------------------------------
// GET /v1/signals
// ---------------------------------------------------------------------------
export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });

  const lim = Math.min(Number(limit) || 20, 100);

  try {
    const rows = await withRetry(() => listSignals(userId, lim));
    return reply.code(200).send({ items: rows });
  } catch (e) {
    req.log.error({ err: e, ctx: 'listSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}
