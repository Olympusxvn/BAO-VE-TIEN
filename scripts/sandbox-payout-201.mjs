/**
 * BAO VE TIEN — sandbox Payouts smoke test (M5 proof gate).
 *
 * Goal: one real sandbox batch returning HTTP 201 + a payout_batch_id,
 * due by end of 2026-11-08. This is the ONLY gate this script proves.
 * A sandbox 201 does NOT prove live Payouts approval — live approval is
 * a separate Dashboard decision.
 *
 * Why this can run while the Developer Dashboard login is locked:
 * sandbox REST calls authenticate with the app's client_id/secret
 * (Basic auth), not with the user's PayPal sign-in, so the hCaptcha /
 * "tried too many times" lock on developer.paypal.com does not block
 * this call. If the sandbox app itself lacks Payouts, PayPal answers
 * 403 — that answer IS the result: Dashboard approval is then needed.
 *
 * Safety, matching docs (SPEC §2.2, §3 PayoutGuard caps, RULE.md):
 * - Sandbox base URL ONLY: https://api-m.sandbox.paypal.com — never live.
 * - One item, $1.00 USD, currency USD (allow-list USD/EUR/GBP/SGD; never VND).
 * - $1.00 is inside the demo caps: $250/item, $500/batch, $1,000/day.
 * - No auto-execution path: this script is a manual, one-off test.
 *   It is NOT the app's payout flow and does NOT call any approval logic.
 * - Credentials come ONLY from .env in this folder (gitignored):
 *     PAYPAL_SANDBOX_CLIENT_ID=...
 *     PAYPAL_SANDBOX_CLIENT_SECRET=...
 *     PAYPAL_SANDBOX_RECEIVER_EMAIL=...   (optional; see note below)
 *   Never paste them in chat, never commit .env. This script never
 *   prints a credential or an access token.
 *
 * Receiver note: in sandbox, the receiver email does not need to be a
 * real vendor. If it is not a registered sandbox account the item
 * stays UNCLAIMED, but the batch itself still returns 201 with a
 * payout_batch_id — which is exactly what this gate needs. Use a
 * sandbox test email (e.g. your sandbox business account's email).
 *
 * Run from ~/workspace/bao-ve-tien:
 *   node scripts/sandbox-payout-201.mjs
 * Success: HTTP 201 + payout_batch_id + batch_status printed, exit 0.
 * Failure: the script prints what the status means and exits non-zero.
 *   401  -> sandbox client_id/secret wrong or not sandbox creds; fix .env.
 *   403  -> Payouts not enabled for this sandbox app; needs Dashboard
 *           (My Apps & Credentials -> Payouts) once login works again.
 *   other -> prints PayPal's error name/message verbatim; paste THAT
 *           (never the .env values) back to Muse.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// .env lives at the bao-ve-tien root (next to this scripts/ folder),
// wherever the user runs the script from. Missing .env is a clean
// exit-2, not a crash.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch (err) {
  if (err?.code !== 'ENOENT') throw err;
}

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID || '';
const clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET || '';
const receiver = process.env.PAYPAL_SANDBOX_RECEIVER_EMAIL || 'sandbox-receiver@example.com';

if (!clientId || !clientSecret) {
  console.error('Missing PAYPAL_SANDBOX_CLIENT_ID / PAYPAL_SANDBOX_CLIENT_SECRET in ~/workspace/bao-ve-tien/.env');
  console.error('Copy them from your PayPal sandbox REST app (never paste them in chat). No PayPal call was made.');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
const senderBatchId = `BAO_SANDBOX_${stamp}_${randomUUID().slice(0, 8)}`;

// 1. OAuth token (client credentials, sandbox only).
const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
const tokenRes = await fetch(`${SANDBOX}/v1/oauth2/token`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: 'grant_type=client_credentials',
});
if (!tokenRes.ok) {
  const body = await tokenRes.text();
  console.error(`Token request failed: HTTP ${tokenRes.status}`);
  console.error(body.slice(0, 500));
  console.error('401 usually means wrong sandbox client_id/secret in .env. Check .env, do not retry more than twice.');
  process.exit(1);
}
const { access_token: token } = await tokenRes.json();
console.log('Sandbox OAuth token: OK (token not printed)');

// 2. One-item, $1.00 USD payout batch — inside every demo cap.
const payload = {
  sender_batch_header: {
    sender_batch_id: senderBatchId,
    email_subject: 'You have a sandbox test payment from BAO VE TIEN Treasury',
    email_message: 'Sandbox test only — BAO VE TIEN Payouts 201 proof batch.',
  },
  items: [
    {
      recipient_type: 'EMAIL',
      amount: { value: '1.00', currency: 'USD' },
      note: 'BAO VE TIEN sandbox 201 proof — $1 test',
      sender_item_id: `ITEM_${stamp}`,
      receiver,
    },
  ],
};

const res = await fetch(`${SANDBOX}/v1/payments/payouts`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'PayPal-Request-Id': `REQ_${stamp}_${randomUUID().slice(0, 8)}`,
  },
  body: JSON.stringify(payload),
});
const data = await res.json().catch(() => ({}));
console.log(`Payouts batch: HTTP ${res.status}`);
console.log(JSON.stringify(data, null, 2));

if (res.status === 201 && data?.batch_header?.payout_batch_id) {
  console.log(`\nPASS: payout_batch_id=${data.batch_header.payout_batch_id} batch_status=${data.batch_header.batch_status}`);
  console.log('Gate met: real sandbox batch returned 201. Report the payout_batch_id back to Muse.');
  process.exit(0);
}
if (res.status === 403) {
  console.error('\n403: Payouts is NOT enabled for this sandbox app.');
  console.error('Next step is the Dashboard (My Apps & Credentials -> Payouts) once PayPal login works again — do not hammer the API.');
  process.exit(1);
}
console.error(`\nNot a 201. Error: ${data?.name || 'unknown'} — ${data?.message || 'no message'}`);
process.exit(1);
