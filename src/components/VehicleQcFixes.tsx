'use client';

/**
 * QC fixes a customer's QC team reported on this vehicle (migration 381),
 * on the In-Shop vehicle card. Renders nothing when there are none.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { fmtQcDate, qcStatusLabel, type QcStatus } from '@/lib/qc-fixes';

interface Row { id: string; status: QcStatus; created_at: string; fix_by: string | null; fixed_at: string | null; comments: string | null; customer_name: string | null }

const COLOR: Record<QcStatus, string> = { new: '#ef4444', scheduled: '#f59e0b', fixed: '#16a34a' };

export default function VehicleQcFixes({ vin }: { vin: string | null | undefined }) {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    if (!vin || vin.length < 6) return;
    let live = true;
    apiFetch(`/api/qc-fixes?vin=${encodeURIComponent(vin)}`)
      .then(r => (r.ok ? r.json() : { reports: [] }))
      .then(j => { if (live) setRows(j.reports || []); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [vin]);
  if (!rows.length) return null;
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
        QC fixes
      </div>
      {rows.map(r => (
        <a key={r.id} href={deepLinks.qcFix(r.id)} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', marginBottom: 4, textDecoration: 'none', color: 'var(--text-primary)', fontSize: 12 }}>
          <span style={{ fontWeight: 800, color: COLOR[r.status] }}>{qcStatusLabel(r.status)}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.comments || 'No comments'}</span>
          <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {r.status === 'fixed' ? `fixed ${fmtQcDate(r.fixed_at)}` : r.fix_by ? `fix by ${fmtQcDate(r.fix_by)}` : `${r.customer_name || ''} ${fmtQcDate(r.created_at)}`}
          </span>
        </a>
      ))}
    </div>
  );
}
