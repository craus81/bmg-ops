'use client';

/**
 * Graphics card on the sales order page (Craig 2026-11-06, thread "Create
 * graphics jobs from sales orders", picked 1C 2A 3A). Lists the order's
 * graphics jobs, or offers "+ Create graphics job" when the order has
 * graphics lines and no job yet. The button opens the usual New Job form on
 * the Graphics board, filled in from the order (or its estimate); nothing is
 * created until the person presses Create there. "Link an existing job…"
 * attaches a job somebody already made.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';
import { GRAPHICS_STATUS_LABELS, type GraphicsJobStatus } from '@/lib/types';
import type { SoGraphicsJob } from '@/lib/so-graphics-server';

const PURPLE = '#7c5cd6';

/** The New Job form, filled in from this order (and its estimate, when it has one). */
export function newGraphicsJobFromSoUrl(soId: string, estimateId: string | null): string {
  const q = new URLSearchParams({ new: '1', fromSo: soId });
  if (estimateId) q.set('fromEstimate', estimateId);
  return `/graphics?${q.toString()}`;
}

interface Hit { id: string; jobNumber: string | null; title: string | null; customer: string | null; status: string; otherOrder: boolean }

export default function SoGraphicsCard({ soId, estimateId, graphicsLineNames, jobs, onLinked }: {
  soId: string;
  estimateId: string | null;
  /** Item names of the order's graphics lines. */
  graphicsLineNames: string[];
  /** null = the lookup failed. */
  jobs: SoGraphicsJob[] | null;
  onLinked: () => void;
}) {
  const router = useRouter();
  const [linking, setLinking] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (text: string) => {
    setQ(text);
    if (text.trim().length < 2) { setHits([]); return; }
    try {
      const res = await apiFetch(`/api/sales-orders/${encodeURIComponent(soId)}/graphics?q=${encodeURIComponent(text.trim())}`);
      const body = await res.json().catch(() => ({}));
      if (res.ok) setHits(body.jobs || []);
    } catch { /* keep the last results */ }
  };

  const link = async (jobId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sales-orders/${encodeURIComponent(soId)}/graphics`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || "Couldn't link the job."); return; }
      setLinking(false); setQ(''); setHits([]);
      onLinked();
    } catch {
      setError("Couldn't link the job. Check your connection.");
    } finally {
      setBusy(false);
    }
  };

  const hasJobs = !!jobs && jobs.length > 0;
  const btn: React.CSSProperties = {
    padding: '8px 14px', borderRadius: '8px', border: 'none', background: PURPLE, color: '#fff',
    fontSize: '13px', fontWeight: 700, cursor: 'pointer',
  };
  const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: theme.accent, fontSize: '13px', fontWeight: 700, cursor: 'pointer' };

  return (
    <div id="so-graphics" style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px', scrollMarginTop: '72px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 800 }}>Graphics</h2>
        {hasJobs
          ? <button type="button" style={linkBtn} onClick={() => router.push(newGraphicsJobFromSoUrl(soId, estimateId))}>+ Another graphics job</button>
          : <button type="button" style={btn} onClick={() => router.push(newGraphicsJobFromSoUrl(soId, estimateId))}>+ Create graphics job</button>}
      </div>

      {jobs === null && (
        <div style={{ marginTop: '8px', fontSize: '13px', color: theme.error, fontWeight: 600 }}>Couldn&apos;t check this order&apos;s graphics jobs. Reload the page to try again.</div>
      )}

      {jobs && jobs.length === 0 && (
        <div style={{ marginTop: '8px', fontSize: '13px', color: theme.textSecondary, lineHeight: 1.45 }}>
          {graphicsLineNames.length > 0
            ? <>This order has {graphicsLineNames.length === 1 ? 'a graphics line' : `${graphicsLineNames.length} graphics lines`} ({graphicsLineNames.join(', ')}) but no graphics job yet, so the design team hasn&apos;t heard about it.</>
            : <>No graphics job on this order.</>}
        </div>
      )}

      {hasJobs && (
        <div style={{ display: 'grid', gap: '6px', marginTop: '10px' }}>
          {jobs!.map(j => (
            <a key={j.id} href={deepLinks.graphicsJob(j.id)} onClick={(e) => { e.preventDefault(); router.push(deepLinks.graphicsJob(j.id)); }}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', background: theme.subtleBg, borderRadius: '8px', padding: '9px 12px', textDecoration: 'none', color: theme.textPrimary }}>
              <span style={{ minWidth: 0 }}>
                <b style={{ color: PURPLE }}>{j.jobNumber || 'Graphics job'}</b>{j.title ? ` · ${j.title}` : ''}
                {j.quantity ? <span style={{ display: 'block', fontSize: '12px', color: theme.textMuted }}>Qty {j.quantity}</span> : null}
              </span>
              <span style={{ fontSize: '12px', fontWeight: 700, borderRadius: '999px', padding: '3px 9px', background: theme.warningBg, color: theme.warning, whiteSpace: 'nowrap' }}>
                {GRAPHICS_STATUS_LABELS[j.status as GraphicsJobStatus] || j.status}
              </span>
            </a>
          ))}
        </div>
      )}

      <div style={{ marginTop: '10px' }}>
        {!linking
          ? <button type="button" style={linkBtn} onClick={() => setLinking(true)}>Link an existing job…</button>
          : (
            <div style={{ display: 'grid', gap: '6px' }}>
              <input id="so-gfx-link" autoFocus value={q} onChange={e => search(e.target.value)} placeholder="Job #, title or customer"
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: '7px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '14px' }} />
              {hits.map(h => (
                <button key={h.id} type="button" disabled={busy || h.otherOrder} onClick={() => link(h.id)}
                  title={h.otherOrder ? 'Already linked to another sales order' : undefined}
                  style={{ textAlign: 'left', background: theme.subtleBg, border: `1px solid ${theme.border}`, borderRadius: '8px', padding: '8px 10px', cursor: h.otherOrder ? 'not-allowed' : 'pointer', color: theme.textPrimary, opacity: h.otherOrder ? 0.55 : 1, fontSize: '13px' }}>
                  <b>{h.jobNumber}</b> · {h.title || 'Untitled'}{h.customer ? ` · ${h.customer}` : ''}{h.otherOrder ? ' · on another order' : ''}
                </button>
              ))}
              {q.trim().length >= 2 && hits.length === 0 && <div style={{ fontSize: '12px', color: theme.textMuted }}>No matching jobs.</div>}
              <button type="button" style={{ ...linkBtn, color: theme.textSecondary, justifySelf: 'start' }} onClick={() => { setLinking(false); setQ(''); setHits([]); }}>Close</button>
            </div>
          )}
        {error && <div style={{ marginTop: '6px', fontSize: '13px', color: theme.error, fontWeight: 600 }}>{error}</div>}
      </div>
    </div>
  );
}
