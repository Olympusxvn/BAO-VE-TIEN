// Gemini advisor slice tests (2026-11-07, user decision: keep OpenAI,
// add Gemini). All keys below are obvious dummies — no real key is used
// anywhere in this file. Nothing here is faked outside the stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adviseBatch, type AdvisorResult } from '../backend/advisor.js';
import type { Batch } from '../backend/store.js';
import { createApp } from '../server.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file — tests set the env they need explicitly.
}

const DUMMY_GEMINI_KEY = 'test-gemini-key-not-real';
const DUMMY_OPENAI_KEY = 'test-openai-key-not-real';

/** Minimal batch for unit-level advisor calls (no server needed). */
function makeBatch(): Batch {
  return {
    id: 'batch-1',
    senderBatchId: 'BAO_TEST_GEMINI_1',
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

/** Gemini-shaped stub: candidates[0].content.parts[*].text. */
function geminiStub(
  text: string,
  capture?: { url?: string; headers?: Record<string, string>; body?: string },
): typeof fetch {
  return (async (url: string, init?: { headers?: Record<string, string>; body?: unknown }) => {
    if (capture) {
      capture.url = String(url);
      capture.headers = { ...(init?.headers ?? {}) };
      capture.body = String(init?.body ?? '');
    }
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

function geminiErrorStub(status: number): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ error: { message: 'bad key' } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
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

test('(a) stubbed Gemini success parses, modelUsed is gemini/<model>', async (t) => {
  withEnv(t, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: DUMMY_GEMINI_KEY, OPENAI_API_KEY: '' });
  const capture: { url?: string; headers?: Record<string, string>; body?: string } = {};
  const result = await adviseBatch(makeBatch(), {
    fetchImpl: geminiStub(validAdvice(), capture),
    fxFetch: fxStub(),
  });
  assert.equal(result.recommendation, 'EXECUTE_NOW');
  assert.equal(result.source, 'llm');
  assert.equal(result.model, 'gemini/gemini-2.5-flash');
  assert.ok(
    capture.url?.startsWith(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    ),
    `unexpected Gemini URL: ${capture.url}`,
  );
  assert.ok(!capture.url?.includes('key='), 'key must never be in the URL');
  assert.equal(capture.headers?.['x-goog-api-key'], DUMMY_GEMINI_KEY);
  assert.ok(capture.body?.includes('"contents"'), 'Gemini body must use contents/parts');
});

test('(a) GEMINI_MODEL env overrides the default model', async (t) => {
  withEnv(t, {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: DUMMY_GEMINI_KEY,
    GEMINI_MODEL: 'gemini-2.5-flash-lite',
    OPENAI_API_KEY: '',
  });
  const capture: { url?: string } = {};
  const result = await adviseBatch(makeBatch(), {
    fetchImpl: geminiStub(validAdvice(), capture),
    fxFetch: fxStub(),
  });
  assert.equal(result.model, 'gemini/gemini-2.5-flash-lite');
  assert.ok(capture.url?.includes('gemini-2.5-flash-lite:generateContent'));
});

test('(b) Gemini HTTP 401 returns HOLD, never EXECUTE_NOW', async (t) => {
  withEnv(t, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: DUMMY_GEMINI_KEY, OPENAI_API_KEY: '' });
  const result = await adviseBatch(makeBatch(), {
    fetchImpl: geminiErrorStub(401),
    fxFetch: fxStub(),
  });
  assert.equal(result.recommendation, 'HOLD');
  assert.equal(result.source, 'rule');
  assert.equal(result.model, 'gemini/gemini-2.5-flash');
  assert.match(result.reason, /Gemini request failed: HTTP 401/);
});

test('(b) Gemini invalid JSON returns HOLD', async (t) => {
  withEnv(t, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: DUMMY_GEMINI_KEY, OPENAI_API_KEY: '' });
  const result = await adviseBatch(makeBatch(), {
    fetchImpl: geminiStub('this is not json'),
    fxFetch: fxStub(),
  });
  assert.equal(result.recommendation, 'HOLD');
  assert.equal(result.source, 'rule');
});

test('(b) Gemini empty candidates returns HOLD', async (t) => {
  withEnv(t, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: DUMMY_GEMINI_KEY, OPENAI_API_KEY: '' });
  const empty = (async () =>
    new Response(JSON.stringify({ candidates: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  const result = await adviseBatch(makeBatch(), { fetchImpl: empty, fxFetch: fxStub() });
  assert.equal(result.recommendation, 'HOLD');
  assert.equal(result.source, 'rule');
  assert.match(result.reason, /Gemini returned no content/);
});

test('(b) Gemini without a key returns HOLD and makes no network call', async (t) => {
  withEnv(t, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: '', OPENAI_API_KEY: '' });
  let calls = 0;
  const neverCall = (async () => {
    calls += 1;
    throw new Error('must not be called');
  }) as typeof fetch;
  const result = await adviseBatch(makeBatch(), { fetchImpl: neverCall, fxFetch: fxStub() });
  assert.equal(result.recommendation, 'HOLD');
  assert.equal(result.source, 'rule');
  assert.equal(result.model, 'gemini/gemini-2.5-flash');
  assert.match(result.reason, /Gemini API key not configured/);
  assert.equal(calls, 0);
});

test('(f) stubbed Gemini request contains no raw email and no free-text note', async (t) => {
  withEnv(t, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: DUMMY_GEMINI_KEY, OPENAI_API_KEY: '' });
  const capture: { body?: string } = {};
  const result = await adviseBatch(makeBatch(), {
    fetchImpl: geminiStub(validAdvice(), capture),
    fxFetch: fxStub(),
  });
  assert.equal(result.recommendation, 'EXECUTE_NOW');
  assert.ok(!capture.body?.includes('vendor@example.com'), 'raw email must not be sent');
  assert.ok(!capture.body?.includes('Pay John Smith'), 'free-text note must not be sent');
  assert.ok(capture.body?.includes('ve***@example.com'), 'masked email must be present');
  assert.ok(capture.body?.includes('[REDACTED]'), 'free-text fields must be redacted');
});

test('(c) BYOK: set gemini config, advise uses it; GET never leaks the key; DELETE falls back to env', async (t) => {
  // No keys in env: the BYOK key must be the one the stub sees.
  withEnv(t, { AI_PROVIDER: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '' });
  const capture: { headers?: Record<string, string>; url?: string } = {};
  const { server, base } = await startServer({
    llmFetch: geminiStub(validAdvice(), capture),
    fxFetch: fxStub(),
  });
  t.after(() => server.close());

  const defaultCfg = (await (await fetch(`${base}/api/treasury/advisor/config`)).json()) as {
    provider: string;
    model: string;
    keySet: boolean;
  };
  assert.equal(defaultCfg.provider, 'openai');
  assert.equal(defaultCfg.model, 'gpt-4o');
  assert.equal(defaultCfg.keySet, false);

  const setRes = await fetch(`${base}/api/treasury/advisor/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'gemini',
      apiKey: DUMMY_GEMINI_KEY,
      model: 'gemini-2.5-flash',
    }),
  });
  assert.equal(setRes.status, 200);
  const setBody = (await setRes.json()) as { provider: string; model: string; keySet: boolean };
  assert.equal(setBody.provider, 'gemini');
  assert.equal(setBody.model, 'gemini-2.5-flash');
  assert.equal(setBody.keySet, true);

  // (d) GET config never contains the key or any distinctive part of it.
  const got = await fetch(`${base}/api/treasury/advisor/config`);
  const gotText = await got.text();
  assert.ok(!gotText.includes(DUMMY_GEMINI_KEY), 'GET config must not return the key');
  assert.ok(!gotText.includes('gemini-key'), 'GET config must not return part of the key');
  assert.ok(!('apiKey' in JSON.parse(gotText)), 'GET config must not have an apiKey field');
  const gotCfg = JSON.parse(gotText) as { provider: string; model: string; keySet: boolean };
  assert.equal(gotCfg.provider, 'gemini');
  assert.equal(gotCfg.keySet, true);

  // Advise with the BYOK config: the stub must see the key in the
  // header (not the URL) and the batch must record gemini/<model>.
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
  assert.equal(advice.model, 'gemini/gemini-2.5-flash');
  assert.equal(advice.source, 'llm');
  assert.equal(capture.headers?.['x-goog-api-key'], DUMMY_GEMINI_KEY);
  assert.ok(!capture.url?.includes('key='), 'key must never be in the URL');

  // Invalid config is rejected.
  const bad = await fetch(`${base}/api/treasury/advisor/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'anthropic', apiKey: DUMMY_GEMINI_KEY }),
  });
  assert.equal(bad.status, 400);

  // DELETE clears the runtime config: back to env (openai, no key).
  const cleared = await fetch(`${base}/api/treasury/advisor/config`, { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  const clearedCfg = (await cleared.json()) as {
    provider: string;
    model: string;
    keySet: boolean;
  };
  assert.equal(clearedCfg.provider, 'openai');
  assert.equal(clearedCfg.model, 'gpt-4o');
  assert.equal(clearedCfg.keySet, false);

  const created2 = await fetch(`${base}/api/treasury/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ recipientEmail: 'vendor@example.com', amount: 10, currency: 'USD' }],
    }),
  });
  const batch2 = (await created2.json()) as { id: string };
  const advised2 = await fetch(`${base}/api/treasury/batches/${batch2.id}/advise`, {
    method: 'POST',
  });
  const advice2 = (await advised2.json()) as AdvisorResult;
  assert.equal(advice2.recommendation, 'HOLD');
  assert.equal(advice2.source, 'rule');
  assert.equal(advice2.model, 'openai/gpt-4o');
  assert.match(advice2.reason, /OpenAI API key not configured/);
});

test('(c) BYOK provider switch without a key keeps the provider but falls back to HOLD', async (t) => {
  withEnv(t, { AI_PROVIDER: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '' });
  const { server, base } = await startServer({
    llmFetch: geminiStub(validAdvice()),
    fxFetch: fxStub(),
  });
  t.after(() => server.close());

  const setRes = await fetch(`${base}/api/treasury/advisor/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'gemini' }),
  });
  assert.equal(setRes.status, 200);
  const cfg = (await setRes.json()) as { provider: string; model: string; keySet: boolean };
  assert.equal(cfg.provider, 'gemini');
  assert.equal(cfg.model, 'gemini-2.5-flash');
  assert.equal(cfg.keySet, false);

  const created = await fetch(`${base}/api/treasury/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ recipientEmail: 'vendor@example.com', amount: 10, currency: 'USD' }],
    }),
  });
  const batch = (await created.json()) as { id: string };
  const advised = await fetch(`${base}/api/treasury/batches/${batch.id}/advise`, {
    method: 'POST',
  });
  const advice = (await advised.json()) as AdvisorResult;
  assert.equal(advice.recommendation, 'HOLD');
  assert.equal(advice.model, 'gemini/gemini-2.5-flash');
});

// Live test: runs ONLY when GEMINI_API_KEY is present; otherwise skips.
// The batch is $1 USD, so the advice is cheap and safe (advise never pays).
const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);
test(
  'live: Gemini advisor returns a valid recommendation (skipped without a key)',
  { skip: !hasGeminiKey },
  async () => {
    const result = await adviseBatch(makeBatch(), { provider: 'gemini' });
    assert.ok(
      ['EXECUTE_NOW', 'HOLD', 'SPLIT_BATCH'].includes(result.recommendation),
      'recommendation must be a known value',
    );
    assert.ok(result.fxRiskScore >= 0 && result.fxRiskScore <= 10);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
    assert.ok(result.model.startsWith('gemini/'));
  },
);
