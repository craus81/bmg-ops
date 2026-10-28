'use client';

/**
 * Home's "Ready to schedule" list, for whoever books installs (Jessie) and
 * anyone copied on new alerts (Craig). Two kinds of job, booking first:
 * every part reserved with no drop-off date (call the customer), and every
 * part in stock but not reserved (check the shelf and reserve). Renders
 * nothing for everyone else and when the list is empty. A row opens the job
 * on the card that needs the next tap.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';

interface Row { id: string; label: string; customer: string | null; soNumber: string | null; step: 'reserve' | 'schedule' }

export default function ReadyToSchedule() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/upfit-projects/ready-to-schedule')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d) { setRows(d.jobs || []); setTotal(d.total || 0); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (rows.length === 0) return null;

  return (
    <div style={{ background: 'var(--card)', border: '1px solid rgba(34,197,94,0.45)', borderRadius: '14px', marginBottom: '14px', overflow: 'hidden' }}>
      <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: '12px', fontWeight: 800, color: '#22c55e' }}>✓ Ready to schedule ({total})</span>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          Parts are here. Reserve them if they aren&apos;t yet, then call to set the drop-off date.
        </div>
      </div>
      {rows.map(r => {
        const book = r.step === 'schedule';
        const color = book ? '#22c55e' : '#f59e0b';
        return (
          <button
            key={r.id}
            onClick={() => router.push(deepLinks.upfitProject(r.id, { focus: book ? 'dates' : 'parts' }))}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
              width: '100%', textAlign: 'left', padding: '10px 14px', background: `${color}0f`,
              border: 'none', borderBottom: '1px solid var(--border)', boxShadow: `inset 3px 0 0 ${color}`, cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{r.label}</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              <span style={{ fontWeight: 800, color }}>{book ? '📅 Set drop-off date' : '📦 Check stock and reserve'}</span>
              {[r.customer, r.soNumber].filter(Boolean).map(t => ` · ${t}`).join('')}
            </span>
          </button>
        );
      })}
      {total > rows.length && (
        <div style={{ padding: '8px 14px', fontSize: '11px', color: 'var(--text-muted)' }}>…and {total - rows.length} more.</div>
      )}
    </div>
  );
}
