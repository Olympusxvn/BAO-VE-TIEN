// In-memory treasury store — DEMO ONLY, no database in this slice.
// Batches, the recipient allow-list and today's spend live here and are
// lost on restart. A later slice persists them; the approval policy in
// PayoutGuard does not depend on where they are stored.
import { randomUUID } from 'node:crypto';
import type { PayoutItem } from '../models/PayoutItem.js';

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
  approved: boolean;
  approvalBlockReasons: string[];
  payoutBatchId?: string;
  errorMessage?: string;
  createdAt: string;
}

export class TreasuryStore {
  readonly batches = new Map<string, Batch>();
  /** Recipient allow-list (max 20, enforced by the guard). Empty by default; managed by the treasurer. */
  readonly allowlist: string[] = [];
  spentTodayUsd = 0;

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
