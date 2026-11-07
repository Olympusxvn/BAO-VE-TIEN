// PayPal Payouts client (SPEC §4.1). Hand-written, native fetch.
// Sandbox ONLY — the base URL is a constant and there is no live URL
// anywhere in this codebase.
//
// Env names (supersede the SPEC's PAYPAL_CLIENT_ID naming, which matched
// an older draft): PAYPAL_SANDBOX_CLIENT_ID / PAYPAL_SANDBOX_CLIENT_SECRET,
// the same names used by scripts/sandbox-payout-201.mjs.
import { PayoutGuard } from '../guard/payoutGuard.js';
import type { PayoutItem } from '../models/PayoutItem.js';

export const PAYPAL_SANDBOX_URL = 'https://api-m.sandbox.paypal.com';

export class HumanApprovalRequired extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`HumanApprovalRequired: ${reasons.join('; ')}`);
    this.name = 'HumanApprovalRequired';
    this.reasons = reasons;
  }
}

export class PayPalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayPalError';
  }
}

export interface BatchExecutionInput {
  payoutPayload: {
    sender_batch_header?: {
      sender_batch_id?: string;
      email_subject?: string;
      email_message?: string;
    };
    items?: Array<{
      recipient_type?: string;
      amount?: { value?: string; currency?: string };
      note?: string;
      sender_item_id?: string;
      receiver?: string;
    }>;
  };
  /** Items expressed in USD-equivalent amounts (caller converts first). */
  items: PayoutItem[];
  approved: boolean;
  spentTodayUsd: number;
  allowlist: string[];
}

export interface PayoutBatchResult {
  batch_header: {
    payout_batch_id: string;
    batch_status: string;
    sender_batch_header?: { sender_batch_id?: string };
  };
}

/** Sandbox OAuth client-credentials token. Shared by the payout service and the webhook verifier. */
export async function fetchSandboxAccessToken(
  fetchImpl: typeof fetch,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  if (!clientId || !clientSecret) {
    throw new PayPalError(
      'PayPal sandbox credentials are not configured (set PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET in .env)',
    );
  }
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  let res: Response;
  try {
    res = await fetchImpl(`${PAYPAL_SANDBOX_URL}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
  } catch (err) {
    throw new PayPalError(
      `PayPal token request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new PayPalError(
      `PayPal token request failed: HTTP ${res.status} (check PAYPAL_SANDBOX_CLIENT_ID / PAYPAL_SANDBOX_CLIENT_SECRET)`,
    );
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new PayPalError('PayPal token response did not contain an access_token');
  }
  return data.access_token;
}

export class PayPalPayoutService {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID ?? '';
    this.clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET ?? '';
    this.fetchImpl = fetchImpl;
  }

  private async getAccessToken(): Promise<string> {
    return fetchSandboxAccessToken(this.fetchImpl, this.clientId, this.clientSecret);
  }

  public async executeBatchPayout(batch: BatchExecutionInput): Promise<PayoutBatchResult> {
    // 0. Approval policy FIRST: no human approval, no PayPal call.
    // Over-cap or off-allow-list batches are AWAITING_APPROVAL, never sent.
    const policyErrors = PayoutGuard.validateBatchPolicy(batch);
    if (policyErrors.length > 0) {
      throw new HumanApprovalRequired(policyErrors);
    }
    // 1. Payload schema check (own guard; build-time spec check only).
    const validation = PayoutGuard.validatePayoutPayload(batch.payoutPayload);
    if (!validation.valid) {
      throw new PayPalError(`PayoutGuard validation failed: ${validation.errors?.join(', ')}`);
    }

    // 2. OAuth token (sandbox only).
    const token = await this.getAccessToken();

    // 3. Dispatch to PayPal Payouts with a fresh idempotency key per call.
    const requestId = `REQ_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${PAYPAL_SANDBOX_URL}/v1/payments/payouts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': requestId,
        },
        body: JSON.stringify(batch.payoutPayload),
      });
    } catch (err) {
      throw new PayPalError(
        `PayPal payouts request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new PayPalError(
        `PayPal payouts request failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 300)}` : ''}`,
      );
    }
    return (await res.json()) as PayoutBatchResult;
  }
}
