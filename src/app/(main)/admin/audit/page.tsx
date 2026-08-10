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
  // A2 row-diff trigger tables (migration 195)
  upfit_projects: 'Upfit Projects',
  graphics_jobs: 'Graphics Jobs',
  cni_jobs: 'CNI Jobs',
  estimates: 'Estimates',
};

const PAGE = 100;

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

  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Server-side filtering + keyset pagination (A2 phase 1) — the old page
  // loaded 300 rows and searched client-side over only those 300, which
  // quietly missed anything older. The search now filters at the database
  // (record id / action), and Load More pages on the created_at cursor.
  const buildQuery = (cursor?: string) => {
    let q = supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(PAGE);
    if (tableFilter) q = q.eq('table_name', tableFilter);
    const s = search.trim().replace(/[,()]/g, ' ').trim();
    if (s) q = q.or(`record_id.ilike.%${s}%,action.ilike.%${s}%`);
    if (cursor) q = q.lt('created_at', cursor);
    return q;
  };

  const loadNames = async (list: AuditRow[]) => {
    const actorIds = [...new Set(list.map(r => r.actor_id).filter(Boolean))] as string[];
    if (actorIds.length === 0) return;
    const { data: profiles } = await supabase
      .from('profiles').select('id, full_name').in('id', actorIds);
    setNames(prev => {
      const map = { ...prev };
      for (const p of profiles || []) map[p.id] = p.full_name;
      return map;
    });
  };

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin || !hasFeature('audit_log')) { router.push('/home'); return; }
    // Debounce so each keystroke doesn't fire a query.
    const t = setTimeout(async () => {
      setLoading(true);
      const { data } = await buildQuery();
      const list = (data || []) as AuditRow[];
      setRows(list);
      setHasMore(list.length === PAGE);
      await loadNames(list);
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [authLoading, isAdmin, tableFilter, search]);

  const loadMore = async () => {
    if (rows.length === 0 || loadingMore) return;
    setLoadingMore(true);
    const { data } = await buildQuery(rows[rows.length - 1].created_at);
    const list = (data || []) as AuditRow[];
    setRows(prev => [...prev, ...list]);
    setHasMore(list.length === PAGE);
    await loadNames(list);
    setLoadingMore(false);
  };

  const visible = rows;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Audit Log</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Who changed what — money-touching records, plus full field-level change history on upfit projects, graphics jobs, and CNI jobs (A2). &quot;System&quot; means a cron, sync, or webhook made the change.
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <select value={tableFilter} onChange={e => setTableFilter(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600 }}>
          <option value="">All areas</option>
          {Object.entries(TABLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search record id or action (filters the whole log)…"
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
                <span style={{ fontSize: '11px', color: r.actor_id ? 'var(--text-secondary)' : 'var(--text-muted)', whiteSpace: 'nowrap', fontStyle: r.actor_id ? 'normal' : 'italic' }}>
                  {r.actor_id ? (names[r.actor_id] || '…') : 'System'}
                </span>
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
      {!loading && hasMore && (
        <div style={{ textAlign: 'center', padding: '12px' }}>
          <button onClick={loadMore} disabled={loadingMore}
            style={{ padding: '8px 18px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: loadingMore ? 0.6 : 1 }}>
            {loadingMore ? 'Loading…' : 'Load older entries'}
          </button>
        </div>
      )}
    </div>
  );
}
