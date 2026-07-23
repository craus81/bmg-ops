'use client';

/**
 * Home → Financials tab (super_admin + executive only). A/R aging, A/P,
 * cash, and net position, sourced from NetSuite via /api/reports/financials.
 * Net position = Cash + A/R − A/P; it reads green when positive, red when
 * negative. Balances come straight off the GL accounts (cash from Bank
 * accounts, A/P from the payables control account, card from Credit Card
 * accounts), so nothing needs to be mapped by hand.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';

interface Overdue { customer: string; amount: number; days: number }
interface CardLine { id: string; name: string; owed: number }
interface FinancialsData {
  ar: {
    total: number; pastDue: number; openCount: number;
    buckets: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number };
    topOverdue: Overdue[];
  };
  ap: { vendorBills: number; cardOwed: number; total: number; cards: CardLine[] };
  cash: number;
  net: number;
}

const AGE = {
  current: 'var(--success)',
  d1_30: '#facc15',
  d31_60: '#f59e0b',
  d61_90: '#fb7a34',
  d90plus: 'var(--error)',
};

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '15px 16px' };
const eyebrow: React.CSSProperties = { fontSize: '11px', fontWeight: 800, letterSpacing: '.8px', textTransform: 'uppercase', color: 'var(--text-muted)' };
const bigNum: React.CSSProperties = { fontSize: '30px', fontWeight: 800, letterSpacing: '-1px', lineHeight: 1, margin: '9px 0 3px', fontVariantNumeric: 'tabular-nums' };

function Tile({ swatch, label, value, sub, valueColor }: { swatch: string; label: string; value: string; sub?: React.ReactNode; valueColor?: string }) {
  return (
    <div style={card}>
      <div style={{ ...eyebrow, display: 'flex', alignItems: 'center', gap: '7px' }}>
        <span style={{ width: '9px', height: '9px', borderRadius: '3px', background: swatch, flexShrink: 0 }} />{label}
      </div>
      <div style={{ ...bigNum, color: valueColor || 'var(--text-primary)' }}>{value}</div>
      {sub && <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{sub}</div>}
    </div>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: '12.5px' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      {value && <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: valueColor ? 700 : 600, color: valueColor || 'var(--text-secondary)' }}>{value}</span>}
    </div>
  );
}

export default function FinancialsDashboard() {
  const [data, setData] = useState<FinancialsData | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const { ar, ap, cash, net } = data;
  const b = ar.buckets;
  const bucketRows: { key: keyof typeof AGE; label: string; amt: number }[] = [
    { key: 'current', label: 'Current — not yet due', amt: b.current },
    { key: 'd1_30', label: '1–30 days past due', amt: b.d1_30 },
    { key: 'd31_60', label: '31–60 days past due', amt: b.d31_60 },
    { key: 'd61_90', label: '61–90 days past due', amt: b.d61_90 },
    { key: 'd90plus', label: '90+ days past due', amt: b.d90plus },
  ];
  const netColor = net >= 0 ? 'var(--success)' : 'var(--error)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>

      {/* Hero */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
        <Tile swatch="var(--navy, #4d8ba6)" label="Cash on hand" value={usd(cash)} sub="Bank accounts · reconciled in NetSuite" />
        <Tile swatch="var(--success)" label="Owed to us · A/R" value={usd(ar.total)}
          sub={<>{ar.openCount} open · <span style={{ color: 'var(--error)', fontWeight: 700 }}>{usd(ar.pastDue)} past due</span></>} />
        <Tile swatch="var(--error)" label="We owe · A/P" value={usd(ap.total)}
          sub={<>Bills {usd(ap.vendorBills)} · Card {usd(ap.cardOwed)}</>} />
        <Tile swatch={netColor} label="Net position" value={`${net >= 0 ? '+' : '−'}${usd(Math.abs(net))}`} valueColor={netColor}
          sub="Cash + A/R − A/P" />
      </div>

      {/* A/R aging */}
      <div>
        <div style={{ ...eyebrow, margin: '2px 2px 10px' }}>Accounts receivable — aging</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', gap: '12px' }} className="fin-ar">
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
              <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)', fontWeight: 600 }}>Total outstanding</span>
              <span style={{ fontSize: '15px', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{usd(ar.total)}</span>
            </div>
            <div style={{ display: 'flex', gap: '2px', height: '24px', borderRadius: '7px', overflow: 'hidden', margin: '10px 0 14px' }}>
              {bucketRows.filter(r => r.amt > 0).map(r => (
                <div key={r.key} title={`${r.label} · ${usd(r.amt)} (${pct(r.amt, ar.total)}%)`}
                  style={{ flex: r.amt, minWidth: '4px', background: AGE[r.key] }} />
              ))}
            </div>
            <div>
              {bucketRows.map(r => (
                <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '14px 1fr auto auto', alignItems: 'center', gap: '10px', padding: '8px 2px', borderTop: '1px solid var(--border)' }}>
                  <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: AGE[r.key] }} />
                  <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 600 }}>{r.label}</span>
                  <span style={{ fontSize: '13.5px', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: r.key === 'd90plus' && r.amt > 0 ? 'var(--error)' : 'var(--text-primary)' }}>{usd(r.amt)}</span>
                  <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', minWidth: '36px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{pct(r.amt, ar.total)}%</span>
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
                    <tr key={i}>
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
          <div style={card}>
            <div style={eyebrow}>Vendor bills</div>
            <div style={{ ...bigNum, fontSize: '25px' }}>{usd(ap.vendorBills)}</div>
            <Row label="Unpaid vendor bills" value="A/P control" />
          </div>
          <div style={card}>
            <div style={eyebrow}>Credit card balance</div>
            <div style={{ ...bigNum, fontSize: '25px' }}>{usd(ap.cardOwed)}</div>
            {ap.cards.length > 0
              ? ap.cards.map(c => <Row key={c.id} label={c.name} value={usd(c.owed)} />)
              : <Row label="No card balances owed" value="" />}
          </div>
        </div>
      </div>

      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', lineHeight: 1.6, borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
        Live from NetSuite · Cash from bank accounts, A/P from the payables control account + credit cards, A/R aged from open customer invoices. Net position = Cash + A/R − A/P.
      </div>

      <style>{`@media (max-width:760px){ .fin-ar{ grid-template-columns:1fr !important; } }`}</style>
    </div>
  );
}
