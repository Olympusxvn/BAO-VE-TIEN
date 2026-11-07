// Webhook handler tests (SPEC §4.3 / §6 test 3 shape, offline with a stubbed
// PayPal fetch). Unverified events return 400 and never touch the ledger;
// a verified PAYMENT.PAYOUTSBATCH.SUCCESS updates the batch and emits SSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookHandler } from '../backend/webhookHandler.js';
import { payoutEvents } from '../backend/events.js';
import { TreasuryStore } from '../backend/store.js';

// The handler refuses every event without a configured webhook id and
// sandbox credentials (values here are dummies; fetch is stubbed).
process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST';
process.env.PAYPAL_SANDBOX_CLIENT_ID = 'test-client-id';
process.env.PAYPAL_SANDBOX_CLIENT_SECRET = 'test-client-secret';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stub fetch: token call succeeds; verification returns the given status. */
function stubPayPal(verificationStatus: string) {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/v1/oauth2/token')) return jsonResponse({ access_token: 'stub-token' });
    if (u.includes('verify-webhook-signature')) {
      return jsonResponse({ verification_status: verificationStatus });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
}

function mockReqRes(event: unknown) {
  const req = {
    body: Buffer.from(JSON.stringify(event)),
    headers: {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/certs',
      'paypal-transmission-id': 'tx-1',
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': new Date().toISOString(),
    },
  } as never;
  let statusCode = 0;
  let sent: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    send(body: unknown) {
      sent = body;
      return this;
    },
  } as never;
  return { req, res, get statusCode() { return statusCode; }, get sent() { return sent; } };
}

test('unverified webhook returns 400 and never touches the ledger', async () => {
  const store = new TreasuryStore();
  const batch = store.createBatch([
    {
      itemId: 'i1',
      recipientEmail: 'vendor@example.com',
      amount: 10,
      currency: 'USD',
      senderItemId: 'ITEM_1',
      status: 'DRAFT',
      fxRiskScore: 0,
    },
  ]);
  batch.payoutBatchId = 'BATCH123';
  const handler = createWebhookHandler(store, stubPayPal('FAILURE'));
  const m = mockReqRes({
    event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS',
    resource: { batch_header: { payout_batch_id: 'BATCH123' } },
  });
  await handler(m.req, m.res);
  assert.equal(m.statusCode, 400);
  assert.equal(store.getBatch(batch.id)?.status, 'DRAFT');
});

test('verified PAYMENT.PAYOUTSBATCH.SUCCESS updates the batch and emits an SSE event', async () => {
  const store = new TreasuryStore();
  const batch = store.createBatch([
    {
      itemId: 'i1',
      recipientEmail: 'vendor@example.com',
      amount: 10,
      currency: 'USD',
      senderItemId: 'ITEM_1',
      status: 'PENDING',
      fxRiskScore: 0,
    },
  ]);
  batch.payoutBatchId = 'BATCH123';
  batch.status = 'PENDING';
  const handler = createWebhookHandler(store, stubPayPal('SUCCESS'));
  const emitted: unknown[] = [];
  payoutEvents.once('payout_update', (u) => emitted.push(u));
  const m = mockReqRes({
    event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS',
    resource: { batch_header: { payout_batch_id: 'BATCH123' } },
  });
  await handler(m.req, m.res);
  assert.equal(m.statusCode, 200);
  assert.equal(store.getBatch(batch.id)?.status, 'SUCCESS');
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], { type: 'batch', batchId: 'BATCH123', status: 'SUCCESS' });
});

test('verified PAYMENT.PAYOUTS-ITEM.FAILED marks the item FAILED with the PayPal message', async () => {
  const store = new TreasuryStore();
  const batch = store.createBatch([
    {
      itemId: 'i1',
      recipientEmail: 'vendor@example.com',
      amount: 10,
      currency: 'USD',
      senderItemId: 'ITEM_9',
      status: 'PENDING',
      fxRiskScore: 0,
    },
  ]);
  batch.payoutBatchId = 'BATCH9';
  const handler = createWebhookHandler(store, stubPayPal('SUCCESS'));
  const m = mockReqRes({
    event_type: 'PAYMENT.PAYOUTS-ITEM.FAILED',
    resource: {
      payout_item_id: 'PI-1',
      sender_item_id: 'ITEM_9',
      errors: { message: 'Receiver is unregistered' },
    },
  });
  await handler(m.req, m.res);
  assert.equal(m.statusCode, 200);
  const item = store.getBatch(batch.id)?.items[0];
  assert.equal(item?.status, 'FAILED');
  assert.equal(item?.errorMessage, 'Receiver is unregistered');
});
