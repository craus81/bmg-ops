'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess, booksAllows } from '@/lib/books/access';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import type { SwitchPiece } from '@/lib/books/switches';

/**
 * Books → Switches (migration 466, src/lib/books/switches.ts, docs/books.md
 * "Switches"; owner decisions 2026-10-31, thread "Replacing NetSuite with
 * FleetSuite": from January 1, 2027 the team works only in FleetSuite).
 *
 * Each piece that moves the team's work out of NetSuite is built switched
 * off, and stays off until it's switched on here. While off, super admins
 * can open it to see what it would send, and nothing goes to NetSuite.
 * Whoever opens the books sees them; only a super admin flips one, and
 * every change is in the audit log.
 */

interface Switch {
  piece: SwitchPiece;
  name: string;
  what: string;
  where: string;
  turnOn?: string;
  turnOff?: string;
  later?: string;
  on: boolean;
  changedAt: string | null;
  changedBy: string | null;
}

const GREEN = '#22c55e';

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function BooksSwitchesPage() {
  const router = useRouter();
  const dialog = useDialog();
  const { hasRole, loading: authLoading } = useAuth();
  // Flipping a switch is the owner's; the bookkeeper and the CPA see which are on.
  const canFlip = booksAllows(booksAccess(hasRole), 'owner');
  const [switches, setSwitches] = useState<Switch[] | null>(null);
  const [onDate, setOnDate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<SwitchPiece | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/books/switches');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setSwitches(json.switches || []);
      setOnDate(json.onDate || '');
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load the switches');
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const flip = async (s: Switch) => {
    const on = !s.on;
    const ok = await dialog.confirm(
      on
        ? s.turnOn ?? `Switch on ${s.name}? From now on staff use it in FleetSuite (${s.where}), and FleetSuite sends each one on to NetSuite.`
        : s.turnOff ?? `Switch off ${s.name}? Nobody can use it in FleetSuite until it's switched on again, so it's done in NetSuite meanwhile.`,
      { confirmLabel: on ? 'Switch on' : 'Switch off', title: s.name, destructive: !on },
    );
    if (!ok) return;
    setBusy(s.piece);
    try {
      const res = await apiFetch('/api/admin/books/switches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ piece: s.piece, on }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      await load();
    } catch (e: any) {
      setError(e?.message || 'Could not change the switch');
    }
    setBusy(null);
  };

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <Link href="/admin/books" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>← Books</Link>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Switches</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '640px' }}>
          Each piece that moves the team&apos;s work out of NetSuite is built switched off{onDate ? `, to be switched on ${onDate}` : ''}.
          While a piece is off, super admins can open it to see what it would send, and nothing goes to NetSuite.
          {canFlip ? '' : ' Only a super admin switches one on or off.'}
        </div>
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>{error}</div>}
      {!switches && !error && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Loading…</div>}

      <div style={{ display: 'grid', gap: '10px', maxWidth: '720px' }}>
        {(switches ?? []).map((s) => (
          <div key={s.piece} style={{ background: 'var(--card)', border: `1px solid ${s.on ? GREEN : 'var(--border)'}`, borderRadius: '12px', padding: '14px', display: 'grid', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '15px', fontWeight: 800 }}>{s.name}</span>
                <span style={{
                  fontSize: '10px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px',
                  background: s.on ? 'var(--success-bg)' : 'var(--subtle-bg)', color: s.on ? 'var(--success)' : 'var(--text-muted)',
                }}>{s.on ? 'ON' : 'OFF'}</span>
              </div>
              {canFlip && (
                <button
                  onClick={() => flip(s)}
                  disabled={busy !== null}
                  style={{
                    padding: '7px 12px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: busy ? 'wait' : 'pointer',
                    border: `1px solid ${s.on ? 'var(--border)' : GREEN}`, background: s.on ? 'var(--card)' : GREEN, color: s.on ? 'var(--text-primary)' : '#fff',
                  }}
                >{busy === s.piece ? 'Changing…' : s.on ? 'Switch off' : 'Switch on'}</button>
              )}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{s.what}</div>
            {s.later && !s.on && <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>{s.later}</div>}
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Where: {s.where}
              {s.changedAt ? ` · Switched ${s.on ? 'on' : 'off'} by ${s.changedBy || 'someone'}, ${when(s.changedAt)}` : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
