# 🛡️ PROJECT.md: BAO VE TIEN (Bảo Vệ Tiền)
## Autonomous Cross-Border Payouts & Global Treasury Intelligence Platform

---

## 🌟 Executive Overview & Pitch

### The One-Liner
**BAO VE TIEN (Bảo Vệ Tiền)** is an AI-driven, autonomous global treasury and cross-border payout management system that protects multi-currency corporate capital against foreign exchange (FX) volatility, automates global vendor disbursements via **PayPal Payouts REST API**, and provides interactive real-time financial analytics using **AG Grid Community**.

**Approval & caps (fixed 2026-11-06, modes added 2026-11-07 — see SPEC §3.1):** Human mode is the default: human approval is mandatory before every batch. Auto mode is opt-in: a batch executes automatically only when the advisor says EXECUTE_NOW, it passes every policy check, it is inside the tighter Auto caps (per-item $100, per-batch $250, daily $500), and fxRiskScore is below 3. Demo caps (env-configurable): per-item $250, per-batch $500, daily $1,000 USD-equivalent. Recipient allow-list, max 20, managed by the treasurer. Over-cap or off-list batches are `AWAITING_APPROVAL`, never sent, and a treasurer override still cannot exceed the daily cap.

**VND rule (fixed 2026-11-06):** VND is NOT a PayPal REST Payouts currency, so it is never sent to PayPal. A VND invoice is displayed in VND, converted to USD at the Frankfurter rate for the PayPal call, and the conversion rate and fee are shown to the user. The payout itself is always in `USD`, `EUR`, `GBP` or `SGD`.

### The Core Problem
Mid-market cross-border enterprises, D2C brands, and global digital platforms face three severe financial friction points:
1. **FX Slippage & Timing Losses:** Cross-border businesses lose money simply by executing global supplier payments at sub-optimal exchange rate windows. (No percentage is claimed: FX savings have not been measured yet — see AUDIT §4.)
2. **Batch Payout Friction:** Manual cross-border disbursements to hundreds of international vendors are error-prone, prone to currency code mismatches, and lack real-time visibility into transaction lifecycles.
3. **Disjointed Compliance & Error Resolution:** When cross-border payouts fail due to local currency restrictions, finance teams waste days manually diagnosing raw JSON error logs rather than resolving them instantaneously.

### The BAO VE TIEN Solution
**BAO VE TIEN** puts AI directly "behind the wheel" of corporate treasury operations. Using **GPT-4o by default (OpenAI API; model configurable via `OPENAI_MODEL`, default `gpt-4o`)** as the sole runtime AI for natural language treasury commands and financial forecasting, the system evaluates real-time FX trends, generates optimized payout batches, with the Payouts client verified at build time against the PayPal OpenAPI spec using the **APIMatic Context Plugin** (build time only), renders high-density analytics in **AG Grid Community**, and triggers batch disbursements via **PayPal Payouts REST API** with real-time **Webhook** feedback loops.

---

## 🎯 Alignment with Hackathon Judging Criteria

### 1. Technological Implementation (Deep & Non-Trivial Integration)
* **PayPal Developer Platform Core:** Deep integration with **PayPal Payouts REST API** (`/v1/payments/payouts`), handling asynchronous batch processing, multi-currency conversion (`USD`, `EUR`, `GBP`, `SGD` — payout currencies only; see VND rule above), idempotency keys (`PayPal-Request-Id`), and Webhooks (`PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.FAILED`).
* **GPT-4o:** Drives the autonomous logic engine. GPT-4o analyzes treasury balances and FX indicators to recommend optimal payout execution times. The backend generates resilient API payloads and manages retry logic.
* **APIMatic Context Plugin (build time only):** Supplies PayPal OpenAPI context while the Payouts client is written, so generated calls are type-correct. It does not run in production. Runtime validation is our own PayoutGuard, and LLM output is re-validated against the invoice before signing.
* **Backend Stack:** High-throughput Node.js / Python service handling secure webhook verification, payload signing, PII masking, and multi-tenant ledger synchronization.

### 2. Design (Complete, Coherent Product Experience)
* **AG Grid Community Frontend:** Renders complex multi-currency ledger data. Provides inline filtering, cell-editing for batch approval, dynamic currency grouping, and in-app summary cards (no Enterprise Pivoting or Integrated Charts are used).
* **Contextual AI Triggers:** Users can execute complex operations (e.g., *"Filter pending EUR payouts above €5,000 and execute via PayPal if FX volatility is low"*) via a single conversational interface embedded within the financial dashboard.

### 3. Potential Impact (Real Value for Real Audience)
* **Target Audience:** Cross-border e-commerce merchants, global digital marketplaces, agency networks, and software vendors operating across multiple currencies.
* **Quantifiable Value:** Aims to cut manual batch payout setup time and to surface real-time PayoutGuard/PayPal error diagnosis so failed batches can be fixed instead of retried blindly. No FX-savings or latency figure is claimed until it is measured — see DEMO-SCRIPT.md for the measured numbers so far.

