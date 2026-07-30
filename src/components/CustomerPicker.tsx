'use client';

import { useState, useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase-browser';

interface CustomerMatch {
  id: string;
  netsuite_id: string;
  company_name: string;
  entity_id: string;
}

interface CustomerPickerProps {
  value: string;
  /** Null/undefined = unresolved free text (no NetSuite match linked yet). */
  netsuiteId?: string | null;
  onChange: (result: { customer: string; customerNetsuiteId: string | null }) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}

/**
 * Typeahead against the local `customers` table (the NetSuite mirror), with
 * a "Create in NetSuite" fallback when nothing matches. Used anywhere a PO's
 * customer needs to resolve to a real NetSuite customer: the Create/Edit PO
 * forms and the Gmail import review modal.
 */
export default function CustomerPicker({ value, netsuiteId, onChange, placeholder, style }: CustomerPickerProps) {
  const supabase = createClient();
  const [results, setResults] = useState<CustomerMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [notice, setNotice] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = value.trim();
    if (q.length < 2) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      const { data } = await supabase
        .from('customers')
        .select('id, netsuite_id, company_name, entity_id')
        .or(`company_name.ilike.%${q}%,entity_id.ilike.%${q}%`)
        .limit(8);
      setResults((data as CustomerMatch[]) || []);
      setSearching(false);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is stable across renders
  }, [value]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const pick = (c: CustomerMatch) => {
    onChange({ customer: c.company_name, customerNetsuiteId: c.netsuite_id });
    setNotice('');
    setCreateError('');
    setOpen(false);
  };

  const createInNetSuite = async () => {
    const name = value.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError('');
    setNotice('');
    try {
      const res = await fetch('/api/wrap-quote/create-customer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName: name }),
      });
      const data = await res.json();

      if (res.status === 409 && data.existingCustomerId) {
        const { data: existing } = await supabase
          .from('customers')
          .select('company_name, netsuite_id')
          .eq('id', data.existingCustomerId)
          .maybeSingle();
        if (existing) {
          onChange({ customer: existing.company_name, customerNetsuiteId: existing.netsuite_id });
          setNotice(`"${existing.company_name}" already existed in NetSuite — linked to it.`);
          setOpen(false);
          return;
        }
      }

      if (!data.success) {
        setCreateError(data.error || 'Failed to create customer in NetSuite');
        return;
      }

      onChange({ customer: name, customerNetsuiteId: data.netsuiteId });
      setNotice(`Created "${name}" in NetSuite and FleetSuite.`);
      setOpen(false);
    } catch {
      setCreateError('Network error — try again');
    } finally {
      setCreating(false);
    }
  };

  const matched = !!netsuiteId;
  const trimmed = value.trim();
  const showCreateOption = trimmed.length >= 2 && !matched && !searching && results.length === 0;

  return (
    <div ref={boxRef} style={{ position: 'relative', ...style }}>
      <input
        value={value}
        onChange={(e) => {
          onChange({ customer: e.target.value, customerNetsuiteId: null });
          setOpen(true);
          setNotice('');
          setCreateError('');
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder || 'Customer name'}
        style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '13px' }}
      />
      {matched && !open && !notice && !createError && (
        <div style={{ fontSize: '10px', color: '#4ade80', fontWeight: 700, marginTop: '3px' }}>✓ Matched to NetSuite</div>
      )}
      {notice && <div style={{ fontSize: '10px', color: '#4ade80', fontWeight: 700, marginTop: '3px' }}>{notice}</div>}
      {createError && <div style={{ fontSize: '10px', color: '#f87171', fontWeight: 700, marginTop: '3px' }}>{createError}</div>}

      {open && (results.length > 0 || showCreateOption || searching) && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: '4px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.35)', zIndex: 60, maxHeight: '240px', overflowY: 'auto' }}>
          {searching && <div style={{ padding: '10px', fontSize: '12px', color: 'var(--text-muted)' }}>Searching…</div>}
          {!searching && results.map((c) => (
            <div
              key={c.id}
              onClick={() => pick(c)}
              style={{ padding: '8px 10px', cursor: 'pointer', fontSize: '12px', borderBottom: '1px solid var(--border)' }}
            >
              <div style={{ fontWeight: 700, color: 'var(--text-body)' }}>{c.company_name}</div>
              {c.entity_id && <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{c.entity_id}</div>}
            </div>
          ))}
          {!searching && showCreateOption && (
            <div
              onClick={createInNetSuite}
              style={{ padding: '8px 10px', cursor: creating ? 'default' : 'pointer', fontSize: '12px', fontWeight: 700, color: '#60a5fa', opacity: creating ? 0.6 : 1 }}
            >
              {creating ? 'Creating…' : `+ Create "${trimmed}" in NetSuite & FleetSuite`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
