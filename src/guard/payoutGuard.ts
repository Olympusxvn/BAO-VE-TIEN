// PayoutGuard — our own hand-written runtime validation (SPEC §3).
// Human approval is mandatory before every batch. The AI recommends,
// the human approves, PayPal executes. No auto-execution path exists.
import { PAYOUT_CURRENCIES, type PayoutItem } from '../models/PayoutItem.js';

// Approval policy (demo sandbox caps, env-configurable).
export const PER_ITEM_CAP_USD = 250;
export const PER_BATCH_CAP_USD = 500;
export const DAILY_CAP_USD = 1000;
export const RECIPIENT_ALLOWLIST_MAX = 20;

export class PayoutGuard {
  /**
   * Enforces the approval policy before any PayPal call. Returns the
   * blocking reasons; an empty array means the batch may be approved.
   * `items` must already be expressed in USD-equivalent amounts (the
   * caller converts via the Frankfurter helper first). Over-cap or
   * off-allow-list batches are AWAITING_APPROVAL and are never sent.
   * A treasurer override still cannot exceed DAILY_CAP_USD.
   */
  public static validateBatchPolicy(batch: {
    items: PayoutItem[];
    approved: boolean;
    spentTodayUsd: number;
    allowlist: string[];
  }): string[] {
    const errors: string[] = [];
    if (!batch.approved) errors.push('Batch has not been human-approved');
    const totalUsd = batch.items.reduce((sum, item) => sum + item.amount, 0);
    if (totalUsd > PER_BATCH_CAP_USD) {
      errors.push(
        `Batch total $${totalUsd.toFixed(2)} exceeds per-batch cap $${PER_BATCH_CAP_USD}`,
      );
    }
    if (batch.spentTodayUsd + totalUsd > DAILY_CAP_USD) {
      errors.push(
        `Batch would exceed daily cap $${DAILY_CAP_USD} (spent today $${batch.spentTodayUsd.toFixed(2)})`,
      );
    }
    batch.items.forEach((item, idx) => {
      if (item.amount > PER_ITEM_CAP_USD) {
        errors.push(
          `Item ${idx} amount $${item.amount.toFixed(2)} exceeds per-item cap $${PER_ITEM_CAP_USD}`,
        );
      }
      if (!batch.allowlist.includes(item.recipientEmail)) {
        errors.push(`Item ${idx} recipient is not on the allow-list`);
      }
    });
    return errors;
  }

  /**
   * Masks PII before ANY data leaves the backend for the LLM.
   * Emails keep the first 2 chars of the local part + the domain, e.g.
   * global_vendor_eu@example.com -> gl***@example.com. Free-text fields
   * (note, email_subject, email_message, recipientNote) become
   * [REDACTED]. Every other string field is also redacted unless it is
   * on the explicit safe-key allow-list (currency, status, amount,
   * value, fxRiskScore). Raw recipient emails are NEVER sent to the LLM.
   */
  public static maskEmail(email: string): string {
    const at = email.indexOf('@');
    if (at <= 0) return '***@***';
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    return `${local.slice(0, 2)}***@${domain}`;
  }

  public static sanitizeForLLM(payload: unknown): unknown {
    const SAFE_KEYS = new Set([
      'currency',
      'status',
      'amount',
      'value',
      'fxRiskScore',
    ]);
    const FREE_TEXT_KEYS = new Set([
      'note',
      'email_subject',
      'email_message',
      'recipientNote',
    ]);
    const mask = (value: unknown, key: string): unknown => {
      if (typeof value === 'string') {
        if (SAFE_KEYS.has(key)) return value;
        if (key.toLowerCase().includes('email') || key === 'receiver') {
          return PayoutGuard.maskEmail(value);
        }
        if (FREE_TEXT_KEYS.has(key)) return '[REDACTED]';
        return '[REDACTED]';
      }
      if (Array.isArray(value)) return value.map((v) => mask(v, key));
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = mask(v, k);
        return out;
      }
      return value;
    };
    return mask(JSON.parse(JSON.stringify(payload)), 'root');
  }

  /** Validates structure against the PayPal Payouts request contract. */
  public static validatePayoutPayload(payload: {
    sender_batch_header?: { sender_batch_id?: string };
    items?: Array<{
      amount?: { value?: string; currency?: string };
    }>;
  }): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    if (!payload.sender_batch_header?.sender_batch_id) {
      errors.push('Missing required field: sender_batch_header.sender_batch_id');
    }
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      errors.push('Payload must contain at least one payout item');
    }
    payload.items?.forEach((item, idx) => {
      if (!item.amount?.value || Number.isNaN(Number(item.amount.value))) {
        errors.push(`Invalid amount value at item index ${idx}`);
      }
      if (
        !item.amount?.currency ||
        !(PAYOUT_CURRENCIES as readonly string[]).includes(item.amount.currency)
      ) {
        errors.push(`Unsupported currency code [${item.amount?.currency}] at index ${idx}`);
      }
    });
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }
}
