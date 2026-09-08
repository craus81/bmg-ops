'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';

/**
 * Print-room labor timer (R6-6): the shop's pick-list timer, pointed at a
 * graphics job. Same rules as the shop context — costing only, never a
 * rate and never install credits, crew hours are presence overlap, and the
 * daily sweep closes anything left running.
 *
 * The optional task tag is what makes the hours useful later: "4 hours on
 * this job" answers less than "3 printing, 1 laminating".
 */

const TAGS = ['print', 'cut', 'laminate', 'design', 'other'] as const;

interface Shift {
  id: string;
  started_at: string;
  ended_at: string | null;
  task_tag: string | null;
  auto_closed?: boolean | null;
}

const fmtDuration = (fromIso: string, toIso?: string | null) => {
  const ms = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
};

export default function PrintRoomTimer({ jobId }: { jobId: string }) {
  const { hasRole, isAdmin } = useAuth();
  const supabase = createClient();
  const [open, setOpen] = useState<Shift | null>(null);
  const [past, setPast] = useState<Shift[]>([]);
  const [tag, setTag] = useState<string>('print');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const canTime = isAdmin || hasRole('graphics_production') || hasRole('production');

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('work_shifts')
      .select('id, started_at, ended_at, task_tag, auto_closed')
      .eq('context', 'graphics')
      .eq('graphics_job_id', jobId)
      .order('started_at', { ascending: false });
    const rows = (data || []) as Shift[];
    setOpen(rows.find(r => !r.ended_at) || null);
    setPast(rows.filter(r => r.ended_at));
  }, [jobId, supabase]);

  useEffect(() => { load(); }, [load]);

  // Keep the running clock honest without refetching.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, [open]);

  const start = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/shifts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: 'graphics', graphicsJobId: jobId, taskTag: tag, members: [] }),
      });
      const body = await res.json();
      if (!res.ok) { setMsg(body?.error || 'Could not start the timer.'); return; }
      await load();
    } finally { setBusy(false); }
  };

  const stop = async () => {
    if (!open) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/shifts/end', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shiftId: open.id }),
      });
      if (!res.ok) { setMsg((await res.json())?.error || 'Could not stop the timer.'); return; }
      await load();
    } finally { setBusy(false); }
  };

  const totalMins = past.reduce((s, p) => s + Math.max(0, (Date.parse(p.ended_at!) - Date.parse(p.started_at)) / 60000), 0);
  const totalLabel = totalMins < 60 ? `${Math.round(totalMins)}m` : `${Math.floor(totalMins / 60)}h ${String(Math.round(totalMins % 60)).padStart(2, '0')}m`;

  if (!canTime && past.length === 0 && !open) return null;

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          Print Room Time
        </div>
        {past.length > 0 && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {totalLabel} logged across {past.length} session{past.length !== 1 ? 's' : ''}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {open ? (
          <>
            <span style={{
              fontSize: '11px', fontWeight: 800, padding: '3px 9px', borderRadius: '999px',
              background: 'rgba(34,197,94,0.12)', color: '#22c55e',
            }}>
              ● running {fmtDuration(open.started_at)}{open.task_tag ? ` · ${open.task_tag}` : ''}
            </span>
            {canTime && (
              <button onClick={stop} disabled={busy} style={{
                padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 800,
                background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', cursor: 'pointer',
              }}>{busy ? '…' : 'Stop'}</button>
            )}
          </>
        ) : canTime ? (
          <>
            <select value={tag} onChange={e => setTag(e.target.value)} style={{
              padding: '5px 8px', borderRadius: '7px', fontSize: '11px',
              border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)',
            }}>
              {TAGS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button onClick={start} disabled={busy} style={{
              padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 800,
              background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.35)', color: '#22c55e', cursor: 'pointer',
            }}>{busy ? '…' : 'Start'}</button>
          </>
        ) : null}
      </div>

      {msg && <div style={{ fontSize: '11.5px', color: '#ef4444', marginTop: '8px' }}>{msg}</div>}

      {past.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '9px' }}>
          {past.slice(0, 8).map(p => (
            <span key={p.id} title={p.auto_closed ? 'Closed by the daily sweep — this length is approximate' : undefined} style={{
              fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px',
              background: 'var(--subtle-bg)', color: 'var(--text-muted)',
            }}>
              {p.task_tag || 'work'} {fmtDuration(p.started_at, p.ended_at)}{p.auto_closed ? ' ≈' : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
