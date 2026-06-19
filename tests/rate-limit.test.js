import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';
import fs from 'node:fs';

test('rate limit: allow 5 per minute, 6th is 429', async () => {
  try { fs.unlinkSync('./data/test-rl.db'); } catch {}

  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: '9092',
      RATE_LIMIT_PER_MIN: '5',
      DATABASE_URL: './data/test-rl.db',
      DB_FAIL_RATE: '0',
    },
    stdio: 'pipe',
  });

  await wait(500);

  const base = 'http://localhost:9092';
  const statuses = [];

  for (let i = 0; i < 6; i++) {
    const code = await postStatus(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'u1', type: 'note', payload: String(i) },
    });
    statuses.push(code);
  }

  const counts = statuses.reduce((acc, c) => {
    acc[c] = (acc[c] || 0) + 1;
    return acc;
  }, {});

  assert.ok(counts[201] >= 5, `Expected at least 5 successful (201), got: ${JSON.stringify(counts)}`);
  assert.ok(counts[429] >= 1, `Expected at least 1 rate-limited (429), got: ${JSON.stringify(counts)}`);

  proc.kill();
  try { fs.unlinkSync('./data/test-rl.db'); } catch {}
});

test('rate limit: different userIds have independent limits', async () => {
  try { fs.unlinkSync('./data/test-rl2.db'); } catch {}

  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: '9095',
      RATE_LIMIT_PER_MIN: '3',
      DATABASE_URL: './data/test-rl2.db',
      DB_FAIL_RATE: '0',
    },
    stdio: 'pipe',
  });

  await wait(500);

  const base = 'http://localhost:9095';

  // Exhaust user A's limit
  for (let i = 0; i < 3; i++) {
    await postStatus(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'userA', type: 'note', payload: String(i) },
    });
  }

  // User A should now be rate-limited
  const codeA = await postStatus(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k' },
    body: { userId: 'userA', type: 'note', payload: 'extra' },
  });
  assert.equal(codeA, 429, 'userA should be rate limited');

  // User B should still be allowed
  const codeB = await postStatus(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k' },
    body: { userId: 'userB', type: 'note', payload: 'first' },
  });
  assert.equal(codeB, 201, 'userB should not be affected by userA limit');

  proc.kill();
  try { fs.unlinkSync('./data/test-rl2.db'); } catch {}
});

test('rate limit: concurrent burst does not exceed limit', async () => {
  try { fs.unlinkSync('./data/test-rl3.db'); } catch {}

  const proc = spawn('node', ['src/server.js'], {
    env: {
      ...process.env,
      API_KEY: 'k',
      PORT: '9096',
      RATE_LIMIT_PER_MIN: '5',
      DATABASE_URL: './data/test-rl3.db',
      DB_FAIL_RATE: '0',
    },
    stdio: 'pipe',
  });

  await wait(500);

  const base = 'http://localhost:9096';

  // Send 10 concurrent requests — only 5 should succeed
  const statuses = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      postStatus(`${base}/v1/signals`, {
        headers: { 'x-api-key': 'k' },
        body: { userId: 'burstUser', type: 'note', payload: String(i) },
      })
    )
  );

  const ok = statuses.filter((s) => s === 201).length;
  const limited = statuses.filter((s) => s === 429).length;

  assert.ok(ok <= 5, `At most 5 should succeed under concurrent burst, got ${ok}`);
  assert.ok(limited >= 5, `At least 5 should be rate-limited under concurrent burst, got ${limited}`);

  proc.kill();
  try { fs.unlinkSync('./data/test-rl3.db'); } catch {}
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
async function postStatus(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
