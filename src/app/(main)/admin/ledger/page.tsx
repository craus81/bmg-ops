'use client';

/**
 * The ledger admin page — QuickBooks import on one tab, the customer review
 * queue on the other.
 *
 * WHO SEES WHAT. `useRequireFeature('ledger')` is the page gate (finance,
 * executive and admins hold it). Everything a finance or executive VIEWER
 * can open renders for them — the connection card, the PDF-gate notice, the
 * latest dry-run report, live progress, the events table, the review queue
 * itself. Every CONTROL is `isAdmin`-only, because their routes are
 * requireAdmin or cron-kind: rendering a button that 403s would be a lie
 * about what the reader can do.
 *
 * The PDF-gate notice comes from /api/admin/quickbooks/status, NOT from
 * /api/admin/ledger/settings — the settings route is requireAdmin and would
 * 403 the very card a finance viewer is promised.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth, useRequireFeature } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';

interface PdfGate { enabled: boolean; reason: string; via: string | null; stampedAt: string | null }
interface Status {
  connected: boolean;
  configured: boolean;
  companyName: string | null;
  realmMasked: string | null;
  environment: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  needsReauth: boolean;
  lastError: string | null;
  capabilities: Record<string, unknown>;
  pdfGate: PdfGate;
}
interface RunRow {
  id: string;
  mode: string;
  status: string;
  phase: string | null;
  started_at: string;
  finished_at: string | null;
  counts: Record<string, any> | null;
  api_calls: number | null;
  error: string | null;
  report_viewed_at: string | null;
  report?: any;
  cursor?: Record<string, any> | null;
  events?: Record<string, number>;
}
interface QueueRow {
  id: string;
  external_id: string;
  display_name: string;
  cleaned_name: string;
  match_status: string;
  match_reason: string | null;
  candidates: { customerId: string; companyName: string | null; netsuiteId: string; why?: string | null }[] | null;
  customer_id: string | null;
  invoiceCount: number | null;
  paymentCount: number | null;
}

/** A `customers` row offered by the hand search (`?q=` on the links route). */
interface CustomerHit {
  id: string;
  company_name: string | null;
  entity_id: string | null;
  netsuite_id: string | null;
}

// Theme TOKENS, not a hard-coded palette: `body` is `color:
// var(--text-primary)`, which is near-white in the dark palette :root
// defines as the app default — so a card painted '#fff' with uncoloured text
// inside renders white on white for anyone who has not chosen light mode.
// Every heading and cell below therefore carries an explicit token colour
// rather than inheriting across a background it does not own.
const card: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10,
  padding: 16, marginBottom: 16, color: 'var(--text-body)',
};
const btn: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border-strong)',
  background: 'var(--card)', color: 'var(--text-secondary)',
  cursor: 'pointer', fontSize: 14, marginRight: 8, marginBottom: 8,
};
const primary: React.CSSProperties = {
  ...btn, background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)',
};
const h2: React.CSSProperties = { fontWeight: 600, marginBottom: 8, color: 'var(--text-primary)' };
const muted: React.CSSProperties = { color: 'var(--text-muted)' };
const rowBorder = '1px solid var(--border)';
const num = (n: unknown) => (typeof n === 'number' ? n.toLocaleString() : '—');

const AUTH_REASONS: Record<string, string> = {
  state_mismatch: 'The security token did not match. Start the connect again from this page.',
  expired: 'The consent screen was left open too long. Try again.',
  user_mismatch: 'The connect was finished by a different account than the one that started it.',
  forbidden: 'You need to be an admin to connect QuickBooks.',
  exchange_failed: 'Intuit refused the authorization code. Check QBO_CLIENT_ID / QBO_CLIENT_SECRET.',
  another_realm_connected: 'A different QuickBooks company is already connected. Disconnect it first.',
  sandbox_on_production: 'A sandbox company cannot be connected to a production deployment — docs/quickbooks-connect.md §7.',
  production_off_production: 'A production company can only be connected to the production deployment.',
  missing_realm: 'Intuit did not return a company id.',
  not_configured: 'The QBO_* environment variables are not set yet — docs/quickbooks-connect.md §3.',
};

