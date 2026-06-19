# Scale Plan — 10k RPS

## Current baseline

The service is a single Node.js + Fastify process backed by SQLite (WAL mode).
SQLite handles ~50k simple reads/writes per second on commodity hardware, but it
does **not** scale horizontally.  Everything below describes the path from this
baseline to 10k RPS across a fleet.

---

## 1. Data Model & Indexes

### signals table
```sql
-- Compound index for the common list query (user_id + time sort)
CREATE INDEX idx_user_created ON signals(user_id, created_at DESC);

-- UNIQUE constraint on idempotency_key is the atomic guard against duplicates
-- (already in schema)
```

### At scale: switch to PostgreSQL or CockroachDB
- `idempotency_key` stays `UNIQUE` — the DB constraint is the single source of
  truth regardless of how many app instances run.
- Partition `signals` by `user_id` hash (or by time) once the table exceeds
  ~100 M rows.
- Keep `created_at` as a Unix ms integer; avoids timezone edge cases and is
  cheap to index.

---

## 2. Idempotency Across Instances

### Problem
Two app nodes can both receive the same `Idempotency-Key` in the same
millisecond.  A check-then-insert pattern races; only a DB-level constraint is
safe.

### Solution (current)
`INSERT OR IGNORE` + `SELECT` on the `UNIQUE(idempotency_key)` column.
One of the concurrent writers wins the insert; the other gets 0 rows changed
and falls back to `SELECT` — returning the same row.  No application-level lock
needed.

### Solution (multi-instance, PostgreSQL)
```sql
INSERT INTO signals (...) VALUES (...)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING *;
```
If `RETURNING` is empty, do a follow-up `SELECT WHERE idempotency_key = $1`.
This is a single network round-trip per request and race-free.

### Optional: idempotency cache
For very high read-back rates, store `idempotency_key → response_body` in Redis
with a 24-hour TTL.  The DB remains the authoritative store; Redis is a fast
read-through cache.

---

## 3. Rate Limiting Across Instances

### Current (single instance)
Atomic SQL upsert into `rate_buckets(user_id, window_start)` —
`INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`.
Correct even under intra-process concurrency because SQLite serialises writes.

### Multi-instance upgrade: Redis
Replace the SQL upsert with:
```
MULTI
  INCR  rl:{userId}:{windowStart}
  PEXPIREAT rl:{userId}:{windowStart} {windowStart + 60000}
EXEC
```
Or use a single Lua script (atomic on the Redis server):
```lua
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], 60000) end
return count
```
`checkAndConsume` in `rateLimit.js` already has a clean interface; swapping the
backend is a one-file change.

### Why not sticky sessions?
Sticky routing ties a user to one node, which breaks on restarts and makes
load balancing uneven.  Shared Redis is the standard answer.

---

## 4. Connection Pooling

| Layer | Tool | Config |
|---|---|---|
| App → DB | `pg-pool` (postgres) / WAL for SQLite | pool size = `(2 × vCPU) + 1` |
| App → Redis | `ioredis` cluster client | `lazyConnect: true`, `keepAlive: 10000` |
| LB → App | HTTP keep-alive | `Connection: keep-alive` |

Each 1 vCPU Node process can sustain ~3–4k RPS for lightweight JSON routes.
At 10k RPS, run **3–4 instances** behind a load balancer (e.g., NGINX, ALB).

---

## 5. Caching

- `GET /v1/signals` results can be cached in Redis for 1–5 s per `(userId, limit)`
  key.  Most read traffic is for recent signals where a short TTL is acceptable.
- `healthz` needs no caching.
- Never cache `POST /v1/signals` responses (idempotent replays must hit the DB
  to guarantee correctness).

---

## 6. Queues (async write path)

At extreme write load (>5k RPS writes), move the insert off the hot path:

```
Client → POST /v1/signals → enqueue to Kafka/SQS → return 202 Accepted
                                    ↓
                              Worker pool → DB insert
```

- Idempotency key is checked **before** enqueue (fast Redis lookup).
- The worker deduplicates again at insert time (DB UNIQUE constraint).
- Downside: response body no longer contains the final `id`; return a
  correlation token instead.

---

## 7. Horizontal Scale & Infra Sketch

```
                ┌──────────────────────┐
  clients ──────▶   ALB / NGINX (L7)  │
                └──────┬───────────────┘
                       │  round-robin
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      Node:8080    Node:8080    Node:8080   (3× t3.small = ~$90/mo)
          │            │            │
          └──────┬─────┘────────────┘
                 │
          ┌──────┴───────┐
          │   Redis 7    │  (ElastiCache t3.micro = ~$15/mo)
          │  rate limit  │
          │  idem cache  │
          └──────────────┘
                 │
          ┌──────┴───────┐
          │  PostgreSQL  │  (RDS t3.small = ~$30/mo)
          │   primary    │
          └──────────────┘
```

Estimated cost at 10k RPS: **~$135/mo** (small instances, no redundancy).
Production HA doubles this; add read replicas for `GET /v1/signals` heavy workloads.

---

## 8. Observability

- **Structured logs** — Fastify already emits JSON logs.  Ship to CloudWatch /
  Datadog / Loki with log level controlled by `LOG_LEVEL` env var.
- **Metrics** — expose a `GET /metrics` (Prometheus format) with:
  - `signals_created_total{userId}` counter
  - `rate_limit_rejected_total{userId}` counter
  - `db_retry_total{attempt}` histogram
  - HTTP latency p50/p95/p99
- **Alerts** — page on: error rate > 1%, p99 latency > 200 ms, DB connection
  pool exhaustion.
- **Tracing** — add `@opentelemetry/instrumentation-fastify` for distributed
  traces across the queue workers.

---

## 9. Failure Modes

| Failure | Behavior |
|---|---|
| DB transient error | Exponential backoff + full jitter, up to 5 retries, then 503 |
| DB down permanently | Circuit breaker opens after N consecutive failures; return 503 immediately |
| Redis down | Fall back to per-node in-memory bucket (degrades to per-instance limits) |
| Duplicate request on retry | DB UNIQUE constraint rejects the second insert; app returns the original row |
| Idempotency-Key omitted | No dedup; each call creates a new record (correct behavior) |

---

## 10. DB_FAIL_RATE simulation

The `DB_FAIL_RATE` env var (0–1) randomly throws `SQLITE_BUSY` to simulate
transient failures.  The retry loop in `withRetry()` handles this:

- attempt 0: immediate
- attempt 1: sleep ≤ 30 ms
- attempt 2: sleep ≤ 60 ms
- attempt 3: sleep ≤ 120 ms
- attempt 4: sleep ≤ 240 ms
- then throw

Full jitter (`Math.random() * cap`) avoids thundering-herd on DB recovery.
