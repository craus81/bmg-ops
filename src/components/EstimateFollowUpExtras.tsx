'use client';

/**
 * What the Quotes page added to a sent estimate, now on the Estimates list
 * itself (Craig, 2026-10-27: "why are there multiple pages that have
 * estimates on them" — Quotes was folded into the Estimates tab).
 *
 * The rows stay the Estimates list's own; this side-loads the follow-up
 * picture from GET /api/quotes (src/lib/quote-list.ts, the same loader the
 * Quotes page used) and keys it by `<type>-<id>`: approval-link opens,
 * link expiry, the pending reminder, the follow-up log, and Won / Lost.
 * The older standalone wrap quotes, which have no estimate row, get their
 * own short list.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDialog } from '@/components/DialogProvider';
import { expiryLabel, type ExpiryState } from '@/lib/quote-expiry';
import { viewLabel } from '@/lib/quote-views';
import type { QuoteListItem } from '@/lib/quote-list';

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—';
// remind_at is a bare DATE — parse it as local so it doesn't shift a day.
const fmtDay = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });

// Only the two states worth interrupting a scan for.
const EXPIRY_CHIP: Partial<Record<ExpiryState, { color: string; title: string }>> = {
  expiring: { color: '#fb923c', title: 'The customer’s approval link is about to stop working' },
  expired: { color: '#ef4444', title: 'The approval link has expired — the customer can no longer accept. Re-send to give them a live link.' },
};

const chip = (color: string): React.CSSProperties => ({
  fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '5px',
  background: `${color}22`, color, whiteSpace: 'nowrap',
});

/** Follow-up data for every quote, keyed `estimate-<id>` / `wrap-<id>`. */
export function useQuoteExtras(enabled: boolean) {
  const [byKey, setByKey] = useState<Record<string, QuoteListItem>>({});
  const [wraps, setWraps] = useState<QuoteListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled) return;
    const mine = ++seq.current;
    try {
      // Stamped and no-store: a marked quote kept coming back as Waiting
      // because the answer was an old copy (see the old Quotes page).
      const res = await fetch(`/api/quotes?status=all&t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok || mine !== seq.current) return;
      const data = await res.json();
      const items: QuoteListItem[] = data.items || [];
      const map: Record<string, QuoteListItem> = {};
      for (const i of items) map[`${i.type}-${i.id}`] = i;
      setByKey(map);
      setWraps(items.filter(i => i.type === 'wrap'));
    } catch { /* the list still works without the extras */ }
    if (mine === seq.current) setLoaded(true);
  }, [enabled]);
  useEffect(() => { reload(); }, [reload]);
  return { byKey, wraps, loaded, reload };
}

/** Mark a sent quote Won (accepted) or Lost (rejected), after asking. */
export function useMarkQuote(onDone: (item: { type: 'estimate' | 'wrap'; id: string }, status: 'accepted' | 'rejected') => void) {
  const dialog = useDialog();
  const [busy, setBusy] = useState<string | null>(null);
  const mark = async (item: { type: 'estimate' | 'wrap'; id: string; number: string; total: number }, won: boolean) => {
    const ok = await dialog.confirm(won
      ? `Mark ${item.number} (${fmtMoney(item.total)}) as won? It becomes accepted, the same as a phone or PO approval.`
      : `Mark ${item.number} as lost?`);
    if (!ok) return;
    setBusy(item.id);
    try {
      const res = await fetch('/api/quotes/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: item.type, id: item.id, action: won ? 'mark_accepted' : 'mark_rejected' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) await dialog.alert(data.error || 'Could not mark it. Reload and try again.');
      else onDone(item, won ? 'accepted' : 'rejected');
    } catch (e: any) {
      await dialog.alert(e?.message || 'Could not mark it. Check your connection and try again.');
    }
    setBusy(null);
  };
  return { mark, busy };
}

/** Chips for a sent quote: approval-link opens, expiry, pending reminder. */
export function QuoteChips({ item }: { item: QuoteListItem | undefined }) {
  if (!item || item.status !== 'sent') return null;
  const expiry = EXPIRY_CHIP[item.expiryState];
  return (
    <>
      {item.views.humanCount > 0 && (
        <span title="Opens are counted from the approval page itself. Link scanners are not counted." style={chip('#38bdf8')}>
          👀 {viewLabel(item.views)}
        </span>
      )}
      {item.viewsTracked && item.views.humanCount === 0 && item.sentAt && (
        <span title="Nobody has opened the approval link yet. Worth checking the address if this persists." style={chip('#94a3b8')}>
          never opened
        </span>
      )}
      {expiry && <span title={expiry.title} style={chip(expiry.color)}>{expiryLabel(item.expiresAt)}</span>}
      {item.nextReminderAt && (
        <span title="Reminder pending — quiet-day nudges are paused until this date" style={chip('#34d399')}>
          ⏰ reminds {fmtDay(item.nextReminderAt)}
        </span>
      )}
    </>
  );
}

/** The latest follow-up comment, with the full log behind a toggle. */
export function QuoteFollowUpLog({ item }: { item: QuoteListItem | undefined }) {
  const [open, setOpen] = useState(false);
  if (!item || item.status !== 'sent' || item.followups.length === 0) return null;
  const latest = item.followups.find(f => f.note);
  return (
    <div onClick={e => e.stopPropagation()} style={{ marginTop: '6px', cursor: 'default' }}>
      {latest && !open && (
        <div style={{ fontSize: '11px', color: 'var(--text-body)', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          &ldquo;{latest.note}&rdquo;
          <span style={{ color: 'var(--text-muted)', fontStyle: 'normal' }}> — {latest.creatorName || 'Unknown'}, {fmtDate(latest.createdAt)}</span>
        </div>
      )}
      <span
        role="button"
        tabIndex={0}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}
        style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', cursor: 'pointer' }}
      >
        {open ? '▾ Hide' : `▸ ${item.followups.length} follow-up${item.followups.length !== 1 ? 's' : ''} logged`}
      </span>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
          {item.followups.map(f => (
            <div key={f.id} style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '7px', background: 'var(--card)', border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', color: 'var(--text-muted)', fontSize: '10px' }}>
                <span>{f.creatorName || 'Unknown'} · {fmtDate(f.createdAt)}</span>
                {f.remindAt && (
                  <span style={{ color: f.reminderSentAt ? 'var(--text-muted)' : '#34d399', fontWeight: 700 }}>
                    ⏰ {f.reminderSentAt ? 'reminded' : 'reminds'} {fmtDay(f.remindAt)}
                  </span>
                )}
              </div>
              {f.note && <div style={{ color: 'var(--text-body)', marginTop: '2px', whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{f.note}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const wonButtonStyle: React.CSSProperties = {
  padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 800,
  background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
};
export const lostButtonStyle: React.CSSProperties = {
  padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
  background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444',
  cursor: 'pointer', whiteSpace: 'nowrap',
};

const WRAP_STATUS: Record<string, { label: string; color: string }> = {
  sent: { label: 'Sent', color: '#fbbf24' },
  accepted: { label: 'Won', color: '#22c55e' },
  rejected: { label: 'Lost', color: '#ef4444' },
};

/**
 * The older standalone wrap quotes: sent to a customer before the Graphics
 * Builder fed estimates, so they have no estimate row. Follow-ups are
 * logged inside the wrap quote itself.
 */
export function OlderWrapQuotes({ wraps, onChanged, onOpen }: {
  wraps: QuoteListItem[];
  onChanged: () => void;
  onOpen: (id: string) => void;
}) {
  const { mark, busy } = useMarkQuote(() => onChanged());
  if (wraps.length === 0) {
    return <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-label)', fontSize: '13px' }}>No older wrap quotes left.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {wraps.map(w => {
        const s = WRAP_STATUS[w.status] || { label: w.status, color: '#94a3b8' };
        return (
          <div key={w.id} id={`qfu-wrap-${w.id}`} style={{ borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--subtle-bg)', padding: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-body)' }}>{w.title || w.number}</div>
                <div style={{ fontSize: '10px', color: 'var(--text-label)', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <span>#{w.number}</span>
                  <span>{w.customer}</span>
                  <span style={{ color: 'var(--text-body)', fontWeight: 700 }}>{fmtMoney(w.total)}</span>
                  <span>{w.status === 'sent' ? `sent ${fmtDate(w.sentAt)}` : `${s.label.toLowerCase()} ${fmtDate(w.decidedAt || w.createdAt)}`}</span>
                  {w.repName && <span>{w.repName}</span>}
                </div>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                  <QuoteChips item={w} />
                </div>
                <QuoteFollowUpLog item={w} />
              </div>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
                {w.status === 'sent' && (
                  <>
                    <button disabled={busy === w.id} onClick={() => mark(w, true)} style={wonButtonStyle}>✓ Won</button>
                    <button disabled={busy === w.id} onClick={() => mark(w, false)} style={lostButtonStyle}>✕ Lost</button>
                  </>
                )}
                <span style={chip(s.color)}>{s.label}</span>
                <button
                  onClick={() => onOpen(w.id)}
                  style={{ padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                  Open →
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