export default function LedgerAdminPage() {
  const { loading: gateLoading, allowed } = useRequireFeature('ledger');
  const { isAdmin, hasRole } = useAuth();
  const isSuperAdmin = hasRole('super_admin');
  const params = useSearchParams();
  const tab = params.get('tab') === 'review' ? 'review' : 'import';
  const focusRun = params.get('run');
  const focusCustomer = params.get('customer');
  const qboAuth = params.get('qboAuth');
  const qboReason = params.get('reason');

  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [activeRun, setActiveRun] = useState<RunRow | null>(null);
  const [lastErrors, setLastErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cutoverDate, setCutoverDate] = useState('');
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [queueStatus, setQueueStatus] = useState<'ambiguous' | 'unmatched' | 'all'>('ambiguous');
  const [queueError, setQueueError] = useState<string | null>(null);
  // Hand search: the ONLY way to resolve an `unmatched` row, which by
  // definition has no confident grade and usually no candidates. Without it
  // the queue offers such a row nothing but "Ignore" — and attaching by hand
  // is the whole point of the queue (owner item 6).
  const [searchFor, setSearchFor] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchHits, setSearchHits] = useState<CustomerHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const loopRef = useRef(false);
  const focusRowRef = useRef<HTMLDivElement | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/quickbooks/status');
      const body = await res.json();
      if (!res.ok) { setStatusError(body?.error || 'Could not read the connection.'); return; }
      setStatus(body);
      setStatusError(null);
    } catch (e: any) {
      setStatusError(e?.message || 'Could not reach the server.');
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/ledger/runs');
      const body = await res.json();
      if (res.ok) setRuns(body.runs || []);
    } catch { /* the progress feed is best effort */ }
  }, []);

  const loadRun = useCallback(async (runId: string) => {
    try {
      const res = await apiFetch(`/api/admin/ledger/runs?runId=${encodeURIComponent(runId)}`);
      const body = await res.json();
      if (res.ok) {
        setActiveRun({ ...body.run, events: body.events });
        setLastErrors(body.lastErrors || []);
      }
    } catch { /* best effort */ }
  }, []);

  const loadQueue = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/admin/ledger/customer-links?status=${queueStatus}`);
      const body = await res.json();
      if (!res.ok) { setQueueError(body?.error || 'Could not load the queue.'); return; }
      setQueue(body.rows || []);
      setQueueError(null);
    } catch (e: any) {
      setQueueError(e?.message || 'Could not reach the server.');
    }
  }, [queueStatus]);

  useEffect(() => { if (allowed) { loadStatus(); loadRuns(); } }, [allowed, loadStatus, loadRuns]);
  useEffect(() => { if (allowed && tab === 'review') loadQueue(); }, [allowed, tab, loadQueue]);
  useEffect(() => { if (focusRun) loadRun(focusRun); }, [focusRun, loadRun]);

  // deep-links.ts's rule: the destination page must actually HANDLE the param
  // the builder emits. `?customer=` scrolls that row into view and flashes it,
  // rather than landing near it in a list of hundreds.
  useEffect(() => {
    if (focusCustomer && focusRowRef.current) {
      focusRowRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [focusCustomer, queue]);

  // Poll the progress feed every 3 s while a run is moving.
  useEffect(() => {
    if (!activeRun || !['running', 'failed'].includes(activeRun.status)) return;
    const id = setInterval(() => loadRun(activeRun.id), 3_000);
    return () => clearInterval(id);
  }, [activeRun, loadRun]);

  /** Loop the import route until it says `complete` — the page's driver. */
  const drive = useCallback(async (body: Record<string, unknown>, label: string) => {
    if (loopRef.current) return;
    loopRef.current = true;
    setBusy(label);
    setMessage(null);
    try {
      let payload: Record<string, unknown> = { budgetMs: 45_000, ...body };
      for (let i = 0; i < 200; i++) {
        const res = await apiFetch('/api/admin/ledger/import', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const out = await res.json();
        if (res.status === 409 || out?.retryAfterMs) {
          await new Promise(r => setTimeout(r, Number(out?.retryAfterMs) || 5_000));
          if (out?.runId) payload = { mode: 'resume', runId: out.runId, budgetMs: 45_000 };
          continue;
        }
        if (!res.ok) { setMessage(out?.error || `Request failed (${res.status})`); break; }
        if (out.runId) {
          setActiveRun(prev => ({ ...(prev || {}), ...out, id: out.runId } as RunRow));
          await loadRun(out.runId);
        }
        if (out.status === 'failed') { setMessage(`Stopped: ${out.error}`); break; }
        if (out.complete || !out.runId) { setMessage(`${label} finished.`); break; }
        payload = { mode: 'resume', runId: out.runId, budgetMs: 45_000 };
      }
    } catch (e: any) {
      setMessage(e?.message || 'Could not reach the server.');
    } finally {
      loopRef.current = false;
      setBusy(null);
      loadRuns();
      loadStatus();
    }
  }, [loadRun, loadRuns, loadStatus]);

  const post = useCallback(async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    setMessage(null);
    try {
      const res = await apiFetch('/api/admin/ledger/import', { method: 'POST', body: JSON.stringify(body) });
      const out = await res.json();
      setMessage(res.ok ? `${label} done.` : out?.error || `Request failed (${res.status})`);
      loadRuns();
      if (out?.runId) loadRun(String(out.runId));
    } catch (e: any) {
      setMessage(e?.message || 'Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }, [loadRuns, loadRun]);

  const decide = useCallback(async (body: Record<string, unknown>) => {
    setBusy('queue');
    try {
      const res = await apiFetch('/api/admin/ledger/customer-links', { method: 'POST', body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) setMessage(out?.error === 'unknown_customer' ? 'That customer no longer exists.' : out?.error || 'Could not save.');
      // The decision is made — fold the hand search away with it.
      setSearchFor(null);
      setSearchHits(null);
      setSearchError(null);
      await loadQueue();
    } finally {
      setBusy(null);
    }
  }, [loadQueue]);

  const runSearch = useCallback(async (term: string) => {
    const q = term.trim();
    if (q.length < 2) { setSearchHits(null); setSearchError('Type at least two characters.'); return; }
    setBusy('search');
    try {
      const res = await apiFetch(`/api/admin/ledger/customer-links?q=${encodeURIComponent(q)}`);
      const body = await res.json();
      if (!res.ok) { setSearchError(body?.error || 'Could not search customers.'); setSearchHits(null); return; }
      setSearchError(null);
      setSearchHits((body.customers || []) as CustomerHit[]);
    } catch (e: any) {
      setSearchError(e?.message || 'Could not reach the server.');
      setSearchHits(null);
    } finally {
      setBusy(null);
    }
  }, []);

  const openSearch = useCallback((rowId: string, seed: string) => {
    setSearchFor(prev => (prev === rowId ? null : rowId));
    setSearchTerm(seed);
    setSearchHits(null);
    setSearchError(null);
  }, []);

  const latestDryRun = useMemo(
    () => runs.find(r => r.mode === 'dry_run' && r.status === 'complete') || null,
    [runs],
  );
  const report = (activeRun?.report ?? latestDryRun?.report) as any;

  useEffect(() => {
    const proposed = report?.cutover?.proposedCutoverDate;
    if (proposed && !cutoverDate) setCutoverDate(String(proposed));
  }, [report, cutoverDate]);

  if (gateLoading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!allowed) return null;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4, color: 'var(--text-primary)' }}>Ledger</h1>
      <p style={{ ...muted, marginBottom: 16 }}>
        QuickBooks history import, customer matching &amp; the NetSuite mirror.
      </p>

      <div style={{ marginBottom: 16 }}>
        <a href={deepLinks.ledgerAdmin({ tab: 'import' })} style={{ ...btn, ...(tab === 'import' ? primary : {}) }}>Import</a>
        <a href={deepLinks.ledgerAdmin({ tab: 'review' })} style={{ ...btn, ...(tab === 'review' ? primary : {}) }}>Review queue</a>
      </div>

      {qboAuth && (
        <div style={{ ...card, borderColor: qboAuth === 'success' ? 'var(--success-border)' : 'var(--error-border)' }}>
          {qboAuth === 'success'
            ? 'QuickBooks connected. If the company name reads "unavailable", only the CompanyInfo probe failed — the connection is valid.'
            : `QuickBooks could not be connected. ${AUTH_REASONS[qboReason || ''] || qboReason || ''}`}
        </div>
      )}
      {message && <div style={{ ...card, borderColor: 'var(--warning-border)' }}>{message}</div>}

      {tab === 'import' ? (
        <>
          <section style={card}>
            <h2 style={h2}>Connection</h2>
            {statusError ? (
              <p style={{ color: 'var(--error)' }}>Could not read the connection — {statusError}</p>
            ) : !status ? (
              <p style={muted}>Loading…</p>
            ) : !status.configured ? (
              <p>Not configured — set the QBO_* variables (docs/quickbooks-connect.md §3).</p>
            ) : !status.connected ? (
              <p>Not connected.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, lineHeight: 1.8, color: 'var(--text-body)' }}>
                <li><strong>{status.companyName || 'company name unavailable'}</strong> ({status.environment}, realm {status.realmMasked})</li>
                <li>Access token refreshes {status.accessExpiresAt ? new Date(status.accessExpiresAt).toLocaleString() : '—'}</li>
                <li>Reconnect by {status.refreshExpiresAt ? new Date(status.refreshExpiresAt).toLocaleDateString() : '—'}</li>
                {status.needsReauth && <li style={{ color: 'var(--error)' }}>Needs reconnecting — {status.lastError}</li>}
              </ul>
            )}
            {isAdmin && (
              <div style={{ marginTop: 12 }}>
                <a href="/api/auth/quickbooks" style={primary}>{status?.connected ? 'Reconnect' : 'Connect'} QuickBooks</a>
              </div>
            )}
          </section>

          <section style={card}>
            <h2 style={h2}>PDF storage gate</h2>
            <p style={{ color: status?.pdfGate?.enabled ? 'var(--success)' : 'var(--warning)' }}>
              {status?.pdfGate?.reason || 'Loading…'}
            </p>
            <p style={{ ...muted, fontSize: 13, marginTop: 6 }}>
              Imported documents are catalogued either way; their BYTES are only written to R2 once the
              privacy flip in docs/r2-private-flip.md has been verified.
            </p>
            {isSuperAdmin && !status?.pdfGate?.enabled && (
              <p style={{ fontSize: 13, marginTop: 6, color: 'var(--text-body)' }}>
                Stamp it on Settings → Company once the probe URL is confirmed blocked.
              </p>
            )}
          </section>

          {isAdmin && (
            <section style={card}>
              <h2 style={h2}>Run</h2>
              <button style={btn} disabled={!!busy} onClick={() => drive({ mode: 'dry_run' }, 'Dry run')}>
                {busy === 'Dry run' ? 'Dry run running…' : 'Dry run'}
              </button>
              <button
                style={btn}
                disabled={!!busy || !latestDryRun}
                onClick={() => latestDryRun && post({ mode: 'report_viewed', runId: latestDryRun.id }, 'Mark read')}
              >
                I have read this report
              </button>
              <input
                type="date"
                value={cutoverDate}
                onChange={e => setCutoverDate(e.target.value)}
                style={{ ...btn, cursor: 'text' }}
              />
              <button
                style={btn}
                disabled={!!busy || !latestDryRun || !cutoverDate}
                onClick={() => latestDryRun && post({ mode: 'confirm_cutover', dryRunId: latestDryRun.id, date: cutoverDate }, 'Confirm cutover')}
              >
                Confirm cutover {cutoverDate}
              </button>
              <button
                style={primary}
                disabled={!!busy || !latestDryRun}
                onClick={() => latestDryRun && drive({ mode: 'import', dryRunId: latestDryRun.id }, 'Import')}
              >
                Start import
              </button>
              {activeRun && ['running', 'failed'].includes(activeRun.status) && (
                <>
                  <button style={btn} disabled={!!busy} onClick={() => drive({ mode: 'resume', runId: activeRun.id }, 'Resume')}>Resume</button>
                  <button style={btn} disabled={!!busy} onClick={() => post({ mode: 'cancel', runId: activeRun.id }, 'Cancel')}>Cancel</button>
                </>
              )}
            </section>
          )}

          {report && (
            <section style={card}>
              <h2 style={h2}>Latest dry run</h2>
              {report.customers && (
                <p>
                  Customers: {num(report.customers.total)} —{' '}
                  {num(report.customers.buckets?.exact)} exact · {num(report.customers.buckets?.cleaned)} after cleanup ·{' '}
                  {num(report.customers.buckets?.ambiguous)} ambiguous · {num(report.customers.buckets?.unmatched)} unmatched ·{' '}
                  {num(report.customers.buckets?.alreadyManual)} already decided
                </p>
              )}
              {report.cutover && (
                <p>
                  Cutover: QuickBooks last {report.cutover.qboLastTxnDate || 'unknown'} · NetSuite first{' '}
                  {report.cutover.netsuiteFirstTrandate || 'unknown'} ({report.cutover.netsuiteSource}) · overlap{' '}
                  {report.cutover.overlapDays == null ? 'unknown' : `${report.cutover.overlapDays} days`} · proposed{' '}
                  <strong>{report.cutover.proposedCutoverDate || 'unknown'}</strong>
                </p>
              )}
              {report.counts && (
                <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {Object.entries(report.counts).map(([k, v]) => `${k} ${v == null ? '—' : num(v)}`).join(' · ')}
                </p>
              )}
              {Array.isArray(report.warnings) && report.warnings.length > 0 && (
                <ul style={{ color: 'var(--warning)', marginTop: 8 }}>
                  {report.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </section>
          )}

          {activeRun && (
            <section style={card}>
              <h2 style={h2}>Progress</h2>
              <p style={{ color: 'var(--text-body)' }}>
                {activeRun.mode} · {activeRun.status} · phase {activeRun.phase || '—'} ·{' '}
                {num(activeRun.cursor?.processed)} of {activeRun.cursor?.expected == null ? '?' : num(activeRun.cursor.expected)} ·{' '}
                {num(activeRun.api_calls)} API calls
              </p>
              {activeRun.counts && (
                <table style={{
                  width: '100%', fontSize: 13, marginTop: 8, borderCollapse: 'collapse',
                  color: 'var(--text-body)',
                }}>
                  <tbody>
                    {Object.entries(activeRun.counts).map(([entity, c]: [string, any]) => (
                      <tr key={entity} style={{ borderTop: rowBorder }}>
                        <td style={{ padding: '4px 0' }}>{entity}</td>
                        <td>{num(c?.mapped)} mapped</td>
                        <td>{num(c?.postCutover)} post-cutover</td>
                        <td>{num(c?.voided)} voided</td>
                        <td>{num(c?.errors)} errors</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {activeRun.events && Object.keys(activeRun.events).length > 0 && (
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8 }}>
                  Events: {Object.entries(activeRun.events).map(([k, v]) => `${k} ${v}`).join(' · ')}
                </p>
              )}
              {lastErrors.length > 0 && (
                <ul style={{ color: 'var(--error)', fontSize: 13, marginTop: 8 }}>
                  {lastErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </section>
          )}

          <section style={card}>
            <h2 style={h2}>Recent runs</h2>
            {runs.length === 0 ? <p style={muted}>Nothing has run yet.</p> : (
              <table style={{
                width: '100%', fontSize: 13, borderCollapse: 'collapse', color: 'var(--text-body)',
              }}>
                <tbody>
                  {runs.map(r => (
                    <tr key={r.id} style={{ borderTop: rowBorder }}>
                      <td style={{ padding: '6px 0' }}>{new Date(r.started_at).toLocaleString()}</td>
                      <td>{r.mode}</td>
                      <td>{r.status}</td>
                      <td>{r.phase || '—'}</td>
                      <td>
                        <a href={deepLinks.ledgerAdmin({ run: r.id })} onClick={() => loadRun(r.id)}>open</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      ) : (
        <section style={card}>
          <h2 style={h2}>Customers needing a match</h2>
          <div style={{ marginBottom: 12 }}>
            {(['ambiguous', 'unmatched', 'all'] as const).map(sVal => (
              <button
                key={sVal}
                style={{ ...btn, ...(queueStatus === sVal ? primary : {}) }}
                onClick={() => setQueueStatus(sVal)}
              >
                {sVal}
              </button>
            ))}
          </div>
          {queueError ? <p style={{ color: 'var(--error)' }}>{queueError}</p>
            : queue.length === 0 ? <p style={muted}>Nothing waiting.</p> : (
            <div>
              {queue.map(row => (
                <div
                  key={row.id}
                  ref={focusCustomer === row.id ? focusRowRef : undefined}
                  style={{
                    borderTop: rowBorder, padding: '10px 0',
                    background: focusCustomer === row.id ? 'var(--warning-bg)' : undefined,
                  }}
                >
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{row.display_name}</div>
                  <div style={{ ...muted, fontSize: 13 }}>
                    cleaned “{row.cleaned_name}” · {row.match_status}
                    {row.match_reason ? ` — ${row.match_reason}` : ''} · {num(row.invoiceCount)} invoices ·{' '}
                    {num(row.paymentCount)} payments
                  </div>
                  <div style={{ marginTop: 6 }}>
                    {(row.candidates || []).map(c => (
                      <button
                        key={c.customerId}
                        style={btn}
                        disabled={!isAdmin || !!busy}
                        title={!isAdmin ? 'Admins attach customers' : c.why || ''}
                        onClick={() => decide({ action: 'attach', ledgerCustomerId: row.id, customerId: c.customerId })}
                      >
                        Attach → {c.companyName || c.netsuiteId}
                      </button>
                    ))}
                    {/* Hand search reads through the SAME role() GET the queue
                        uses, so it renders for a finance or executive viewer
                        too — with its Attach buttons disabled, exactly like
                        the candidate buttons above. */}
                    <button
                      style={btn}
                      disabled={!!busy}
                      onClick={() => openSearch(row.id, row.cleaned_name || row.display_name)}
                    >
                      {searchFor === row.id ? 'Close search' : 'Search customers…'}
                    </button>
                    {isAdmin && (
                      <>
                        <button style={btn} disabled={!!busy} onClick={() => decide({ action: 'ignore', ledgerCustomerId: row.id })}>Ignore</button>
                        {row.customer_id && (
                          <button style={btn} disabled={!!busy} onClick={() => decide({ action: 'unlink', ledgerCustomerId: row.id })}>Unlink</button>
                        )}
                      </>
                    )}
                  </div>

                  {/* The queue's answer for a row with NO candidates at
                      all — which is what `unmatched` means. Without it such a
                      row could only ever be ignored, and attaching by hand is
                      the whole point of the queue (owner item 6). Same POST
                      `attach` as a candidate button, so the route's
                      `unknown_customer` wall applies either way. */}
                  {searchFor === row.id && (
                    <div style={{ marginTop: 6, paddingLeft: 12, borderLeft: '3px solid var(--border-strong)' }}>
                      <form
                        onSubmit={e => { e.preventDefault(); runSearch(searchTerm); }}
                        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
                      >
                        <input
                          value={searchTerm}
                          onChange={e => setSearchTerm(e.target.value)}
                          placeholder="FleetSuite customer name"
                          aria-label="Search FleetSuite customers"
                          style={{
                            padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-strong)',
                            background: 'var(--card)', color: 'var(--text-primary)',
                            fontSize: 14, minWidth: 220, flex: '1 1 220px',
                          }}
                        />
                        <button type="submit" style={primary} disabled={!!busy}>Search</button>
                      </form>
                      {searchError && <p style={{ color: 'var(--error)', fontSize: 13 }}>{searchError}</p>}
                      {searchHits && searchHits.length === 0 && (
                        <p style={{ ...muted, fontSize: 13 }}>No active customer matched that name.</p>
                      )}
                      {searchHits && searchHits.length > 0 && (
                        <div style={{ marginTop: 6 }}>
                          {searchHits.map(hit => (
                            <button
                              key={hit.id}
                              style={btn}
                              disabled={!isAdmin || !!busy}
                              title={!isAdmin ? 'Admins attach customers' : hit.entity_id || hit.netsuite_id || ''}
                              onClick={() => decide({ action: 'attach', ledgerCustomerId: row.id, customerId: hit.id })}
                            >
                              Attach → {hit.company_name || hit.entity_id || hit.netsuite_id}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
