# APIMatic — Honest Usage Record (BAO VE TIEN)

## What APIMatic is here
The **APIMatic Context Plugin** is a **build-time tool only**. It supplies
PayPal OpenAPI context to the coding agent while the Payouts client is
written, so generated calls are type-correct against the PayPal Payouts
OpenAPI specification.

## What it was used for
- Verifying the `POST /v1/payments/payouts` request shape (sender batch
  header, items, `recipient_type`, `amount.value` / `amount.currency`,
  `sender_item_id`, `receiver`) against the PayPal Payouts OpenAPI spec
  while the client in `src/backend/paypalService.ts` was written.
- Verifying the OAuth2 token call (`POST /v1/oauth2/token`,
  `grant_type=client_credentials`) and the `PayPal-Request-Id`
  idempotency header.
- Verifying the Verify Webhook Signature call
  (`POST /v1/notifications/verify-webhook-signature`) and its fields.

## What it is NOT — do not claim otherwise
- It does **not** run in the production request path.
- It does **not** validate payloads at runtime. Runtime validation is our
  own hand-written `PayoutGuard` (`src/guard/payoutGuard.ts`). Never
  present `PayoutGuard` as APIMatic output.
- It does **not** mask PII. PII masking is our own `PayoutGuard.sanitizeForLLM`
  (see SPEC.md §3).
- It does **not** generate the SDK used at runtime. The runtime client is
  a hand-written Axios client, verified at build time against the spec.

## How to reproduce
1. Install the APIMatic Context Plugin in the coding agent.
2. Ask it to check `src/backend/paypalService.ts` against the PayPal
   Payouts OpenAPI spec (endpoint, required fields, currency allow-list
   `USD, EUR, GBP, SGD`, idempotency header).
3. Confirm the client matches the spec; fix any mismatch the plugin flags.
4. The plugin is not installed, imported, or called by the shipped app.

## Sponsor prize basis
Best Use of APIMatic ($1,000 x3) is claimed on the build-time use above,
documented here, not on any runtime APIMatic component — there is none.
