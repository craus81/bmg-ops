'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { downloadCsv } from '@/lib/csv';

/**
 * K10 — Invoice reconciliation: NetSuite invoices for a period vs the
 * FleetSuite records claiming them. Three buckets: amount mismatches,
 * NetSuite-only invoices (no FS record), FleetSuite-only claims (number
 * missing from NS — annotated typo/deleted vs just outside the window).
 */

interface MatchedRow {
  invoiceNumber: string;
  date: string | null;
  status: 'open' | 'paid' | null;
  customer: string;
  po: string | null;
  total: number;
  scanCount: number;
  scanAmount: number;
  graphicsJobs: number;
  graphicsAmount: number;
  fsTotal: number;
  delta: number;
  amountMismatch: boolean;
}

interface NsOnlyRow {
  invoiceNumber: string;
  date: string | null;
  status: 'open' | 'paid' | null;
  customer: string;
  po: string | null;
  total: number;
}

interface FsOnlyRow {
  invoiceNumber: string;
  scanCount: number;
  scanAmount: number;
  scanCustomers: string[];
  scanDates: string[];
  graphicsJobs: { jobNumber: string | null; title: string | null; amount: number | null }[];
  graphicsAmount: number;
  nsStatus: 'outside_window' | 'not_found';
  nsDate: string | null;
  nsTotal: number | null;
}

