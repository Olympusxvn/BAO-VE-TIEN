# 📜 RULE.md: Strict Development \& Execution Rules for Muse Code

# 

# Project: BAO VE TIEN — Autonomous Global Treasury Platform

# 

# This document outlines non-negotiable engineering standards, hackathon constraints, security rules, and judging criteria alignments. Muse Code MUST follow these rules strictly during code generation and execution.

# 

# 🛑 1. Core Mandates \& Constraints

# 

# Meaningful Use of PayPal \& AI (Mandatory Constraint):

# 

# The project MUST deeply combine the PayPal Developer Platform and AI.

# 

# Simple "add a PayPal button to an AI chat" or "use AI to summarize text" is STICKEDLY PROHIBITED. AI must act as an autonomous decision engine or treasury advisor that calculates FX risk, evaluates batch readiness, and triggers or validates PayPal Payouts.

# 

# Sandbox Realism (No Mocking Core Payment Loops):

# 

# All payment dispatches must execute against the official PayPal Developer Sandbox API (https://api-m.sandbox.paypal.com).

# 

# Do NOT mock PayPal API responses in production build paths unless Sandbox API network connectivity is completely unavailable.

# 

# Payout Currencies (Fixed 2026-11-06): Payouts are sent ONLY in `USD`, `EUR`, `GBP`, `SGD`. VND is NOT a PayPal REST Payouts currency and must never appear as a payout `currency` value. A VND invoice is displayed in VND and converted to USD at the Frankfurter rate for the PayPal call, with the rate shown.
#
# FX Source & AI Identity (Fixed 2026-11-06; model made configurable 2026-11-06): The sole runtime AI provider is OpenAI. The model is configurable via the `OPENAI_MODEL` env var, default `gpt-4o` (key in `OPENAI_API_KEY`, also env only). Switching models is a config change only — no code change, no new trust boundary, and the output is still re-validated against the invoice before signing. GPT-4o is the default, NOT a requirement: any OpenAI chat-completion model may be used. The sole FX source is the Frankfurter API (ECB reference rates), `GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,SGD`, refreshed hourly and cached. If the FX source or GPT-4o times out or rate-limits, the advisor returns HOLD with a rule-based score; a HOLD recommendation never executes in either mode (in Human mode nothing executes without a human Approve click; in Auto mode only EXECUTE_NOW within policy can execute — see the approval-modes rule below).
#
# Strict Adherence to Current Scope (No Overbuilding):

# 

# Implement ONLY the 4 Core Features defined in STRATEGY.md.

# 

# Do NOT implement Phase 2 or Phase 3 features (Dispute Shield, Hyperwallet integration, etc.) during this sprint.

# 

# 🏆 2. Alignment with Judging Criteria

# 

# Every line of code written by Muse Code must directly serve one or more of the official judging criteria:

# 

# A. Technological Implementation (Deep \& Non-Trivial)

# 

# Enforce type-safety on all PayPal API schemas. APIMatic Context Plugin is a BUILD-TIME tool only (it supplies PayPal OpenAPI context while the client is written); runtime validation is our own PayoutGuard, never presented as APIMatic.

# 

# Enforce Idempotency on every payout batch call via PayPal-Request-Id headers.

# 

# Implement real-time asynchronous status updates using PayPal Webhooks (PAYMENT.PAYOUTSBATCH.SUCCESS, PAYMENT.PAYOUTS-ITEM.SUCCEEDED, PAYMENT.PAYOUTS-ITEM.FAILED).

# 

# Utilize the PayPal AI Toolkit (MCP Server) for CLI-based sandbox operations.

# 

# B. Design \& Coherence (Complete Product Experience)

# 

# Utilize AG Grid Community (MIT, no Enterprise, no licence key) for the financial ledger to deliver low-latency rendering, cell editing, status badge styling, and in-app summary cards.

# 

# Provide a unified user interface where conversational AI triggers grid filters or payout execution seamlessly.

# 

# C. Potential Impact (Real-World Utility)

# 

# Solves multi-currency foreign exchange (FX) slippage and manual disbursement errors for global businesses.

# 

# Ensure clear calculation and display of estimated FX savings (e.g., "Saved $340.20 on this EUR batch").

# 

# D. Innovation \& Novelty

# 

