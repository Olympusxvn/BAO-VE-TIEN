# BAO VE TIEN — Autonomous Global Treasury

An AI FX advisor that decides when to pay, and pays through PayPal Payouts.
Built for the PayPal AI Hackathon 2026 ("Build What's Next with PayPal and AI").

The AI recommends, a human approves, PayPal executes. Every batch needs human
approval before it is sent. Demo caps: $250 per item, $500 per batch,
$1,000 per day (USD-equivalent), recipient allow-list of at most 20.
Payouts are USD, EUR, GBP, SGD only. A VND invoice is displayed in VND and
converted to USD at the Frankfurter (ECB) rate before the PayPal call; VND
is never sent as a payout currency.

## Status

Early. This repo currently holds the audited design docs and one sandbox
smoke-test script. The full app (backend, advisor, dashboard) is not built
yet. Nothing here is a claim about measured performance: every number in the
docs is either sourced or marked to be measured before the demo video.

## Contents

- `docs/` — project overview, PRD, technical specification, strategy
  roadmap, rules, the two build prompts, and an honest APIMatic note
  (build-time only, not a runtime validator).
- `docs/` also covers the audit fixes: real PayPal webhook names
  (`PAYMENT.PAYOUTSBATCH.*` / `PAYMENT.PAYOUTS-ITEM.*`) with signature
  verification, deterministic PII masking, and AG Grid Community (MIT).
- `scripts/sandbox-payout-201.mjs` — one-item $1.00 USD sandbox payout
  batch. Proves a real sandbox batch returns 201 + `payout_batch_id`.
  Sandbox only, never live.
- `AUDIT-2026-11-06.md` — the audit report (conditional go) and the fix log.

## Sandbox smoke test

```bash
# Create .env in this folder (gitignored, never commit it):
#   PAYPAL_SANDBOX_CLIENT_ID=...
#   PAYPAL_SANDBOX_CLIENT_SECRET=...
#   PAYPAL_SANDBOX_RECEIVER_EMAIL=...   (optional)
node scripts/sandbox-payout-201.mjs
```

Success is HTTP 201 with a `payout_batch_id`. A 403 means Payouts is not
enabled for the sandbox app yet; a 401 means the sandbox credentials in
`.env` are wrong. A sandbox 201 proves sandbox Payouts works; it does not
prove live Payouts approval.

## Run the backend (Nov 8 slice)

```bash
npm install
cp .env.example .env   # fill in PAYPAL_SANDBOX_CLIENT_ID / PAYPAL_SANDBOX_CLIENT_SECRET
npm run build
npm start              # http://localhost:3000 (sandbox only)
npm test               # SPEC §6 tests 1, 4, 5 + webhook + server smoke tests
```

Routes: `POST /api/treasury/batches` (create DRAFT), `GET
/api/treasury/batches[/:id]`, `POST /api/treasury/batches/:id/advise`
(OpenAI FX advisor — stores recommendation + FX risk score, never
approves or executes; without `OPENAI_API_KEY` it returns HOLD with a
rule-based score and makes no LLM call), `POST
/api/treasury/batches/:id/approve` (human approval gate — re-checks caps,
allow-list and daily spend, then executes; a failing batch stays
`AWAITING_APPROVAL`), `GET`/`POST`/`DELETE /api/treasury/allowlist`
(recipient allow-list, max 20, demo only, no auth), `GET
/api/treasury/events` (SSE payout updates), `POST /api/webhooks/paypal`
(signature-verified), `GET /api/health`. No route executes an
unauthorized batch. Batches, the allow-list and daily spend are
in-memory (demo only).

## Approval modes — Human-default / Auto-supervised (2026-11-07)

Two treasury-level modes, default **Human**. Human mode: every batch
needs a human Approve click; no auto-execution path. Auto mode
(opt-in): a batch executes automatically only when it passes the
policy, the tighter auto caps, an `EXECUTE_NOW` recommendation and a
low FX risk score — otherwise it stays `AWAITING_APPROVAL`. Auto
execution uses the same `executeBatchPayout` path with the policy
re-checked; a manual Approve click still works in Auto mode.

| Cap | Human (manual approve) | Auto (automatic) |
| --- | --- | --- |
| Per-item | $250 | $100 |
| Per-batch | $500 | $250 |
| Daily | $1,000 | $500 (auto-spent-today budget) |
| FX risk score | no limit | < 3.0 |
| Advisor | EXECUTE_NOW required | EXECUTE_NOW required |

Mode endpoints: `GET /api/treasury/mode`, `POST /api/treasury/mode
{ mode: 'HUMAN' | 'AUTO' }`, `POST /api/treasury/mode/pause
{ paused: boolean }` (kill switch — pausing stops all auto-execution
immediately), `GET /api/treasury/audit` (mode changes, pause changes,
auto executions with policy snapshot + advisor output, blocked
evaluations).

Warnings (exact copy, also in `frontend/src/modeStrings.ts`): enabling
Auto shows a confirm dialog — "Auto mode executes batches
automatically when they pass policy — no per-batch approval. Waiting
for approval can mean missing an FX window. Only enable Auto mode if
you trust the policy, caps, and allow-list. You can pause it anytime."
— and there is no UI path to Auto mode that skips it. While Auto is
on, an always-on banner reads "Auto mode is ON — qualifying batches
execute automatically. Pause anytime.", the header shows an amber Auto
badge, and every auto-executed batch carries the notice "Executed
automatically in Auto mode — policy + advisor output logged".

Why Auto exists: waiting for human approval can mean missing the FX
window — enable Auto only if confident in the policy. That is also
what makes the entry truly agentic: in Auto mode the AI decides and
acts within a pre-approved policy, not just recommends. The demo video
should feature Auto executing a real sandbox batch.

## Safety

- Sandbox base URL only in the test script (`api-m.sandbox.paypal.com`).
- No credential is printed by the script, and `.env` is gitignored.
- No payout is sent without authorization: in Human mode without a
  human approval, in Auto mode without passing the policy + auto caps
  + EXECUTE_NOW + low FX risk. Over-cap or off-list batches stay
  `AWAITING_APPROVAL` and are never sent.

## License

MIT. See `LICENSE`.
