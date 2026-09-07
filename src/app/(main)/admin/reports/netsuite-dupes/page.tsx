'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

/**
 * The look-first surface for the unique-index program (§7.4 item 12):
 * which NetSuite-id money columns hold duplicated ids. Migration 264 only
 * builds each unique index when its column is clean — clean the rows this
 * page lists, redeploy, and the index builds itself.
 */

interface DupeColumn {
  table: string;
  column: string;
  label: string;
  indexed_by?: string;
  total: number;
  error?: string;
  duplicatedIds: { value: string; count: number; rowIds: string[] }[];
}

export default function NetsuiteDupesPage() {
  const router = useRouter();
  const { isAdmin, loading: authLoading } = useAuth();
  const [data, setData] = useState<{ columns: DupeColumn[]; clean: boolean; generatedAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) { router.push('/home'); return; }
    (async () => {
      try {
        const res = await fetch('/api/reports/netsuite-dupes');
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        setData(json);
      } catch (e: any) {
        setError(e?.message || 'Report failed');
      }
    })();
  }, [authLoading, isAdmin, router]);

  return (
    <div style={{ maxWidth: '900px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>NetSuite Duplicate IDs</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Migration 264 creates a unique index on each column below only while its data is clean. Clean any
        duplicates listed here, redeploy, and the index builds itself on the next production deploy.
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: '13px' }}>{error}</div>}
      {!data && !error && <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Checking…</div>}

      {data && (
        <>
          <div style={{
            padding: '10px 14px', borderRadius: '10px', marginBottom: '14px', fontSize: '13px', fontWeight: 700,
            background: data.clean ? 'rgba(34,197,94,0.1)' : 'rgba(251,191,36,0.1)',
            border: `1px solid ${data.clean ? 'rgba(34,197,94,0.35)' : 'rgba(251,191,36,0.4)'}`,
            color: data.clean ? '#22c55e' : '#f59e0b',
          }}>
            {data.clean
              ? 'All clean — every unique index can build (or already has).'
              : 'Duplicates found — the affected indexes are skipped until these rows are cleaned.'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {data.columns.map(c => (
              <div key={`${c.table}.${c.column}`} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 800, fontSize: '13px' }}>{c.table}.{c.column}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', flex: 1 }}>{c.label}{c.indexed_by ? ` · unique since ${c.indexed_by}` : ''}</div>
                  <span style={{
                    fontSize: '11px', fontWeight: 800, padding: '2px 10px', borderRadius: '999px',
                    background: c.error ? 'rgba(239,68,68,0.12)' : c.duplicatedIds.length === 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                    color: c.error ? '#ef4444' : c.duplicatedIds.length === 0 ? '#22c55e' : '#ef4444',
                  }}>
                    {c.error ? 'read failed' : c.duplicatedIds.length === 0 ? `clean · ${c.total} linked` : `${c.duplicatedIds.length} duplicated id${c.duplicatedIds.length !== 1 ? 's' : ''}`}
                  </span>
                </div>
                {c.error && <div style={{ fontSize: '12px', color: 'var(--danger, #ef4444)', marginTop: '6px' }}>{c.error}</div>}
                {c.duplicatedIds.length > 0 && (
                  <div style={{ marginTop: '8px', overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: '12px', width: '100%' }}>
                      <thead>
                        <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: '11px' }}>
                          <th style={{ padding: '4px 8px' }}>NetSuite id</th>
                          <th style={{ padding: '4px 8px' }}>Rows</th>
                          <th style={{ padding: '4px 8px' }}>Row ids (first 10)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.duplicatedIds.map(d => (
                          <tr key={d.value} style={{ borderTop: '1px solid var(--border)' }}>
                            <td style={{ padding: '4px 8px', fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>{d.value}</td>
                            <td style={{ padding: '4px 8px' }}>{d.count}</td>
                            <td style={{ padding: '4px 8px', fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: 'var(--text-muted)' }}>{d.rowIds.join(', ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
