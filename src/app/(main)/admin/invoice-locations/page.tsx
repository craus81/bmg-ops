'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';

const ENDPOINT = '/api/netsuite/backfill-invoice-locations';

interface Change {
  invoiceId: string;
  invoiceNumber: string | null;
  customer: string | null;
  fromLocationId: string | null;
  toLocationId: string;
  toLocation: string;
}
interface Plan {
  summary: {
    fleetSuiteInvoices: number;
    alreadyCorrect: number;
    indeterminateKept: number;
    toChange: number;
    byTargetLocation: Record<string, number>;
  };
  changes: Change[];
  closedPeriodInvoices?: string[];
}

/**
 * Read the backfill endpoint safely: it can return a non-JSON body on a
 * gateway timeout, so we parse defensively and surface the HTTP status rather
 * than throwing an opaque JSON error.
 */
async function callBackfill(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (e.g. a timeout page) */ }
  if (!res.ok || !json) {
    throw new Error(json?.error || `HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
  }
  return json;
}

const CHUNK = 10;

export default function InvoiceLocationsPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const dialog = useDialog();

  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; applied: number; failed: number } | null>(null);
  const [result, setResult] = useState<{ applied: number; failed: number; closed: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin === false) router.push('/home');
  }, [isAdmin, router]);

  async function runPreview() {
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      setPlan(await callBackfill({}));
    } catch (e: any) {
      setError(e?.message || 'Preview failed');
    } finally {
      setLoading(false);
    }
  }

  async function apply() {
    if (!plan || plan.changes.length === 0) return;
    const ids = plan.changes.map((c) => c.invoiceId);
    const ok = await dialog.confirm(
      `Apply ${ids.length} location change${ids.length !== 1 ? 's' : ''} to NetSuite? Invoices already on the right location, or in a closed period, are skipped automatically.`,
      { confirmLabel: 'Apply changes' },
    );
    if (!ok) return;

    setApplying(true);
    setError(null);
    setResult(null);
    let applied = 0;
    let failed = 0;
    const closed: string[] = [];
    setProgress({ done: 0, total: ids.length, applied, failed });
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const r = await callBackfill({ dryRun: false, invoiceIds: ids.slice(i, i + CHUNK) });
        applied += r.summary?.applied || 0;
        failed += r.summary?.failed || 0;
        if (Array.isArray(r.closedPeriodInvoices)) closed.push(...r.closedPeriodInvoices);
        setProgress({ done: Math.min(i + CHUNK, ids.length), total: ids.length, applied, failed });
      }
      setResult({ applied, failed, closed });
      // Refresh the preview so the table reflects the new NetSuite state.
      setPlan(await callBackfill({}));
    } catch (e: any) {
      setError(`Stopped after applying ${applied}: ${e?.message || 'apply failed'}`);
    } finally {
      setApplying(false);
      setProgress(null);
    }
  }

  const card: CSSProperties = {
    background: theme.card,
    border: `1px solid ${theme.border}`,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  };
  const btn: CSSProperties = {
    background: theme.orange,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '10px 18px',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
  };

  const busy = loading || applying;

  return (
    <div style={{ maxWidth: 920, margin: '0 auto', padding: 16, color: theme.textPrimary }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Invoice Locations</h1>
      <p style={{ color: theme.textSecondary, fontSize: 14, marginBottom: 16 }}>
        Set the NetSuite Location on existing FleetSuite invoices to match the PO rules
        (Masterack → its plant, Designs That Stick → Kansas City, everything else → O&apos;Fallon).
        Preview is read-only; nothing changes until you click Apply.
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <button onClick={runPreview} disabled={busy} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
          {loading ? 'Previewing…' : 'Preview changes'}
        </button>
        {plan && plan.changes.length > 0 && (
          <button
            onClick={apply}
            disabled={busy}
            style={{ ...btn, background: theme.success, opacity: busy ? 0.6 : 1 }}
          >
            {applying ? 'Applying…' : `Apply ${plan.changes.length} change${plan.changes.length !== 1 ? 's' : ''}`}
          </button>
        )}
      </div>

      {error && (
        <div style={{ ...card, background: theme.errorBg, borderColor: theme.errorBorder, color: theme.error }}>
          {error}
        </div>
      )}

      {progress && (
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            Applying… {progress.done}/{progress.total} (applied {progress.applied}, failed {progress.failed})
          </div>
          <div style={{ height: 8, background: theme.progressTrack, borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(progress.done / progress.total) * 100}%`, background: theme.orange }} />
          </div>
        </div>
      )}

      {result && (
        <div style={{ ...card, background: theme.successBg, borderColor: theme.successBorder }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Done</div>
          <div style={{ fontSize: 14 }}>
            Applied <strong>{result.applied}</strong>, failed <strong>{result.failed}</strong>
            {result.closed.length > 0 && (
              <>
                {' '}— skipped (closed period): {result.closed.join(', ')}
              </>
            )}
          </div>
        </div>
      )}

      {plan && (
        <>
          <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 20 }}>
            <Stat label="FleetSuite invoices" value={plan.summary.fleetSuiteInvoices} />
            <Stat label="Already correct" value={plan.summary.alreadyCorrect} />
            <Stat label="To change" value={plan.summary.toChange} highlight />
            <Stat label="Indeterminate (kept)" value={plan.summary.indeterminateKept} />
            {Object.entries(plan.summary.byTargetLocation || {}).map(([loc, n]) => (
              <Stat key={loc} label={`→ ${loc}`} value={n} />
            ))}
          </div>

          {plan.changes.length === 0 ? (
            <div style={card}>Every FleetSuite invoice is already on the right location. Nothing to change. 🎉</div>
          ) : (
            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: theme.subtleBg, textAlign: 'left' }}>
                    <th style={th}>Invoice</th>
                    <th style={th}>Customer</th>
                    <th style={th}>From (id)</th>
                    <th style={th}>To</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.changes.map((c) => (
                    <tr key={c.invoiceId} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={td}>{c.invoiceNumber || c.invoiceId}</td>
                      <td style={td}>{c.customer || '—'}</td>
                      <td style={{ ...td, color: theme.textMuted }}>{c.fromLocationId ?? '—'}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{c.toLocation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, color: highlight ? theme.orange : theme.textPrimary }}>{value}</div>
      <div style={{ fontSize: 12, color: theme.textSecondary }}>{label}</div>
    </div>
  );
}

const th: CSSProperties = { padding: '10px 12px', fontWeight: 600, fontSize: 12, color: theme.textSecondary };
const td: CSSProperties = { padding: '8px 12px' };
