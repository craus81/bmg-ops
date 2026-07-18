'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

interface HealthCheck {
  syncType: string;
  label: string;
  intervalMinutes: number;
  status: 'ok' | 'stale' | 'error' | 'never';
  lastRunAt: string | null;
  ageMinutes: number | null;
  problem: string | null;
}

const STATUS_STYLE: Record<HealthCheck['status'], { label: string; color: string; bg: string }> = {
  ok: { label: 'OK', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  stale: { label: 'Stale', color: '#fbbf24', bg: 'rgba(251,191,36,0.1)' },
  error: { label: 'Error', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  never: { label: 'Never ran', color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' },
};

const fmtAge = (min: number | null) => {
  if (min == null) return '—';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
};

export default function SystemHealthPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();

  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [cronSecretConfigured, setCronSecretConfigured] = useState(true);
  const [generatedAt, setGeneratedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/system-health');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setChecks(data.checks || []);
      setCronSecretConfigured(data.cronSecretConfigured);
      setGeneratedAt(data.generatedAt);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    load();
  }, [isAdmin, router, load]);

  const badCount = checks.filter(c => c.status !== 'ok').length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>System Health</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Background jobs and syncs. A watcher runs every 30 minutes and pushes an alert to admins when anything here goes stale or errors.
          </div>
        </div>
        <button onClick={load} disabled={loading} style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          {loading ? 'Checking…' : '↻ Refresh'}
        </button>
      </div>

      {!cronSecretConfigured && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', fontWeight: 600 }}>
          CRON_SECRET is not configured — scheduled runs can&apos;t authenticate, so every cron on this page is effectively off.
        </div>
      )}
      {error && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {!loading && !error && (
        <div style={{ fontSize: '12px', fontWeight: 700, color: badCount === 0 ? '#22c55e' : '#fbbf24', marginBottom: '10px' }}>
          {badCount === 0 ? '✓ All background jobs healthy' : `⚠ ${badCount} job${badCount !== 1 ? 's' : ''} need attention`}
          {generatedAt && <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '8px' }}>checked {new Date(generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {checks.map(c => {
          const s = STATUS_STYLE[c.status];
          return (
            <div key={c.syncType} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', borderRadius: '10px', background: 'var(--card)', border: `1px solid ${c.status === 'ok' ? 'var(--border)' : s.color + '44'}` }}>
              <span style={{ fontSize: '10px', fontWeight: 800, padding: '3px 9px', borderRadius: '6px', background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>{s.label}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{c.label}</div>
                {c.problem && <div style={{ fontSize: '11px', color: s.color, marginTop: '2px' }}>{c.problem}</div>}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                Last run {fmtAge(c.ageMinutes)}<br />
                every {c.intervalMinutes >= 60 ? `${c.intervalMinutes / 60}h` : `${c.intervalMinutes} min`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
