// BAO VE TIEN backend (Nov 8 + advisor + modes slices).
// Express + native fetch only. Sandbox ONLY — no live PayPal URL anywhere.
// Human mode (default): a batch executes only after a human Approve
// click. Auto mode (opt-in): a batch executes only after passing the
// approval policy AND the tighter auto caps, an EXECUTE_NOW
// recommendation and a low FX risk score — supervised autonomy, never
// outside policy. Both paths execute through the same executeBatchPayout
// with the policy re-checked; there is NO route that executes an
// unauthorized batch. The advisor (POST /:id/advise) only recommends;
// OPENAI_API_KEY / OPENAI_MODEL come from env (see .env.example).
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import { adviseBatch } from './backend/advisor.js';
import { payoutEvents } from './backend/events.js';
import { getFxRates, toUsd, type FxRates } from './backend/fx.js';
import {
  HumanApprovalRequired,
  PayPalError,
  PayPalPayoutService,
} from './backend/paypalService.js';
import { createWebhookHandler } from './backend/webhookHandler.js';
import {
  TreasuryStore,
  type AuditEntry,
  type Batch,
  type TreasuryMode,
} from './backend/store.js';
import {
  AUTO_DAILY_CAP_USD,
  AUTO_FX_RISK_MAX,
  AUTO_PER_BATCH_CAP_USD,
  AUTO_PER_ITEM_CAP_USD,
  DAILY_CAP_USD,
  PER_BATCH_CAP_USD,
  PER_ITEM_CAP_USD,
  PayoutGuard,
} from './guard/payoutGuard.js';
import {
  PAYOUT_CURRENCIES,
  type PayoutCurrency,
  type PayoutItem,
} from './models/PayoutItem.js';

interface CreateItemInput {
  recipientEmail?: unknown;
  amount?: unknown;
  currency?: unknown;
  recipientNote?: unknown;
  senderItemId?: unknown;
}

function parseCreateItems(body: unknown): PayoutItem[] | string {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { items?: unknown }).items)) {
    return 'Body must be { "items": [...] } with at least one item';
  }
  const rawItems = (body as { items: unknown[] }).items;
  if (rawItems.length === 0) return 'Payload must contain at least one payout item';
  const items: PayoutItem[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i] as CreateItemInput;
    if (typeof raw !== 'object' || raw === null) return `Item ${i} must be an object`;
    if (typeof raw.recipientEmail !== 'string' || !raw.recipientEmail.includes('@')) {
      return `Item ${i} needs a valid recipientEmail`;
    }
    if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount <= 0) {
      return `Item ${i} amount must be a number greater than 0`;
    }
    if (
      typeof raw.currency !== 'string' ||
      !(PAYOUT_CURRENCIES as readonly string[]).includes(raw.currency)
    ) {
      return `Item ${i} currency must be one of ${PAYOUT_CURRENCIES.join(', ')} (VND is never a payout currency)`;
    }
    if (raw.recipientNote !== undefined && typeof raw.recipientNote !== 'string') {
      return `Item ${i} recipientNote must be a string`;
    }
    if (raw.senderItemId !== undefined && typeof raw.senderItemId !== 'string') {
      return `Item ${i} senderItemId must be a string`;
    }
    items.push({
      itemId: randomUUID(),
      recipientEmail: raw.recipientEmail,
      amount: raw.amount,
      currency: raw.currency as PayoutCurrency,
      recipientNote: raw.recipientNote as string | undefined,
      senderItemId:
        (raw.senderItemId as string | undefined) ?? `ITEM_${randomUUID().slice(0, 8)}`,
      status: 'DRAFT',
      fxRiskScore: 0, // Set by the advisor slice (Nov 9); 0 = unscored.
    });
  }
  return items;
}

/** Converts batch items to USD-equivalent amounts for the cap check. */
async function toUsdItems(
  items: PayoutItem[],
): Promise<{ usdItems: PayoutItem[]; rates: FxRates | null }> {
  if (items.every((item) => item.currency === 'USD')) {
    return { usdItems: items, rates: null };
  }
  const rates = await getFxRates();
  return {
    usdItems: items.map((item) => ({ ...item, amount: toUsd(item.amount, item.currency, rates) })),
    rates,
  };
}

