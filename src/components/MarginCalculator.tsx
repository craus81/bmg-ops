'use client';

/**
 * Margin calculator for pricing requests (owner, 2026-10-08): pick a margin
 * from a list of options, either direction.
 *   Cost → price: what to charge for a vendor cost at each margin.
 *   Price → vendor budget: the most a vendor can charge at each margin for
 *   a selling price (the quote, or a price Masterack is aiming for).
 * Margin is gross margin on the selling price. Tapping a row picks that
 * margin as the request's target.
 */

import { useEffect, useState } from 'react';
import { MARGIN_OPTIONS, costForMargin, priceForMargin } from '@/lib/pricing-request';

const fmtMoney = (n: number | null) =>
  n == null ? '—' : '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const parse = (s: string) => {
  const v = Number(String(s).replace(/[$,\s]/g, ''));
  return String(s).trim() === '' || !Number.isFinite(v) ? null : v;
};

export default function MarginCalculator({
  cost, price, targetMargin, onPickMargin,
}: {
  /** Starting vendor cost (the request's vendor cost). */
  cost: number | null;
  /** Starting selling price (the quoted graphic price). */
  price: number | null;
  targetMargin: number | null;
  onPickMargin?: (margin: number) => void;
}) {
  const [mode, setMode] = useState<'price' | 'budget'>('price');
  const [amount, setAmount] = useState('');

  // Follow the request's numbers until someone types their own.
  const start = mode === 'price' ? cost : price;
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setAmount(start != null && start > 0 ? String(start) : '');
  }, [start, touched]);

  const value = parse(amount);
  const margins = Array.from(new Set([...MARGIN_OPTIONS, ...(targetMargin != null ? [targetMargin] : [])])).sort((a, b) => a - b);

  const tab = (key: 'price' | 'budget', text: string) => (
    <button
      type="button"
      onClick={() => { setMode(key); setTouched(false); }}
      style={{
        padding: '5px 10px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
        border: `1px solid ${mode === key ? '#2563eb' : 'var(--border)'}`,
        background: mode === key ? 'rgba(37,99,235,0.12)' : 'transparent',
        color: mode === key ? '#60a5fa' : 'var(--text-secondary)',
      }}
    >{text}</button>
  );

  const th: React.CSSProperties = { textAlign: 'right', fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)', padding: '4px 6px' };
  const td: React.CSSProperties = { textAlign: 'right', padding: '5px 6px', fontVariantNumeric: 'tabular-nums', fontSize: '13px' };

  return (
    <div style={{ marginTop: '10px', padding: '10px', borderRadius: '10px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
        {tab('price', 'Cost → price')}
        {tab('budget', 'Price → vendor budget')}
        <input
          inputMode="decimal"
          value={amount}
          onChange={e => { setAmount(e.target.value); setTouched(true); }}
          placeholder={mode === 'price' ? 'Vendor cost $' : 'Selling price $'}
          style={{ flex: 1, minWidth: '120px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '16px' }}
        />
      </div>
      {value == null || value <= 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {mode === 'price' ? 'Enter what the vendor charges to see the price at each margin.' : 'Enter a selling price to see the most a vendor can charge at each margin.'}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Margin</th>
              <th style={th}>{mode === 'price' ? 'Charge' : 'Max vendor cost'}</th>
              <th style={th}>Profit</th>
            </tr>
          </thead>
          <tbody>
            {margins.map(m => {
              const result = mode === 'price' ? priceForMargin(value, m) : costForMargin(value, m);
              const profit = result == null ? null : mode === 'price' ? result - value : value - result;
              const isTarget = targetMargin != null && m === targetMargin;
              return (
                <tr
                  key={m}
                  onClick={onPickMargin ? () => onPickMargin(m) : undefined}
                  title={onPickMargin ? 'Use this margin as the target' : undefined}
                  style={{ cursor: onPickMargin ? 'pointer' : undefined, background: isTarget ? 'rgba(74,222,128,0.10)' : undefined }}
                >
                  <td style={{ ...td, textAlign: 'left', fontWeight: isTarget ? 800 : 600 }}>{m}%{isTarget ? ' (target)' : ''}</td>
                  <td style={{ ...td, fontWeight: 700, color: 'var(--text-primary)' }}>{fmtMoney(result)}</td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{fmtMoney(profit == null ? null : Math.round(profit * 100) / 100)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
