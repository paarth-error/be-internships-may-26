import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';
import fs from 'node:fs';

const TEST_DB = './data/test-idem.db';

test('idempotency returns same resource for same key', async () => {
  // Clean slate DB for this test
  try { fs.unlinkSync(TEST_DB); } catch {}

  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: '9091',
      DATABASE_URL: TEST_DB,
      DB_FAIL_RATE: '0',
    },
    stdio: 'pipe',
  });

  await wait(500);

  const base = 'http://localhost:9091';
  const idem = 'same-key-' + Date.now();

  const a = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k', 'idempotency-key': idem },
    body: { userId: 'u1', type: 'note', payload: 'x' },
  });

  const b = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k', 'idempotency-key': idem },
    body: { userId: 'u1', type: 'note', payload: 'x' },
  });

  assert.ok(a.id, `first response should have an id, got: ${JSON.stringify(a)}`);
  assert.equal(a.id, b.id, 'both calls should return the same id');
  assert.equal(a.idempotencyKey, b.idempotencyKey, 'idempotencyKey must match');

  proc.kill();
  try { fs.unlinkSync(TEST_DB); } catch {}
});

test('idempotency: concurrent requests with same key return same resource', async () => {
  try { fs.unlinkSync('./data/test-idem-concurrent.db'); } catch {}

  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: '9093',
      DATABASE_URL: './data/test-idem-concurrent.db',
      DB_FAIL_RATE: '0',
      RATE_LIMIT_PER_MIN: '100',
    },
    stdio: 'pipe',
  });

  await wait(500);

  const base = 'http://localhost:9093';
  const idem = 'concurrent-key-' + Date.now();

  // Fire 5 concurrent requests with the same idempotency key
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      postJson(`${base}/v1/signals`, {
        headers: { 'x-api-key': 'k', 'idempotency-key': idem },
        body: { userId: 'u2', type: 'note', payload: 'concurrent' },
      })
    )
  );

  const ids = results.map((r) => r.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, 1, `All concurrent requests should return the same id, got: ${ids}`);

  proc.kill();
  try { fs.unlinkSync('./data/test-idem-concurrent.db'); } catch {}
});

test('no idempotency key creates unique signals', async () => {
  try { fs.unlinkSync('./data/test-idem-no-key.db'); } catch {}

  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: '9094',
      DATABASE_URL: './data/test-idem-no-key.db',
      DB_FAIL_RATE: '0',
      RATE_LIMIT_PER_MIN: '100',
    },
    stdio: 'pipe',
  });

  await wait(500);

  const base = 'http://localhost:9094';

  const a = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k' },
    body: { userId: 'u3', type: 'note', payload: 'x' },
  });
  const b = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k' },
    body: { userId: 'u3', type: 'note', payload: 'x' },
  });

  assert.notEqual(a.id, b.id, 'without idempotency key, two calls create two records');

  proc.kill();
  try { fs.unlinkSync('./data/test-idem-no-key.db'); } catch {}
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
async function postJson(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => (chunks += d));
        res.on('end', () => resolve(JSON.parse(chunks || '{}')));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
