'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { downloadCsv } from '@/lib/csv';
import type { DivisionItem, DivisionReport, RevenueBucket } from '@/lib/division-revenue';

/**
 * Upfit vs Graphics (owner ask 2026-10-06): NetSuite revenue split by item
 * (rule in src/lib/division-revenue.ts) next to Paychex labor split by
 * payroll role, by month, so the owner can see which side makes money.
 * Super admin / executive only, same wall as the route.
 */

interface Payload { range: { from: string; to: string }; report: DivisionReport; peopleWithoutRole: number }

const fmtMoney = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtPct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');
const fmtMonth = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', marginBottom: '14px' };
const eyebrow: React.CSSProperties = { fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: '8px' };
const th: React.CSSProperties = { fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { fontSize: '12.5px', padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const btn: React.CSSProperties = { padding: '8px 14px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontWeight: 700, fontSize: '13px', cursor: 'pointer' };
const primaryBtn: React.CSSProperties = { ...btn, background: theme.accent, border: 'none', color: '#fff' };
const input: React.CSSProperties = { padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '16px' };
const money = (n: number) => <span style={{ color: n < 0 ? theme.error : undefined }}>{fmtMoney(n)}</span>;

const BUCKET_LABELS: Record<RevenueBucket, string> = {
  upfit: 'Upfit',
  graphics: 'Graphics',
  unsplit: 'Not split (discounts, no item)',
  excluded: 'Left out (freight, shipping)',
};

function SideCard({ title, revenue, labor, total }: { title: string; revenue: number; labor: number; total: number }) {
  const after = revenue - labor;
  return (
    <div style={{ ...card, marginBottom: 0, flex: '1 1 220px', minWidth: '220px' }}>
      <div style={eyebrow}>{title}</div>
      <div style={{ fontSize: '22px', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(revenue)}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>revenue · {fmtPct(revenue, total)} of the split</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginTop: '8px' }}>
        <span>Labor cost</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(labor)} ({fmtPct(labor, revenue)})</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 800, marginTop: '4px' }}>
        <span>After labor</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(after)} ({fmtPct(after, revenue)})</span>
      </div>
    </div>
  );
}

