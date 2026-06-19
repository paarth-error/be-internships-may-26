# Signals Challenge (Node.js + Fastify)

A minimal production-leaning service that handles load, rate limits per user, and avoids duplicates via idempotency.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/signals` | Create a signal |
| `GET`  | `/v1/signals?userId=&limit=` | List signals for a user |
| `GET`  | `/healthz` | Health check |

### POST /v1/signals

**Headers**
- `X-API-Key` (required) — must match `API_KEY` env var
- `Idempotency-Key` (optional) — repeated calls with the same key return the original resource

**Body**
```json
{ "userId": "string", "type": "string", "payload": "string" }
```

**Responses**
- `201` — signal created
- `200` — idempotent replay (same resource returned)
- `400` — missing required fields
- `401` — invalid or missing API key
- `429` — rate limited (`RATE_LIMIT_PER_MIN` per minute per userId)
- `503` — DB unavailable after retries

---

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `API_KEY` | `change-me` | Shared API key for auth |
| `PORT` | `8080` | HTTP port |
| `DATABASE_URL` | `./data/signals.db` | SQLite file path |
| `RATE_LIMIT_PER_MIN` | `5` | Max requests per userId per minute |
| `DB_FAIL_RATE` | `0` | 0–1 probability of simulated DB failure |
| `LOG_LEVEL` | `info` | Fastify log level |

---

## Tests

```bash
npm test
```

Runs all test files in `tests/` using Node.js built-in test runner.

---

## Implementation highlights

### Atomic Idempotency
Uses `INSERT OR IGNORE` on the `UNIQUE(idempotency_key)` DB column.  When two
concurrent requests arrive with the same key, exactly one insert wins; the other
falls back to `SELECT`.  No application-level lock, no check-then-insert race.

### Concurrency-Safe Rate Limiting
Uses an atomic SQL upsert (`INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`)
on a `rate_buckets(user_id, window_start)` table.  The increment and read happen
in a single statement — no race between reading the counter and writing it back.
Multi-instance safety: drop-in swap to Redis `INCR` + Lua script (see SCALE.md).

### Retry / Backoff on DB Failures
`withRetry()` wraps every DB call with up to 5 attempts using exponential
backoff with full jitter to avoid thundering-herd on DB recovery.

---

## Scale plan

See [SCALE.md](./SCALE.md) for the 10k RPS design (indexes, pooling, Redis
rate limiting, async write queue, horizontal scaling, cost estimate).
