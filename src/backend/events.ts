// Tiny in-process event bus for payout updates (webhook -> SSE stream).
// The webhook handler emits; the SSE route in server.ts subscribes.
import { EventEmitter } from 'node:events';

export interface PayoutUpdate {
  type: 'batch' | 'item';
  batchId: string;
  status: string;
  payoutItemId?: string;
  message?: string;
}

export const payoutEvents = new EventEmitter();
