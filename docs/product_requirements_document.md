# 📄 PRD.md: Product Requirements Document

## BAO VE TIEN — Autonomous Global Treasury & Cross-Border Payout Platform

---

## 1. Document Overview & Goals

This Product Requirements Document (PRD) defines the functional requirements, user experience, feature set, and operational guardrails for **BAO VE TIEN (Bảo Vệ Tiền)**.

### Target Objectives
1. **Automate Global Disbursements:** Provide a zero-friction batch payout workflow executing directly through the PayPal Payouts REST API.
2. **Mitigate Foreign Exchange Volatility:** Integrate AI-driven FX trend forecasting to recommend ideal payment windows for cross-border transactions.
3. **Ensure Financial Integrity:** Prevent invalid payloads, API schema errors, and PII leaks using our own PayoutGuard schema validator (client verified at build time with the APIMatic Context Plugin) and strict schema validators.
4. **Deliver Enterprise Insights:** Render real-time multi-currency transaction ledgers with low-latency interactive controls via AG Grid Community.

---

## 2. User Personas

| Persona | Role | Key Pain Points | Primary Goal in BAO VE TIEN |
| :--- | :--- | :--- | :--- |
| **Corporate Treasurer (Elena)** | VP of Finance / Treasurer | High FX slippage, unpredictable cross-border transaction fees, lack of real-time visibility. | Wants AI suggestions on when to execute multi-currency disbursements to maximize capital efficiency. |
| **Operations Manager (David)** | Global Vendor Manager | Manual invoice collation, high failure rate on cross-border payments, tedious dispute handling. | Wants to batch-approve supplier payouts with one click (Approve & Execute, enabled only within caps and for allow-listed recipients) and get instant status updates via Webhooks. |
| **Developer / Admin (Alex)** | FinTech Integration Lead | Debugging raw JSON errors from payment gateways, managing complex API specs across environments. | Relies on PayoutGuard-validated payloads and automated error translation to maintain high uptime. |

---

## 3. Epics & Key Features

```
         ┌─────────────────────────────────────────────────────────┐
         │                  EPIC 1: FX Intelligence               │
         │         - Real-Time FX Rate Tracking & Analysis         │
         │         - GPT-4o Opportunity Windows Alert             │
         └────────────────────────────┬────────────────────────────┘
                                      │
                                      ▼
         ┌─────────────────────────────────────────────────────────┐
         │                  EPIC 2: Batch Payouts                 │
         │         - Multi-Currency Invoice Ingestion             │
         │         - PayPal Payouts REST API Execution            │
         │         - PayoutGuard Schema Validation & Error Shield  │
         └────────────────────────────┬────────────────────────────┘
                                      │
                                      ▼
         ┌─────────────────────────────────────────────────────────┐
         │                EPIC 3: Real-Time Webhooks              │
         │         - Event Receiver (PAYMENT.PAYOUTSBATCH.SUCCESS, etc.)  │
         │         - Asynchronous Status Synchronization           │
         └────────────────────────────┬────────────────────────────┘
                                      │
                                      ▼
         ┌─────────────────────────────────────────────────────────┐
         │                 EPIC 4: Enterprise UI                  │
         │         - AG Grid Community Multi-Currency Ledger          │
         │         - Embedded Natural Language AI Chat Assistant   │
         └─────────────────────────────────────────────────────────┘
```

---

### Epic 1: Autonomous FX Intelligence & Opportunity Alerts

#### Feature 1.1: Multi-Currency Exchange Tracker
* **Description:** Monitors exchange rates between major operating currencies (`USD`, `EUR`, `GBP`, `SGD`). Sole FX source: Frankfurter API (ECB reference rates), `GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,SGD`, refreshed hourly and cached. VND is display-only: a VND invoice is shown in VND and converted to USD at the Frankfurter rate for the PayPal call, never sent as `currency: VND` (VND is not a PayPal REST Payouts currency).
* **Requirements:**
  * Fetch live exchange rates at configurable intervals (e.g., hourly/daily).
  * Calculate volatility indices and spread differentials for cross-border pairs.

#### Feature 1.2: GPT-4o Execution Window Advisor
* **Description:** GPT-4o analyzes historical volatility and upcoming invoice due dates to rank payout urgency versus exchange rate favorability.
* **Requirements:**
  * Categorize payout batches into three confidence tiers: **Execute Now** (Low FX Risk), **Hold** (High Volatility), **Urgent Due** (Override FX for compliance).
  * Display reasoning in natural language alongside quantitative savings estimates.

---

### Epic 2: Intelligent Batch Payout Engine (PayPal Integration)

