// SPEC §6 tests 1, 4, 5 — all offline, no network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PayoutGuard } from '../guard/payoutGuard.js';
import {
  HumanApprovalRequired,
  PayPalError,
  PayPalPayoutService,
} from '../backend/paypalService.js';
import type { PayoutItem } from '../models/PayoutItem.js';

function item(overrides: Partial<PayoutItem> = {}): PayoutItem {
  return {
    itemId: 'item-1',
    recipientEmail: 'vendor@example.com',
    amount: 10,
    currency: 'USD',
    senderItemId: 'ITEM_1',
    status: 'DRAFT',
    fxRiskScore: 1.0,
    ...overrides,
  };
}

function payload(amountValue = '10.00', currency = 'USD') {
  return {
    sender_batch_header: { sender_batch_id: 'BAO_TEST_001' },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: { value: amountValue, currency },
        note: 'Test invoice',
        sender_item_id: 'ITEM_1',
        receiver: 'vendor@example.com',
      },
    ],
  };
}

/** A fetch stub that records every call — used to prove no PayPal request is made. */
function countingFetch() {
  const calls: string[] = [];
  const stub = (async (url: string | URL | Request, _init?: unknown) => {
    calls.push(String(url));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { stub, calls };
}

test('SPEC §6 test 1: invalid payload is blocked before any network call', async () => {
  const { stub, calls } = countingFetch();
  const service = new PayPalPayoutService(stub);
  await assert.rejects(
    service.executeBatchPayout({
      payoutPayload: payload('INVALID'),
      items: [item()],
      approved: true,
      spentTodayUsd: 0,
      allowlist: ['vendor@example.com'],
    }),
    (err: unknown) => err instanceof PayPalError && /validation failed/i.test(err.message),
  );
  assert.equal(calls.length, 0, 'no PayPal request may be made for an invalid payload');
});

test('SPEC §6 test 4: PII mask (receiver -> gl***@example.com, free text -> [REDACTED])', () => {
  assert.equal(
    PayoutGuard.maskEmail('global_vendor_eu@example.com'),
    'gl***@example.com',
  );
  const masked = PayoutGuard.sanitizeForLLM({
    receiver: 'global_vendor_eu@example.com',
    note: 'Pay John Smith',
    email_subject: 'Payment for Alice',
    email_message: 'Hi Alice, paying invoice #1',
    currency: 'EUR',
    amount: 1250,
    fxRiskScore: 2.5,
    nested: { recipientEmail: 'alice@vendor.com', recipientNote: 'Thanks Alice' },
  });
  const flat = JSON.stringify(masked);
  assert.ok(flat.includes('gl***@example.com'), 'masked email must appear');
  assert.ok(flat.includes('[REDACTED]'), 'free-text fields must be redacted');
  assert.ok(!flat.includes('global_vendor_eu@example.com'), 'raw receiver email must not leak');
  assert.ok(!flat.includes('John Smith'), 'raw name in note must not leak');
  assert.ok(!flat.includes('Alice'), 'raw name in subject must not leak');
  assert.ok(!flat.includes('alice@vendor.com'), 'nested raw email must not leak');
  // Safe keys survive so the advisor still sees the numbers.
  const out = masked as { currency: string; amount: number; fxRiskScore: number };
  assert.equal(out.currency, 'EUR');
  assert.equal(out.amount, 1250);
  assert.equal(out.fxRiskScore, 2.5);
});

test('SPEC §6 test 5: approval gate — unapproved, $501 batch, off-allow-list each throw HumanApprovalRequired with no PayPal call', async () => {
  // (a) approved: false
  {
    const { stub, calls } = countingFetch();
    const service = new PayPalPayoutService(stub);
    await assert.rejects(
      service.executeBatchPayout({
        payoutPayload: payload(),
        items: [item()],
        approved: false,
        spentTodayUsd: 0,
        allowlist: ['vendor@example.com'],
      }),
      (err: unknown) => err instanceof HumanApprovalRequired,
    );
    assert.equal(calls.length, 0);
  }
  // (b) batch total $501 exceeds the $500 per-batch cap (items individually under $250)
  {
    const { stub, calls } = countingFetch();
    const service = new PayPalPayoutService(stub);
    const items = [
      item({ itemId: 'a', senderItemId: 'A', amount: 167 }),
      item({ itemId: 'b', senderItemId: 'B', amount: 167 }),
      item({ itemId: 'c', senderItemId: 'C', amount: 167 }),
    ];
    await assert.rejects(
      service.executeBatchPayout({
        payoutPayload: payload(),
        items,
        approved: true,
        spentTodayUsd: 0,
        allowlist: ['vendor@example.com'],
      }),
      (err: unknown) =>
        err instanceof HumanApprovalRequired && /per-batch cap/.test(err.message),
    );
    assert.equal(calls.length, 0);
  }
  // (c) recipient off the allow-list
  {
    const { stub, calls } = countingFetch();
    const service = new PayPalPayoutService(stub);
    await assert.rejects(
      service.executeBatchPayout({
        payoutPayload: payload(),
        items: [item()],
        approved: true,
        spentTodayUsd: 0,
        allowlist: ['someone-else@example.com'],
      }),
      (err: unknown) =>
        err instanceof HumanApprovalRequired && /allow-list/.test(err.message),
    );
    assert.equal(calls.length, 0);
  }
  // (d) per-item cap: a single $251 item is blocked too
  {
    const { stub, calls } = countingFetch();
    const service = new PayPalPayoutService(stub);
    await assert.rejects(
      service.executeBatchPayout({
        payoutPayload: payload(),
        items: [item({ amount: 251 })],
        approved: true,
        spentTodayUsd: 0,
        allowlist: ['vendor@example.com'],
      }),
      (err: unknown) =>
        err instanceof HumanApprovalRequired && /per-item cap/.test(err.message),
    );
    assert.equal(calls.length, 0);
  }
});
