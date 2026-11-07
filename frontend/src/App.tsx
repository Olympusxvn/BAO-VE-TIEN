// BAO VE TIEN treasury dashboard. All data comes from the backend API;
// an empty ledger shows an empty state, never seeded fake batches.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  checkApproval,
  getFxRates,
  spentToday,
  type AdviseResult,
  type AdvisorConfig,
  type AdvisorProvider,
  type Batch,
  type FxRates,
  type ModeState,
  type PayoutCurrency,
  type TreasuryMode,
} from './api';
import { LedgerGrid, toGridRows } from './LedgerGrid';
import {
  AdvisorConfigPanel,
  AdvisorPanel,
  AllowlistManager,
  AutoConfirmDialog,
  CreateBatchForm,
  ModeBanner,
  SummaryCards,
} from './Panels';

type SseState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export default function App() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [rates, setRates] = useState<FxRates | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [advice, setAdvice] = useState<AdviseResult | null>(null);
  const [sseState, setSseState] = useState<SseState>('connecting');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [modeState, setModeState] = useState<ModeState | null>(null);
  const [showAutoConfirm, setShowAutoConfirm] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [advisorConfig, setAdvisorConfig] = useState<AdvisorConfig | null>(null);
  const errorTimer = useRef<number | null>(null);

  const showError = useCallback((message: string) => {
    setError(message);
    if (errorTimer.current) window.clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => setError(''), 15000);
  }, []);

  const refreshBatches = useCallback(async () => {
    const list = await api.listBatches();
    setBatches(list);
    return list;
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [list, { allowlist: list2 }, mode, advisorCfg] = await Promise.all([
        api.listBatches(),
        api.getAllowlist(),
        api.getMode(),
        api.getAdvisorConfig(),
      ]);
      setBatches(list);
      setAllowlist(list2);
      setModeState(mode);
      setAdvisorConfig(advisorCfg);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to load the ledger.');
    } finally {
      setLoading(false);
    }
    // FX rates are display-only: never block the ledger on them.
    void getFxRates().then(setRates);
  }, [showError]);

  useEffect(() => {
    void loadAll();
    return () => {
      if (errorTimer.current) window.clearTimeout(errorTimer.current);
    };
  }, [loadAll]);

  // Live updates: payout_update events from the backend refresh the ledger.
  useEffect(() => {
    const source = new EventSource('/api/treasury/events');
    source.onopen = () => setSseState('connected');
    source.onerror = () => {
      // EventSource reconnects automatically; report it honestly.
      setSseState((prev) => (prev === 'connected' ? 'reconnecting' : prev));
    };
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string };
        if (data.type === 'batch') {
          void refreshBatches().catch((err: unknown) =>
            showError(err instanceof Error ? err.message : 'Failed to refresh the ledger.'),
          );
        }
      } catch {
        // Ignore malformed SSE payloads; the next refresh fixes the view.
      }
    };
    return () => {
      source.close();
      setSseState('disconnected');
    };
  }, [refreshBatches, showError]);

  const spent = useMemo(() => spentToday(batches, rates), [batches, rates]);
  const approvalByBatch = useMemo(() => {
    const map = new Map<string, { canApprove: boolean; reasons: string[] }>();
    for (const batch of batches) {
      map.set(batch.id, checkApproval(batch, allowlist, spent ?? 0, rates));
    }
    return map;
  }, [batches, allowlist, rates, spent]);
  const rows = useMemo(() => toGridRows(batches, approvalByBatch), [batches, approvalByBatch]);
  const selected = batches.find((b) => b.id === selectedId) ?? batches[0] ?? null;

  const handleApprove = useCallback(
    async (batchId: string) => {
      setBusy(`approve-${batchId}`);
      try {
        const updated = await api.approve(batchId);
        setBatches((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
      } catch (err) {
        // The backend refusal is shown as-is — never a fake success.
        showError(err instanceof Error ? err.message : 'Approval failed.');
        try {
          await refreshBatches();
        } catch {
          // Keep the shown error; the ledger refresh is best-effort here.
        }
      } finally {
        setBusy(null);
      }
    },
    [refreshBatches, showError],
  );

  const handleAdvise = useCallback(
    async (batchId: string) => {
      setBusy(`advise-${batchId}`);
      try {
        const result = await api.advise(batchId);
        setAdvice(result);
        await refreshBatches();
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Advisor request failed.');
      } finally {
        setBusy(null);
      }
    },
    [refreshBatches, showError],
  );

  const handleCreate = useCallback(
    async (item: {
      recipientEmail: string;
      amount: number;
      currency: PayoutCurrency;
      recipientNote?: string;
    }) => {
      setBusy('create');
      try {
        const created = await api.createBatch([item]);
        setBatches((prev) => [...prev, created]);
        setSelectedId(created.id);
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Failed to create batch.');
      } finally {
        setBusy(null);
      }
    },
    [showError],
  );

  const handleAddAllowlist = useCallback(
    async (email: string) => {
      setBusy('allowlist-add');
      try {
        const { allowlist: next } = await api.addAllowlist(email);
        setAllowlist(next);
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Failed to add to allow-list.');
      } finally {
        setBusy(null);
      }
    },
    [showError],
  );

  const handleRemoveAllowlist = useCallback(
    async (email: string) => {
      setBusy('allowlist-remove');
      try {
        const { allowlist: next } = await api.removeAllowlist(email);
        setAllowlist(next);
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Failed to remove from allow-list.');
      } finally {
        setBusy(null);
      }
    },
    [showError],
  );

  /**
   * Mode toggle. Switching to AUTO always opens the confirm dialog —
   * there is no UI path to Auto mode that skips confirmation.
   * Switching back to HUMAN is immediate and always safe.
   */
  const handleModeToggle = useCallback(() => {
    if (!modeState) return;
    if (modeState.mode === 'HUMAN') {
      setShowAutoConfirm(true);
      return;
    }
    void (async () => {
      setModeBusy(true);
      try {
        setModeState(await api.setMode('HUMAN'));
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Failed to switch mode.');
      } finally {
        setModeBusy(false);
      }
    })();
  }, [modeState, showError]);

  const handleConfirmAuto = useCallback(async () => {
    setModeBusy(true);
    try {
      const next: ModeState = await api.setMode('AUTO');
      setModeState(next);
      setShowAutoConfirm(false);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to enable Auto mode.');
    } finally {
      setModeBusy(false);
    }
  }, [showError]);

  const handlePause = useCallback(
    async (paused: boolean) => {
      setModeBusy(true);
      try {
        setModeState(await api.setPaused(paused));
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Failed to change pause state.');
      } finally {
        setModeBusy(false);
      }
    },
    [showError],
  );

  // Judge BYOK: provider + key + model for this session only. An empty
  // key keeps the current key; an empty model keeps the current model.
  const handleSaveAdvisorConfig = useCallback(
    async (input: { provider: AdvisorProvider; apiKey: string; model: string }) => {
      setBusy('advisor-config');
      try {
        const next = await api.setAdvisorConfig({
          provider: input.provider,
          ...(input.apiKey ? { apiKey: input.apiKey } : {}),
          ...(input.model ? { model: input.model } : {}),
        });
        setAdvisorConfig(next);
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Failed to save advisor settings.');
      } finally {
        setBusy(null);
      }
    },
    [showError],
  );

  const handleClearAdvisorConfig = useCallback(async () => {
    setBusy('advisor-config');
    try {
      setAdvisorConfig(await api.clearAdvisorConfig());
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to clear advisor settings.');
    } finally {
      setBusy(null);
    }
  }, [showError]);

  const sseLabel: Record<SseState, string> = {
    connecting: 'Live updates: connecting…',
    connected: 'Live updates: connected',
    reconnecting: 'Live updates: reconnecting…',
    disconnected: 'Live updates: disconnected',
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">BVT</span>
          <div>
            <h1>BAO VE TIEN</h1>
            <p>Autonomous Global Treasury</p>
          </div>
        </div>
        <div className="topbar-right">
          <span className="pill pill-sandbox">PayPal Sandbox</span>
          {modeState && (
            <>
              <span
                className={`badge mode-badge ${modeState.mode === 'AUTO' ? 'mode-auto' : 'mode-human'}`}
                title={
                  modeState.mode === 'AUTO'
                    ? 'Auto mode: qualifying batches execute automatically'
                    : 'Human mode: every batch needs a human Approve click'
                }
              >
                {modeState.mode === 'AUTO' ? 'Auto mode' : 'Human mode'}
                {modeState.mode === 'AUTO' && modeState.paused ? ' — paused' : ''}
              </span>
              <button
                type="button"
                className="btn-secondary btn-mode"
                disabled={modeBusy}
                onClick={handleModeToggle}
                title={
                  modeState.mode === 'AUTO'
                    ? 'Switch back to Human mode'
                    : 'Switch to Auto mode (shows a confirmation first)'
                }
              >
                {modeState.mode === 'AUTO' ? 'Switch to Human' : 'Switch to Auto'}
              </button>
            </>
          )}
          <span
            className={`pill pill-sse sse-${sseState}`}
            title={sseLabel[sseState]}
            role="status"
          >
            <span className="dot" aria-hidden="true" />
            {sseLabel[sseState]}
          </span>
        </div>
      </header>

      <main>
        {modeState && (
          <ModeBanner
            modeState={modeState}
            onPause={() => void handlePause(true)}
            onResume={() => void handlePause(false)}
            pausing={modeBusy}
          />
        )}
        {error && (
          <div className="banner-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError('')} aria-label="Dismiss error">
              Dismiss
            </button>
          </div>
        )}

        {loading ? (
          <p className="muted">Loading the ledger…</p>
        ) : (
          <>
            <SummaryCards
              batches={batches}
              spentTodayUsd={spent}
              allowlistCount={allowlist.length}
              fxDate={rates?.date}
            />

            <section className="panel grid-panel" aria-label="Payout ledger">
              <div className="panel-head">
                <h2>Payout ledger</h2>
                <span className="muted">
                  {rows.length} item{rows.length === 1 ? '' : 's'} · {batches.length} batch
                  {batches.length === 1 ? '' : 'es'}
                </span>
              </div>
              <p className="muted">
                Click a row to inspect its batch in the advisor panel. Approval
                needs an EXECUTE_NOW recommendation, in-cap amounts and an
                allow-listed recipient — the backend re-checks every rule before
                any PayPal call.
              </p>
              <LedgerGrid
                rows={rows}
                onApprove={handleApprove}
                onSelectBatch={setSelectedId}
                approvingId={busy?.startsWith('approve-') ? busy.slice('approve-'.length) : null}
              />
            </section>

            <div className="two-col">
              <AdvisorPanel
                batch={selected}
                advice={advice}
                asking={busy?.startsWith('advise-') ?? false}
                onAskAdvisor={handleAdvise}
              />
              <CreateBatchForm busy={busy === 'create'} onCreate={handleCreate} />
            </div>

            <AdvisorConfigPanel
              config={advisorConfig}
              busy={busy === 'advisor-config'}
              onSave={handleSaveAdvisorConfig}
              onClear={handleClearAdvisorConfig}
            />

            <AllowlistManager
              allowlist={allowlist}
              busy={busy?.startsWith('allowlist-') ?? false}
              onAdd={handleAddAllowlist}
              onRemove={handleRemoveAllowlist}
            />
          </>
        )}
      </main>

      <footer>
        Sandbox only. No real money moves here.{' '}
        {modeState?.mode === 'AUTO'
          ? 'Auto mode is ON: qualifying batches execute automatically within the pre-approved policy — pause anytime.'
          : 'Human mode: the AI recommends, a human approves, PayPal executes.'}
      </footer>
      {showAutoConfirm && (
        <AutoConfirmDialog
          onConfirm={() => void handleConfirmAuto()}
          onCancel={() => setShowAutoConfirm(false)}
          confirming={modeBusy}
        />
      )}
    </div>
  );
}
