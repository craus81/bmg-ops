'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';

const ENDPOINT = '/api/netsuite/backfill-invoice-locations';
// NetSuite invoice PATCHes are slow (several seconds each) and the function has
// a 60s ceiling, so apply only a few per request; a failed chunk is reported,
// not fatal (re-applying is a no-op for invoices already on the chosen location).
const CHUNK = 4;
// Persist unapplied picks here so closing the tab / navigating away doesn't
// lose the work — they're restored on the next load.
const STORAGE_KEY = 'invoiceLocationPendingPicks';

interface Loc { id: string; name: string }
interface InvoiceRow {
  invoiceId: string;
  invoiceNumber: string | null;
  customer: string | null;
  memo: string | null;
  currentLocationId: string | null;
  currentLocationName: string | null;
  suggestedLocationId: string;
  suggestedLocation: string;
  confident: boolean;
}
interface ListResponse {
  locations: Loc[];
  invoices: InvoiceRow[];
  summary: { fleetSuiteInvoices: number; alreadyCorrect: number; indeterminateKept: number; toChange: number };
}

/** Read the endpoint safely — a gateway timeout returns non-JSON. */
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

type Filter = 'all' | 'pending' | 'indeterminate' | 'correct';

export default function InvoiceLocationsPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const dialog = useDialog();

  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<ListResponse['summary'] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ applied: number; failed: number; closed: string[]; errors: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null);
  const [restoredCount, setRestoredCount] = useState(0);

  useEffect(() => {
    if (isAdmin === false) router.push('/home');
  }, [isAdmin, router]);

  // Persist the user's unapplied picks (those that differ from the invoice's
  // current location) so the work survives a tab close / navigation. Skipped
  // until invoices are loaded so an empty initial state can't clobber storage.
  useEffect(() => {
    if (invoices.length === 0) return;
    const map: Record<string, string> = {};
    for (const inv of invoices) {
      const pick = picks[inv.invoiceId];
      if (pick && pick !== inv.currentLocationId) map[inv.invoiceId] = pick;
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* storage unavailable */ }
  }, [picks, invoices]);

  // Default each invoice's pick: the rule's suggestion when it's confident,
  // otherwise leave it on its current location (indeterminate stays put).
  function defaultPick(inv: InvoiceRow): string {
    return inv.confident ? inv.suggestedLocationId : inv.currentLocationId || inv.suggestedLocationId;
  }

  async function load() {
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const data: ListResponse = await callBackfill({});
      setLocations(data.locations || []);
      setInvoices(data.invoices || []);
      setSummary(data.summary || null);
      // Start from the rule's defaults, then overlay any unapplied picks saved
      // from a previous visit (so navigating away never loses the work).
      const p: Record<string, string> = {};
      for (const inv of data.invoices || []) p[inv.invoiceId] = defaultPick(inv);
      let restored = 0;
      try {
        const saved: Record<string, string> = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        for (const inv of data.invoices || []) {
          const s = saved[inv.invoiceId];
          if (s) {
            p[inv.invoiceId] = s;
            if (s !== inv.currentLocationId) restored++;
          }
        }
      } catch { /* storage unavailable / bad JSON */ }
      setPicks(p);
      setRestoredCount(restored);
    } catch (e: any) {
      setError(e?.message || 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }

  // Open the invoice's PDF (pulled from NetSuite via the RESTlet, same as the
  // rest of the app) in a new tab — no NetSuite login. The blank tab is opened
  // synchronously inside the click so popup blockers don't eat it.
  async function openInvoicePdf(inv: InvoiceRow) {
    const win = window.open('', '_blank');
    if (win) win.document.write('Loading invoice PDF…');
    setPdfLoadingId(inv.invoiceId);
    setError(null);
    try {
      const res = await fetch(`/api/netsuite/pdf?type=invoice&id=${encodeURIComponent(inv.invoiceId)}`);
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch { /* non-JSON */ }
      if (!res.ok || !data?.success || !data.pdfBase64) {
        throw new Error(data?.error || `Couldn't load PDF (HTTP ${res.status})`);
      }
      const raw = atob(data.pdfBase64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      if (win) win.location.href = url;
      else window.open(url, '_blank');
    } catch (e: any) {
      if (win) win.close();
      setError(`${inv.invoiceNumber || inv.invoiceId}: ${e?.message || 'PDF failed'}`);
    } finally {
      setPdfLoadingId(null);
    }
  }

  const pending = useMemo(
    () => invoices.filter((inv) => picks[inv.invoiceId] && picks[inv.invoiceId] !== inv.currentLocationId),
    [invoices, picks],
  );

  function statusOf(inv: InvoiceRow): Filter {
    if (picks[inv.invoiceId] && picks[inv.invoiceId] !== inv.currentLocationId) return 'pending';
    if (!inv.confident) return 'indeterminate';
    return 'correct';
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return invoices.filter((inv) => {
      if (filter !== 'all' && statusOf(inv) !== filter) return false;
      if (q && !(`${inv.invoiceNumber || ''} ${inv.customer || ''} ${inv.memo || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices, picks, filter, search]);

  async function apply() {
    if (pending.length === 0) return;
    const ok = await dialog.confirm(
      `Apply ${pending.length} location change${pending.length !== 1 ? 's' : ''} to NetSuite? Invoices in a closed period will be reported and skipped.`,
      { confirmLabel: 'Apply changes' },
    );
    if (!ok) return;

    const assignments = pending.map((inv) => ({ invoiceId: inv.invoiceId, locationId: picks[inv.invoiceId] }));
    setApplying(true);
    setError(null);
    setResult(null);
    let applied = 0;
    let failed = 0;
    const closed: string[] = [];
    const errors: string[] = [];
    setProgress({ done: 0, total: assignments.length });
    for (let i = 0; i < assignments.length; i += CHUNK) {
      try {
        const r = await callBackfill({ dryRun: false, assignments: assignments.slice(i, i + CHUNK) });
        applied += r.summary?.applied || 0;
        failed += r.summary?.failed || 0;
        if (Array.isArray(r.closedPeriodInvoices)) closed.push(...r.closedPeriodInvoices);
      } catch (e: any) {
        errors.push(e?.message || 'chunk failed');
      }
      setProgress({ done: Math.min(i + CHUNK, assignments.length), total: assignments.length });
    }
    setResult({ applied, failed, closed, errors });
    setApplying(false);
    setProgress(null);
    await load(); // refresh current locations from NetSuite
  }

  const card: CSSProperties = { background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 16, marginBottom: 16 };
  const btn: CSSProperties = { background: theme.orange, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
  const busy = loading || applying;

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: 16, color: theme.textPrimary }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Invoice Locations</h1>
      <p style={{ color: theme.textSecondary, fontSize: 14, marginBottom: 16 }}>
        Every FleetSuite invoice with its current NetSuite location. The dropdown is pre-filled with the
        rule&apos;s suggestion (Masterack → plant, Designs That Stick → Kansas City, others → O&apos;Fallon);
        adjust any of them, then apply. Indeterminate invoices are left on their current location for you to set.
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={load} disabled={busy} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
          {loading ? 'Loading…' : invoices.length ? 'Reload' : 'Load invoices'}
        </button>
        {invoices.length > 0 && (
          <button onClick={apply} disabled={busy || pending.length === 0} style={{ ...btn, background: theme.success, opacity: busy || pending.length === 0 ? 0.5 : 1 }}>
            {applying ? 'Applying…' : `Apply ${pending.length} change${pending.length !== 1 ? 's' : ''}`}
          </button>
        )}
        {invoices.length > 0 && (
          <>
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} style={selectStyle}>
              <option value="all">All ({invoices.length})</option>
              <option value="pending">Pending changes ({pending.length})</option>
              <option value="indeterminate">Indeterminate ({invoices.filter((i) => !i.confident).length})</option>
              <option value="correct">Already correct</option>
            </select>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search invoice # or customer"
              style={{ ...selectStyle, minWidth: 220 }}
            />
          </>
        )}
      </div>

      {error && (
        <div style={{ ...card, background: theme.errorBg, borderColor: theme.errorBorder, color: theme.error }}>{error}</div>
      )}

      {restoredCount > 0 && (
        <div style={{ ...card, background: theme.warningBg, borderColor: theme.warningBorder, fontSize: 13 }}>
          Restored <strong>{restoredCount}</strong> unapplied change{restoredCount !== 1 ? 's' : ''} from before — review and Apply when ready.
        </div>
      )}

      {progress && (
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Applying… {progress.done}/{progress.total}</div>
          <div style={{ height: 8, background: theme.progressTrack, borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(progress.done / progress.total) * 100}%`, background: theme.orange }} />
          </div>
        </div>
      )}

      {result && (
        <div style={{ ...card, background: result.errors.length ? theme.warningBg : theme.successBg, borderColor: result.errors.length ? theme.warningBorder : theme.successBorder }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{result.errors.length ? 'Finished — some chunks need a re-run' : 'Done'}</div>
          <div style={{ fontSize: 14 }}>
            Applied <strong>{result.applied}</strong>, failed <strong>{result.failed}</strong>
            {result.closed.length > 0 && <> {' '}— skipped (closed period): {Array.from(new Set(result.closed)).join(', ')}</>}
          </div>
          {result.errors.length > 0 && (
            <div style={{ fontSize: 13, marginTop: 8, color: theme.textSecondary }}>
              {result.errors.length} chunk{result.errors.length !== 1 ? 's' : ''} didn&apos;t complete (usually a timeout). Just Apply again to finish.
            </div>
          )}
        </div>
      )}

      {summary && (
        <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 20 }}>
          <Stat label="FleetSuite invoices" value={summary.fleetSuiteInvoices} />
          <Stat label="Already correct" value={summary.alreadyCorrect} />
          <Stat label="Rule suggests a change" value={summary.toChange} highlight />
          <Stat label="Indeterminate" value={summary.indeterminateKept} />
          <Stat label="Pending (your picks)" value={pending.length} highlight />
        </div>
      )}

      {invoices.length > 0 && (
        <div style={{ ...card, padding: 0, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: theme.subtleBg, textAlign: 'left' }}>
                <th style={th}>Invoice</th>
                <th style={th}>For (memo)</th>
                <th style={th}>Customer</th>
                <th style={th}>Current</th>
                <th style={th}>Set to</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((inv) => {
                const status = statusOf(inv);
                return (
                  <tr key={inv.invoiceId} style={{ borderTop: `1px solid ${theme.border}`, background: status === 'pending' ? theme.warningBg : 'transparent' }}>
                    <td style={td}>
                      <button
                        onClick={() => openInvoicePdf(inv)}
                        disabled={pdfLoadingId === inv.invoiceId}
                        title="Open the invoice PDF"
                        style={{ background: 'none', border: 'none', padding: 0, color: theme.orange, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' }}
                      >
                        {inv.invoiceNumber || inv.invoiceId} {pdfLoadingId === inv.invoiceId ? '…' : '📄'}
                      </button>
                    </td>
                    <td style={{ ...td, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: theme.textSecondary }} title={inv.memo || ''}>
                      {inv.memo || '—'}
                    </td>
                    <td style={td}>{inv.customer || '—'}</td>
                    <td style={{ ...td, color: theme.textMuted }}>{inv.currentLocationName || '—'}</td>
                    <td style={td}>
                      <select
                        value={picks[inv.invoiceId] || ''}
                        onChange={(e) => setPicks((p) => ({ ...p, [inv.invoiceId]: e.target.value }))}
                        style={selectStyle}
                      >
                        {locations.map((l) => (
                          <option key={l.id} value={l.id}>{l.name}</option>
                        ))}
                      </select>
                    </td>
                    <td style={td}><Badge status={status} /></td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr><td style={{ ...td, color: theme.textMuted }} colSpan={6}>No invoices match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
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

function Badge({ status }: { status: Filter }) {
  const map: Record<Filter, { label: string; color: string }> = {
    pending: { label: 'will change', color: theme.warning },
    indeterminate: { label: 'indeterminate', color: theme.textMuted },
    correct: { label: 'correct', color: theme.success },
    all: { label: '', color: theme.textMuted },
  };
  const s = map[status];
  return <span style={{ fontSize: 12, fontWeight: 600, color: s.color }}>{s.label}</span>;
}

const th: CSSProperties = { padding: '10px 12px', fontWeight: 600, fontSize: 12, color: theme.textSecondary, whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '8px 12px', verticalAlign: 'middle' };
const selectStyle: CSSProperties = {
  background: theme.inputBg,
  color: theme.textPrimary,
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 13,
};
