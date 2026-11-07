# 🎯 STRATEGY.md: Strategic Development & Roadmap

## Project: BAO VE TIEN (Bảo Vệ Tiền) — Autonomous Global Treasury Platform

---

## 🏆 Hackathon Objectives & Prize Alignment

Our sole focus is to build a winning submission for the **PayPal AI Hackathon** by maximizing score potential across all judging criteria and positioning for key top-tier prizes:

*   **Best Use of PayPal + AI ($5,000):** Deep, non-trivial combination of PayPal Payouts REST API + Webhook events + PayPal AI Toolkit (MCP) with GPT-4o autonomous decision reasoning.
*   **Most Impactful ($5,000):** Solves a real multi-billion dollar pain point for cross-border businesses—foreign exchange (FX) slippage, batch payout friction, and payment failures.
*   **Grand Prize Contender ($12,000):** Complete, coherent enterprise product experience leveraging partner tools (**APIMatic Context Plugins**, **AG Grid Community**) with resilient defensive programming.

---

## ⚡ Current State: "Lean & Powerful" Strategy (No Overbuild)

To win in a high-speed hackathon environment, **we avoid overbuilding**. We do not create custom microservice clusters or reinvent UI component libraries from scratch. Instead, we orchestrate premier tools (**PayPal AI Toolkit MCP**, **APIMatic**, **AG Grid Community**, **GPT-4o**) into a tight, fault-tolerant workflow.

---

## 🚀 The 4 Core MVP Features (Present Scope)

### Feature 1: Autonomous FX Risk Advisor & Treasury Engine (PayPal + AI Core)
*   **What it does:** Ingests cross-border supplier payment batches across multiple currencies (`USD`, `EUR`, `GBP`, `SGD`). GPT-4o analyzes FX rate trends, volatility spreads, and invoice due dates to assign a risk score (`LOW`, `MEDIUM`, `HIGH`) and execution recommendation (`EXECUTE_NOW`, `HOLD_30_MINS`, `SPLIT_BATCH`).
*   **Tooling:** **PayPal AI Toolkit (MCP Server)** for conversational sandbox testing + **OpenAI** (default runtime AI provider; model via `OPENAI_MODEL`, default `gpt-4o` — GPT-4o is the default, not a requirement, any OpenAI chat-completion model may be used; key in `OPENAI_API_KEY`, env only) + **Gemini** (second provider; model via `GEMINI_MODEL`, default `gemini-2.5-flash`; key in `GEMINI_API_KEY`, env only; provider via `AI_PROVIDER`; judge BYOK at runtime) + **Frankfurter API** (ECB reference rates) as the sole FX source. Approval gate: human approval mandatory before every batch; caps per-item $250 / per-batch $500 / daily $1,000 USD-equivalent; recipient allow-list max 20; over-cap or off-list = `AWAITING_APPROVAL`, never sent. Payout currencies are `USD`, `EUR`, `GBP`, `SGD` only — VND invoices are converted to USD for the PayPal call, never sent as VND.

### Feature 2: Type-Safe & Error-Shielded Batch Execution Engine
*   **What it does:** Dispatches multi-currency supplier payments via `POST /v1/payments/payouts` with absolute schema safety and idempotency protection (`PayPal-Request-Id`). Intercepts API errors and translates raw PayPal JSON errors into human-actionable insights.
*   **Tooling:** **PayoutGuard** (own runtime validator; APIMatic Context Plugin used at build time only to verify the client) + **PayPal Payouts REST API**.

### Feature 3: Interactive Real-Time Treasury Ledger Dashboard
*   **What it does:** High-density, zero-latency financial grid displaying multi-currency transaction states, live FX risk indicators, and batch status badges. Includes an embedded AI conversational assistant to filter ledger data and trigger batch approvals using natural language.
*   **Tooling:** **AG Grid Community** (Data Grid, MIT) + in-app summary cards (no Enterprise features).

### Feature 4: Webhook Feedback Loop & Defensive Fallback Mechanisms
*   **What it does:** Listens to asynchronous PayPal events (`PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTSBATCH.DENIED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`) to update the AG Grid dashboard instantly via Server-Sent Events (SSE). Includes a deterministic rule-based fallback mode if AI services experience timeouts or rate limits.
*   **Tooling:** **PayPal Webhooks Engine** + **Node.js Express Controller**.

---

## 🔮 Future Vision & Strategic Roadmap (Post-Hackathon)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1 (Current MVP): Cross-Border Payouts & FX Risk Advisor                    │
│   - PayPal Payouts REST API + Webhooks + AG Grid Community + APIMatic + MCP Tooling │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2 (Near-Term Expansion): Smart Dispute Shield & Automated Escrow          │
│   - PayPal Disputes API integration for automated evidence submission.          │
│   - Predictive fraud prevention via historical merchant pattern analysis.        │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3 (Enterprise Scale): Multi-Rail Corporate Treasury Agent                  │
│   - Hyperwallet & Braintree GraphQL API unification.                            │
│   - Autonomous FX hedging contracts & multi-bank liquidity optimization.         │
└──────────────────────────────────────────────────────────────────────────────────┘
```

1.  **Phase 2 — Smart Dispute Shield & Merchant Protection:**
    *   Integrate PayPal Disputes API to automatically draft evidence logs when chargebacks occur on cross-border orders.
    *   Incorporate automated proof-of-delivery cross-referencing to protect cross-border merchants against chargeback fraud.
2.  **Phase 3 — Global Hyperwallet & Enterprise FX Hedging:**
    *   Expand payout rails to **Hyperwallet** for local bank account deposits in 180+ countries.
    *   Enable autonomous forward-contract FX hedging triggers when corporate treasury capital exposure exceeds customizable thresholds.

---

## 📌 Instructions for Muse Code Execution

1.  **Focus strictly on the 4 Core Features.** Do not implement features from Phase 2 or Phase 3 during the hackathon sprint.
2.  **Rely on partner tools** (**APIMatic** at build time, **AG Grid Community**, **PayPal MCP**) to handle complex UI and client-verification tasks; runtime validation is our own PayoutGuard.
3.  **Prioritize end-to-end working execution in PayPal Sandbox** over superficial extra features.