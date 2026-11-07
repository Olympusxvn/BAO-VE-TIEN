# BAO VE TIEN — Demo Script & Rehearsal Plan

Video: under 3 minutes, public on YouTube, English. The video must show the AI
actually transacting (a real sandbox batch + webhook), inside a pre-approved
policy — not merely recommending. Auto mode is the centrepiece: it is the
"truly agentic" story for Most Impactful and Best Use of PayPal + AI.

## Measured numbers so far (2026-11-07, local VM, no credentials)

Only these numbers may be stated as results in the README or video.
Everything else in the PRD/SPEC is a target until measured live.

| What | Measured | How |
| --- | --- | --- |
| Backend tests | 26 pass / 0 fail / 2 skipped (live OpenAI + live sandbox tests skip without creds) | `npm test`, 2026-11-07, ~1.9 s |
| Frontend build | Clean (AG Grid chunk-size warning only) | `npm run build`, ~6 s |
| API health (local) | ~0.01 s round-trip | curl, localhost |
| Create batch (local) | ~0.01 s, HTTP 201 DRAFT | curl, $50 USD, allow-listed |
| Advise, rule-based, no key | ~1.36 s round-trip, HOLD, score 0.4 | curl; includes the Frankfurter FX fetch, so it varies with network |
| Approve, no PayPal creds | ~0.004 s to a clear 502 refusal, batch FAILED (terminal, no retry) | curl; the guard path is fast — the PayPal call itself is what a live run adds |
| Sandbox Payouts | HTTP 201, `payout_batch_id` SZVFXWTEXSY9W, `batch_status` PENDING, $1.00 USD | Run on the user's machine, 2026-11-07 (user report; not independently verified here) |
| Frankfurter FX (2026-11-05 rates) | EUR 0.89095, GBP 0.74299, SGD 1.2773 per USD | Live API check, 2026-11-06 |

## Still to measure live (user's machine, before the video)

- PayPal payout round-trip: approve/auto-execute → 201 + `payout_batch_id`
  (wall-clock seconds, from click to the PayPal response).
- Webhook-to-UI: seconds from the `PAYMENT.PAYOUTSBATCH.*` event to the
  ledger updating over SSE.
- Live AI advise (OpenAI or Gemini): model actually used (from
  `OPENAI_MODEL` / `GEMINI_MODEL` or BYOK), time, and the recommendation
  + score shown. Name that model in the README/video.
- FX rate shown on screen at demo time (Frankfurter, dated).

## Shot list (budget ~170 s)

1. **(0:00–0:20) The problem.** Dashboard open, Human mode badge visible.
   Narration: "A treasurer waits for approval and misses the FX window.
   BAO VE TIEN lets the AI act inside a policy the human pre-approved."
2. **(0:20–0:50) Human mode.** Create a $50 USD batch to an allow-listed
   vendor, click Ask advisor → EXECUTE_NOW, fxRiskScore shown. Click
   Approve & Execute → batch PENDING with a real `payout_batch_id`.
   Narration: "Human mode: the AI recommends, the human approves, PayPal
   executes."
3. **(0:50–1:30) Auto mode — the centrepiece.** Toggle to Auto: the confirm
   dialog appears — read it on screen ("Waiting for approval can mean
   missing an FX window. Only enable Auto mode if you trust the policy,
   caps, and allow-list."). Enable. Create a second small batch inside the
   Auto caps ($100 item / $250 batch / $500 daily). It executes by itself:
   PENDING + `payout_batch_id`, audit log entry visible. Narration: "Auto
   mode: same policy, same guard — no per-batch wait. One second is a
   light-year for an AI; waiting costs the window."
4. **(1:30–2:10) The guard says no.** Create a batch over the Auto cap
   ($150 item) or to an off-allow-list vendor → it stays AWAITING_APPROVAL
   with the blocking reason shown; nothing is sent. Then pause Auto with
   the kill switch. Narration: "Auto never means unchecked. Over the cap,
   off the list, or paused — it waits for a human."
5. **(2:10–2:50) Webhook lands.** Show the ledger updating live (SSE) when
   the PayPal webhook arrives, and the summary cards moving. Close on the
   audit log: every mode change and auto-execution recorded with its policy
   snapshot. Narration: "Every autonomous move is logged with the policy
   that allowed it."

## Rehearsal checklist (run before recording)

- [ ] `.env` on the demo machine has the sandbox `PAYPAL_SANDBOX_CLIENT_ID` /
      `PAYPAL_SANDBOX_CLIENT_SECRET` and `OPENAI_API_KEY` (never on camera,
      never in the repo).
- [ ] Backend + frontend build clean; tests 26 pass / 0 fail / 2 skipped.
- [ ] Mode starts HUMAN; allow-list has the demo vendor; daily spend $0.
- [ ] Frankfurter reachable (check the FX date shown in the UI).
- [ ] First live run: Human-mode batch, confirm 201 + `payout_batch_id`.
- [ ] Second live run: Auto-mode batch inside Auto caps, confirm it
      executes by itself and the audit log records it.
- [ ] Over-cap batch stays AWAITING_APPROVAL; pause stops Auto.
- [ ] Webhook arrives and the ledger updates without a refresh.
- [ ] Record the four live numbers (payout round-trip, webhook-to-UI,
      live advise time + model, FX rate) into the table above.

## Fallbacks (if something fails live, say so on camera — never fake it)

- FX fetch fails → the UI honestly shows "FX rates unavailable" and
  non-USD cap checks stay uncheckable; the backend remains authoritative.
- No OpenAI key → the advisor returns rule-based HOLD and nothing
  auto-executes; say so.
- PayPal 502/401/403 → show the refusal; do not re-record it as a success.

## Must NOT appear in the video or README

- Any FX-savings percentage, payout-latency figure, or FPS number that was
  not measured in the run above.
- "Zero-hallucination", "zero latency", "100% schema compliance" as
  achieved results.
- A mocked payout presented as real; a sandbox 201 presented as live
  approval (live approval is still unchecked).
- The natural-language command interface (not in the current build).
