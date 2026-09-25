'use client';

import { useState, useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase-browser';
import {
  cleanPartQuery, partSearchFilter, rankPartSuggestions, latestPoPrices,
  type PartSuggestion, type LastPoPrice,
} from '@/lib/part-suggest';

export type { LastPoPrice } from '@/lib/part-suggest';
export interface PickedPartHit extends PartSuggestion {
  /** This customer's most recent PO price for the part, if any. */
  lastPo?: LastPoPrice;
}

const money = (n: number) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const shortDate = (d: string | null) => {
  const m = (d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1].slice(2)}` : '';
};

/** "Last PO $12.00 · #4512 · 6/1/26" */
export function lastPoLabel(lp: LastPoPrice): string {
  return [`Last PO ${money(lp.price)}`, lp.poNumber ? `#${lp.poNumber}` : '', shortDate(lp.date)].filter(Boolean).join(' · ');
}

/**
 * The PO "Add Part" field: a plain part-number input that suggests catalog
 * parts as you type (debounced server-side search — netsuite_parts is too
 * big to trust a client copy), with the parts list sell price and this
 * customer's last PO price on each row. Free text still works for parts
 * that aren't in the catalog; Enter with no row highlighted calls onEnter.
 */
export default function PartNumberAutocomplete({
  value,
  onChange,
  onPick,
  onEnter,
  customer,
  excludePoId,
  placeholder = 'Type a part number…',
  style,
}: {
  value: string;
  onChange: (text: string) => void;
  onPick: (hit: PickedPartHit) => void;
  onEnter?: () => void;
  customer: string;
  /** PO being edited — its own lines don't count as "last PO". */
  excludePoId?: string | null;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const supabase = createClient();
  const [hits, setHits] = useState<PickedPartHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  // A pick writes the picked number into the box; don't search it again
  // until the user types.
  const picked = useRef<string | null>(null);
  const poCache = useRef(new Map<string, Map<string, any>>());

  useEffect(() => {
    if (picked.current !== null && value === picked.current) return;
    const cleaned = cleanPartQuery(value);
    const mySeq = ++seq.current;
    if (!cleaned) { setHits([]); setLoading(false); return; }
    setLoading(true);
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('netsuite_parts')
        .select('id, item_number, display_name, sales_price, customer, billable_customer')
        .eq('is_active', true)
        .or(partSearchFilter(cleaned))
        .order('item_number')
        .limit(40);
      if (mySeq !== seq.current) return;
      const ranked: PickedPartHit[] = rankPartSuggestions((data as PartSuggestion[]) || [], cleaned, customer).slice(0, 12);

      // This customer's last PO price for each suggestion (best-effort).
      const cust = customer.trim();
      if (cust && ranked.length) {
        // The customer's newest POs (cached per customer), then their lines
        // for these parts — a busy customer has too many lines to read
        // unordered. 100 ids keeps the request URL comfortably short.
        let poById = poCache.current.get(cust.toLowerCase());
        if (!poById) {
          const { data: custPos, error: posErr } = await supabase
            .from('purchase_orders')
            .select('id, po_number, ordered_date, created_at')
            .ilike('customer', cust.replace(/[\\%_]/g, '\\$&'))
            .order('created_at', { ascending: false })
            .order('id')
            .limit(100);
          if (mySeq !== seq.current) return;
          poById = new Map(((custPos as any[]) || []).map(p => [p.id as string, p]));
          if (!posErr) poCache.current.set(cust.toLowerCase(), poById);
        }
        const nums = [...new Set(ranked.flatMap(h => [h.item_number, h.item_number.toUpperCase()]))];
        const { data: lines } = poById.size
          ? await supabase
              .from('po_line_items')
              .select('part_number, unit_price, po_id')
              .in('po_id', [...poById.keys()])
              .in('part_number', nums)
              .limit(1000)
          : { data: [] };
        if (mySeq !== seq.current) return;
        const pos = poById;
        const rows = ((lines as any[]) || []).map(l => ({ ...l, purchase_orders: pos.get(l.po_id) || null }));
        const last = latestPoPrices(rows, excludePoId);
        for (const h of ranked) {
          const lp = last.get(h.item_number.toUpperCase());
          if (lp) h.lastPo = lp;
        }
      }
      setHits(ranked);
      setActive(-1);
      setLoading(false);
    }, 200);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [value, customer, excludePoId]);

  const pick = (h: PickedPartHit) => {
    picked.current = h.item_number;
    setOpen(false);
    setHits([]);
    setActive(-1);
    onPick(h);
  };

  const showList = open && cleanPartQuery(value) !== '';

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={value}
        onChange={e => { picked.current = null; onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, hits.length - 1)); }
          else if (e.key === 'ArrowUp' && hits.length) { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          else if (e.key === 'Escape') setOpen(false);
          else if (e.key === 'Enter') {
            e.preventDefault();
            if (showList && active >= 0 && hits[active]) pick(hits[active]);
            else { setOpen(false); onEnter?.(); }
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        style={style}
      />
      {showList && (hits.length > 0 || loading) && (
        <div
          style={{
            position: 'absolute', left: 0, right: 0, top: '100%', marginTop: '4px', zIndex: 50,
            maxHeight: '260px', overflowY: 'auto', borderRadius: '8px',
            background: 'var(--card)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          }}
        >
          {hits.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: '11px', color: 'var(--text-muted)' }}>Searching parts…</div>
          )}
          {hits.map((h, i) => (
            <button
              key={h.id}
              type="button"
              // mousedown, not click: fires before the input's blur closes the list.
              onMouseDown={e => { e.preventDefault(); pick(h); }}
              onMouseEnter={() => setActive(i)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
                width: '100%', padding: '8px 10px', textAlign: 'left', cursor: 'pointer', border: 'none',
                borderBottom: '1px solid var(--border)',
                background: i === active ? 'var(--subtle-bg)' : 'transparent',
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>{h.item_number}</span>
                {h.display_name && (
                  <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {h.display_name}
                  </span>
                )}
              </span>
              <span style={{ textAlign: 'right', flexShrink: 0 }}>
                <span style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>
                  {Number(h.sales_price) > 0 ? money(Number(h.sales_price)) : 'No price'}
                </span>
                {h.lastPo && <span style={{ display: 'block', fontSize: '10px', color: '#60a5fa' }}>{lastPoLabel(h.lastPo)}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