### 4. Innovation / Novelty
* **From Reactive to Autonomous Treasury:** Moving beyond static "click to pay" dashboards to an autonomous **Treasury Guard** that continuously calculates capital exposure and advises payouts within pre-approved thresholds. In Human mode (default) the rule is: the AI *recommends*, the human *approves*, PayPal *executes*. In Auto mode the human pre-approves the policy (caps, allow-list, risk threshold) and the AI executes only batches that pass it — see SPEC §3.1.
* **Validated AI Payment Pipeline:** Combines LLM reasoning with strict PayoutGuard schema validation (client verified at build time with the APIMatic Context Plugin). LLM output is re-validated against the invoice before signing; no payload is sent to PayPal without passing PayoutGuard.

### 5. Presentation & Demo Readiness
* **End-to-End Live Workflow:**
  1. **Inbound Invoices:** AI parses international vendor invoices across currencies.
  2. **AG Grid Analysis:** Data is populated into AG Grid Community with dynamic FX risk indicators.
  3. **GPT-4o Decision:** GPT-4o alerts the operator of a favorable EUR/USD FX window.
  4. **Human Approval:** Elena reviews the batch and clicks **"Approve & Execute"**. The button is enabled only when the batch is within caps (per-item $250, per-batch $500, daily $1,000 USD-equivalent), every recipient is on the allow-list, and the GPT-4o recommendation is EXECUTE_NOW. Anything over a cap or off the allow-list stays `AWAITING_APPROVAL` and is never sent.
  5. **PayPal Execution:** After approval, the backend calls the PayPal Payouts API with the batch.
  5. **Real-time Webhook:** Webhook fires `PAYMENT.PAYOUTSBATCH.SUCCESS`, updating the AG Grid dashboard instantly with PayPal Transaction IDs.

---

## 🛠️ Architecture & Technology Stack

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │                    AG Grid Community Frontend Dashboard                   │
 │        (Multi-Currency Ledger, Live FX Charts, Conversational AI)     │
 └───────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      GPT-4o Advisor Engine                        │
 │     (FX Trend Analysis, Treasury Logic, Natural Language Commands)     │
 └───────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                 PayoutGuard (runtime; APIMatic: build time only)       │
 │         (Schema Verification, SDK Wrapper, PII Masking Engine)         │
 └───────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                   Node.js / Python Backend Service                    │
 │             (Express/FastAPI, Webhook Receiver, Database)             │
 └───────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                   PayPal Developer Platform (Sandbox)                 │
 │     - PayPal Payouts REST API  |  - Webhook Events (PAYMENT.PAYOUTSBATCH.*)   │
 └────────────────────────────────────────────────────────────────────────┘
```

| Component | Technology / Tool | Role in BAO VE TIEN |
| :--- | :--- | :--- |
| **Core AI Engine** | **GPT-4o by default (OpenAI API; model via `OPENAI_MODEL`, default `gpt-4o`)** | Analyzes FX trends, generates payout batches, and executes commands. |
| **API Wrapper** | **PayoutGuard (own code)** | Validates payloads at runtime and translates API errors. The APIMatic Context Plugin was used at build time only to verify the client against the PayPal OpenAPI spec. |
| **Frontend UI** | **AG Grid Community** | Community data grid (MIT), dynamic currency grouping, in-app summary cards. |
| **Payments API** | **PayPal Payouts REST API** | Executes global multi-currency batch payouts (`/v1/payments/payouts`). |
| **FX Rates** | **Frankfurter API (ECB reference rates)** | Sole FX source: `GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,SGD`, no key, refreshed hourly and cached. If the FX source or GPT-4o is unavailable, the advisor returns HOLD with a rule-based score; a HOLD recommendation never executes in either approval mode (see SPEC §3.1). |
| **Real-time Events**| **PayPal Webhooks** | Captures asynchronous payout confirmations (`PAYMENT.PAYOUTSBATCH.*`). |
| **Backend** | **Node.js / Python** | Middleware orchestration, security, signature verification, REST endpoints. |

---

## 📋 Repository Directory Structure

```text
bao-ve-tien/
├── PROJECT.md             # High-level architecture, pitch, and judging matrix
├── PRD.md                 # Product Requirements Document & Features
├── SPEC.md                # Technical Specification, API contracts, and Schemas
├── docs/                  # Architecture diagrams & demo script
├── src/
│   ├── ai/                # GPT-4o prompt handlers & treasury agents
│   ├── guard/             # PayoutGuard (own code); APIMatic used at build time only, no runtime dependency
│   ├── backend/           # Node.js/Python server, PayPal Payouts controller & Webhook listener
│   └── frontend/          # AG Grid Community dashboard components & FX widgets
└── sandbox/               # PayPal Sandbox credentials configuration & seed data
```