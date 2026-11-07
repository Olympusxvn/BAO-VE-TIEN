// Dashboard panels: summary cards, advisor, allow-list, create-batch form.
// Every number shown here is derived from the API — nothing is seeded.
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ALLOWLIST_MAX,
  AUTO_DAILY_CAP_USD,
  AUTO_FX_RISK_MAX,
  AUTO_PER_BATCH_CAP_USD,
  AUTO_PER_ITEM_CAP_USD,
  DAILY_CAP_USD,
  PAYOUT_CURRENCIES,
  type AdviseResult,
  type Batch,
  type ModeState,
  type PayoutCurrency,
} from './api';
import { AUTO_BANNER, AUTO_ENABLE_WARNING, AUTO_EXECUTED_NOTICE, AUTO_PAUSED_BANNER } from './modeStrings';

export function SummaryCards({
  batches,
  spentTodayUsd,
  allowlistCount,
  fxDate,
}: {
  batches: Batch[];
  spentTodayUsd: number | null;
  allowlistCount: number;
  fxDate?: string;
}) {
  const awaiting = batches.filter(
    (b) => b.status === 'DRAFT' || b.status === 'AWAITING_APPROVAL',
  ).length;
  const executed = batches.filter((b) => b.status === 'PENDING' || b.status === 'SUCCESS').length;
  const failed = batches.filter((b) => b.status === 'FAILED').length;
  const spent = spentTodayUsd ?? 0;
  const pct = Math.min(100, (spent / DAILY_CAP_USD) * 100);

  return (
    <section className="cards" aria-label="Treasury summary">
      <div className="card">
        <div className="card-label">Awaiting approval</div>
        <div className="card-value">{awaiting}</div>
        <div className="card-sub">
          {batches.length} batch{batches.length === 1 ? '' : 'es'} in the ledger
        </div>
      </div>
      <div className="card">
        <div className="card-label">Executed today</div>
        <div className="card-value">{executed}</div>
        <div className="card-sub">{failed} failed</div>
      </div>
      <div className="card">
        <div className="card-label">Spent today vs ${DAILY_CAP_USD.toLocaleString()} daily cap</div>
        <div className="card-value">
          $
          {spent.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </div>
        <div className="cap-bar" aria-label={`Spent ${pct.toFixed(0)} percent of the daily cap`}>
          <div className="cap-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="card-sub">
          {spentTodayUsd === null
            ? 'FX rates unavailable — USD total cannot be priced'
            : `${pct.toFixed(0)}% of the daily cap used`}
        </div>
      </div>
      <div className="card">
        <div className="card-label">Allow-list</div>
        <div className="card-value">
          {allowlistCount} <span className="card-unit">/ {ALLOWLIST_MAX}</span>
        </div>
        <div className="card-sub">
          {fxDate ? `FX rates (ECB) ${fxDate}` : 'FX rates unavailable'}
        </div>
      </div>
    </section>
  );
}

function recommendationClass(rec?: string): string {
  if (rec === 'EXECUTE_NOW') return 'rec-execute';
  if (rec === 'SPLIT_BATCH') return 'rec-split';
  return 'rec-hold';
}

export function AdvisorPanel({
  batch,
  advice,
  asking,
  onAskAdvisor,
}: {
  batch: Batch | null;
  advice: AdviseResult | null;
  asking: boolean;
  onAskAdvisor: (batchId: string) => void;
}) {
  if (!batch) {
    return (
      <section className="panel" aria-label="Advisor">
        <h2>Advisor</h2>
        <p className="muted">Select a batch in the ledger to see its advisor recommendation.</p>
      </section>
    );
  }
  const total = batch.items.reduce((s, i) => s + i.amount, 0);
  const currencies = [...new Set(batch.items.map((i) => i.currency))].join(', ');
  return (
    <section className="panel" aria-label="Advisor">
      <h2>Advisor</h2>
      <dl className="facts">
        <div>
          <dt>Batch</dt>
          <dd className="mono">{batch.senderBatchId}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`badge status-${batch.status.toLowerCase()}`}>{batch.status}</span>
          </dd>
        </div>
        <div>
          <dt>Items</dt>
          <dd>
            {batch.items.length} · {currencies} · total {total.toFixed(2)}
          </dd>
        </div>
        <div>
          <dt>Recommendation</dt>
          <dd>
            {batch.recommendation ? (
              <span className={`badge ${recommendationClass(batch.recommendation)}`}>
                {batch.recommendation}
              </span>
            ) : (
              <span className="muted">Not assessed yet</span>
            )}
          </dd>
        </div>
        <div>
          <dt>FX risk score</dt>
          <dd>
            {typeof batch.fxRiskScore === 'number' ? batch.fxRiskScore.toFixed(1) : '—'}
            <span className="muted"> / 10</span>
          </dd>
        </div>
        <div>
          <dt>Reason</dt>
          <dd>{batch.advisorReason ?? '—'}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>
            {batch.modelUsed ?? '—'}
            {advice && advice.batchId === batch.id
              ? ` (${advice.source === 'llm' ? 'AI assessment' : 'rule-based fallback'})`
              : ''}
          </dd>
        </div>
        {batch.autoExecuted && (
          <div>
            <dt>Execution</dt>
            <dd className="auto-notice">{AUTO_EXECUTED_NOTICE}</dd>
          </div>
        )}
        {batch.autoBlockReasons && batch.autoBlockReasons.length > 0 && (
          <div>
            <dt>Auto mode</dt>
            <dd className="error-text">Auto-execution blocked: {batch.autoBlockReasons.join('; ')}</dd>
          </div>
        )}
        {batch.payoutBatchId && (
          <div>
            <dt>PayPal batch</dt>
            <dd className="mono">{batch.payoutBatchId}</dd>
          </div>
        )}
        {batch.errorMessage && (
          <div>
            <dt>Error</dt>
            <dd className="error-text">{batch.errorMessage}</dd>
          </div>
        )}
      </dl>
      <button
        type="button"
        className="btn-primary"
        disabled={asking || batch.status === 'PENDING' || batch.status === 'SUCCESS' || batch.status === 'FAILED'}
        onClick={() => onAskAdvisor(batch.id)}
      >
        {asking ? 'Asking advisor…' : 'Ask advisor'}
      </button>
    </section>
  );
}

