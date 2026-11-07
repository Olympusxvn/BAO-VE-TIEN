// AG Grid Community (MIT), v36.x — SPEC §5. No licence key, no
// Enterprise modules. AgGridProvider + AllCommunityModule + themeQuartz
// via the Theming API, no CSS imports. Theme accent is PayPal blue.
import { AgGridProvider, AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, themeQuartz } from 'ag-grid-community';
import type { ColDef } from 'ag-grid-community';
import type { Batch, PayoutItem } from './api';

const modules = [AllCommunityModule];

// PayPal palette: accent #0070E0, navy text #001435, light gray header.
const theme = themeQuartz.withParams({
  accentColor: '#0070E0',
  backgroundColor: '#ffffff',
  foregroundColor: '#001435',
  headerBackgroundColor: '#F5F7FA',
  headerTextColor: '#003087',
  borderColor: '#DDE3EA',
  rowHoverColor: '#F0F6FF',
});

export interface GridRow extends PayoutItem {
  batchId: string;
  batchStatus: string;
  payoutBatchId?: string;
  canApprove: boolean;
  approvalBlockReason: string;
}

function fxRiskStyle(score: number): { color: string; fontWeight: string } {
  if (score < 3) return { color: '#0B7A45', fontWeight: '700' };
  if (score < 7) return { color: '#B25E00', fontWeight: '600' };
  return { color: '#C81E1E', fontWeight: '700' };
}

export function LedgerGrid({
  rows,
  onApprove,
  onSelectBatch,
  approvingId,
}: {
  rows: GridRow[];
  onApprove: (batchId: string) => void;
  onSelectBatch: (batchId: string) => void;
  approvingId: string | null;
}) {
  const columnDefs: ColDef<GridRow>[] = [
    { field: 'senderItemId', headerName: 'Item Ref', checkboxSelection: true, flex: 1 },
    { field: 'recipientEmail', headerName: 'Vendor Email', filter: true, flex: 1.3 },
    {
      field: 'amount',
      headerName: 'Amount',
      valueFormatter: (params) =>
        params.data ? `${params.data.currency} ${params.value.toFixed(2)}` : '',
      flex: 0.8,
    },
    { field: 'currency', headerName: 'Currency', filter: true, flex: 0.75 },
    {
      field: 'fxRiskScore',
      headerName: 'FX Risk Index',
      cellStyle: (params) =>
        typeof params.value === 'number' ? fxRiskStyle(params.value) : undefined,
      valueFormatter: (params) =>
        typeof params.value === 'number' ? params.value.toFixed(1) : '—',
      flex: 0.85,
    },
    {
      field: 'status',
      headerName: 'Status',
      cellRenderer: (params: { value?: string }) => {
        const value = params.value ?? '';
        return <span className={`badge status-${value.toLowerCase()}`}>{value}</span>;
      },
      flex: 0.9,
    },
    {
      headerName: 'Approval',
      cellRenderer: (params: { data?: GridRow }) => {
        const row = params.data;
        if (!row) return null;
        const disabled = !row.canApprove || approvingId === row.batchId;
        const title = row.canApprove
          ? 'Approve & Execute'
          : row.approvalBlockReason || 'Cannot approve this batch';
        return (
          <button
            type="button"
            className="btn-approve"
            disabled={disabled}
            title={title}
            onClick={() => onApprove(row.batchId)}
          >
            {approvingId === row.batchId ? 'Approving…' : 'Approve & Execute'}
          </button>
        );
      },
      flex: 1.1,
    },
  ];

  return (
    <AgGridProvider modules={modules}>
      <div style={{ height: '480px', width: '100%' }}>
        <AgGridReact<GridRow>
          theme={theme}
          rowData={rows}
          columnDefs={columnDefs}
          rowSelection="multiple"
          animateRows
          onRowClicked={(event) => {
            if (event.data) onSelectBatch(event.data.batchId);
          }}
          overlayNoRowsTemplate="No batches yet. Create your first batch below."
        />
      </div>
    </AgGridProvider>
  );
}

// Flatten batches into grid rows, attaching the per-batch approval check.
export function toGridRows(
  batches: Batch[],
  approvalByBatch: Map<string, { canApprove: boolean; reasons: string[] }>,
): GridRow[] {
  const rows: GridRow[] = [];
  for (const batch of batches) {
    const check = approvalByBatch.get(batch.id) ?? { canApprove: false, reasons: [] };
    for (const item of batch.items) {
      rows.push({
        ...item,
        batchId: batch.id,
        batchStatus: batch.status,
        payoutBatchId: batch.payoutBatchId,
        canApprove: check.canApprove,
        approvalBlockReason: check.reasons.join('; '),
      });
    }
  }
  return rows;
}