# Pivot from reactive "click-to-pay" portals to an Autonomous Treasury Guard that protects corporate capital.

# 

# 🔒 3. Security, Privacy \& Defensive Programming Rules

# 

# Approval Gate & Caps (Fixed 2026-11-06; modes added 2026-11-07 — this rule
# supersedes the 2026-11-06 "human approval mandatory before every batch"
# wording. The old sentence no longer applies; see SPEC §3.1):
#
# Human-default / Auto-supervised. HUMAN mode (default): the AI recommends,
# the human approves, PayPal executes — every batch needs a human Approve
# click, and there is NO auto-execution path. AUTO mode (opt-in): a batch
# executes automatically ONLY when it passes the standard policy AND the
# tighter auto caps, the advisor recommends EXECUTE_NOW and fxRiskScore <
# 3.0. In both modes there is NO code path that executes an unauthorized
# batch: auto execution goes through the SAME executeBatchPayout with the
# policy re-checked, and a manual Approve click still works in Auto mode.
# A HOLD recommendation never executes in either mode.
#
# Demo caps (env-configurable): per-item $250, per-batch $500, daily $1,000 USD-equivalent. Recipient allow-list max 20, managed by the treasurer. A batch over any cap, or with any recipient off the allow-list, is `AWAITING_APPROVAL` and is NEVER sent to PayPal. A treasurer override still cannot exceed the daily cap. The backend re-checks caps, allow-list and daily spend in `POST /api/treasury/batches/:id/approve` AND in `executeBatchPayout` before any PayPal call; the disabled Approve button in the UI is never the only defence.
#
# Auto-mode caps (tighter, 2026-11-07): per-item $100, per-batch $250, auto daily $500 (auto-spent-today budget), fxRiskScore < 3.0. Any failing condition leaves the batch AWAITING_APPROVAL with the blocking reasons shown. Pause (POST /api/treasury/mode/pause) stops all auto-execution immediately. Every mode change, pause change, auto execution (with policy snapshot + advisor output) and blocked auto evaluation is written to the audit log (GET /api/treasury/audit). Auto mode warns explicitly: the enable-confirm dialog, the always-on banner, the amber Auto badge and the per-batch notice (exact copy in SPEC §3.1 and frontend/src/modeStrings.ts).
#
# PII Masking Rule:

# 

# MUST sanitize or hash sensitive personally identifiable information (recipient emails, vendor names) before sending transaction logs or context payloads to OpenAI GPT-4o.

# 

# Retain raw PII strictly on the backend Node.js server for execution with PayPal Sandbox APIs.

# 

# Credential \& Secret Protection:

# 

# NEVER hardcode PAYPAL\_CLIENT\_ID, PAYPAL\_CLIENT\_SECRET, or OPENAI\_API\_KEY in source code files. Always read from environment variables (process.env).

# 

# Defensive Error Handling \& Fallback:

# 

# Every PayPal REST call must be wrapped in try/catch blocks using our own error translation helpers (PayPal error code -> human-actionable message).

# 

# If AI service API calls time out or hit rate limits (HTTP 429), the backend MUST fall back to deterministic, rule-based FX thresholds rather than crashing or hanging the payout request.

# 

# 🧪 4. Code Quality \& Testing Guidelines

# 

# Language: TypeScript (Strict mode enabled).

# 

# Styling \& Architecture: Modular service pattern (src/services/, src/controllers/, src/apimatic/, src/frontend/).

# 

# Verification: Use the /paypal:doctor or MCP diagnostic slash commands after completing major milestones to check for API anti-patterns or missing error handles.

# 

# 🎯 5. Winning Checklist for Muse Code

# 

# Before marking any phase complete, verify that:

# 

# \[ ] PayPal Payouts REST API (POST /v1/payments/payouts) succeeds in Sandbox.

# 

# \[ ] PayoutGuard (own code, not APIMatic) intercepts and blocks malformed JSON payloads prior to network call. APIMatic usage is documented in docs/APIMATIC.md.

# 

# \[ ] AG Grid Community displays multi-currency rows with FX risk scores (LOW, MEDIUM, HIGH).

# 

# \[ ] Incoming PayPal Webhook updates transaction status dynamically in the UI.

# 

# \[ ] PII data is masked before sending transaction context to GPT-4o.