/** Always-on banner while Auto mode is on (or paused). Never hidden. */
export function ModeBanner({
  modeState,
  onPause,
  onResume,
  pausing,
}: {
  modeState: ModeState;
  onPause: () => void;
  onResume: () => void;
  pausing: boolean;
}) {
  if (modeState.mode !== 'AUTO') return null;
  return (
    <div className="banner-auto" role="status">
      <span>{modeState.paused ? AUTO_PAUSED_BANNER : AUTO_BANNER}</span>
      {modeState.paused ? (
        <button type="button" className="btn-warning" disabled={pausing} onClick={onResume}>
          {pausing ? 'Resuming…' : 'Resume Auto'}
        </button>
      ) : (
        <button type="button" className="btn-warning" disabled={pausing} onClick={onPause}>
          {pausing ? 'Pausing…' : 'Pause Auto'}
        </button>
      )}
    </div>
  );
}

/**
 * Confirm dialog shown before Auto mode can be enabled. There is no
 * path from the UI to Auto mode that skips this confirmation.
 */
export function AutoConfirmDialog({
  onConfirm,
  onCancel,
  confirming,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  confirming: boolean;
}) {
  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="auto-confirm-title">
      <div className="dialog">
        <h2 id="auto-confirm-title">Enable Auto mode?</h2>
        <p>{AUTO_ENABLE_WARNING}</p>
        <p className="muted">
          Auto caps: item ≤ ${AUTO_PER_ITEM_CAP_USD} · batch ≤ ${AUTO_PER_BATCH_CAP_USD} · daily
          ≤ ${AUTO_DAILY_CAP_USD} · FX risk score &lt; {AUTO_FX_RISK_MAX}. A batch that fails any
          check stays awaiting approval.
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn-warning" disabled={confirming} onClick={onConfirm}>
            {confirming ? 'Enabling…' : 'Enable Auto mode'}
          </button>
          <button type="button" className="btn-secondary" disabled={confirming} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function AllowlistManager({
  allowlist,
  busy,
  onAdd,
  onRemove,
}: {
  allowlist: string[];
  busy: boolean;
  onAdd: (email: string) => void;
  onRemove: (email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [localError, setLocalError] = useState('');
  const full = allowlist.length >= ALLOWLIST_MAX;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setLocalError('Enter a valid email address.');
      return;
    }
    setLocalError('');
    onAdd(value);
    setEmail('');
  };

  return (
    <section className="panel" aria-label="Allow-list">
      <h2>
        Allow-list <span className="muted">({allowlist.length} / {ALLOWLIST_MAX})</span>
      </h2>
      <p className="muted">
        Only allow-listed recipients can be approved for payout. A batch with any
        off-list recipient stays awaiting approval.
      </p>
      <form onSubmit={submit} className="inline-form">
        <label>
          <span className="sr-only">Recipient email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="vendor@example.com"
            disabled={busy || full}
          />
        </label>
        <button type="submit" className="btn-primary" disabled={busy || full}>
          Add
        </button>
      </form>
      {localError && <p className="error-text">{localError}</p>}
      {full && <p className="muted">Allow-list is full (max {ALLOWLIST_MAX} entries).</p>}
      {allowlist.length === 0 ? (
        <p className="muted">No recipients yet. Add one to approve a batch.</p>
      ) : (
        <ul className="allowlist">
          {allowlist.map((entry) => (
            <li key={entry}>
              <span className="mono">{entry}</span>
              <button
                type="button"
                className="btn-ghost"
                disabled={busy}
                onClick={() => onRemove(entry)}
                aria-label={`Remove ${entry} from allow-list`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CreateBatchForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (item: {
    recipientEmail: string;
    amount: number;
    currency: PayoutCurrency;
    recipientNote?: string;
  }) => void;
}) {
  const [email, setEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<string>('USD');
  const [note, setNote] = useState('');
  const [localError, setLocalError] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setLocalError('Enter a valid recipient email address.');
      return;
    }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setLocalError('Amount must be a number greater than 0.');
      return;
    }
    if (currency === 'VND') {
      setLocalError(
        'VND is not a PayPal Payouts currency. Convert the invoice to USD first — VND is never sent as a payout currency.',
      );
      return;
    }
    if (!PAYOUT_CURRENCIES.includes(currency as PayoutCurrency)) {
      setLocalError('Currency must be USD, EUR, GBP or SGD.');
      return;
    }
    setLocalError('');
    onCreate({
      recipientEmail: value,
      amount: parsed,
      currency: currency as PayoutCurrency,
      recipientNote: note.trim() || undefined,
    });
    setEmail('');
    setAmount('');
    setNote('');
  };

  return (
    <section className="panel" aria-label="Create batch">
      <h2>Create batch</h2>
      <p className="muted">
        One payout item per batch in this demo. The batch starts as DRAFT — ask
        the advisor, add the recipient to the allow-list, then approve.
      </p>
      <form onSubmit={submit} className="stack-form">
        <label>
          Recipient email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="vendor@example.com"
            disabled={busy}
          />
        </label>
        <div className="form-row">
          <label>
            Amount
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="100.00"
              disabled={busy}
            />
          </label>
          <label>
            Currency
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={busy}>
              {PAYOUT_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="VND">VND — not supported</option>
            </select>
          </label>
        </div>
        {currency === 'VND' && (
          <p className="error-text">
            VND is not a PayPal Payouts currency. Convert the invoice to USD
            first — VND is never sent as a payout currency.
          </p>
        )}
        <label>
          Recipient note <span className="muted">(optional)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Invoice #INV-2026-0001"
            disabled={busy}
          />
        </label>
        {localError && <p className="error-text">{localError}</p>}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create batch'}
        </button>
      </form>
    </section>
  );
}
