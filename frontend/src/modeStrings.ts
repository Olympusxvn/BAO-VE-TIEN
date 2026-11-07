// Auto-mode warning copy (user-approved wording, 2026-11-07).
// Use these constants verbatim — the backend test asserts the exact
// strings, and the UI must never paraphrase the warning away.
export const AUTO_ENABLE_WARNING =
  'Auto mode executes batches automatically when they pass policy — no per-batch approval. Waiting for approval can mean missing an FX window. Only enable Auto mode if you trust the policy, caps, and allow-list. You can pause it anytime.';

export const AUTO_BANNER =
  'Auto mode is ON — qualifying batches execute automatically. Pause anytime.';

export const AUTO_PAUSED_BANNER =
  'Auto mode is paused — batches will not execute automatically until you resume.';

export const AUTO_EXECUTED_NOTICE =
  'Executed automatically in Auto mode — policy + advisor output logged';