#### Feature 2.1: Multi-Currency Invoice & Batch Ingestion
* **Description:** Ingest vendor payment demands in bulk (via CSV, JSON, or API endpoint).
* **Requirements:**
  * Parse vendor emails, PayPal account IDs, amounts, currencies, and reference notes.
  * Auto-assign unique `sender_batch_id` and individual `sender_item_id` string hashes for idempotency.

#### Feature 2.2: PayoutGuard Schema Validation & PII Guard
* **Description:** Passes generated payout payloads through PayoutGuard (own runtime code, not APIMatic) before transmitting to PayPal. The APIMatic Context Plugin was used at build time only to verify the Payouts client against the PayPal OpenAPI spec; see docs/APIMATIC.md.
* **Requirements:**
  * Validate JSON payload strictly against PayPal Payouts OpenAPI specification.
  * Strip or mask sensitive PII (e.g., raw vendor bank info, personal notes) from LLM logs while retaining required PayPal payment routing parameters.
  * Intercept 4xx/5xx API errors and translate raw PayPal error codes into human-readable action items (e.g., `"INSUFFICIENT_FUNDS"` $\rightarrow$ *"Top up Sandbox USD account before re-trying"*).

#### Feature 2.3: PayPal Payouts REST API Execution
* **Description:** Dispatches batch payments using `POST /v1/payments/payouts`.
* **Requirements:**
  * Support `recipient_type` as `EMAIL` or `PAYPAL_ID`.
  * Manage request headers including OAuth 2.0 Bearer tokens and `PayPal-Request-Id` for idempotency protection.

---

### Feature 2.4: Approval Modes — Human-default / Auto-supervised
* **Description:** Human mode (default): no batch reaches PayPal without a human approval. The GPT-4o advisor recommends; the treasurer approves in the grid. Auto mode (opt-in): a batch that passes the policy, the tighter auto caps, an EXECUTE_NOW recommendation and a low FX risk score executes automatically — supervised autonomy within a pre-approved policy, never unsupervised spending. (Modes added 2026-11-07; this supersedes the 2026-11-06 "human approval mandatory before every batch" wording. See SPEC §3.1.)
* **Requirements:**
  * Approve button ("Approve & Execute") per batch, disabled unless the batch is within caps (per-item $250, per-batch $500, daily $1,000 USD-equivalent), every recipient is on the allow-list (max 20), and the GPT-4o recommendation is EXECUTE_NOW. The disabled reason is shown. A manual Approve click still works in Auto mode.
  * Over-cap or off-allow-list batches are `AWAITING_APPROVAL` and are never sent. A treasurer override still cannot exceed the daily cap.
  * Backend re-checks caps, allow-list and daily spend in `POST /api/treasury/batches/:id/approve` and in `executeBatchPayout`. There is no API path that executes an unauthorized batch; auto execution uses the same `executeBatchPayout` path.
  * Auto mode executes only when ALL hold: advisor `EXECUTE_NOW`, standard policy passes, tighter auto caps hold (per-item ≤ $100, per-batch ≤ $250, auto-spent-today + batch total ≤ $500), `fxRiskScore < 3.0`, mode AUTO and not paused. Any failing condition leaves the batch `AWAITING_APPROVAL` with the blocking reasons shown.
  * Mode endpoints: `GET /api/treasury/mode`, `POST /api/treasury/mode { mode: 'HUMAN' | 'AUTO' }`, `POST /api/treasury/mode/pause { paused: boolean }`, `GET /api/treasury/audit`. Every mode change, pause change, auto execution (with policy snapshot + advisor output) and blocked auto evaluation is logged.
  * Warnings: enable-confirm dialog (exact copy in SPEC §3.1) before Auto can be turned on — enabling without confirming is impossible in the UI; always-on banner while Auto is on ("Auto mode is ON — qualifying batches execute automatically. Pause anytime."); amber Auto badge (vs blue/green Human badge); per-batch notice on auto-executed batches ("Executed automatically in Auto mode — policy + advisor output logged"); pause button always visible while Auto is on.

### Epic 3: Asynchronous Webhook Synchronization

#### Feature 3.1: Webhook Event Receiver
* **Description:** Backend HTTP listener handling incoming Webhook notifications from PayPal Sandbox.
* **Requirements:**
  * Subscribe to events: `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTSBATCH.DENIED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.FAILED`, `PAYMENT.PAYOUTS-ITEM.BLOCKED`.
  * Validate PayPal Webhook signatures via PayPal's Verify Webhook Signature API (`POST /v1/notifications/verify-webhook-signature`) using the headers (`PAYPAL-AUTH-ALGO`, `PAYPAL-CERT-URL`, `PAYPAL-TRANSMISSION-ID`, `PAYPAL-TRANSMISSION-SIG`, `PAYPAL-TRANSMISSION-TIME`) and the webhook ID from env. Unverified events are rejected with 400 and never update the ledger.

