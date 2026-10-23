'use client';

import { useState, useEffect } from 'react';
import { deepLinks } from '@/lib/deep-links';
import type { PulseCheck, PulseStatus } from '@/lib/business-heartbeat';

/**
 * Business Pulse on the super-admin Dashboard (owner decision 2026-10-22):
 * replaces the 11:10 AM push/email/bell alert. The five checks are worked out
 * when the page opens, judging the last full business day against the same
 * weekday over four weeks — see src/lib/business-pulse.ts.
 */

interface PulseResponse {
  day: string;
  dayLabel: string;
  checks: PulseCheck[];
  tripped: PulseCheck[];
  unknown: PulseCheck[];
  todaySoFar: { scans: number | null; quotesSent: number | null };
}

/** Where tapping a row goes. */
const ROW_LINKS: Record<string, string> = {
  scans: '/admin/scans?tab=all&range=7d',
  quotes_sent: '/estimates',
  ar_over_60: '/invoices',
  bounces: deepLinks.emailDelivery(),
  dead_crons: deepLinks.systemHealth(),
};

const PILL: Record<PulseStatus, { label: string; bg: string; color: string }> = {
  ok: { label: 'OK', bg: 'var(--success-bg)', color: 'var(--success)' },
  tripped: { label: 'Look', bg: 'var(--error-bg)', color: 'var(--error)' },
  unknown: { label: "Can't tell", bg: 'var(--subtle-bg)', color: 'var(--text-muted)' },
};

export default function BusinessPulseCard({ onOpen }: { onOpen: (path: string) => void }) {
  const [data, setData] = useState<PulseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/business-pulse')
      .then(async r => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.error || `Business pulse failed (${r.status})`);
        return body as PulseResponse;
      })
      .then(setData)
      .catch(e => setError(e?.message || 'Business pulse failed to load'));
  }, []);

  const tripped = data?.tripped.length ?? 0;
  const headNote = error ? null
    : !data ? 'Checking…'
    : tripped > 0 ? `${tripped} need${tripped === 1 ? 's' : ''} a look`
    : data.unknown.length > 0 ? `${data.unknown.length} can't tell`
    : 'All OK';
  const headColor = tripped > 0 ? 'var(--error)' : data && data.unknown.length === 0 ? 'var(--success)' : 'var(--text-muted)';

  const soFar = (key: string): string | null => {
    if (!data) return null;
    const n = key === 'scans' ? data.todaySoFar.scans : key === 'quotes_sent' ? data.todaySoFar.quotesSent : undefined;
    return n == null ? null : `Today so far: ${n}`;
  };

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px 10px' }}>
        <h2 style={{ margin: 0, fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-secondary)' }}>Business pulse</h2>
        {headNote && <span style={{ fontSize: '11px', fontWeight: 700, color: headColor }}>{headNote}</span>}
      </div>
      <div style={{ borderTop: '1px solid var(--border)' }}>
        {error && (
          <div style={{ padding: '14px 16px', fontSize: '12.5px', fontWeight: 600, color: 'var(--error)' }}>
            Couldn&rsquo;t load the business pulse: {error}
          </div>
        )}
        {data?.checks.map(c => {
          const pill = PILL[c.status];
          const path = ROW_LINKS[c.key];
          const extra = soFar(c.key);
          return (
            <button key={c.key} onClick={() => { if (path) onOpen(path); }} style={{
              display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 16px', width: '100%',
              background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
              cursor: path ? 'pointer' : 'default', textAlign: 'left',
            }}>
              <span style={{
                minWidth: '62px', textAlign: 'center', fontSize: '11px', fontWeight: 800, padding: '4px 8px',
                borderRadius: '7px', flexShrink: 0, background: pill.bg, color: pill.color,
              }}>{pill.label}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{c.label}</span>
                <span style={{ display: 'block', fontSize: '11.5px', marginTop: '2px', lineHeight: 1.4, color: c.status === 'tripped' ? 'var(--error)' : 'var(--text-muted)', fontWeight: c.status === 'tripped' ? 600 : 400 }}>
                  {c.detail}{extra ? ` ${extra}.` : ''}
                </span>
              </span>
              {path && <span style={{ color: 'var(--text-muted)', fontSize: '15px' }}>›</span>}
            </button>
          );
        })}
      </div>
      {data && (
        <div style={{ padding: '9px 16px', fontSize: '11px', color: 'var(--text-muted)' }}>
          Judges {data.dayLabel}, the last full business day, against the same weekday over the last 4 weeks.
        </div>
      )}
    </div>
  );
}
