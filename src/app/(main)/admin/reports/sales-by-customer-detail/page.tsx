'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

interface Line {
  invoice_id: string;
  invoice_number: string;
  trandate: string;
  memo: string | null;
  customer: string;
  location: string | null;
  part_number: string | null;
  description: string | null;
  quantity: number;
  unit_rate: number;
  net_amount: number;
}

interface ReportResponse {
  range: { start: string; end: string };
  customers: string[];
  lineCount: number;
  grandTotal: number;
  perCustomer: { customer: string; lineCount: number; invoiceCount: number; total: number }[];
  lines: Line[];
}

const DEFAULT_CUSTOMERS = 'Masterack, Designs that Stick';
const DEFAULT_START = '2026-01-01';
const DEFAULT_END = '2026-03-31';

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}
function fmtQty(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function fmtDate(s: string): string {
  if (!s) return '';
  const d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function SalesByCustomerDetailReportPage() {
  const router = useRouter();
  const { user, isAdmin, isSales } = useAuth();

  const [start, setStart] = useState(DEFAULT_START);
  const [end, setEnd] = useState(DEFAULT_END);
  const [customers, setCustomers] = useState(DEFAULT_CUSTOMERS);
  const [data, setData] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<keyof Line>('trandate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filterCustomer, setFilterCustomer] = useState<string>('');

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const qs = new URLSearchParams({ start, end, customers });
      const res = await fetch(`/api/reports/sales-by-customer-detail?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Report failed');
      } else {
        setData(json as ReportResponse);
      }
    } catch (e: any) {
      setError(e?.message || 'Network error');
    }
    setLoading(false);
  }, [start, end, customers]);

  useEffect(() => {
    if (!user) return;
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    run();
  }, [user, isAdmin, isSales, router, run]);

  const filteredSortedLines = useMemo(() => {
    if (!data) return [];
    const filtered = filterCustomer
      ? data.lines.filter(l => l.customer === filterCustomer)
      : data.lines;
    const sorted = [...filtered].sort((a, b) => {
      const av = a[sortKey] as any;
      const bv = b[sortKey] as any;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const cmp = String(av || '').localeCompare(String(bv || ''));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [data, filterCustomer, sortKey, sortDir]);

  const filteredTotal = useMemo(
    () => filteredSortedLines.reduce((s, l) => s + l.net_amount, 0),
    [filteredSortedLines]
  );

  const toggleSort = (key: keyof Line) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const exportCsv = () => {
    if (!data) return;
    const rows = filteredSortedLines;
    const headers = ['Invoice #', 'Date', 'Customer', 'Memo', 'Location', 'Part #', 'Description', 'Qty', 'Rate', 'Net Amount'];
    const escape = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [
      headers.join(','),
      ...rows.map(l => [
        l.invoice_number, l.trandate, l.customer, l.memo, l.location,
        l.part_number, l.description, l.quantity, l.unit_rate, l.net_amount,
      ].map(escape).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-detail_${start}_${end}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const inputStyle: React.CSSProperties = {
    padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)',
    background: 'var(--card)', color: 'var(--text-primary)', fontSize: '13px',
  };
  const headerCellStyle: React.CSSProperties = {
    padding: '8px 10px', textAlign: 'left', fontSize: '11px', fontWeight: 700,
    color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px',
    cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none',
  };
  const cellStyle: React.CSSProperties = {
    padding: '8px 10px', fontSize: '12px', color: 'var(--text-primary)',
    borderTop: '1px solid var(--border)', verticalAlign: 'top',
  };
  const numCellStyle: React.CSSProperties = { ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  const indicator = (key: keyof Line) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <div>
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Sales by Customer — Detail</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Per-line invoice detail pulled live from NetSuite via SuiteQL.</div>
      </div>

      {/* Filters */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(220px, 1fr) 140px 140px auto auto',
        gap: '10px', alignItems: 'end',
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px',
        padding: '12px', marginBottom: '14px',
      }}>
        <label>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>Customers (comma-separated, partial match)</div>
          <input style={{ ...inputStyle, width: '100%' }} value={customers} onChange={e => setCustomers(e.target.value)} />
        </label>
        <label>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>Start</div>
          <input type="date" style={inputStyle} value={start} onChange={e => setStart(e.target.value)} />
        </label>
        <label>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>End</div>
          <input type="date" style={inputStyle} value={end} onChange={e => setEnd(e.target.value)} />
        </label>
        <button
          onClick={run}
          disabled={loading}
          style={{
            padding: '10px 16px', borderRadius: '10px', border: 'none',
            background: 'var(--accent, #2563eb)', color: '#fff',
            fontSize: '13px', fontWeight: 700, cursor: 'pointer',
          }}
        >{loading ? 'Loading…' : 'Run report'}</button>
        <button
          onClick={exportCsv}
          disabled={!data}
          style={{
            padding: '10px 16px', borderRadius: '10px',
            border: '1px solid var(--border)', background: 'var(--card)',
            fontSize: '13px', fontWeight: 700, cursor: data ? 'pointer' : 'not-allowed',
            opacity: data ? 1 : 0.5,
          }}
        >Export CSV</button>
      </div>

      {error && (
        <div style={{
          padding: '12px', borderRadius: '10px', marginBottom: '12px',
          background: 'color-mix(in srgb, var(--danger, #ef4444) 8%, var(--card))',
          border: '1px solid var(--danger, #ef4444)', color: 'var(--danger, #ef4444)', fontSize: '13px',
        }}>{error}</div>
      )}

      {data && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
            <button
              onClick={() => setFilterCustomer('')}
              style={{
                padding: '10px 14px', borderRadius: '12px',
                border: `1px solid ${filterCustomer === '' ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
                background: filterCustomer === '' ? 'color-mix(in srgb, var(--accent, #2563eb) 10%, var(--card))' : 'var(--card)',
                cursor: 'pointer', textAlign: 'left', minWidth: '180px',
              }}
            >
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>All customers</div>
              <div style={{ fontSize: '18px', fontWeight: 800, marginTop: '2px' }}>{fmtMoney(data.grandTotal)}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{data.lineCount} lines</div>
            </button>
            {data.perCustomer.map(c => (
              <button
                key={c.customer}
                onClick={() => setFilterCustomer(c.customer)}
                style={{
                  padding: '10px 14px', borderRadius: '12px',
                  border: `1px solid ${filterCustomer === c.customer ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
                  background: filterCustomer === c.customer ? 'color-mix(in srgb, var(--accent, #2563eb) 10%, var(--card))' : 'var(--card)',
                  cursor: 'pointer', textAlign: 'left', minWidth: '180px',
                }}
              >
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.customer}</div>
                <div style={{ fontSize: '18px', fontWeight: 800, marginTop: '2px' }}>{fmtMoney(c.total)}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{c.invoiceCount} invoice{c.invoiceCount === 1 ? '' : 's'} · {c.lineCount} lines</div>
              </button>
            ))}
          </div>

          {/* Detail table */}
          {filteredSortedLines.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', borderRadius: '12px', background: 'var(--card)', border: '1px solid var(--border)' }}>
              No invoice lines for this filter.
            </div>
          ) : (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead style={{ background: 'var(--subtle-bg, #f8fafc)' }}>
                    <tr>
                      <th style={headerCellStyle} onClick={() => toggleSort('invoice_number')}>Invoice #{indicator('invoice_number')}</th>
                      <th style={headerCellStyle} onClick={() => toggleSort('trandate')}>Date{indicator('trandate')}</th>
                      <th style={headerCellStyle} onClick={() => toggleSort('customer')}>Customer{indicator('customer')}</th>
                      <th style={headerCellStyle}>Memo</th>
                      <th style={headerCellStyle} onClick={() => toggleSort('location')}>Location{indicator('location')}</th>
                      <th style={headerCellStyle} onClick={() => toggleSort('part_number')}>Part #{indicator('part_number')}</th>
                      <th style={{ ...headerCellStyle, textAlign: 'right' }} onClick={() => toggleSort('quantity')}>Qty{indicator('quantity')}</th>
                      <th style={{ ...headerCellStyle, textAlign: 'right' }} onClick={() => toggleSort('net_amount')}>Net Amount{indicator('net_amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSortedLines.map((l, idx) => (
                      <tr key={`${l.invoice_id}-${idx}`} style={{ background: idx % 2 === 0 ? 'transparent' : 'var(--subtle-bg, #f8fafc)' }}>
                        <td style={{ ...cellStyle, fontWeight: 700 }}>{l.invoice_number}</td>
                        <td style={cellStyle}>{fmtDate(l.trandate)}</td>
                        <td style={cellStyle}>{l.customer}</td>
                        <td style={{ ...cellStyle, maxWidth: '260px', whiteSpace: 'pre-wrap' }}>{l.memo || ''}</td>
                        <td style={cellStyle}>{l.location || ''}</td>
                        <td style={cellStyle}>
                          <div style={{ fontFamily: 'monospace', fontSize: '11px' }}>{l.part_number || ''}</div>
                          {l.description && l.description !== l.part_number && (
                            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{l.description}</div>
                          )}
                        </td>
                        <td style={numCellStyle}>{fmtQty(l.quantity)}</td>
                        <td style={numCellStyle}>{fmtMoney(l.net_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: 'var(--subtle-bg, #f8fafc)' }}>
                      <td style={{ ...cellStyle, fontWeight: 800 }} colSpan={6}>
                        {filterCustomer ? `Total — ${filterCustomer}` : 'Total — all customers'}
                      </td>
                      <td style={{ ...numCellStyle, fontWeight: 800 }}>{fmtQty(filteredSortedLines.reduce((s, l) => s + l.quantity, 0))}</td>
                      <td style={{ ...numCellStyle, fontWeight: 800 }}>{fmtMoney(filteredTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
