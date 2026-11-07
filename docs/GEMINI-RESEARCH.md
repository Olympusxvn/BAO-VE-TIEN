# Gemini provider research (for the advisor multi-provider slice)

Researched 2026-11-07, before the user picks the provider shape
(keep OpenAI + add Gemini, or switch fully to Gemini). No key was used
or recorded here. Verify the model ID live at build time — model names
drift; `GEMINI_MODEL` is the escape hatch.

## Public Gemini API (API-key auth)

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- Auth: pass the key in the `x-goog-api-key` request header, NOT the
  `?key=` query string (keys in URLs leak into shell history and logs).
- Request body (generateContent shape):
  `{"contents": [{"parts": [{"text": "<prompt>"}]}]}`
- Response text: `candidates[0].content.parts[*].text` (join parts).
- No SDK needed — native fetch, same as the OpenAI advisor.

## Models (verify live at build time)

- `gemini-2.0-flash` and `gemini-2.5-flash` are the established free-tier
  Flash models; `gemini-2.5-flash-lite` has the most generous free quota.
- Newer Flash models (Gemini 3.x family) appear on 2026 pricing pages;
  confirm the exact model ID against the live models endpoint before
  hard-coding a default. Default candidate for testing: `gemini-2.5-flash`.

## Free tier (Google AI Studio)

- Flash models: free input/output tokens within rate limits (~15 RPM on
  the 2.0 Flash free tier). Pro models are paid-only.
- Privacy caveat: free-tier content may be used to improve Google's
  products. The existing PII-mask rule (mask before any LLM call) matters
  even more on the free tier — never send raw recipient emails.

## What the slice must do

- Add a Gemini client beside the OpenAI client in `src/backend/advisor.ts`
  (same interface: prompt in, validated recommendation out; same HOLD
  fallback on any failure).
- Provider + model selectable at runtime: env (`AI_PROVIDER`,
  `GEMINI_API_KEY`, `GEMINI_MODEL`, `OPENAI_MODEL`) AND the judge BYOK
  UI (provider dropdown + key + model inputs, key kept in memory only,
  never persisted, never logged, masked on display).
- `modelUsed` in the advise response must name the provider + model
  actually used (e.g. `gemini/gemini-2.5-flash`).
- Update SPEC §1.1 (provider no longer OpenAI-only), RULE.md, PRD, README,
  AUDIT (§15). Tests: Gemini response parsing, invalid-key → HOLD,
  BYOK config never persisted, `modelUsed` naming.
