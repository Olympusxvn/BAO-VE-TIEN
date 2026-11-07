// Human/Auto approval-mode tests (user decision 2026-11-07).
// (a) HUMAN mode never auto-executes, even with an EXECUTE_NOW
//     recommendation. (b) AUTO mode executes when every condition
//     holds, through the same executeBatchPayout path, and logs the
//     execution with its policy snapshot + advisor output. (c) Each
//     single failing condition blocks auto-execution with no PayPal
//     call. (d) Mode changes and pause/unpause are logged and readable.
// (e) The warning strings exist verbatim in the frontend code.
// PayPal and OpenAI are stubbed here; nothing is faked outside stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file — no live tests in this file.
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

function validAdvice(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    recommendation: 'EXECUTE_NOW',
    fxRiskScore: 2.0,
    reason: 'Low FX risk for the $50.00 item; total $50.00.',
    ...overrides,
  });
}

/** PayPal stub that counts every invocation (token + payouts). */
function paypalStub(counter: { calls: number }): typeof fetch {
  return (async (url: string) => {
    counter.calls += 1;
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
}

/** Restores env after the test. */
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

async function startServer(deps: {
  llmFetch?: typeof fetch;
  fxFetch?: typeof fetch;
  paypalFetch?: typeof fetch;
}) {
  const { app, store } = createApp(deps);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no listen address');
  return { server, store, base: `http://127.0.0.1:${address.port}` };
}

async function createBatch(
  base: string,
  items: Array<{ recipientEmail: string; amount: number; currency: string }>,
): Promise<{ id: string }> {
  const res = await fetch(`${base}/api/treasury/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string };
}

async function allowlistAdd(base: string, email: string): Promise<void> {
  const res = await fetch(`${base}/api/treasury/allowlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(res.status, 201);
}

async function setMode(base: string, mode: string): Promise<void> {
  const res = await fetch(`${base}/api/treasury/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  assert.equal(res.status, 200);
}

async function advise(base: string, batchId: string): Promise<Response> {
  return fetch(`${base}/api/treasury/batches/${batchId}/advise`, { method: 'POST' });
}

async function getBatch(base: string, batchId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/treasury/batches/${batchId}`);
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

const DUMMY_CREDS = {
  OPENAI_API_KEY: 'test-key-not-real',
  PAYPAL_SANDBOX_CLIENT_ID: 'test-id',
  PAYPAL_SANDBOX_CLIENT_SECRET: 'test-secret',
};

test('(a) HUMAN mode never auto-executes, even with EXECUTE_NOW', async (t) => {
  withEnv(t, DUMMY_CREDS);
  const calls = { calls: 0 };
  const { server, base } = await startServer({
    llmFetch: openaiStub(validAdvice()),
    fxFetch: fxStub(),
    paypalFetch: paypalStub(calls),
  });
  t.after(() => server.close());

  const mode = (await (await fetch(`${base}/api/treasury/mode`)).json()) as {
    mode: string;
    paused: boolean;
  };
  assert.equal(mode.mode, 'HUMAN');
  assert.equal(mode.paused, false);

  const batch = await createBatch(base, [
    { recipientEmail: 'vendor@example.com', amount: 50, currency: 'USD' },
  ]);
  await allowlistAdd(base, 'vendor@example.com');
  const advised = await advise(base, batch.id);
  assert.equal(advised.status, 200);
  assert.equal(((await advised.json()) as { recommendation: string }).recommendation, 'EXECUTE_NOW');

  const fetched = await getBatch(base, batch.id);
  assert.equal(fetched.status, 'AWAITING_APPROVAL');
  assert.equal(fetched.approved, false);
  assert.equal(calls.calls, 0, 'no PayPal call may be made in Human mode');
});

test('(b) AUTO mode executes when every condition holds, and logs it', async (t) => {
  withEnv(t, DUMMY_CREDS);
  const calls = { calls: 0 };
  const { server, base } = await startServer({
    llmFetch: openaiStub(validAdvice()),
    fxFetch: fxStub(),
    paypalFetch: paypalStub(calls),
  });
  t.after(() => server.close());

  await setMode(base, 'AUTO');
  const batch = await createBatch(base, [
    { recipientEmail: 'vendor@example.com', amount: 50, currency: 'USD' },
  ]);
  await allowlistAdd(base, 'vendor@example.com');
  const advised = await advise(base, batch.id);
  assert.equal(advised.status, 200);
  const advice = (await advised.json()) as {
    recommendation: string;
    autoExecuted: boolean;
    status: string;
    payoutBatchId?: string;
  };
  assert.equal(advice.recommendation, 'EXECUTE_NOW');
  assert.equal(advice.autoExecuted, true);
  assert.equal(advice.status, 'PENDING');
  assert.equal(advice.payoutBatchId, 'TEST_BATCH_123');

  const fetched = await getBatch(base, batch.id);
  assert.equal(fetched.status, 'PENDING');
  assert.equal(fetched.payoutBatchId, 'TEST_BATCH_123');
  assert.equal(fetched.autoExecuted, true);
  assert.equal(calls.calls, 2, 'one token call + one payouts call');

  const audit = (await (await fetch(`${base}/api/treasury/audit`)).json()) as {
    entries: Array<{
      kind: string;
      detail: Record<string, unknown>;
    }>;
  };
  const execution = audit.entries.find((e) => e.kind === 'auto-execution');
  assert.ok(execution, 'auto-execution must be in the audit log');
  const policy = execution.detail.policy as Record<string, unknown>;
  assert.equal(policy.mode, 'AUTO');
  assert.equal(policy.totalUsd, 50);
  assert.equal(policy.recommendation, 'EXECUTE_NOW');
  const advisor = execution.detail.advisor as Record<string, unknown>;
  assert.equal(advisor.recommendation, 'EXECUTE_NOW');
  assert.equal(advisor.fxRiskScore, 2);
  const modeChange = audit.entries.find((e) => e.kind === 'mode-change');
  assert.ok(modeChange, 'mode change must be in the audit log');
  assert.deepEqual(
    { from: modeChange.detail.from, to: modeChange.detail.to },
    { from: 'HUMAN', to: 'AUTO' },
  );
});

test('(c) advisor HOLD blocks auto-execution with no PayPal call', async (t) => {
  withEnv(t, DUMMY_CREDS);
  const calls = { calls: 0 };
  const { server, base } = await startServer({
    llmFetch: openaiStub(
      validAdvice({ recommendation: 'HOLD', fxRiskScore: 5.0, reason: 'FX risk is high for the $50.00 item; total $50.00.' }),
    ),
    fxFetch: fxStub(),
    paypalFetch: paypalStub(calls),
  });
  t.after(() => server.close());

  await setMode(base, 'AUTO');
  const batch = await createBatch(base, [
    { recipientEmail: 'vendor@example.com', amount: 50, currency: 'USD' },
  ]);
  await allowlistAdd(base, 'vendor@example.com');
  const advised = await advise(base, batch.id);
  assert.equal(advised.status, 200);
  assert.equal(((await advised.json()) as { recommendation: string }).recommendation, 'HOLD');
  const fetched = await getBatch(base, batch.id);
  assert.equal(fetched.status, 'AWAITING_APPROVAL');
  assert.equal(calls.calls, 0);
});

test('(c) item $101 exceeds the Auto per-item cap and blocks execution', async (t) => {
  withEnv(t, DUMMY_CREDS);
  const calls = { calls: 0 };
  const { server, base } = await startServer({
    llmFetch: openaiStub(
      validAdvice({ reason: 'Low FX risk for the $101.00 item; total $101.00.' }),
    ),
    fxFetch: fxStub(),
    paypalFetch: paypalStub(calls),
  });
  t.after(() => server.close());

  await setMode(base, 'AUTO');
  const batch = await createBatch(base, [
    { recipientEmail: 'vendor@example.com', amount: 101, currency: 'USD' },
  ]);
  await allowlistAdd(base, 'vendor@example.com');
  await advise(base, batch.id);
  const fetched = await getBatch(base, batch.id);
  assert.equal(fetched.status, 'AWAITING_APPROVAL');
  assert.ok(
    ((fetched.autoBlockReasons ?? []) as string[]).some((r) => /Auto-mode per-item cap/.test(r)),
  );
  assert.equal(calls.calls, 0);
});

test('(c) batch $270 exceeds the Auto per-batch cap and blocks execution', async (t) => {
  withEnv(t, DUMMY_CREDS);
  const calls = { calls: 0 };
  const { server, base } = await startServer({
    llmFetch: openaiStub(
      validAdvice({ reason: 'Low FX risk for the $90.00 item; total $270.00.' }),
    ),
    fxFetch: fxStub(),
    paypalFetch: paypalStub(calls),
  });
  t.after(() => server.close());

  await setMode(base, 'AUTO');
  const batch = await createBatch(base, [
    { recipientEmail: 'vendor@example.com', amount: 90, currency: 'USD' },
    { recipientEmail: 'vendor@example.com', amount: 90, currency: 'USD' },
    { recipientEmail: 'vendor@example.com', amount: 90, currency: 'USD' },
  ]);
  await allowlistAdd(base, 'vendor@example.com');
  await advise(base, batch.id);
  const fetched = await getBatch(base, batch.id);
  assert.equal(fetched.status, 'AWAITING_APPROVAL');
  assert.ok(
    ((fetched.autoBlockReasons ?? []) as string[]).some((r) => /Auto-mode per-batch cap/.test(r)),
  );
  assert.equal(calls.calls, 0);
});

test('(c) auto daily budget already spent blocks execution', async (t) => {
  withEnv(t, DUMMY_CREDS);
  const calls = { calls: 0 };
  const { server, base, store } = await startServer({
    llmFetch: openaiStub(validAdvice()),
    fxFetch: fxStub(),
    paypalFetch: paypalStub(calls),
  });
  t.after(() => server.close());

  await setMode(base, 'AUTO');
  store.autoSpentTodayUsd = 480; // $480 of the $500 auto daily budget used.
  const batch = await createBatch(base, [
    { recipientEmail: 'vendor@example.com', amount: 50, currency: 'USD' },
  ]);
  await allowlistAdd(base, 'vendor@example.com');
  await advise(base, batch.id);
  const fetched = await getBatch(base, batch.id);
  assert.equal(fetched.status, 'AWAITING_APPROVAL');
  assert.ok(
    ((fetched.autoBlockReasons ?? []) as string[]).some((r) => /Auto-mode daily cap/.test(r)),
  );
  assert.equal(calls.calls, 0);
});

test('(c) FX risk score 3.0 is not below the Auto maximum and blocks execution', async (t) => {
  withEnv(t, DUMMY_CREDS);
  const calls = { calls: 0 };
  const { server, base } = await startServer({
    llmFetch: openaiStub(validAdvice({ fxRiskScore: 3.0 })),
    fxFetch: fxStub(),
    paypalFetch: paypalStub(calls),
  });
  t.after(() => server.close());

  await setMode(base, 'AUTO');
  const batch = await createBatch(base, [
    { recipientEmail: 'vendor@example.com', amount: 50, currency: 'USD' },
  ]);
  await allowlistAdd(base, 'vendor@example.com');
  const advised = await advise(base, batch.id);
  assert.equal(advised.status, 200);
  assert.equal(((await advised.json()) as { fxRiskScore: number }).fxRiskScore, 3);
  const fetched = await getBatch(base, batch.id);
  assert.equal(fetched.status, 'AWAITING_APPROVAL');
  assert.ok(
    ((fetched.autoBlockReasons ?? []) as string[]).some((r) => /not below 3/.test(r)),
  );
  assert.equal(calls.calls, 0);
});

test('(c) off-allow-list recipient blocks auto-execution', async (t) => {
  withEnv(t, DUMMY_CREDS);
  const calls = { calls: 0 };
  const { server, base } = await startServer({
    llmFetch: openaiStub(validAdvice()),
    fxFetch: fxStub(),
    paypalFetch: paypalStub(calls),
  });
  t.after(() => server.close());

  await setMode(base, 'AUTO');
  // Recipient deliberately NOT added to the allow-list.
  const batch = await createBatch(base, [
    { recipientEmail: 'vendor@example.com', amount: 50, currency: 'USD' },
  ]);
  await advise(base, batch.id);
  const fetched = await getBatch(base, batch.id);
  assert.equal(fetched.status, 'AWAITING_APPROVAL');
  assert.ok(
    ((fetched.autoBlockReasons ?? []) as string[]).some((r) => /allow-list/.test(r)),
  );
  assert.equal(calls.calls, 0);
});

test('(c) paused Auto mode blocks auto-execution', async (t) => {
  withEnv(t, DUMMY_CREDS);
  const calls = { calls: 0 };
  const { server, base } = await startServer({
    llmFetch: openaiStub(validAdvice()),
    fxFetch: fxStub(),
    paypalFetch: paypalStub(calls),
  });
  t.after(() => server.close());

  await setMode(base, 'AUTO');
  const paused = await fetch(`${base}/api/treasury/mode/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: true }),
  });
  assert.equal(paused.status, 200);
  const batch = await createBatch(base, [
    { recipientEmail: 'vendor@example.com', amount: 50, currency: 'USD' },
  ]);
  await allowlistAdd(base, 'vendor@example.com');
  await advise(base, batch.id);
  const fetched = await getBatch(base, batch.id);
  assert.equal(fetched.status, 'AWAITING_APPROVAL');
  assert.equal(fetched.autoExecuted, undefined);
  assert.equal(calls.calls, 0);
});

test('(d) mode changes and pause/unpause are logged and readable', async (t) => {
  const { server, base } = await startServer({});
  t.after(() => server.close());

  const initial = (await (await fetch(`${base}/api/treasury/mode`)).json()) as {
    mode: string;
    paused: boolean;
    autoCaps: Record<string, number>;
  };
  assert.equal(initial.mode, 'HUMAN');
  assert.equal(initial.paused, false);
  assert.equal(initial.autoCaps.perItem, 100);
  assert.equal(initial.autoCaps.perBatch, 250);
  assert.equal(initial.autoCaps.daily, 500);
  assert.equal(initial.autoCaps.fxRiskMax, 3);

  const badMode = await fetch(`${base}/api/treasury/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'BOGUS' }),
  });
  assert.equal(badMode.status, 400);

  await setMode(base, 'AUTO');
  const pausedRes = await fetch(`${base}/api/treasury/mode/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: true }),
  });
  assert.equal(pausedRes.status, 200);
  const badPause = await fetch(`${base}/api/treasury/mode/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: 'yes' }),
  });
  assert.equal(badPause.status, 400);

  const resumed = await fetch(`${base}/api/treasury/mode/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: false }),
  });
  assert.equal(resumed.status, 200);
  const mode = (await (await fetch(`${base}/api/treasury/mode`)).json()) as {
    mode: string;
    paused: boolean;
  };
  assert.equal(mode.mode, 'AUTO');
  assert.equal(mode.paused, false);

  const audit = (await (await fetch(`${base}/api/treasury/audit`)).json()) as {
    entries: Array<{ id: string; at: string; kind: string; detail: Record<string, unknown> }>;
  };
  assert.ok(audit.entries.length >= 3);
  for (const entry of audit.entries) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(!Number.isNaN(Date.parse(entry.at)), 'audit entry needs a timestamp');
  }
  const kinds = audit.entries.map((e) => e.kind);
  assert.ok(kinds.includes('mode-change'), 'mode change must be logged');
  assert.equal(kinds.filter((k) => k === 'pause-change').length, 2);
  const change = audit.entries.find((e) => e.kind === 'mode-change');
  assert.deepEqual(
    { from: change?.detail.from, to: change?.detail.to },
    { from: 'HUMAN', to: 'AUTO' },
  );
});

test('(e) the Auto warning strings exist verbatim in the frontend code', async () => {
  const root = fileURLToPath(new URL('../../frontend/src/', import.meta.url));
  const strings = readFileSync(`${root}modeStrings.ts`, 'utf8');
  assert.ok(
    strings.includes(
      'Auto mode executes batches automatically when they pass policy — no per-batch approval. Waiting for approval can mean missing an FX window. Only enable Auto mode if you trust the policy, caps, and allow-list. You can pause it anytime.',
    ),
    'enable-confirm warning must exist verbatim',
  );
  assert.ok(
    strings.includes('Auto mode is ON — qualifying batches execute automatically. Pause anytime.'),
    'Auto banner must exist verbatim',
  );
  // The components must actually use them (not dead strings).
  const app = readFileSync(`${root}App.tsx`, 'utf8');
  const panels = readFileSync(`${root}Panels.tsx`, 'utf8');
  assert.ok(
    app.includes('modeStrings') || panels.includes('modeStrings'),
    'a component must import the warning strings',
  );
});
