// HTTP smoke tests for the Express server: health, create, approve failing
// closed (off-allow-list recipient, no PayPal call), and VND rejection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

async function startServer() {
  const { app } = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no listen address');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test('server: health, create batch, approve fails closed without an allow-listed recipient', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as { status: string; sandbox: boolean };
  assert.equal(healthBody.status, 'ok');
  assert.equal(healthBody.sandbox, true);

  const created = await fetch(`${base}/api/treasury/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ recipientEmail: 'vendor@example.com', amount: 10, currency: 'USD' }],
    }),
  });
  assert.equal(created.status, 201);
  const batch = (await created.json()) as { id: string; status: string };
  assert.equal(batch.status, 'DRAFT');

  // The store allow-list starts empty, so approve must fail closed with
  // 422 and the batch stays AWAITING_APPROVAL — no PayPal call is made.
  const approved = await fetch(`${base}/api/treasury/batches/${batch.id}/approve`, {
    method: 'POST',
  });
  assert.equal(approved.status, 422);
  const denied = (await approved.json()) as { batch: { status: string }; reasons: string[] };
  assert.equal(denied.batch.status, 'AWAITING_APPROVAL');
  assert.ok(denied.reasons.some((r) => /allow-list/.test(r)));

  const fetched = await fetch(`${base}/api/treasury/batches/${batch.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(((await fetched.json()) as { status: string }).status, 'AWAITING_APPROVAL');
});

test('server: VND is rejected at creation (never a payout currency)', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const res = await fetch(`${base}/api/treasury/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ recipientEmail: 'vendor@example.com', amount: 10, currency: 'VND' }],
    }),
  });
  assert.equal(res.status, 400);
});
