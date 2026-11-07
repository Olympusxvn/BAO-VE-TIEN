// In-memory treasury store — DEMO ONLY, no database in this slice.
// Batches, the recipient allow-list and today's spend live here and are
// lost on restart. A later slice persists them; the approval policy in
// PayoutGuard does not depend on where they are stored.
import { randomUUID } from 'node:crypto';
import type { AdvisorProvider, AdvisorRecommendation } from './advisor.js';
import type { PayoutItem } from '../models/PayoutItem.js';
import { RECIPIENT_ALLOWLIST_MAX } from '../guard/payoutGuard.js';

/**
 * Judge BYOK (bring your own key) runtime advisor config: partial
 * overrides over env. In-memory only — the key is never written to
 * disk, never logged, and never returned by any endpoint. All fields
 * are optional: an absent field falls back to env / defaults.
 */
export interface AdvisorRuntimeConfig {
  provider?: AdvisorProvider;
  apiKey?: string;
  model?: string;
}

export type BatchStatus =
  | 'DRAFT'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED';

export interface Batch {
  id: string;
  senderBatchId: string;
  items: PayoutItem[];
  status: BatchStatus;
  /** Authorized to execute: a human Approve click, or a passed auto gate. */
  approved: boolean;
  approvalBlockReasons: string[];
  payoutBatchId?: string;
  errorMessage?: string;
  createdAt: string;
  /** Latest advisor result (set by POST /:id/advise; never executes). */
  fxRiskScore?: number;
  recommendation?: AdvisorRecommendation;
  advisorReason?: string;
  modelUsed?: string;
  advisorSource?: 'llm' | 'rule';
  /** True when the batch was executed automatically in Auto mode. */
  autoExecuted?: boolean;
  /** Reasons the auto gate blocked this batch (Auto mode only). */
  autoBlockReasons?: string[];
}

/** Treasury approval mode. HUMAN (default): every batch needs a human
 * Approve click. AUTO (opt-in): a batch that passes the policy, the
 * tighter auto caps, an EXECUTE_NOW recommendation and a low FX risk
 * score executes automatically — supervised autonomy, not unsupervised. */
export type TreasuryMode = 'HUMAN' | 'AUTO';

export type AuditKind =
  | 'mode-change'
  | 'pause-change'
  | 'auto-execution'
  | 'auto-blocked';

export interface AuditEntry {
  id: string;
  at: string;
  kind: AuditKind;
  detail: Record<string, unknown>;
}

export class TreasuryStore {
  readonly batches = new Map<string, Batch>();
  /** Recipient allow-list (max 20, enforced by the guard). Empty by default; managed by the treasurer. */
  readonly allowlist: string[] = [];
  spentTodayUsd = 0;
  /** USD spent by Auto-mode executions today (separate auto budget). */
  autoSpentTodayUsd = 0;
  /** Approval mode (default HUMAN) and the Auto pause / kill switch. */
  mode: TreasuryMode = 'HUMAN';
  paused = false;
  /** In-memory audit log (chronological). Demo only, lost on restart. */
  readonly audit: AuditEntry[] = [];

  /** BYOK runtime advisor config (judge's key/model), in-memory only.
   * Null means "use env config". Lost on restart, by design. */
  advisorRuntime: AdvisorRuntimeConfig | null = null;

  /** Merges a BYOK patch over the current runtime config. An empty
   * apiKey or model removes that override (falls back to env). */
  setAdvisorRuntime(patch: AdvisorRuntimeConfig): void {
    const merged: AdvisorRuntimeConfig = { ...(this.advisorRuntime ?? {}) };
    if (patch.provider !== undefined) merged.provider = patch.provider;
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === '') delete merged.apiKey;
      else merged.apiKey = patch.apiKey;
    }
    if (patch.model !== undefined) {
      if (patch.model === '') delete merged.model;
      else merged.model = patch.model;
    }
    this.advisorRuntime = merged;
  }

  /** Clears the BYOK config entirely — the advisor falls back to env. */
  clearAdvisorRuntime(): void {
    this.advisorRuntime = null;
  }

  logAudit(kind: AuditKind, detail: Record<string, unknown>): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      kind,
      detail,
    };
    this.audit.push(entry);
    return entry;
  }

  /** Changes the mode and logs it. Returns false when unchanged. */
  setMode(mode: TreasuryMode): boolean {
    if (mode === this.mode) return false;
    const from = this.mode;
    this.mode = mode;
    this.logAudit('mode-change', { from, to: mode });
    return true;
  }

  /** Pauses / resumes Auto mode and logs it. Returns false when unchanged. */
  setPaused(paused: boolean): boolean {
    if (paused === this.paused) return false;
    this.paused = paused;
    this.logAudit('pause-change', { paused, mode: this.mode });
    return true;
  }

  createBatch(items: PayoutItem[]): Batch {
    const batch: Batch = {
      id: randomUUID(),
      senderBatchId: `BAO_VE_TIEN_BATCH_${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`,
      items,
      status: 'DRAFT',
      approved: false,
      approvalBlockReasons: [],
      createdAt: new Date().toISOString(),
    };
    this.batches.set(batch.id, batch);
    return batch;
  }

  getBatch(id: string): Batch | undefined {
    return this.batches.get(id);
  }

  listBatches(): Batch[] {
    return [...this.batches.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : 1,
    );
  }

  /** Demo-only allow-list management (no auth in this slice). Returns
   * 'added', 'duplicate', or 'full' (max 20 entries). */
  addAllowlist(email: string): 'added' | 'duplicate' | 'full' {
    if (this.allowlist.includes(email)) return 'duplicate';
    if (this.allowlist.length >= RECIPIENT_ALLOWLIST_MAX) return 'full';
    this.allowlist.push(email);
    return 'added';
  }

  removeAllowlist(email: string): boolean {
    const idx = this.allowlist.indexOf(email);
    if (idx === -1) return false;
    this.allowlist.splice(idx, 1);
    return true;
  }

  findBatchByPayoutId(payoutBatchId: string): Batch | undefined {
    return this.listBatches().find((b) => b.payoutBatchId === payoutBatchId);
  }

  findItemBySenderId(senderItemId: string): { batch: Batch; item: PayoutItem } | undefined {
    for (const batch of this.batches.values()) {
      const item = batch.items.find((i) => i.senderItemId === senderItemId);
      if (item) return { batch, item };
    }
    return undefined;
  }
}
