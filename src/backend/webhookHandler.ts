// PayPal webhook handler (SPEC §4.3). The raw request body must be
// preserved (the route uses express.raw) and the signature verified via
// POST /v1/notifications/verify-webhook-signature BEFORE trusting
// anything. Unverified events return 400 and never touch the ledger.
// Sandbox ONLY.
import type { Request, Response } from 'express';
import {
  PAYPAL_SANDBOX_URL,
  fetchSandboxAccessToken,
} from './paypalService.js';
import { payoutEvents } from './events.js';
import type { TreasuryStore } from './store.js';

interface WebhookEvent {
  event_type?: string;
  resource?: {
    batch_header?: { payout_batch_id?: string };
    payout_item_id?: string;
    sender_item_id?: string;
    errors?: { message?: string };
    [key: string]: unknown;
  };
}

async function verifySignature(
  req: Request,
  rawBody: Buffer,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID ?? '';
  if (!webhookId) return false;
  const token = await fetchSandboxAccessToken(
    fetchImpl,
    process.env.PAYPAL_SANDBOX_CLIENT_ID ?? '',
    process.env.PAYPAL_SANDBOX_CLIENT_SECRET ?? '',
  );
  const res = await fetchImpl(
    `${PAYPAL_SANDBOX_URL}/v1/notifications/verify-webhook-signature`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_algo: req.headers['paypal-auth-algo'],
        cert_url: req.headers['paypal-cert-url'],
        transmission_id: req.headers['paypal-transmission-id'],
        transmission_sig: req.headers['paypal-transmission-sig'],
        transmission_time: req.headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: JSON.parse(rawBody.toString('utf8')),
      }),
    },
  );
  if (!res.ok) return false;
  const data = (await res.json()) as { verification_status?: string };
  return data.verification_status === 'SUCCESS';
}

export function createWebhookHandler(
  store: TreasuryStore,
  fetchImpl: typeof fetch = fetch,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const rawBody = req.body as Buffer | undefined;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      res.status(400).send({ status: 'INVALID_BODY' });
      return;
    }
    let event: WebhookEvent;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as WebhookEvent;
    } catch {
      res.status(400).send({ status: 'INVALID_JSON' });
      return;
    }

    let verified = false;
    try {
      verified = await verifySignature(req, rawBody, fetchImpl);
    } catch (err) {
      console.error(
        '[PayPal Webhook] Signature verification error:',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!verified) {
      console.error('[PayPal Webhook] Signature verification FAILED, ignoring event');
      res.status(400).send({ status: 'INVALID_SIGNATURE' });
      return;
    }

    const resource = event.resource ?? {};
    switch (event.event_type) {
      case 'PAYMENT.PAYOUTSBATCH.SUCCESS': {
        const payoutBatchId = resource.batch_header?.payout_batch_id;
        console.log(`[PayPal Webhook] Batch ${payoutBatchId} SUCCESS`);
        if (payoutBatchId) {
          const batch = store.findBatchByPayoutId(payoutBatchId);
          if (batch) batch.status = 'SUCCESS';
          payoutEvents.emit('payout_update', {
            type: 'batch',
            batchId: payoutBatchId,
            status: 'SUCCESS',
          });
        }
        break;
      }
      case 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': {
        const senderItemId = resource.sender_item_id;
        console.log(`[PayPal Webhook] Item ${resource.payout_item_id} SUCCEEDED`);
        if (senderItemId) {
          const found = store.findItemBySenderId(senderItemId);
          if (found) {
            found.item.status = 'SUCCESS';
            found.item.paypalTransactionId = resource.payout_item_id;
            payoutEvents.emit('payout_update', {
              type: 'item',
              batchId: found.batch.id,
              status: 'SUCCESS',
              payoutItemId: resource.payout_item_id,
            });
          }
        }
        break;
      }
      case 'PAYMENT.PAYOUTS-ITEM.FAILED': {
        const senderItemId = resource.sender_item_id;
        const message = resource.errors?.message ?? 'Payout item failed';
        console.error(`[PayPal Webhook] Item ${resource.payout_item_id} FAILED: ${message}`);
        if (senderItemId) {
          const found = store.findItemBySenderId(senderItemId);
          if (found) {
            found.item.status = 'FAILED';
            found.item.errorMessage = message;
            payoutEvents.emit('payout_update', {
              type: 'item',
              batchId: found.batch.id,
              status: 'FAILED',
              payoutItemId: resource.payout_item_id,
              message,
            });
          }
        }
        break;
      }
      default:
        console.log(`[PayPal Webhook] Unhandled event type: ${event.event_type}`);
    }

    res.status(200).send({ status: 'ACK' });
  };
}
