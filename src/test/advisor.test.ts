// Advisor slice tests (Nov 9 plan, SPEC §6).
// (a) no key -> HOLD, rule-based, no network call.
// (b) stubbed OpenAI request carries no raw email and no free-text note.
// (c) invalid JSON / ungrounded amount -> HOLD, never EXECUTE_NOW.
// (d) valid stubbed EXECUTE_NOW is stored on the batch via the route.
// (e) allow-list add/list/remove, duplicate and 21st entry rejected.
// (f) end-to-end with stubbed PayPal: create -> advise -> allow-list ->
//     approve -> executes (stubbed 201), batch PENDING with payout_batch_id.
// Live OpenAI test runs ONLY when OPENAI_API_KEY is present; otherwise it
// skips cleanly. Nothing here is faked outside the stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adviseBatch, type AdvisorResult } from '../backend/advisor.js';
import type { Batch } from '../backend/store.js';
import { createApp } from '../server.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file — the live test skips below.
}

/** Minimal batch for unit-level advisor calls (no server needed). */
function makeBatch(): Batch {
  return {
    id: 'batch-1',
    senderBatchId: 'BAO_TEST_1',
    items: [
      {
        itemId: 'item-1',
        recipientEmail: 'vendor@example.com',
        amount: 10,
        currency: 'USD',
        recipientNote: 'Pay John Smith',
        senderItemId: 'ITEM_1',
        status: 'DRAFT',
        fxRiskScore: 0,
      },
    ],
    status: 'DRAFT',
    approved: false,
    approvalBlockReasons: [],
    createdAt: new Date().toISOString(),
  };
}

/** Frankfurter-shaped stub (EUR 0.89, GBP 0.74, SGD 1.28 per USD). */
function fxStub(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ rates: { EUR: 0.89, GBP: 0.74, SGD: 1.28 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
}

function openaiStub(content: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

function validAdvice(
  overrides: Partial<AdvisorResult> = {},
): string {
  return JSON.stringify({
    recommendation: 'EXECUTE_NOW',
    fxRiskScore: 2.5,
    reason: 'Low FX risk for the $10.00 item; total $10.00.',
    ...overrides,
  });
}

/** Restores env after the test; returns a cleanup hook. */
function withEnv(t: import('node:test').TestContext, vars: Record<string, string>): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('(a) advise without OPENAI_API_KEY returns HOLD and makes no network call', async (t) => {
  withEnv(t, { OPENAI_API_KEY: '' });
  let calls = 0;
  const neverCall = (async () => {
    calls += 1;
    throw new Error('must not be called');
  }) as typeof fetch;
  const result = await adviseBatch(makeBatch(), { fetchImpl: neverCall, fxFetch: fxStub() });
  assert.equal(result.recommendation, 'HOLD');
  assert.equal(result.source, 'rule');
  assert.ok(result.fxRiskScore >= 0 && result.fxRiskScore <= 10);
  assert.match(result.reason, /rule-based/);
  assert.equal(calls, 0);
});

test('(b) stubbed OpenAI request contains no raw email and no free-text note', async (t) => {
  withEnv(t, { OPENAI_API_KEY: 'test-key-not-real' });
  let capturedBody = '';
  const capturing = (async (_url: string, init?: { body?: unknown }) => {
    capturedBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: validAdvice() } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  const result = await adviseBatch(makeBatch(), { fetchImpl: capturing, fxFetch: fxStub() });
  assert.equal(result.recommendation, 'EXECUTE_NOW');
  assert.equal(result.source, 'llm');
  assert.ok(!capturedBody.includes('vendor@example.com'), 'raw email must not be sent');
  assert.ok(!capturedBody.includes('Pay John Smith'), 'free-text note must not be sent');
  assert.ok(capturedBody.includes('ve***@example.com'), 'masked email must be present');
  assert.ok(capturedBody.includes('[REDACTED]'), 'free-text fields must be redacted');
});

test('(c) invalid JSON from the LLM returns HOLD, never EXECUTE_NOW', async (t) => {
  withEnv(t, { OPENAI_API_KEY: 'test-key-not-real' });
  const result = await adviseBatch(makeBatch(), {
    fetchImpl: openaiStub('this is not json'),
    fxFetch: fxStub(),
  });
  assert.equal(result.recommendation, 'HOLD');
  assert.equal(result.source, 'rule');
});

test('(c) ungrounded amount in the LLM answer returns HOLD', async (t) => {
  withEnv(t, { OPENAI_API_KEY: 'test-key-not-real' });
  const result = await adviseBatch(makeBatch(), {
    fetchImpl: openaiStub(
      validAdvice({ reason: 'Execute the $999.00 payment now.' }),
    ),
    fxFetch: fxStub(),
  });
  assert.equal(result.recommendation, 'HOLD');
  assert.equal(result.source, 'rule');
  assert.match(result.reason, /not in this batch/);
});

test('(d) valid stubbed EXECUTE_NOW is stored on the batch via POST /:id/advise', async (t) => {
  withEnv(t, { OPENAI_API_KEY: 'test-key-not-real' });
  const { app } = createApp({
    openaiFetch: openaiStub(validAdvice()),
    fxFetch: fxStub(),
  });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no listen address');
  const base = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${base}/api/treasury/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ recipientEmail: 'vendor@example.com', amount: 10, currency: 'USD' }],
    }),
  });
  assert.equal(created.status, 201);
  const batch = (await created.json()) as { id: string };

  const advised = await fetch(`${base}/api/treasury/batches/${batch.id}/advise`, {
    method: 'POST',
  });
  assert.equal(advised.status, 200);
  const advice = (await advised.json()) as AdvisorResult & { batchId: string };
  assert.equal(advice.recommendation, 'EXECUTE_NOW');
  assert.equal(advice.fxRiskScore, 2.5);
  assert.equal(advice.model, 'gpt-4o');
  assert.equal(advice.source, 'llm');

  const fetched = (await (await fetch(`${base}/api/treasury/batches/${batch.id}`)).json()) as {
    recommendation?: string;
    fxRiskScore?: number;
    items: Array<{ fxRiskScore: number }>;
  };
  assert.equal(fetched.recommendation, 'EXECUTE_NOW');
  assert.equal(fetched.fxRiskScore, 2.5);
  assert.equal(fetched.items[0].fxRiskScore, 2.5);
});

