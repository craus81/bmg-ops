'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface AuditRow {
  id: string;
  actor_id: string | null;
  table_name: string;
  record_id: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

const TABLE_LABELS: Record<string, string> = {
  scan_logs: 'Scan Log',
  netsuite_parts: 'Parts',
  install_pay_rates: 'Pay Rates',
  payouts: 'Payouts',
  vendor_invoices: 'Vendor Invoices',
  install_credits: 'Pay Credits',
};

export default function AuditLogPage() {
  const router = useRouter();
  const { isAdmin, hasFeature, loading: authLoading } = useAuth();
  const supabase = createClient();

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [tableFilter, setTableFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin || !hasFeature('audit_log')) { router.push('/home'); return; }
    const load = async () => {
      setLoading(true);
      let q = supabase
        .from('audit_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(300);
      if (tableFilter) q = q.eq('table_name', tableFilter);
      const { data } = await q;
      const list = (data || []) as AuditRow[];
      setRows(list);
      const actorIds = [...new Set(list.map(r => r.actor_id).filter(Boolean))] as string[];
      if (actorIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles').select('id, full_name').in('id', actorIds);
        const map: Record<string, string> = {};
        for (const p of profiles || []) map[p.id] = p.full_name;
        setNames(map);
      }
      setLoading(false);
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [authLoading, isAdmin, tableFilter]);

  const visible = rows.filter(r => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      (r.record_id || '').toLowerCase().includes(q) ||
      r.action.toLowerCase().includes(q) ||
      (names[r.actor_id || ''] || '').toLowerCase().includes(q) ||
      JSON.stringify(r.detail || {}).toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Audit Log</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Who changed what on money-touching records — bulk scan edits, part prices, pay rates, payout transitions, vendor invoices, and pay-credit corrections.
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <select value={tableFilter} onChange={e => setTableFilter(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600 }}>
          <option value="">All areas</option>
          {Object.entries(TABLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search record id, action, person, or detail…"
          style={{ flex: 1, minWidth: '220px', padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px' }} />
      </div>

      {loading && <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>}
      {!loading && visible.length === 0 && (
        <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          No audit entries{tableFilter || search ? ' match the filters' : ' yet — they appear as money-touching changes happen'}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {visible.map(r => {
          const isOpen = expanded.has(r.id);
          return (
            <div key={r.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
              <button
                onClick={() => setExpanded(prev => { const n = new Set(prev); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer' }}
              >
                <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '5px', background: 'rgba(96,165,250,0.1)', color: '#60a5fa', whiteSpace: 'nowrap' }}>
                  {TABLE_LABELS[r.table_name] || r.table_name}
                </span>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{r.action}</span>
                {r.record_id && <span style={{ fontSize: '10px', fontFamily: 'monospace', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.record_id}</span>}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{names[r.actor_id || ''] || '—'}</span>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {new Date(r.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </span>
              </button>
              {isOpen && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px', overflowX: 'auto' }}>
                  <pre style={{ margin: 0, fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {JSON.stringify(r.detail ?? {}, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!loading && rows.length === 300 && (
        <div style={{ textAlign: 'center', padding: '10px', color: 'var(--text-muted)', fontSize: '11px' }}>
          Showing the 300 most recent entries — filter by area to narrow further.
        </div>
      )}
    </div>
  );
}
