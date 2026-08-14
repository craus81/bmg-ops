'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';

/**
 * Per-record audit history (roadmap A2 phase 4): everything the row-diff
 * trigger (migration 195) and the money-audit helpers (migration 147)
 * recorded about ONE record, newest first — who changed what, when,
 * field by field.
 *
 * Reads audit_log under its existing admin-only RLS policy, so mount this
 * behind an isAdmin check — a non-admin would just see an empty list.
 * History loads lazily on first expand; a record with no entries says so.
 */

interface AuditRow {
  id: string;
  actor_id: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

const fmtVal = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 60)}…` : s;
  }
  const s = String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

const fmtField = (k: string) => k.replace(/_/g, ' ');

export default function RecordChanges({ table, recordId }: { table: string; recordId: string }) {
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [actors, setActors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  // A different record invalidates everything (board pages swap recordId).
  useEffect(() => { setRows(null); setOpen(false); }, [table, recordId]);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('audit_log')
        .select('id, actor_id, action, detail, created_at')
        .eq('table_name', table)
        .eq('record_id', recordId)
        .order('created_at', { ascending: false })
        .limit(100);
      const list = (data || []) as AuditRow[];
      setRows(list);
      const ids = [...new Set(list.map(r => r.actor_id).filter((a): a is string => !!a))];
      if (ids.length > 0) {
        const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', ids);
        setActors(Object.fromEntries((profs || []).map((p: { id: string; full_name: string | null }) => [p.id, p.full_name || 'Unknown'])));
      }
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && rows === null && !loading) load();
  };

  const renderDetail = (r: AuditRow) => {
    const changed = r.detail?.changed as Record<string, { from: unknown; to: unknown }> | undefined;
    if (r.action === 'row_update' && changed) {
      return Object.entries(changed).map(([field, d]) => (
        <div key={field} style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{fmtField(field)}</span>
          {': '}
          <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>{fmtVal(d.from)}</span>
          {' → '}
          <span style={{ fontWeight: 600 }}>{fmtVal(d.to)}</span>
        </div>
      ));
    }
    if (r.action === 'row_delete') {
      return <div style={{ fontSize: '11px', color: '#f87171', fontWeight: 700 }}>Record deleted (full row captured in the audit log)</div>;
    }
    // Legacy money-audit writes (pay rates, billing edits, …) carry
    // per-action detail shapes — show them compactly rather than hiding them.
    return r.detail
      ? <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{fmtVal(r.detail)}</div>
      : null;
  };

  return (
    <div style={{ marginTop: '12px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
      <button
        onClick={toggle}
        style={{
          width: '100%', padding: '10px 12px', background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)',
          fontSize: '12px', fontWeight: 800, textAlign: 'left',
        }}
      >
        <span>Changes</span>
        {rows !== null && (
          <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>
            {rows.length === 0 ? 'none recorded' : `${rows.length}${rows.length === 100 ? '+' : ''} entr${rows.length === 1 ? 'y' : 'ies'}`}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--text-muted)' }}>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px', maxHeight: '340px', overflowY: 'auto' }}>
          {loading && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>}
          {!loading && rows !== null && rows.length === 0 && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              No changes recorded yet — history starts when a record is edited (tracking began Aug 2026).
            </div>
          )}
          {!loading && (rows || []).map(r => (
            <div key={r.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>
                {new Date(r.created_at).toLocaleString()}
                {' · '}
                <span style={{ fontWeight: 700, color: r.actor_id ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                  {r.actor_id ? (actors[r.actor_id] || 'Unknown user') : 'System'}
                </span>
                {r.action !== 'row_update' && r.action !== 'row_delete' && (
                  <span style={{ fontFamily: 'monospace' }}>{' · '}{r.action}</span>
                )}
              </div>
              {renderDetail(r)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
