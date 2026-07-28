'use client';

/**
 * Home → Financials tab (super_admin + executive only). A/R aging, A/P,
 * cash, and net position, sourced from NetSuite via /api/reports/financials.
 * Net position = Cash + A/R − A/P; green when positive, red when negative.
 * Cash / card / A/P are GL account balances from the financials RESTlet; until
 * it's deployed those tiles show "—" with a hint (A/R works without it).
 *
 * Every tile, aging row, and overdue account is clickable — it opens the
 * FinancialsDrilldown modal with the transactions/accounts behind that
 * number (verify the totals, chase past dues, print statements/invoices/
 * bills) without leaving FleetSuite.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import FinancialsDrilldown, { AGE_META, DrillTarget } from './FinancialsDrilldown';

export interface Overdue { key: string; customer: string; amount: number; days: number }
export interface FinancialsData {
  ar: {
    total: number; pastDue: number; openCount: number;
    buckets: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number };
    topOverdue: Overdue[];
  };
  ap: { vendorBills: number | null; cardOwed: number | null; total: number | null };
  cash: number | null;
  net: number | null;
  config: { balancesOk: boolean; balancesError: string | null; bankConfigured: boolean; cardConfigured: boolean; apConfigured: boolean };
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money = (n: number | null) => (n === null ? '—' : usd(n));
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '15px 16px' };
const eyebrow: React.CSSProperties = { fontSize: '11px', fontWeight: 800, letterSpacing: '.8px', textTransform: 'uppercase', color: 'var(--text-muted)' };
const bigNum: React.CSSProperties = { fontSize: '30px', fontWeight: 800, letterSpacing: '-1px', lineHeight: 1, margin: '9px 0 3px', fontVariantNumeric: 'tabular-nums' };
const hint: React.CSSProperties = { color: 'var(--warning)' };

function Tile({ swatch, label, value, sub, valueColor, onClick }: {
  swatch: string; label: string; value: string; sub?: React.ReactNode; valueColor?: string; onClick?: () => void;
}) {
  return (
    <div
      style={{ ...card, position: 'relative', cursor: onClick ? 'pointer' : undefined }}
      className={onClick ? 'fin-click' : undefined}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <div style={{ ...eyebrow, display: 'flex', alignItems: 'center', gap: '7px' }}>
        <span style={{ width: '9px', height: '9px', borderRadius: '3px', background: swatch, flexShrink: 0 }} />{label}
      </div>
      {onClick && <span aria-hidden style={{ position: 'absolute', top: '13px', right: '14px', color: 'var(--text-muted)', fontSize: '14px', fontWeight: 700 }}>›</span>}
      <div style={{ ...bigNum, color: valueColor || 'var(--text-primary)' }}>{value}</div>
      {sub && <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{sub}</div>}
    </div>
  );
}

function Row({ label, value, valueColor }: { label: string; value: React.ReactNode; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: '12.5px' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      {value && <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: valueColor ? 700 : 600, color: valueColor || 'var(--text-secondary)' }}>{value}</span>}
    </div>
  );
}

/** Small "view more" affordance for section headers. */
function HeaderLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11.5px', fontWeight: 700, color: 'var(--text-muted)', padding: '2px 4px' }}>
      {label} ›
    </button>
  );
}

