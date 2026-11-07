// BAO VE TIEN backend slice (Nov 8 plan, started Nov 7).
// Express + native fetch only. Sandbox ONLY — no live PayPal URL anywhere.
// Human approval is mandatory: there is NO route that executes an
// unapproved batch. The advisor (POST /:id/advise) only recommends;
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
import { TreasuryStore, type Batch } from './backend/store.js';
import { PayoutGuard } from './guard/payoutGuard.js';
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

  app.post('/api/treasury/batches', (req: Request, res: Response) => {
    const parsed = parseCreateItems(req.body);
    if (typeof parsed === 'string') {
      res.status(400).send({ error: parsed });
      return;
    }
    const batch = store.createBatch(parsed);
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
    for (const item of batch.items) item.fxRiskScore = result.fxRiskScore;
    res.status(200).send({
      batchId: batch.id,
      recommendation: result.recommendation,
      fxRiskScore: result.fxRiskScore,
      reason: result.reason,
      model: result.model,
      source: result.source,
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

    const payoutPayload = {
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

    batch.approved = true;
    batch.status = 'APPROVED';
    try {
      // executeBatchPayout re-checks the policy itself (defence in depth).
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
      payoutEvents.emit('payout_update', {
        type: 'batch',
        batchId: batch.payoutBatchId,
        status: 'PENDING',
      });
      res.status(200).send(batch);
    } catch (err) {
      if (err instanceof HumanApprovalRequired) {
        // Cannot happen after the check above, but never execute anyway.
        batch.status = 'AWAITING_APPROVAL';
        batch.approved = false;
        batch.approvalBlockReasons = err.reasons;
        res.status(422).send({ batch, reasons: err.reasons });
        return;
      }
      // Execution failed: the batch is terminal (FAILED) so a retry
      // cannot double-pay. Create a new batch to try again.
      const message = err instanceof PayPalError ? err.message : 'Unknown execution error';
      batch.status = 'FAILED';
      batch.errorMessage = message;
      res.status(502).send({ batch, error: message });
    }
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