interface Summary {
  nsInvoices: number;
  nsTotal: number;
  matched: number;
  clean: number;
  amountMismatches: number;
  nsOnly: number;
  fsOnly: number;
  fsNotFound: number;
}

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '6px 10px', fontSize: '11px', fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const tdStyle: React.CSSProperties = {
  padding: '7px 10px', fontSize: '13px', borderBottom: '1px solid var(--border)',
  color: 'var(--text-primary)', verticalAlign: 'top',
};
const tdRight: React.CSSProperties = { ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' };

export default function InvoiceReconciliationPage() {
  const router = useRouter();
  const { user, isAdmin, loading: authLoading } = useAuth();

  const today = new Date().toISOString().slice(0, 10);
  const [start, setStart] = useState(`${today.slice(0, 7)}-01`);
  const [end, setEnd] = useState(today);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [matched, setMatched] = useState<MatchedRow[]>([]);
  const [nsOnly, setNsOnly] = useState<NsOnlyRow[]>([]);
  const [fsOnly, setFsOnly] = useState<FsOnlyRow[]>([]);
  const [showClean, setShowClean] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user || !isAdmin) router.push('/home');
  }, [user, isAdmin, authLoading, router]);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/invoice-reconciliation?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setSummary(data.summary);
      setMatched(data.matched || []);
      setNsOnly(data.nsOnly || []);
      setFsOnly(data.fsOnly || []);
    } catch (err: any) {
      setError(err.message || 'Report failed');
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  const exportCsv = () => {
    const rows: (string | number | null)[][] = [];
    for (const m of matched) {
      rows.push([
        m.amountMismatch ? 'amount_mismatch' : 'matched',
        m.invoiceNumber, m.date, m.customer, m.status, m.po,
        m.total, m.scanCount, m.scanAmount, m.graphicsJobs, m.graphicsAmount, m.fsTotal, m.delta, '',
      ]);
    }
    for (const n of nsOnly) {
      rows.push(['netsuite_only', n.invoiceNumber, n.date, n.customer, n.status, n.po, n.total, 0, 0, 0, 0, 0, n.total, '']);
    }
    for (const f of fsOnly) {
      rows.push([
        f.nsStatus === 'not_found' ? 'fs_only_not_in_netsuite' : 'fs_only_outside_window',
        f.invoiceNumber, f.scanDates.join(' '), f.scanCustomers.join('; '), '', '',
        f.nsTotal, f.scanCount, f.scanAmount, f.graphicsJobs.length, f.graphicsAmount,
        f.scanAmount + f.graphicsAmount, null,
        f.nsStatus === 'outside_window' ? `in NetSuite on ${f.nsDate}` : 'not found in NetSuite',
      ]);
    }
    downloadCsv(
      `invoice-reconciliation-${start}-to-${end}.csv`,
      ['bucket', 'invoice #', 'date', 'customer', 'status', 'po', 'netsuite total', 'scans', 'scan amount', 'graphics jobs', 'graphics amount', 'fleetsuite total', 'delta', 'note'],
      rows,
    );
  };

  const mismatches = matched.filter(m => m.amountMismatch);
  const clean = matched.filter(m => !m.amountMismatch);

  const tile = (label: string, value: string | number, tone?: 'bad' | 'warn' | 'good') => (
    <div style={{
      flex: '1 1 120px', padding: '10px 14px', borderRadius: '12px',
      background: 'var(--card)', border: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{
        fontSize: '20px', fontWeight: 800, marginTop: '2px',
        color: tone === 'bad' ? '#ef4444' : tone === 'warn' ? '#f59e0b' : tone === 'good' ? '#22c55e' : 'var(--text-primary)',
      }}>{value}</div>
    </div>
  );

  const sectionTitle = (text: string, count: number) => (
    <div style={{ fontSize: '14px', fontWeight: 800, margin: '18px 0 8px' }}>
      {text} <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>({count})</span>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '10px', marginBottom: '14px' }}>
        <div style={{ flex: 1, minWidth: '220px' }}>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>Invoice Reconciliation</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            NetSuite invoices vs FleetSuite records (scans + graphics jobs) claiming them. Totals are net of tax on both sides.
          </div>
        </div>
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>From</div>
          <input type="date" value={start} onChange={e => setStart(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '13px' }} />
        </div>
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>To</div>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '13px' }} />
        </div>
        <button onClick={run} disabled={loading} style={{
          padding: '9px 18px', borderRadius: '10px', border: 'none', cursor: 'pointer',
          background: 'var(--accent, #2563eb)', color: '#fff', fontWeight: 800, fontSize: '13px',
          opacity: loading ? 0.6 : 1,
        }}>{loading ? 'Comparing…' : 'Run'}</button>
        {summary && (
          <button onClick={exportCsv} style={{
            padding: '9px 14px', borderRadius: '10px', border: '1px solid var(--border)', cursor: 'pointer',
            background: 'var(--card)', fontWeight: 700, fontSize: '13px',
          }}>Download CSV</button>
        )}
      </div>

      {error && (
        <div style={{ padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', fontSize: '13px', marginBottom: '12px' }}>
          {error}
        </div>
      )}

      {!summary && !loading && !error && (
        <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          Pick a period and hit Run. Defaults to the current month.
        </div>
      )}

      {summary && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '4px' }}>
            {tile('NS invoices', summary.nsInvoices)}
            {tile('NS total', money(summary.nsTotal))}
            {tile('Matched clean', summary.clean, 'good')}
            {tile('Amount mismatches', summary.amountMismatches, summary.amountMismatches > 0 ? 'warn' : 'good')}
            {tile('NS only', summary.nsOnly)}
            {tile('FS not in NS', summary.fsNotFound, summary.fsNotFound > 0 ? 'bad' : 'good')}
          </div>

          {/* ── 1. Amount mismatches — the actionable list ── */}
          {sectionTitle('Amount mismatches', mismatches.length)}
          {mismatches.length === 0 ? (
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Every matched invoice agrees within $1.</div>
          ) : (
            <div style={{ overflowX: 'auto', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--card)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={thStyle}>Invoice #</th><th style={thStyle}>Date</th><th style={thStyle}>Customer</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>NS total</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>FS total</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Delta</th>
                  <th style={thStyle}>FS sources</th>
                </tr></thead>
                <tbody>
                  {mismatches.map(m => (
                    <tr key={m.invoiceNumber}>
                      <td style={tdStyle}>{m.invoiceNumber}</td>
                      <td style={tdStyle}>{m.date || '—'}</td>
                      <td style={tdStyle}>{m.customer}</td>
                      <td style={tdRight}>{money(m.total)}</td>
                      <td style={tdRight}>{money(m.fsTotal)}</td>
                      <td style={{ ...tdRight, fontWeight: 800, color: m.delta > 0 ? '#f59e0b' : '#ef4444' }}>
                        {m.delta > 0 ? '+' : ''}{money(m.delta)}
                      </td>
                      <td style={tdStyle}>
                        {[m.scanCount > 0 ? `${m.scanCount} scan${m.scanCount === 1 ? '' : 's'} (${money(m.scanAmount)})` : '',
                          m.graphicsJobs > 0 ? `${m.graphicsJobs} graphics (${money(m.graphicsAmount)})` : '']
                          .filter(Boolean).join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── 2. FS-only claims — typos / deleted invoices first ── */}
          {sectionTitle('FleetSuite records with no NetSuite invoice in this period', fsOnly.length)}
          {fsOnly.length === 0 ? (
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>None — every FleetSuite claim points at a real invoice in the period.</div>
          ) : (
            <div style={{ overflowX: 'auto', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--card)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={thStyle}>Invoice #</th><th style={thStyle}>Status</th><th style={thStyle}>Customer(s)</th>
                  <th style={thStyle}>FS date(s)</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>FS amount</th>
                  <th style={thStyle}>Sources</th>
                </tr></thead>
                <tbody>
                  {fsOnly.map(f => (
                    <tr key={f.invoiceNumber}>
                      <td style={tdStyle}>{f.invoiceNumber}</td>
                      <td style={tdStyle}>
                        {f.nsStatus === 'not_found' ? (
                          <span style={{ color: '#ef4444', fontWeight: 700 }}>Not in NetSuite</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>In NS on {f.nsDate} ({money(f.nsTotal)})</span>
                        )}
                      </td>
                      <td style={tdStyle}>{f.scanCustomers.join(', ') || '—'}</td>
                      <td style={tdStyle}>{f.scanDates.join(', ') || '—'}</td>
                      <td style={tdRight}>{money(f.scanAmount + f.graphicsAmount)}</td>
                      <td style={tdStyle}>
                        {[f.scanCount > 0 ? `${f.scanCount} scan${f.scanCount === 1 ? '' : 's'}` : '',
                          f.graphicsJobs.length > 0 ? f.graphicsJobs.map(g => g.jobNumber || 'graphics job').join(', ') : '']
                          .filter(Boolean).join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── 3. NS-only invoices — entered directly in NetSuite ── */}
          {sectionTitle('NetSuite invoices with no FleetSuite record', nsOnly.length)}
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            Usually fine — invoices entered directly in NetSuite (freight, credits rebilled, manual work). Listed so nothing hides.
          </div>
          {nsOnly.length > 0 && (
            <div style={{ overflowX: 'auto', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--card)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={thStyle}>Invoice #</th><th style={thStyle}>Date</th><th style={thStyle}>Customer</th>
                  <th style={thStyle}>PO</th><th style={thStyle}>Status</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                </tr></thead>
                <tbody>
                  {nsOnly.map(n => (
                    <tr key={n.invoiceNumber}>
                      <td style={tdStyle}>{n.invoiceNumber}</td>
                      <td style={tdStyle}>{n.date || '—'}</td>
                      <td style={tdStyle}>{n.customer}</td>
                      <td style={tdStyle}>{n.po || '—'}</td>
                      <td style={tdStyle}>{n.status || '—'}</td>
                      <td style={tdRight}>{money(n.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── 4. Clean matches, collapsed ── */}
          {sectionTitle('Matched & clean', clean.length)}
          <button onClick={() => setShowClean(v => !v)} style={{
            padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--border)',
            background: 'var(--card)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
          }}>{showClean ? 'Hide' : 'Show'} {clean.length} clean invoice{clean.length === 1 ? '' : 's'}</button>
          {showClean && clean.length > 0 && (
            <div style={{ overflowX: 'auto', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--card)', marginTop: '8px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={thStyle}>Invoice #</th><th style={thStyle}>Date</th><th style={thStyle}>Customer</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                  <th style={thStyle}>FS sources</th>
                </tr></thead>
                <tbody>
                  {clean.map(m => (
                    <tr key={m.invoiceNumber}>
                      <td style={tdStyle}>{m.invoiceNumber}</td>
                      <td style={tdStyle}>{m.date || '—'}</td>
                      <td style={tdStyle}>{m.customer}</td>
                      <td style={tdRight}>{money(m.total)}</td>
                      <td style={tdStyle}>
                        {[m.scanCount > 0 ? `${m.scanCount} scan${m.scanCount === 1 ? '' : 's'}` : '',
                          m.graphicsJobs > 0 ? `${m.graphicsJobs} graphics` : '']
                          .filter(Boolean).join(' · ')}
                      </td>
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
