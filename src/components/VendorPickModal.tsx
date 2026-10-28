'use client';

import { useEffect, useState } from 'react';
import { closeOnEscape } from '@/lib/modal-escape';
import { createClient } from '@/lib/supabase-browser';
import { looseOrFilter } from '@/lib/loose-search';
import { theme } from '@/lib/theme';

export interface PickedVendor {
  name: string;
  /** NetSuite internal id; null when the typed name was kept as is. */
  netsuiteId: string | null;
}

/**
 * The Purchasing row's Vendor button: search the NetSuite vendor mirror
 * (netsuite_vendors, synced nightly, readable by staff) so the request gets
 * the vendor's NetSuite id and Create PO doesn't ask for it again. A vendor
 * NetSuite doesn't have yet can still be kept as typed.
 */
export default function VendorPickModal({
  title, initialName, onPick, onClose,
}: {
  title: string;
  initialName: string;
  onPick: (v: PickedVendor) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialName);
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [searched, setSearched] = useState('');

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); setSearched(''); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const filter = looseOrFilter(['company_name', 'entity_id'], q);
      if (!filter) { if (!cancelled) { setResults([]); setSearched(q); } return; }
      const { data } = await createClient()
        .from('netsuite_vendors')
        .select('netsuite_id, company_name, entity_id')
        .eq('is_inactive', false)
        .or(filter)
        .order('company_name')
        .limit(10);
      if (!cancelled) {
        setResults((data || []).map((v: { netsuite_id: string; company_name: string | null; entity_id: string | null }) =>
          ({ id: v.netsuite_id, name: v.company_name || v.entity_id || v.netsuite_id })));
        setSearched(q);
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const typed = query.trim();
  const exact = results.some(r => r.name.trim().toLowerCase() === typed.toLowerCase());
  const row: React.CSSProperties = {
    display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px', background: 'transparent',
    border: 'none', borderBottom: `1px solid ${theme.border}`, color: theme.textPrimary, fontSize: '13px', cursor: 'pointer',
  };

  return (
    <div
      ref={closeOnEscape(onClose)}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '16px' }}
    >
      <div style={{ width: '100%', maxWidth: '420px', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary }}>{title}</div>
          <button onClick={onClose} title="Close" style={{ background: 'none', border: 'none', color: theme.textMuted, cursor: 'pointer', fontSize: '14px', padding: 0 }}>✕</button>
        </div>
        <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search NetSuite vendors"
          style={{ width: '100%', padding: '8px 10px', fontSize: '16px', background: theme.inputBg, color: theme.textPrimary, border: `1px solid ${theme.border}`, borderRadius: '8px', boxSizing: 'border-box' }} />
        <div style={{ marginTop: '8px', border: `1px solid ${theme.border}`, borderRadius: '8px', overflow: 'hidden' }}>
          {results.map(r => (
            <button key={r.id} onClick={() => onPick({ name: r.name, netsuiteId: r.id })} style={row}>
              {r.name}
            </button>
          ))}
          {searched && searched === typed && results.length === 0 && (
            <div style={{ padding: '9px 10px', fontSize: '12px', color: theme.textMuted, borderBottom: `1px solid ${theme.border}` }}>
              No NetSuite vendor matches “{typed}”.
            </div>
          )}
          {typed && !exact && (
            <button onClick={() => onPick({ name: typed, netsuiteId: null })} style={{ ...row, borderBottom: 'none', color: theme.textSecondary }}>
              Use “{typed}” as typed <span style={{ fontSize: '11px', color: theme.textMuted }}>(you’ll pick the NetSuite vendor at Create PO)</span>
            </button>
          )}
          {!typed && (
            <button onClick={() => onPick({ name: '', netsuiteId: null })} style={{ ...row, borderBottom: 'none', color: theme.textSecondary }}>
              Clear the vendor
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
