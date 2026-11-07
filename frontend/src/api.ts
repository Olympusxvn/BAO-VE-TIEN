// API client for the BAO VE TIEN backend. Same origin in dev (Vite proxy)
// and in production (the backend serves frontend/dist). The frontend
// never calls PayPal directly and holds no credentials.

export type PayoutCurrency = 'USD' | 'EUR' | 'GBP' | 'SGD';

export type BatchStatus =
  | 'DRAFT'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED';

export type Recommendation = 'EXECUTE_NOW' | 'HOLD' | 'SPLIT_BATCH';

export type ItemStatus =
  | 'DRAFT'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'PENDING'
  | 'SCHEDULED'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'FAILED';

export interface PayoutItem {
  itemId: string;
  recipientEmail: string;
  amount: number;
  currency: PayoutCurrency;
  recipientNote?: string;
  senderItemId: string;
  status: ItemStatus;
  fxRiskScore: number;
  paypalTransactionId?: string;
  errorMessage?: string;
}

export interface Batch {
  id: string;
  senderBatchId: string;
  items: PayoutItem[];
  status: BatchStatus;
  approved: boolean;
  approvalBlockReasons: string[];
  payoutBatchId?: string;
  errorMessage?: string;
  createdAt: string;
  fxRiskScore?: number;
  recommendation?: Recommendation;
  advisorReason?: string;
  modelUsed?: string;
}

export interface AdviseResult {
  batchId: string;
  recommendation: Recommendation;
  fxRiskScore: number;
  reason: string;
  model: string;
  source: 'llm' | 'rule';
}

export const PAYOUT_CURRENCIES: readonly PayoutCurrency[] = ['USD', 'EUR', 'GBP', 'SGD'];

export const PER_ITEM_CAP_USD = 250;
export const PER_BATCH_CAP_USD = 500;
export const DAILY_CAP_USD = 1000;
export const ALLOWLIST_MAX = 20;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; reasons?: string[] };
  if (!res.ok) {
    const detail = data.reasons?.join('; ') ?? data.error ?? `Request failed: HTTP ${res.status}`;
    throw new Error(detail);
  }
  return data as T;
}

export const api = {
  listBatches: () => req<Batch[]>('/api/treasury/batches'),
  getBatch: (id: string) => req<Batch>(`/api/treasury/batches/${encodeURIComponent(id)}`),
  createBatch: (items: { recipientEmail: string; amount: number; currency: PayoutCurrency; recipientNote?: string }[]) =>
    req<Batch>('/api/treasury/batches', { method: 'POST', body: JSON.stringify({ items }) }),
  advise: (id: string) =>
    req<AdviseResult>(`/api/treasury/batches/${encodeURIComponent(id)}/advise`, { method: 'POST' }),
  approve: (id: string) =>
    req<Batch>(`/api/treasury/batches/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  getAllowlist: () => req<{ allowlist: string[] }>('/api/treasury/allowlist'),
  addAllowlist: (email: string) =>
    req<{ allowlist: string[] }>('/api/treasury/allowlist', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  removeAllowlist: (email: string) =>
    req<{ allowlist: string[] }>(`/api/treasury/allowlist/${encodeURIComponent(email)}`, {
      method: 'DELETE',
    }),
  health: () => req<{ status: string; sandbox: boolean; batches: number }>('/api/health'),
};

// FX rates — Frankfurter API (ECB reference rates), the sole FX source
// (same endpoint the backend uses). Display and cap-estimate only: the
// backend re-checks every cap authoritatively at approve time.
export interface FxRates {
  EUR: number;
  GBP: number;
  SGD: number;
  date?: string;
}

export async function getFxRates(): Promise<FxRates | null> {
  try {
    const res = await fetch(
      'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,SGD',
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      rates?: { EUR?: number; GBP?: number; SGD?: number };
      date?: string;
    };
    if (!data.rates?.EUR || !data.rates?.GBP || !data.rates?.SGD) return null;
    return { EUR: data.rates.EUR, GBP: data.rates.GBP, SGD: data.rates.SGD, date: data.date };
  } catch {
    return null;
  }
}

/** Converts an amount to its USD-equivalent. Returns null when a
 * non-USD amount cannot be priced (no rates) — never price caps 1:1. */
export function toUsd(amount: number, currency: PayoutCurrency, rates: FxRates | null): number | null {
  if (currency === 'USD') return amount;
  if (!rates) return null;
  const rate = rates[currency];
  if (!rate || rate <= 0) return null;
  return amount / rate;
}

/** Client-side approval check, mirroring the backend policy (SPEC §5).
 * This is a UI hint only: the backend re-checks caps, allow-list and
 * daily spend in POST /:id/approve before any PayPal call. */
export function checkApproval(
  batch: Batch,
  allowlist: string[],
  spentTodayUsd: number,
  rates: FxRates | null,
): { canApprove: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (batch.status !== 'DRAFT' && batch.status !== 'AWAITING_APPROVAL') {
    reasons.push(`Batch is ${batch.status}`);
  }
  if (!batch.recommendation) {
    reasons.push('No advisor recommendation yet — ask the advisor first');
  } else if (batch.recommendation !== 'EXECUTE_NOW') {
    reasons.push(`Advisor recommends ${batch.recommendation}, not EXECUTE_NOW`);
  }
  const hasNonUsd = batch.items.some((item) => item.currency !== 'USD');
  if (hasNonUsd && !rates) {
    reasons.push('FX rates unavailable — USD-equivalent cannot be checked');
  }
  let totalUsd = 0;
  let priced = true;
  for (const item of batch.items) {
    const usd = toUsd(item.amount, item.currency, rates);
    if (usd === null) {
      priced = false;
      continue;
    }
    totalUsd += usd;
    if (usd > PER_ITEM_CAP_USD) {
      reasons.push(
        `${item.senderItemId}: $${usd.toFixed(2)} exceeds the $${PER_ITEM_CAP_USD} per-item cap`,
      );
    }
    if (!allowlist.includes(item.recipientEmail)) {
      reasons.push(`${item.senderItemId}: recipient is not on the allow-list`);
    }
  }
  if (priced) {
    if (totalUsd > PER_BATCH_CAP_USD) {
      reasons.push(
        `Batch total $${totalUsd.toFixed(2)} exceeds the $${PER_BATCH_CAP_USD} per-batch cap`,
      );
    }
    if (spentTodayUsd + totalUsd > DAILY_CAP_USD) {
      reasons.push(`Batch would exceed the $${DAILY_CAP_USD} daily cap`);
    }
  }
  // Reasons the backend recorded on a previous approve attempt are
  // authoritative — keep them visible until they are resolved.
  for (const reason of batch.approvalBlockReasons) {
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return { canApprove: reasons.length === 0, reasons };
}

/** USD-equivalent of executed batches (PENDING or SUCCESS). Null when a
 * non-USD amount cannot be priced without FX rates. */
export function spentToday(batches: Batch[], rates: FxRates | null): number | null {
  let total = 0;
  for (const batch of batches) {
    if (batch.status !== 'PENDING' && batch.status !== 'SUCCESS') continue;
    for (const item of batch.items) {
      const usd = toUsd(item.amount, item.currency, rates);
      if (usd === null) return null;
      total += usd;
    }
  }
  return total;
}