function ItemsTable({ items, bucket }: { items: DivisionItem[]; bucket: RevenueBucket }) {
  const [all, setAll] = useState(false);
  const rows = items.filter(i => i.bucket === bucket);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, 10);
  return (
    <div style={{ ...card, flex: '1 1 300px', minWidth: '280px', marginBottom: 0 }}>
      <div style={eyebrow}>{BUCKET_LABELS[bucket]} · top items</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {shown.map(i => (
            <tr key={`${i.item_number}|${i.item_type}`}>
              <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>{i.item_number}{i.item_type ? <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}> · {i.item_type}</span> : null}</td>
              <td style={td}>{money(i.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 10 && (
        <button style={{ ...btn, padding: '4px 10px', fontSize: '11px', marginTop: '8px' }} onClick={() => setAll(!all)}>
          {all ? 'Show top 10' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

export default function UpfitVsGraphicsPage() {
  const { hasFeature, loading: authLoading } = useAuth();
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mirrors the route's requireFinancials — super_admin / executive only.
  const allowed = hasFeature('financials');

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch(`/api/reports/upfit-vs-graphics?from=${f}&to=${t}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Report failed');
      setData(json as Payload);
    } catch (e: any) {
      setError(e.message || 'Report failed');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!allowed) { router.push('/home'); return; }
    load(from, to);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasFeature identity changes per render; auth state deps cover it
  }, [authLoading, router, load]);

  const preset = (f: string, t: string) => { setFrom(f); setTo(t); load(f, t); };
  const r = data?.report;
  const t = r?.totals;
  const split = t ? t.upfitRevenue + t.graphicsRevenue : 0;

  const exportCsv = () => r && downloadCsv(`upfit-vs-graphics-${data!.range.from}-to-${data!.range.to}.csv`,
    ['Month', 'Upfit revenue', 'Upfit labor', 'Upfit after labor', 'Graphics revenue', 'Graphics labor', 'Graphics after labor', 'Shared labor', 'Labor with no role', 'Not split revenue', 'Left out revenue'],
    r.months.map(m => [m.month, m.upfitRevenue, m.upfitLabor, m.upfitAfterLabor, m.graphicsRevenue, m.graphicsLabor, m.graphicsAfterLabor, m.sharedLabor, m.unassignedLabor, m.unsplitRevenue, m.excludedRevenue]));
  const exportItems = () => r && downloadCsv(`upfit-vs-graphics-items-${data!.range.from}-to-${data!.range.to}.csv`,
    ['Item', 'NetSuite type', 'Side', 'Revenue'],
    r.items.map(i => [i.item_number, i.item_type || '', BUCKET_LABELS[i.bucket], i.amount]));

  return (
    <div>
      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Upfit vs Graphics</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          NetSuite invoiced revenue (less credit memos, before tax) split by item, next to Paychex labor cost split by payroll role.
          Graphics is 3M Vinyl, Graphics Install Labor, Graphics Removal and any part number starting &ldquo;06&rdquo;; everything else is Upfit.
        </div>
      </div>

      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <button style={btn} onClick={() => preset(`${year}-01-01`, today)}>This year</button>
        <button style={btn} onClick={() => preset(`${Number(year) - 1}-01-01`, `${Number(year) - 1}-12-31`)}>Last year</button>
        <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" style={input} value={from} onChange={e => setFrom(e.target.value)} />
          <span style={{ color: 'var(--text-muted)' }}>to</span>
          <input type="date" style={input} value={to} onChange={e => setTo(e.target.value)} />
          <button style={primaryBtn} onClick={() => load(from, to)} disabled={loading}>{loading ? 'Loading…' : 'Run'}</button>
        </span>
      </div>

      {error && <div style={{ ...card, color: theme.error }}>{error}</div>}
      {loading && !data && <div style={card}>Loading…</div>}

      {r && t && (
        <>
          {(data!.peopleWithoutRole > 0 || r.monthsWithoutPayroll.length > 0) && (
            <div style={{ ...card, borderColor: theme.warning, fontSize: '13px' }}>
              {data!.peopleWithoutRole > 0 && (
                <div>{data!.peopleWithoutRole} {data!.peopleWithoutRole === 1 ? 'person on payroll has' : 'people on payroll have'} no role yet, so {fmtMoney(t.unassignedLabor)} of labor isn&rsquo;t on either side. <Link href="/admin/reports/paychex-payroll" style={{ color: theme.orange, fontWeight: 700 }}>Set roles</Link></div>
              )}
              {r.monthsWithoutPayroll.length > 0 && (
                <div>No payroll uploaded for {r.monthsWithoutPayroll.map(fmtMonth).join(', ')}, so those months show revenue with no labor.</div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '14px' }}>
            <SideCard title="Upfit" revenue={t.upfitRevenue} labor={t.upfitLabor} total={split} />
            <SideCard title="Graphics" revenue={t.graphicsRevenue} labor={t.graphicsLabor} total={split} />
            <div style={{ ...card, marginBottom: 0, flex: '1 1 220px', minWidth: '220px', fontSize: '13px' }}>
              <div style={eyebrow}>Not on either side</div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Shared labor (Sales + Office)</span><span>{fmtMoney(t.sharedLabor)}</span></div>
              {t.unassignedLabor ? <div style={{ display: 'flex', justifyContent: 'space-between', color: theme.warning }}><span>Labor with no role</span><span>{fmtMoney(t.unassignedLabor)}</span></div> : null}
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Discounts / no-item lines</span><span>{money(t.unsplitRevenue)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Freight + shipping (left out)</span><span>{fmtMoney(t.excludedRevenue)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, marginTop: '6px' }}>
                <span>Company after all labor</span>
                <span>{money(t.upfitAfterLabor + t.graphicsAfterLabor + t.unsplitRevenue - t.sharedLabor - t.unassignedLabor)}</span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>Parts and materials cost aren&rsquo;t subtracted yet.</div>
            </div>
          </div>

          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
              <div style={eyebrow}>By month</div>
              <button style={{ ...btn, padding: '4px 10px', fontSize: '11px' }} onClick={exportCsv}>CSV</button>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'left' }} rowSpan={2}>Month</th>
                    <th style={{ ...th, textAlign: 'center' }} colSpan={3}>Upfit</th>
                    <th style={{ ...th, textAlign: 'center' }} colSpan={3}>Graphics</th>
                    <th style={th} rowSpan={2}>Shared labor</th>
                  </tr>
                  <tr>
                    <th style={th}>Revenue</th><th style={th}>Labor</th><th style={th}>After labor</th>
                    <th style={th}>Revenue</th><th style={th}>Labor</th><th style={th}>After labor</th>
                  </tr>
                </thead>
                <tbody>
                  {r.months.map(m => (
                    <tr key={m.month}>
                      <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{fmtMonth(m.month)}</td>
                      <td style={td}>{fmtMoney(m.upfitRevenue)}</td>
                      <td style={td}>{fmtMoney(m.upfitLabor)}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{money(m.upfitAfterLabor)}</td>
                      <td style={td}>{fmtMoney(m.graphicsRevenue)}</td>
                      <td style={td}>{fmtMoney(m.graphicsLabor)}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{money(m.graphicsAfterLabor)}</td>
                      <td style={td}>{fmtMoney(m.sharedLabor)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 800 }}>Total</td>
                    <td style={{ ...td, fontWeight: 800 }}>{fmtMoney(t.upfitRevenue)}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{fmtMoney(t.upfitLabor)}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{money(t.upfitAfterLabor)}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{fmtMoney(t.graphicsRevenue)}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{fmtMoney(t.graphicsLabor)}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{money(t.graphicsAfterLabor)}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{fmtMoney(t.sharedLabor)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Which items landed where, so you can spot anything on the wrong side.</div>
            <button style={{ ...btn, padding: '4px 10px', fontSize: '11px' }} onClick={exportItems}>All items CSV</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '14px' }}>
            <ItemsTable items={r.items} bucket="graphics" />
            <ItemsTable items={r.items} bucket="upfit" />
            <ItemsTable items={r.items} bucket="unsplit" />
            <ItemsTable items={r.items} bucket="excluded" />
          </div>
        </>
      )}
    </div>
  );
}
