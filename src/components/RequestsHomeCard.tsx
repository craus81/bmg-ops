'use client';

/**
 * The small Requests card at the bottom of Home (Craig, 2026-10-30): one
 * line and a button, so it never pushes the day's work down.
 */

import { useRouter } from 'next/navigation';

export default function RequestsHomeCard() {
  const router = useRouter();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', marginTop: '20px', borderRadius: '14px', border: '1px solid var(--border)', background: 'var(--card)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>Something not working?</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>Tell us and we&apos;ll fix it, or ask for a feature.</div>
      </div>
      <button
        onClick={() => router.push('/requests?new=1')}
        style={{ flexShrink: 0, padding: '9px 14px', borderRadius: '10px', border: 'none', background: '#22c55e', color: '#fff', fontSize: '13px', fontWeight: 800, cursor: 'pointer' }}
      >+ New request</button>
    </div>
  );
}
