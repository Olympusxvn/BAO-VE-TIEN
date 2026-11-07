// Frankfurter API (ECB reference rates) — the sole FX source (RULE.md).
// GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,SGD
// No key required. Rates are refreshed hourly and cached in memory.
// The API returns rates as "1 USD = X currency", so converting to USD
// means dividing by the rate. Never price caps 1:1 for non-USD amounts.
import type { PayoutCurrency } from '../models/PayoutItem.js';

const FRANKFURTER_URL =
  'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,SGD';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface FxRates {
  /** Units of currency per 1 USD, e.g. EUR 0.89 means 1 USD = 0.89 EUR. */
  EUR: number;
  GBP: number;
  SGD: number;
  fetchedAt: number;
}

let cached: FxRates | null = null;

export function clearFxCache(): void {
  cached = null;
}

export async function getFxRates(
  fetchImpl: typeof fetch = fetch,
): Promise<FxRates> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;
  const res = await fetchImpl(FRANKFURTER_URL);
  if (!res.ok) {
    throw new Error(`Frankfurter FX fetch failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    rates?: { EUR?: number; GBP?: number; SGD?: number };
  };
  const rates = data.rates;
  if (!rates?.EUR || !rates?.GBP || !rates?.SGD) {
    throw new Error('Frankfurter FX response is missing EUR, GBP or SGD rates');
  }
  cached = { EUR: rates.EUR, GBP: rates.GBP, SGD: rates.SGD, fetchedAt: now };
  return cached;
}

/** Converts an amount in `currency` to its USD-equivalent using `rates`. */
export function toUsd(amount: number, currency: PayoutCurrency, rates: FxRates): number {
  if (currency === 'USD') return amount;
  const rate = rates[currency];
  if (!rate || rate <= 0) {
    throw new Error(`No FX rate available for ${currency}`);
  }
  return amount / rate;
}