export default function FinancialsDashboard() {
  const [data, setData] = useState<FinancialsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillTarget | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiFetch('/api/reports/financials');
        const body = await res.json();
        if (!alive) return;
        if (!res.ok) { setError(body?.error || 'Failed to load financials'); return; }
        setData(body);
      } catch {
        if (alive) setError('Could not reach NetSuite. Try again in a moment.');
      }
    })();
    return () => { alive = false; };
  }, []);

  if (error) {
    return (
      <div style={{ ...card, textAlign: 'center', color: 'var(--text-muted)', padding: '40px 16px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)' }}>{error}</div>
        <div style={{ fontSize: '12px', marginTop: '6px' }}>A/R, A/P, and balances come live from NetSuite.</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ textAlign: 'center', padding: '50px 0' }}>
        <div style={{ width: '32px', height: '32px', border: '3px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>Pulling from NetSuite…</div>
      </div>
    );
  }

  const { ar, ap, cash, net, config } = data;
  const b = ar.buckets;
  const bucketRows = AGE_META.map(m => ({ key: m.key, label: m.label, color: m.color, amt: b[m.key] }));
  const netColor = net === null ? 'var(--text-muted)' : net >= 0 ? 'var(--success)' : 'var(--error)';
  const netValue = net === null ? '—' : `${net >= 0 ? '+' : '−'}${usd(Math.abs(net))}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>

      {!config.balancesOk && (
        <div style={{ ...card, padding: '11px 14px', fontSize: '12px', color: 'var(--text-secondary)', borderColor: 'color-mix(in srgb, var(--warning) 35%, var(--border))' }}>
          <span style={{ color: 'var(--warning)', fontWeight: 700 }}>Cash, cards & A/P unavailable.</span>{' '}
          {config.balancesError
            ? <>NetSuite said: <code style={{ color: 'var(--text-primary)' }}>{config.balancesError}</code>{' '}
                {/permission|account/i.test(config.balancesError) && <>— the RESTlet runs under the integration role, so grant it <code>Lists &gt; Accounts: View</code>.</>}</>
            : <>Deploy <code>scripts/netsuite-financials-restlet.js</code> and set <code>NETSUITE_FINANCIALS_RESTLET_URL</code>.</>}
          {' '}A/R is live below either way.
        </div>
      )}

      {/* Hero */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
        <Tile swatch="var(--navy, #4d8ba6)" label="Cash on hand" value={money(cash)}
          onClick={() => setDrill({ view: 'cash' })}
          sub={config.balancesOk ? 'Reconciled in NetSuite' : <span style={hint}>Balances RESTlet not deployed</span>} />
        <Tile swatch="var(--success)" label="Owed to us · A/R" value={usd(ar.total)}
          onClick={() => setDrill({ view: 'ar' })}
          sub={<>{ar.openCount} open · <span
            onClick={(e) => { e.stopPropagation(); setDrill({ view: 'ar', bucket: 'pastdue' }); }}
            style={{ color: 'var(--error)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'color-mix(in srgb, var(--error) 45%, transparent)', textUnderlineOffset: '3px' }}
            title="See past-due invoices">{usd(ar.pastDue)} past due</span></>} />
        <Tile swatch="var(--error)" label="We owe · A/P" value={money(ap.total)}
          onClick={() => setDrill({ view: 'bills' })}
          sub={<>Bills {money(ap.vendorBills)} · Card {money(ap.cardOwed)}</>} />
        <Tile swatch={netColor} label="Net position" value={netValue} valueColor={netColor} sub="Cash + A/R − A/P"
          onClick={() => setDrill({ view: 'net' })} />
      </div>

      {/* A/R aging */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', margin: '2px 2px 10px' }}>
          <div style={eyebrow}>Accounts receivable — aging</div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <HeaderLink label="All invoices" onClick={() => setDrill({ view: 'ar' })} />
            <HeaderLink label="Statements" onClick={() => setDrill({ view: 'ar', grouped: true })} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', gap: '12px' }} className="fin-ar">
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
              <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)', fontWeight: 600 }}>Total outstanding</span>
              <span style={{ fontSize: '15px', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{usd(ar.total)}</span>
            </div>
            <div style={{ display: 'flex', gap: '2px', height: '24px', borderRadius: '7px', overflow: 'hidden', margin: '10px 0 14px' }}>
              {bucketRows.filter(r => r.amt > 0).map(r => (
                <div key={r.key} title={`${r.label} · ${usd(r.amt)} (${pct(r.amt, ar.total)}%) — click to view`}
                  onClick={() => setDrill({ view: 'ar', bucket: r.key })}
                  style={{ flex: r.amt, minWidth: '4px', background: r.color, cursor: 'pointer' }} />
              ))}
            </div>
            <div>
              {bucketRows.map(r => (
                <div key={r.key} role="button" tabIndex={0} className="fin-click"
                  onClick={() => setDrill({ view: 'ar', bucket: r.key })}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrill({ view: 'ar', bucket: r.key }); } }}
                  style={{ display: 'grid', gridTemplateColumns: '14px 1fr auto auto 14px', alignItems: 'center', gap: '10px', padding: '8px 2px', borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                  <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: r.color }} />
                  <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 600 }}>{r.label}</span>
                  <span style={{ fontSize: '13.5px', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: r.key === 'd90plus' && r.amt > 0 ? 'var(--error)' : 'var(--text-primary)' }}>{usd(r.amt)}</span>
                  <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', minWidth: '36px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{pct(r.amt, ar.total)}%</span>
                  <span aria-hidden style={{ color: 'var(--text-muted)', fontSize: '13px', fontWeight: 700, textAlign: 'right' }}>›</span>
                </div>
              ))}
            </div>
          </div>

          <div style={card}>
            <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '4px' }}>Top overdue accounts</div>
            {ar.topOverdue.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '16px 0', textAlign: 'center' }}>Nothing past due 🎉</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {ar.topOverdue.map((o, i) => (
                    <tr key={i} className="fin-click" role="button" tabIndex={0}
                      onClick={() => setDrill({ view: 'ar', bucket: 'pastdue', customer: { key: o.key, name: o.customer } })}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrill({ view: 'ar', bucket: 'pastdue', customer: { key: o.key, name: o.customer } }); } }}
                      style={{ cursor: 'pointer' }} title="See this customer's invoices">
                      <td style={{ padding: '9px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{o.customer}</td>
                      <td style={{ padding: '9px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: '13px', fontWeight: 700, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(o.amount)}</td>
                      <td style={{ padding: '9px 0 9px 10px', borderTop: i ? '1px solid var(--border)' : 'none', textAlign: 'right' }}>
                        <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', color: o.days > 90 ? 'var(--error)' : o.days > 60 ? '#fb7a34' : o.days > 30 ? '#f59e0b' : '#facc15', background: 'var(--subtle-bg)' }}>{o.days}d</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* A/P */}
      <div>
        <div style={{ ...eyebrow, margin: '2px 2px 10px' }}>Accounts payable — what we owe</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
          <div style={{ ...card, position: 'relative', cursor: 'pointer' }} className="fin-click" role="button" tabIndex={0}
            onClick={() => setDrill({ view: 'bills' })}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrill({ view: 'bills' }); } }}>
            <div style={eyebrow}>Vendor bills</div>
            <span aria-hidden style={{ position: 'absolute', top: '13px', right: '14px', color: 'var(--text-muted)', fontSize: '14px', fontWeight: 700 }}>›</span>
            <div style={{ ...bigNum, fontSize: '25px' }}>{money(ap.vendorBills)}</div>
            <Row label="Unpaid vendor bills" value={config.apConfigured ? 'A/P control account' : <span style={hint}>Set A/P account ID</span>} />
          </div>
          <div style={{ ...card, position: 'relative', cursor: 'pointer' }} className="fin-click" role="button" tabIndex={0}
            onClick={() => setDrill({ view: 'cards' })}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrill({ view: 'cards' }); } }}>
            <div style={eyebrow}>Credit card balance</div>
            <span aria-hidden style={{ position: 'absolute', top: '13px', right: '14px', color: 'var(--text-muted)', fontSize: '14px', fontWeight: 700 }}>›</span>
            <div style={{ ...bigNum, fontSize: '25px' }}>{money(ap.cardOwed)}</div>
            <Row label="Balances owed on cards" value={config.cardConfigured ? 'From NetSuite' : <span style={hint}>Set card account ID(s)</span>} />
          </div>
        </div>
      </div>

      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', lineHeight: 1.6, borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
        Live from NetSuite · Cash / A/P / cards from GL account balances (financials RESTlet), A/R aged from open customer invoices. Net position = Cash + A/R − A/P.
        {' '}Click any tile or row to see the transactions behind it, chase past dues, and print statements, invoices, and bills.
      </div>

      {drill && <FinancialsDrilldown target={drill} summary={data} onClose={() => setDrill(null)} />}

      <style>{`
        @media (max-width:760px){ .fin-ar{ grid-template-columns:1fr !important; } }
        /* !important so the hover beats the inline background/border on the
           tiles — otherwise the clickable cards give no feedback at all. */
        .fin-click:hover { background: var(--card-hover, var(--subtle-bg)) !important; border-color: var(--border-strong) !important; }
      `}</style>
    </div>
  );
}