/** Builds the PayPal Payouts request payload for a batch. */
function buildPayoutPayload(batch: Batch): {
  sender_batch_header: {
    sender_batch_id: string;
    email_subject: string;
    email_message: string;
  };
  items: Array<{
    recipient_type: string;
    amount: { value: string; currency: string };
    note?: string;
    sender_item_id: string;
    receiver: string;
  }>;
} {
  return {
    sender_batch_header: {
      sender_batch_id: batch.senderBatchId,
      email_subject: 'You have a cross-border payment from BAO VE TIEN Treasury',
      email_message: 'Thank you for your business. Your payout has been executed via PayPal Payouts.',
    },
    items: batch.items.map((item) => ({
      recipient_type: 'EMAIL',
      amount: { value: item.amount.toFixed(2), currency: item.currency },
      note: item.recipientNote,
      sender_item_id: item.senderItemId,
      receiver: item.recipientEmail,
    })),
  };
}

/** Fetch implementations for external calls. Tests pass stubs; the
 * production server uses the global fetch. Nothing here is mocked in
 * the production path — stubs exist only inside unit tests. */
export interface AppDeps {
  paypalFetch?: typeof fetch;
  openaiFetch?: typeof fetch;
  fxFetch?: typeof fetch;
}

export function createApp(deps: AppDeps = {}): { app: Express; store: TreasuryStore } {
  const store = new TreasuryStore();
  const paypal = new PayPalPayoutService(deps.paypalFetch);
  const app = express();

  // Express 5 types a route param as string | string[]; :id is single.
  const routeId = (req: Request): string =>
    Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  /**
   * THE single execution path, used by the manual Approve endpoint and
   * by Auto mode alike. The caller must already have authorized the
   * batch (human Approve click, or a passed auto gate) and re-checked
   * the policy; executeBatchPayout re-checks it once more (defence in
   * depth). On success the batch is PENDING with its PayPal batch id;
   * on failure it is terminal FAILED so a retry cannot double-pay.
   */
  async function executeAuthorizedBatch(
    batch: Batch,
    usdItems: PayoutItem[],
    authorizedBy: 'human' | 'auto',
    auditDetail?: Record<string, unknown>,
  ): Promise<
    | { ok: true; payoutBatchId: string }
    | { ok: false; reasons?: string[]; error?: string }
  > {
    const payoutPayload = buildPayoutPayload(batch);
    batch.approved = true;
    batch.status = 'APPROVED';
    try {
      const result = await paypal.executeBatchPayout({
        payoutPayload,
        items: usdItems,
        approved: true,
        spentTodayUsd: store.spentTodayUsd,
        allowlist: store.allowlist,
      });
      const totalUsd = usdItems.reduce((sum, item) => sum + item.amount, 0);
      batch.status = 'PENDING';
      batch.payoutBatchId = result.batch_header.payout_batch_id;
      store.spentTodayUsd += totalUsd;
      if (authorizedBy === 'auto') {
        store.autoSpentTodayUsd += totalUsd;
        batch.autoExecuted = true;
        store.logAudit('auto-execution', {
          batchId: batch.id,
          senderBatchId: batch.senderBatchId,
          payoutBatchId: batch.payoutBatchId,
          totalUsd,
          ...(auditDetail ?? {}),
        });
      }
      payoutEvents.emit('payout_update', {
        type: 'batch',
        batchId: batch.payoutBatchId,
        status: 'PENDING',
      });
      return { ok: true, payoutBatchId: batch.payoutBatchId };
    } catch (err) {
      if (err instanceof HumanApprovalRequired) {
        // Cannot happen after the caller's check, but never execute anyway.
        batch.status = 'AWAITING_APPROVAL';
        batch.approved = false;
        batch.approvalBlockReasons = err.reasons;
        return { ok: false, reasons: err.reasons };
      }
      // Execution failed: the batch is terminal (FAILED) so a retry
      // cannot double-pay. Create a new batch to try again.
      const message = err instanceof PayPalError ? err.message : 'Unknown execution error';
      batch.status = 'FAILED';
      batch.errorMessage = message;
      return { ok: false, error: message };
    }
  }

  /**
   * Auto-mode evaluation, run after batch creation and after each
   * advise call. Executes the batch only when the mode is AUTO, not
   * paused, and every auto condition holds; otherwise the batch stays
   * AWAITING_APPROVAL with the blocking reasons. A batch that was never
   * assessed (no recommendation) is left untouched.
   */
  async function maybeAutoExecute(batch: Batch): Promise<boolean> {
    if (store.mode !== 'AUTO' || store.paused) return false;
    if (batch.status !== 'DRAFT' && batch.status !== 'AWAITING_APPROVAL') return false;
    if (!batch.recommendation) return false;

    let usdItems: PayoutItem[];
    try {
      ({ usdItems } = await toUsdItems(batch.items));
    } catch (err) {
      const reason = `FX rates unavailable: ${err instanceof Error ? err.message : String(err)}; non-USD items cannot be cap-checked`;
      batch.status = 'AWAITING_APPROVAL';
      batch.autoBlockReasons = [reason];
      store.logAudit('auto-blocked', {
        batchId: batch.id,
        senderBatchId: batch.senderBatchId,
        reasons: [reason],
        recommendation: batch.recommendation,
        fxRiskScore: batch.fxRiskScore,
      });
      return false;
    }

    const totalUsd = usdItems.reduce((sum, item) => sum + item.amount, 0);
    const errors = PayoutGuard.validateAutoPolicy({
      items: usdItems,
      recommendation: batch.recommendation,
      fxRiskScore: batch.fxRiskScore,
      spentTodayUsd: store.spentTodayUsd,
      autoSpentTodayUsd: store.autoSpentTodayUsd,
      allowlist: store.allowlist,
    });
    if (errors.length > 0) {
      batch.status = 'AWAITING_APPROVAL';
      batch.autoBlockReasons = errors;
      store.logAudit('auto-blocked', {
        batchId: batch.id,
        senderBatchId: batch.senderBatchId,
        reasons: errors,
        recommendation: batch.recommendation,
        fxRiskScore: batch.fxRiskScore,
      });
      return false;
    }

    const outcome = await executeAuthorizedBatch(batch, usdItems, 'auto', {
      policy: {
        mode: 'AUTO',
        paused: false,
        recommendation: batch.recommendation,
        fxRiskScore: batch.fxRiskScore,
        totalUsd,
        autoSpentBeforeUsd: store.autoSpentTodayUsd,
        spentTodayBeforeUsd: store.spentTodayUsd,
        autoCaps: {
          perItem: AUTO_PER_ITEM_CAP_USD,
          perBatch: AUTO_PER_BATCH_CAP_USD,
          daily: AUTO_DAILY_CAP_USD,
          fxRiskMax: AUTO_FX_RISK_MAX,
        },
        caps: {
          perItem: PER_ITEM_CAP_USD,
          perBatch: PER_BATCH_CAP_USD,
          daily: DAILY_CAP_USD,
        },
      },
      advisor: {
        recommendation: batch.recommendation,
        fxRiskScore: batch.fxRiskScore,
        reason: batch.advisorReason,
        model: batch.modelUsed,
        source: batch.advisorSource,
      },
    });
    return outcome.ok;
  }

  // Webhook first, with raw-body capture — express.json() must NOT run
  // on this route, the signature check needs the untouched body.
  app.post(
    '/api/webhooks/paypal',
    express.raw({ type: 'application/json' }),
    createWebhookHandler(store),
  );

  app.use(express.json());

  app.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).send({
      status: 'ok',
      sandbox: true,
      batches: store.listBatches().length,
      time: new Date().toISOString(),
    });
  });

  app.post('/api/treasury/batches', async (req: Request, res: Response) => {
    const parsed = parseCreateItems(req.body);
    if (typeof parsed === 'string') {
      res.status(400).send({ error: parsed });
      return;
    }
    const batch = store.createBatch(parsed);
    // Auto trigger point: a fresh batch has no recommendation yet, so
    // this is a no-op today — but the check belongs here so a future
    // pre-assessed batch cannot slip past the gate.
    await maybeAutoExecute(batch);
    res.status(201).send(batch);
  });

  app.get('/api/treasury/batches', (_req: Request, res: Response) => {
    res.status(200).send(store.listBatches());
  });

  app.get('/api/treasury/batches/:id', (req: Request, res: Response) => {
    const id = routeId(req);
    const batch = store.getBatch(id);
    if (!batch) {
      res.status(404).send({ error: `Batch ${id} not found` });
      return;
    }
    res.status(200).send(batch);
  });

  // Advisor: runs the FX advisor for a batch and stores the result.
  // NEVER changes approval state and NEVER executes a payout; execution
  // stays behind POST /:id/approve only.
  app.post('/api/treasury/batches/:id/advise', async (req: Request, res: Response) => {
    const id = routeId(req);
    const batch = store.getBatch(id);
    if (!batch) {
      res.status(404).send({ error: `Batch ${id} not found` });
      return;
    }
    if (batch.status === 'PENDING' || batch.status === 'SUCCESS' || batch.status === 'FAILED') {
      res.status(409).send({ error: `Batch ${id} is ${batch.status}; advice is closed` });
      return;
    }
    const result = await adviseBatch(batch, {
      fetchImpl: deps.openaiFetch,
      fxFetch: deps.fxFetch,
    });
    batch.fxRiskScore = result.fxRiskScore;
    batch.recommendation = result.recommendation;
    batch.advisorReason = result.reason;
    batch.modelUsed = result.model;
    batch.advisorSource = result.source;
    for (const item of batch.items) item.fxRiskScore = result.fxRiskScore;
    // Auto trigger point: a qualifying batch executes now in Auto mode.
    // Otherwise the batch has been assessed and awaits a decision.
    const autoExecuted = await maybeAutoExecute(batch);
    if (!autoExecuted && batch.status === 'DRAFT') {
      batch.status = 'AWAITING_APPROVAL';
    }
    res.status(200).send({
      batchId: batch.id,
      recommendation: result.recommendation,
      fxRiskScore: result.fxRiskScore,
      reason: result.reason,
      model: result.model,
      source: result.source,
      autoExecuted,
      status: batch.status,
      payoutBatchId: batch.payoutBatchId,
    });
  });

  // Allow-list management (demo only, no auth in this slice). Adding an
  // entry persists in the same store the approve path reads, so an
  // allow-listed recipient can be approved via the API right away.
  app.get('/api/treasury/allowlist', (_req: Request, res: Response) => {
    res.status(200).send({ allowlist: [...store.allowlist] });
  });

  app.post('/api/treasury/allowlist', (req: Request, res: Response) => {
    const email = (req.body as { email?: unknown } | null)?.email;
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).send({ error: 'Body must be { "email": "<valid email>" }' });
      return;
    }
    const outcome = store.addAllowlist(email);
    if (outcome === 'duplicate') {
      res.status(409).send({ error: `Email ${email} is already on the allow-list` });
      return;
    }
    if (outcome === 'full') {
      res.status(422).send({ error: 'Allow-list is full (max 20 entries)' });
      return;
    }
    res.status(201).send({ allowlist: [...store.allowlist] });
  });

  app.delete('/api/treasury/allowlist/:email', (req: Request, res: Response) => {
    const email = Array.isArray(req.params.email) ? req.params.email[0] : req.params.email;
    if (!store.removeAllowlist(email)) {
      res.status(404).send({ error: `Email ${email} is not on the allow-list` });
      return;
    }
    res.status(200).send({ allowlist: [...store.allowlist] });
  });

  // Approval modes (user decision 2026-11-07). HUMAN (default): every
  // batch needs a human Approve click. AUTO (opt-in): a batch that
  // passes the policy, the tighter auto caps, an EXECUTE_NOW
  // recommendation and a low FX risk score executes automatically.
  // Every mode change and pause change is written to the audit log.
  const modeState = (): {
    mode: TreasuryMode;
    paused: boolean;
    autoCaps: { perItem: number; perBatch: number; daily: number; fxRiskMax: number };
    caps: { perItem: number; perBatch: number; daily: number };
  } => ({
    mode: store.mode,
    paused: store.paused,
    autoCaps: {
      perItem: AUTO_PER_ITEM_CAP_USD,
      perBatch: AUTO_PER_BATCH_CAP_USD,
      daily: AUTO_DAILY_CAP_USD,
      fxRiskMax: AUTO_FX_RISK_MAX,
    },
    caps: {
      perItem: PER_ITEM_CAP_USD,
      perBatch: PER_BATCH_CAP_USD,
      daily: DAILY_CAP_USD,
    },
  });

  app.get('/api/treasury/mode', (_req: Request, res: Response) => {
    res.status(200).send(modeState());
  });

  app.post('/api/treasury/mode', (req: Request, res: Response) => {
    const mode = (req.body as { mode?: unknown } | null)?.mode;
    if (mode !== 'HUMAN' && mode !== 'AUTO') {
      res.status(400).send({ error: 'Body must be { "mode": "HUMAN" | "AUTO" }' });
      return;
    }
    store.setMode(mode);
    res.status(200).send(modeState());
  });

  // Pause / kill switch: pausing stops all auto-execution immediately.
  // Paused batches stay AWAITING_APPROVAL; the mode itself is unchanged.
  app.post('/api/treasury/mode/pause', (req: Request, res: Response) => {
    const paused = (req.body as { paused?: unknown } | null)?.paused;
    if (typeof paused !== 'boolean') {
      res.status(400).send({ error: 'Body must be { "paused": true | false }' });
      return;
    }
    store.setPaused(paused);
    res.status(200).send(modeState());
  });

  // Audit log (chronological): mode changes, pause changes, auto
  // executions (with the policy snapshot + advisor output at the time)
  // and blocked auto evaluations.
  app.get('/api/treasury/audit', (_req: Request, res: Response) => {
    const entries: AuditEntry[] = store.audit.map((entry) => ({ ...entry }));
    res.status(200).send({ entries });
  });

  app.post('/api/treasury/batches/:id/approve', async (req: Request, res: Response) => {
    const id = routeId(req);
    const batch: Batch | undefined = store.getBatch(id);
    if (!batch) {
      res.status(404).send({ error: `Batch ${id} not found` });
      return;
    }
    if (batch.status === 'PENDING' || batch.status === 'SUCCESS') {
      res.status(409).send({ error: `Batch ${batch.id} was already executed` });
      return;
    }
    if (batch.status === 'FAILED') {
      res.status(409).send({ error: `Batch ${batch.id} failed; create a new batch` });
      return;
    }
    if (batch.status === 'APPROVED') {
      res.status(409).send({ error: `Batch ${batch.id} is already approved` });
      return;
    }

    // FX conversion for the cap check. If rates are unavailable and any
    // item is non-USD, the batch cannot be cap-checked: it stays
    // AWAITING_APPROVAL. Never price caps 1:1.
    let usdItems: PayoutItem[];
    try {
      ({ usdItems } = await toUsdItems(batch.items));
    } catch (err) {
      const reason = `FX rates unavailable: ${err instanceof Error ? err.message : String(err)}; non-USD items cannot be cap-checked`;
      batch.status = 'AWAITING_APPROVAL';
      batch.approvalBlockReasons = [reason];
      res.status(422).send({ batch, reasons: [reason] });
      return;
    }

    // Policy re-check at approve time (caps, allow-list, daily spend).
    const policyErrors = PayoutGuard.validateBatchPolicy({
      items: usdItems,
      approved: true,
      spentTodayUsd: store.spentTodayUsd,
      allowlist: store.allowlist,
    });
    if (policyErrors.length > 0) {
      batch.status = 'AWAITING_APPROVAL';
      batch.approvalBlockReasons = policyErrors;
      res.status(422).send({ batch, reasons: policyErrors });
      return;
    }

    // Manual approval: the same execution path Auto mode uses, with the
    // same policy re-check inside executeBatchPayout (defence in depth).
    // A manual Approve click still works in Auto mode.
    const outcome = await executeAuthorizedBatch(batch, usdItems, 'human');
    if (outcome.ok) {
      res.status(200).send(batch);
      return;
    }
    if (outcome.reasons) {
      res.status(422).send({ batch, reasons: outcome.reasons });
      return;
    }
    res.status(502).send({ batch, error: outcome.error ?? 'Unknown execution error' });
  });

  app.get('/api/treasury/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const onUpdate = (update: unknown): void => {
      res.write(`data: ${JSON.stringify(update)}\n\n`);
    };
    payoutEvents.on('payout_update', onUpdate);
    req.on('close', () => {
      payoutEvents.off('payout_update', onUpdate);
    });
  });

  // Production: serve the built frontend (frontend/dist) when it exists.
  // API routes above always win; anything else that is not /api/* falls
  // back to index.html (single-page app). When frontend/dist does not
  // exist the server stays API-only. No API route or approval logic
  // is changed by this.
  const frontendDist = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'frontend',
    'dist',
  );
  if (existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get(/^(?!\/api\/).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  return { app, store };
}

function main(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file is fine; credentials come from the environment.
  }
  const port = Number(process.env.PORT ?? 3000);
  const { app } = createApp();
  app.listen(port, () => {
    console.log(`BAO VE TIEN backend listening on http://localhost:${port} (sandbox only)`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