test('(e) allow-list add/list/remove; duplicate and 21st entry rejected', async (t) => {
  const { app } = createApp();
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no listen address');
  const base = `http://127.0.0.1:${address.port}`;
  const json = async (res: Response) => (await res.json()) as { allowlist: string[] };

  const empty = await fetch(`${base}/api/treasury/allowlist`);
  assert.deepEqual((await json(empty)).allowlist, []);

  const bad = await fetch(`${base}/api/treasury/allowlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email' }),
  });
  assert.equal(bad.status, 400);

  const added = await fetch(`${base}/api/treasury/allowlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'vendor@example.com' }),
  });
  assert.equal(added.status, 201);
  assert.deepEqual((await json(added)).allowlist, ['vendor@example.com']);

  const dup = await fetch(`${base}/api/treasury/allowlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'vendor@example.com' }),
  });
  assert.equal(dup.status, 409);

  for (let i = 0; i < 19; i++) {
    const res = await fetch(`${base}/api/treasury/allowlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `vendor${i}@example.com` }),
    });
    assert.equal(res.status, 201);
  }
  const full = await fetch(`${base}/api/treasury/allowlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'one-too-many@example.com' }),
  });
  assert.equal(full.status, 422);

  const removed = await fetch(`${base}/api/treasury/allowlist/vendor@example.com`, {
    method: 'DELETE',
  });
  assert.equal(removed.status, 200);
  assert.equal((await json(removed)).allowlist.length, 19);

  const missing = await fetch(`${base}/api/treasury/allowlist/vendor@example.com`, {
    method: 'DELETE',
  });
  assert.equal(missing.status, 404);
});

test('(f) end-to-end with stubbed PayPal: advise -> allow-list -> approve -> PENDING', async (t) => {
  // Dummy sandbox credentials: the PayPal client reads them from env at
  // construction, but the stubbed transport never sends them anywhere.
  withEnv(t, {
    OPENAI_API_KEY: 'test-key-not-real',
    PAYPAL_SANDBOX_CLIENT_ID: 'test-id',
    PAYPAL_SANDBOX_CLIENT_SECRET: 'test-secret',
  });
  const paypalStub = (async (url: string) => {
    if (String(url).endsWith('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'stub-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        batch_header: { payout_batch_id: 'TEST_BATCH_123', batch_status: 'PENDING' },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  const { app } = createApp({
    openaiFetch: openaiStub(
      validAdvice({ reason: 'Low FX risk for the $1.00 item; total $1.00.' }),
    ),
    fxFetch: fxStub(),
    paypalFetch: paypalStub,
  });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no listen address');
  const base = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${base}/api/treasury/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ recipientEmail: 'vendor@example.com', amount: 1, currency: 'USD' }],
    }),
  });
  assert.equal(created.status, 201);
  const batch = (await created.json()) as { id: string };

  const advised = await fetch(`${base}/api/treasury/batches/${batch.id}/advise`, {
    method: 'POST',
  });
  assert.equal(advised.status, 200);
  assert.equal(((await advised.json()) as AdvisorResult).recommendation, 'EXECUTE_NOW');

  const listed = await fetch(`${base}/api/treasury/allowlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'vendor@example.com' }),
  });
  assert.equal(listed.status, 201);

  const approved = await fetch(`${base}/api/treasury/batches/${batch.id}/approve`, {
    method: 'POST',
  });
  assert.equal(approved.status, 200);
  const done = (await approved.json()) as {
    status: string;
    payoutBatchId?: string;
    recommendation?: string;
  };
  assert.equal(done.status, 'PENDING');
  assert.equal(done.payoutBatchId, 'TEST_BATCH_123');
  assert.equal(done.recommendation, 'EXECUTE_NOW');
});

// Live test: runs ONLY when OPENAI_API_KEY is present; otherwise skips.
// The batch is $1 USD, so the advice is cheap and safe (advise never pays).
const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY);
test(
  'live: OpenAI advisor returns a valid recommendation (skipped without a key)',
  { skip: !hasOpenAiKey },
  async () => {
    const result = await adviseBatch(makeBatch());
    assert.ok(
      ['EXECUTE_NOW', 'HOLD', 'SPLIT_BATCH'].includes(result.recommendation),
      'recommendation must be a known value',
    );
    assert.ok(result.fxRiskScore >= 0 && result.fxRiskScore <= 10);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
    assert.equal(typeof result.model, 'string');
  },
);
