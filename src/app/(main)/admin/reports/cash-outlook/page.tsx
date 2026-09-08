'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';

/**
 * Cash Outlook — 4 weeks forward (R6-12).
 *
 * The page's job is to make the shape of the forecast's ignorance visible:
 * what is sidelined (overdue, unplaceable, beyond the horizon), what is
 * modelled rather than known (payroll), and what could not be read at all
 * (the bank balance). A cash chart with those quietly folded in is worse
 * than no chart.
 */

interface FlowLine { source: string; amount: number; count: number }
interface WeekBucket {
  weekStart: string;
  inflow: number;
  outflow: number;
  net: number;
  projectedBalance: number | null;
  inflowDetail: FlowLine[];
  outflowDetail: FlowLine[];
}
interface Outlook {
  today: string;
  weeks: WeekBucket[];
  startingCash: number | null;
  startingCashError: string | null;
  overdue: { amount: number; count: number };
  unplaceable: { amount: number; count: number };
  beyond: { amount: number; count: number };
  coverage: { byHistory: number; byTerms: number; unplaced: number };
  payroll: { weekly: number | null; basis: string | null; error: string | null };
  warnings: string[];
  meta: { horizonWeeks: number; minPaySamples: number; generatedAt: string };
}

const SOURCE_LABEL: Record<string, string> = {
  ar_history: 'Invoices, dated from how this customer actually pays',
  ar_terms: 'Invoices, dated from the stated terms',
  vendor_bills: 'Vendor bills',
  payouts: 'Approved installer payouts',
  payroll: 'Payroll (modelled run-rate)',
};

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const weekLabel = (start: string) => {
  const s = new Date(`${start}T12:00:00Z`);
  const e = new Date(Date.parse(`${start}T12:00:00Z`) + 6 * 86_400_000);
  const f = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${f(s)} – ${f(e)}`;
};

export default function CashOutlookPage() {
  const { isAdmin, hasFeature, loading: authLoading } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<Outlook | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mirrors the route's requireFinancials — super_admin / executive only.
  const allowed = hasFeature('financials');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/reports/cash-outlook');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Report failed');
      setData(json as Outlook);
    } catch (e: any) {
      setError(e.message || 'Report failed');
      setData(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!allowed) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasFeature identity changes per render; auth state deps cover it
  }, [authLoading, isAdmin, router, load]);

  if (authLoading || !allowed) return null;

  const maxFlow = Math.max(1, ...(data?.weeks || []).flatMap(w => [w.inflow, w.outflow]));

  return (
    <div style={{ maxWidth: '900px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Cash Outlook — next 4 weeks</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Expected collections placed at the date each customer <em>actually</em> pays — not the date the invoice says — minus
        vendor bills at their due dates, approved payouts, and payroll. Everything this forecast can&rsquo;t see is named below
        rather than folded in.
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', marginBottom: '12px' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {data && !loading && (
        <>
          {data.warnings.length > 0 && (
            <div style={{ border: '1px solid #f59e0b', background: '#f59e0b14', borderRadius: '12px', padding: '12px 16px', marginBottom: '14px' }}>
              <div style={{ fontSize: '12px', fontWeight: 800, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: '5px' }}>
                What this forecast does not know
              </div>
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12.5px' }}>
                {data.warnings.map((w, i) => <li key={i} style={{ marginBottom: '3px' }}>{w}</li>)}
              </ul>
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', minWidth: '160px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Cash today</div>
              <div style={{ fontSize: '22px', fontWeight: 800, marginTop: '2px' }}>
                {data.startingCash == null ? '—' : fmtMoney(data.startingCash)}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {data.startingCash == null ? (data.startingCashError || 'unavailable') : 'bank accounts, from NetSuite'}
              </div>
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', minWidth: '160px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>In 4 weeks</div>
              <div style={{
                fontSize: '22px', fontWeight: 800, marginTop: '2px',
                color: data.weeks[3]?.projectedBalance == null ? 'inherit'
                  : data.weeks[3].projectedBalance < 0 ? '#ef4444' : '#22c55e',
              }}>
                {data.weeks[3]?.projectedBalance == null ? '—' : fmtMoney(data.weeks[3].projectedBalance)}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>projected, on these assumptions</div>
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', minWidth: '160px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Late, not counted</div>
              <div style={{ fontSize: '22px', fontWeight: 800, marginTop: '2px', color: data.overdue.amount > 0 ? '#f59e0b' : 'inherit' }}>
                {data.overdue.amount > 0 ? fmtMoney(data.overdue.amount) : '—'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {data.overdue.count} invoice{data.overdue.count === 1 ? '' : 's'} past their usual pay date
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gap: '10px', marginBottom: '14px' }}>
            {data.weeks.map((w, i) => (
              <div key={w.weekStart} style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', background: 'var(--card)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ fontWeight: 800, fontSize: '14px' }}>
                    {i === 0 ? 'This week' : `Week ${i + 1}`}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 500, marginLeft: '8px', fontSize: '12px' }}>{weekLabel(w.weekStart)}</span>
                  </div>
                  <div style={{ fontSize: '13px' }}>
                    <span style={{ color: w.net >= 0 ? '#22c55e' : '#ef4444', fontWeight: 800 }}>
                      {w.net >= 0 ? '+' : ''}{fmtMoney(w.net)}
                    </span>
                    {w.projectedBalance != null && (
                      <span style={{ color: 'var(--text-muted)' }}> → {fmtMoney(w.projectedBalance)}</span>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '8px' }}>
                  <div style={{ width: '46px', fontSize: '11px', color: 'var(--text-muted)' }}>In</div>
                  <div style={{ flex: 1, background: 'var(--border)', borderRadius: '4px', height: '12px', overflow: 'hidden' }}>
                    <div style={{ width: `${(w.inflow / maxFlow) * 100}%`, background: '#22c55e', height: '100%' }} />
                  </div>
                  <div style={{ width: '90px', textAlign: 'right', fontSize: '12px', fontWeight: 700 }}>{fmtMoney(w.inflow)}</div>
                </div>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '4px' }}>
                  <div style={{ width: '46px', fontSize: '11px', color: 'var(--text-muted)' }}>Out</div>
                  <div style={{ flex: 1, background: 'var(--border)', borderRadius: '4px', height: '12px', overflow: 'hidden' }}>
                    <div style={{ width: `${(w.outflow / maxFlow) * 100}%`, background: '#ef4444', height: '100%' }} />
                  </div>
                  <div style={{ width: '90px', textAlign: 'right', fontSize: '12px', fontWeight: 700 }}>{fmtMoney(w.outflow)}</div>
                </div>

                {(w.inflowDetail.length > 0 || w.outflowDetail.length > 0) && (
                  <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '7px' }}>
                    {[...w.inflowDetail, ...w.outflowDetail].map(l => (
                      <div key={l.source}>
                        {SOURCE_LABEL[l.source] || l.source}: {fmtMoney(l.amount)}
                        {l.source !== 'payroll' && ` · ${l.count} record${l.count === 1 ? '' : 's'}`}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', fontSize: '12.5px' }}>
            <div style={{ fontWeight: 800, marginBottom: '6px' }}>How the collections were dated</div>
            <div style={{ color: 'var(--text-muted)' }}>
              <div>{fmtMoney(data.coverage.byHistory)} placed from this customer&rsquo;s own payment history ({data.meta.minPaySamples}+ paid invoices).</div>
              <div>{fmtMoney(data.coverage.byTerms)} placed from the invoice&rsquo;s stated due date, for want of enough history.</div>
              {data.coverage.unplaced > 0 && (
                <div style={{ color: '#f59e0b' }}>{fmtMoney(data.coverage.unplaced)} could not be dated at all and is in none of the weeks above.</div>
              )}
              {data.beyond.amount > 0 && (
                <div>{fmtMoney(data.beyond.amount)} is expected after this 4-week window.</div>
              )}
            </div>
            <div style={{ fontWeight: 800, margin: '10px 0 6px' }}>Payroll</div>
            <div style={{ color: 'var(--text-muted)' }}>
              {data.payroll.weekly == null
                ? `Not included — ${data.payroll.error || 'unavailable'}. The outflow side is understated.`
                : `${fmtMoney(data.payroll.weekly)}/week — ${data.payroll.basis}. FleetSuite does not know your pay dates (payroll runs elsewhere), so this is spread evenly rather than spiked on a date it would be inventing. The 4-week total is right; the shape inside a fortnight is approximate.`}
            </div>
          </div>

          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px' }}>
            Weeks run Monday–Sunday on the shop calendar. Money already past the date a customer normally pays is shown as
            &ldquo;late, not counted&rdquo; rather than assumed to land next week. A payable with no due date, or already past it,
            IS counted this week — an unknown payable is not optional.
            Generated {new Date(data.meta.generatedAt).toLocaleString()}.
          </div>
        </>
      )}
    </div>
  );
}
