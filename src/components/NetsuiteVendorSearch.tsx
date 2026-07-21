'use client';

import { useState, useEffect } from 'react';

export interface NsVendor {
  id: string;         // numeric Internal ID — the one bills need
  entityId: string;
  companyName: string;
  email: string | null;
  phone: string | null;
  address: { street: string; city: string; state: string; zip: string } | null;
}

/**
 * Debounced live search against existing NetSuite vendors
 * (/api/cni/search-vendors, admin-only). Selecting a result hands the vendor
 * to the caller — this component never writes anything itself, so callers
 * decide whether to link a company, fill a field, or import a new record.
 */
export default function NetsuiteVendorSearch({
  onSelect,
  placeholder = 'Search NetSuite vendors by name…',
  autoFocus = false,
}: {
  onSelect: (v: NsVendor) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NsVendor[]>([]);
  const [state, setState] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); setState('idle'); setError(null); return; }
    setState('searching');
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/cni/search-vendors?q=${encodeURIComponent(q)}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok && !data.error) {
          setResults(data.vendors || []);
          setError(null);
          setState('done');
        } else {
          setResults([]);
          setError(data.error || `Search failed (${res.status})`);
          setState('error');
        }
      } catch (err: any) {
        setResults([]);
        setError(err.message || 'Network error');
        setState('error');
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div>
      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        style={{
          width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '14px',
          border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
        }}
      />
      {state === 'searching' && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>Searching NetSuite…</div>
      )}
      {state === 'error' && (
        <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--error)', marginTop: '6px' }}>{error}</div>
      )}
      {state === 'done' && results.length === 0 && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
          No NetSuite vendors match &ldquo;{query.trim()}&rdquo;.
        </div>
      )}
      {results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
          {results.map(v => (
            <button
              key={v.id}
              onClick={() => onSelect(v)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
                width: '100%', textAlign: 'left', padding: '8px 12px', borderRadius: '8px',
                background: 'var(--subtle-bg)', border: '1px solid var(--border)', cursor: 'pointer',
              }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {v.companyName || v.entityId}
                </span>
                {v.entityId && v.entityId !== v.companyName && (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '6px' }}>{v.entityId}</span>
                )}
                {(v.email || v.phone || v.address) && (
                  <span style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)' }}>
                    {[v.email, v.phone, v.address ? [v.address.city, v.address.state].filter(Boolean).join(', ') : null].filter(Boolean).join(' · ')}
                  </span>
                )}
              </span>
              <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--orange)', whiteSpace: 'nowrap' }}>
                #{v.id}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
