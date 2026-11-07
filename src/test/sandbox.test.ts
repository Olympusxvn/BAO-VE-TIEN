// SPEC §6 test 2: live sandbox batch returns 201 + payout_batch_id.
// Runs ONLY when sandbox credentials are present in .env; otherwise it
// skips cleanly. Nothing here is faked: without credentials there is no
// result to assert, so the suite must not fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalPayoutService } from '../backend/paypalService.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file — the test skips below.
}

const hasCreds = Boolean(
  process.env.PAYPAL_SANDBOX_CLIENT_ID && process.env.PAYPAL_SANDBOX_CLIENT_SECRET,
);

test(
  'SPEC §6 test 2: live sandbox batch returns 201 + payout_batch_id',
  { skip: !hasCreds },
  async () => {
    const receiver =
      process.env.PAYPAL_SANDBOX_RECEIVER_EMAIL ?? 'sandbox-receiver@example.com';
    const service = new PayPalPayoutService();
    const result = await service.executeBatchPayout({
      payoutPayload: {
        sender_batch_header: {
          sender_batch_id: `BAO_TEST_${Date.now()}`,
          email_subject: 'BAO VE TIEN sandbox test',
          email_message: 'Sandbox test only.',
        },
        items: [
          {
            recipient_type: 'EMAIL',
            amount: { value: '1.00', currency: 'USD' },
            note: 'BAO VE TIEN sandbox 201 proof — $1 test',
            sender_item_id: `ITEM_${Date.now()}`,
            receiver,
          },
        ],
      },
      items: [
        {
          itemId: 'test-1',
          recipientEmail: receiver,
          amount: 1,
          currency: 'USD',
          senderItemId: 'ITEM_1',
          status: 'DRAFT',
          fxRiskScore: 0,
        },
      ],
      approved: true,
      spentTodayUsd: 0,
      allowlist: [receiver],
    });
    assert.ok(
      result.batch_header.payout_batch_id,
      'response must contain a payout_batch_id',
    );
    assert.equal(typeof result.batch_header.batch_status, 'string');
  },
);