#### Feature 3.2: Real-time Ledger Synchronization
* **Description:** Pushes status updates instantly to the frontend when a payout item transitions from `PENDING` to `SUCCESS` or `FAILED`.

---

### Epic 4: AG Grid Community Treasury Dashboard

#### Feature 4.1: Low-Latency Multi-Currency Grid
* **Description:** Interactive financial grid powered by AG Grid Community.
* **Requirements:**
  * Dynamic column sorting, cell editing (for manual payout overrides), and grouping by Currency / Vendor Country.
  * Integrated status badge formatting (`Success` = Green, `Pending` = Yellow, `Failed` = Red).
  * Custom AG Grid header widgets displaying real-time total batch value converted to base currency (`USD`).

#### Feature 4.2: Embedded Conversational AI Assistant
* **Description:** A slide-over chat interface powered by GPT-4o.
* **Requirements:**
  * Allow natural language queries: *"Show all EUR payouts pending over $1,000"*, *"Execute batch #8821 via PayPal Payouts API"*.
  * Execute grid filtering actions or trigger payment executions based on user confirmation.

---

## 4. User Journeys & End-to-End Workflow

```
[Treasurer Log-in] ──> [View AG Grid Ledger] ──> [GPT-4o FX Alert Triggered]
                                                            │
                                                            ▼
[PayPal Payout Triggered] <── [Review Batch & FX Savings] ◄──┘
           │
           ▼
[PayoutGuard Schema Check] ──> [PayPal Payouts REST API] ──> [Sandbox Event]
                                                                  │
                                                                  ▼
[AG Grid Real-time Update] <── [Backend Webhook Handler] <────────┘
```

1. **Step 1: Dashboard Initialization:** Elena logs in. AG Grid Community loads pending global vendor payments aggregated across USD, EUR, GBP, and SGD.
2. **Step 2: AI Opportunity Discovery:** GPT-4o displays a notification banner: *"EUR/USD exchange rate is 1.4% more favorable than 7-day average. 14 pending EUR vendor payouts ready for execution."*
3. **Step 3: Batch Approval:** Elena reviews the flagged items in AG Grid, selects the batch, and clicks **"Approve & Execute"**. The button is disabled unless the batch is within caps (per-item $250, per-batch $500, daily $1,000 USD-equivalent), every recipient is on the allow-list, and the GPT-4o recommendation is EXECUTE_NOW. Over-cap or off-list batches stay `AWAITING_APPROVAL` and are never sent to PayPal.
4. **Step 4: Safe API Execution:** 
   * The backend compiles the transaction object.
   * PayoutGuard verifies the structure against PayPal's Payout schema.
   * Node.js/Python backend sends `POST /v1/payments/payouts` to PayPal Sandbox.
5. **Step 5: Event Confirmation:** PayPal processes the batch asynchronously and emits `PAYMENT.PAYOUTSBATCH.SUCCESS`. The Webhook listener receives the payload and updates AG Grid in real-time, displaying green transaction IDs.

---

## 5. Non-Functional Requirements (NFRs)

* **Performance:** AG Grid rendering must maintain 60 FPS scrolling for ledgers up to 10,000 rows. Payout submission to PayPal API response latency must be $< 1.5$ seconds in Sandbox.
* **Security & Privacy:** Strictly zero storage of raw credentials; OAuth tokens cached in memory only. PII masking applied prior to forwarding any transaction context to external AI models.
* **Reliability:** Idempotency keys (`PayPal-Request-Id`) enforced on every outbound payout attempt to prevent double disbursements during network dropouts.
* **Compatibility:** Fully tested and operating within the official PayPal Developer Sandbox environment.

---

## 6. Success Metrics & Key Performance Indicators (KPIs)

* **FX Slippage Reduction:** Achieve an average $\ge 1.5\%$ cost savings on cross-border batch disbursements during test simulations.
* **API Success Rate:** $100\%$ schema validation compliance through PayoutGuard prior to PayPal API invocation.
* **Execution Efficiency:** Reduce manual batch payout setup time from minutes to under 10 seconds via natural language AI commands.
* **Webhook Responsiveness:** $\le 500\text{ ms}$ processing time from receipt of PayPal Webhook event to dashboard UI update.