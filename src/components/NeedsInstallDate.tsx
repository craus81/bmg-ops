'use client';

/**
 * Home's "Needs install date" list, for whoever books installs
 * (Admin → Users → Settings → "Schedules installs"; Jessie). Approved jobs
 * we install with no date yet, oldest approval first. Renders nothing for
 * everyone else and when the list is empty, so it mounts cheaply on every
 * Home. A row opens the job on its Install card.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';

interface Row { id: string; label: string; customer: string | null; onSite: boolean; approvedAt: string | null }

const daysAgo = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
};

export default function NeedsInstallDate() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/graphics/needs-install-date')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d) { setRows(d.jobs || []); setTotal(d.total || 0); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (rows.length === 0) return null;

  return (
    <div style={{ background: 'var(--card)', border: '1px solid rgba(245,158,11,0.45)', borderRadius: '14px', marginBottom: '14px', overflow: 'hidden' }}>
      <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: '12px', fontWeight: 800, color: '#f59e0b' }}>📅 Needs install date ({total})</span>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          Customer approved the proof. Call to book the install, then send the confirmation from the job.
        </div>
      </div>
      {rows.map(r => (
        <button
          key={r.id}
          onClick={() => router.push(deepLinks.graphicsJob(r.id, { schedule: true }))}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
            width: '100%', textAlign: 'left', padding: '10px 14px', background: 'rgba(245,158,11,0.06)',
            border: 'none', borderBottom: '1px solid var(--border)', boxShadow: 'inset 3px 0 0 #f59e0b', cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{r.label}</span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {[r.customer, r.onSite ? 'Onsite' : 'BMG shop', r.approvedAt && `approved ${daysAgo(r.approvedAt)}`].filter(Boolean).join(' · ')}
          </span>
        </button>
      ))}
      {total > rows.length && (
        <div style={{ padding: '8px 14px', fontSize: '11px', color: 'var(--text-muted)' }}>…and {total - rows.length} more.</div>
      )}
    </div>
  );
}
