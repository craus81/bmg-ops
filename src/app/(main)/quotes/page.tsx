'use client';

/**
 * The combined quotes list — every estimate and wrap quote in one place,
 * whichever builder made it (Strategy C: one list, never a table merge).
 * Replaces the Quote Follow-Ups page: the follow-up queue is now the
 * "Waiting" filter of this list, with the same log/won/lost machinery
 * (POST /api/quotes/follow-up) and the same quiet-day ordering, so nudge
 * deep links (?item=<type>-<id>) keep landing on the exact row.
 * Rows open in their own builder — /estimates or /admin/wrap-quote.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { deepLinks } from '@/lib/deep-links';
import { flashNote } from '@/lib/focus-note';

interface FollowUpNote {
  id: string;
  note: string | null;
  remindAt: string | null;
  reminderSentAt: string | null;
  createdBy: string | null;
  creatorName: string | null;
  createdAt: string;
}

interface QuoteItem {
  type: 'estimate' | 'wrap';
  id: string;
  number: string;
  /** The estimate's other number when it has two (see estimate-number.ts). */
  altNumber: string | null;
  title: string;
  customer: string;
  total: number;
  status: string;
  repId: string | null;
  repName: string | null;
  createdAt: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  lastFollowupAt: string | null;
  followups: FollowUpNote[];
  nextReminderAt: string | null;
}

type Group = 'working' | 'sent' | 'won' | 'lost';
type GroupFilter = Group | 'all';

const groupOf = (i: QuoteItem): Group =>
  i.status === 'sent' ? 'sent'
  : i.status === 'accepted' ? 'won'
  : i.status === 'rejected' ? 'lost'
  : 'working';

const GROUP_CHIPS: { key: GroupFilter; label: string }[] = [
  { key: 'sent', label: 'Waiting' },
  { key: 'working', label: 'Working' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
  { key: 'all', label: 'All' },
];

const STATUS_CHIP: Record<string, { label: string; color: string }> = {
  draft: { label: 'Draft', color: '#94a3b8' },
  pushed: { label: 'Pushed to NS', color: '#60a5fa' },
  sent: { label: 'Sent', color: '#fbbf24' },
  accepted: { label: 'Accepted', color: '#22c55e' },
  rejected: { label: 'Rejected', color: '#ef4444' },
};

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—';
// remind_at is a bare DATE — parse it as local so it doesn't shift a day.
const fmtDay = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });

const quietDaysOf = (i: QuoteItem): number => {
  const ref = Math.max(
    i.sentAt ? new Date(i.sentAt).getTime() : 0,
    i.lastFollowupAt ? new Date(i.lastFollowupAt).getTime() : 0,
  );
  return ref ? Math.floor((Date.now() - ref) / 86_400_000) : 0;
};
const quietColor = (d: number) => d >= 14 ? '#ef4444' : d >= 5 ? '#fbbf24' : 'var(--text-muted)';

export default function QuotesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isAdmin, isSales, loading: authLoading } = useAuth();
  const dialog = useDialog();

  const [items, setItems] = useState<QuoteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [group, setGroup] = useState<GroupFilter>(() => {
    const s = searchParams.get('status');
    return s && ['working', 'sent', 'won', 'lost', 'all'].includes(s) ? s as GroupFilter : 'sent';
  });
  const [typeFilter, setTypeFilter] = useState<'all' | 'estimate' | 'wrap'>('all');
  const [search, setSearch] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [historyOpen, setHistoryOpen] = useState<Set<string>>(new Set());

  // Log Follow-Up dialog — the comment ("what did the customer say") and an
  // optional "remind me on" date that pauses the quiet-day nudges until then.
  const [logTarget, setLogTarget] = useState<QuoteItem | null>(null);
  const [logNote, setLogNote] = useState('');
  const [logRemindAt, setLogRemindAt] = useState('');
  const [logSaving, setLogSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/quotes?status=all');
      const data = await res.json();
      if (res.ok) setItems(data.items || []);
    } catch { /* empty list signals it */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    load();
  }, [authLoading, isAdmin, isSales, router, load]);

  // Deep link: ?item=<type>-<id> (follow-up nudges and reminders) switches
  // to the group holding that quote, then scrolls to and flashes its row.
  const [flashedItem, setFlashedItem] = useState<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const item = searchParams.get('item');
    if (!item || item === flashedItem) return;
    setFlashedItem(item);
    const target = items.find(i => `${i.type}-${i.id}` === item);
    if (target) setGroup(groupOf(target));
    flashNote(`qfu-${item}`);
  }, [loading, searchParams, flashedItem, items]);

  const act = async (item: QuoteItem, action: 'mark_accepted' | 'mark_rejected', confirmMsg: string) => {
    if (!(await dialog.confirm(confirmMsg))) return;
    setBusy(item.id);
    try {
      const res = await fetch('/api/quotes/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: item.type, id: item.id, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) await dialog.alert(data.error || 'Action failed');
      else await load();
    } catch (e: any) {
      await dialog.alert(e.message || 'Action failed');
    }
    setBusy(null);
  };

  const saveFollowUp = async () => {
    if (!logTarget) return;
    setLogSaving(true);
    try {
      const res = await fetch('/api/quotes/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: logTarget.type,
          id: logTarget.id,
          action: 'log_followup',
          note: logNote.trim() || undefined,
          remindAt: logRemindAt || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        await dialog.alert(data.error || 'Failed to log the follow-up');
      } else {
        setLogTarget(null);
        setLogNote('');
        setLogRemindAt('');
        await load();
      }
    } catch (e: any) {
      await dialog.alert(e.message || 'Failed to log the follow-up');
    }
    setLogSaving(false);
  };

  const toggleHistory = (key: string) => {
    setHistoryOpen(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Base = type / mine / search filters; the status chips count within it.
  const q = search.trim().toLowerCase();
  const base = items
    .filter(i => typeFilter === 'all' || i.type === typeFilter)
    .filter(i => !mineOnly || i.repId === user?.id)
    .filter(i => !q
      || i.number.toLowerCase().includes(q)
      || (i.altNumber || '').toLowerCase().includes(q)
      || i.customer.toLowerCase().includes(q)
      || i.title.toLowerCase().includes(q));
  const groupCounts = base.reduce((m, i) => { m[groupOf(i)] = (m[groupOf(i)] || 0) + 1; return m; }, {} as Record<Group, number>);

  const visible = base
    .filter(i => group === 'all' || groupOf(i) === group)
    .sort((a, b) => group === 'sent'
      ? quietDaysOf(b) - quietDaysOf(a)
      : (b.createdAt || '').localeCompare(a.createdAt || ''));
  const totalValue = visible.reduce((s, i) => s + i.total, 0);
  const overdue = group === 'sent' ? visible.filter(i => quietDaysOf(i) >= 5) : [];

  const chipStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
    background: active ? 'rgba(96,165,250,0.15)' : 'var(--card)',
    border: `1px solid ${active ? 'rgba(96,165,250,0.4)' : 'var(--border)'}`,
    color: active ? '#60a5fa' : 'var(--text-muted)',
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>Quotes</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Every estimate and wrap quote in one place. Waiting quotes sort quietest first — log each follow-up so the clock resets; reps get a nudge after 5 quiet days.
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button onClick={() => router.push(deepLinks.newEstimate())} style={{ padding: '7px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', cursor: 'pointer' }}>
            + New Estimate
          </button>
          <button onClick={() => router.push('/admin/wrap-quote')} style={{ padding: '7px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', cursor: 'pointer' }}>
            + New Wrap Quote
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' }}>
        {GROUP_CHIPS.map(c => (
          <button key={c.key} onClick={() => setGroup(c.key)} style={chipStyle(group === c.key)}>
            {c.label}{c.key !== 'all' ? ` (${groupCounts[c.key as Group] || 0})` : ` (${base.length})`}
          </button>
        ))}
        <span style={{ width: '1px', height: '20px', background: 'var(--border)' }} />
        {([['all', 'Both'], ['estimate', 'Estimates'], ['wrap', 'Wraps']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTypeFilter(key)} style={chipStyle(typeFilter === key)}>{label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px' }}>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search number, customer, title…"
          style={{ flex: 1, minWidth: '200px', maxWidth: '340px', padding: '8px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', outline: 'none' }}
        />
        <div style={{ padding: '8px 12px', borderRadius: '10px', background: 'var(--card)', border: '1px solid var(--border)', fontSize: '12px', color: 'var(--text-muted)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>{visible.length}</strong> {group === 'sent' ? 'waiting' : 'shown'} · <strong style={{ color: '#f472b6' }}>{fmtMoney(totalValue)}</strong> quoted
          {overdue.length > 0 && <span style={{ color: '#fbbf24', fontWeight: 700 }}> · {overdue.length} overdue for a follow-up</span>}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} style={{ width: '15px', height: '15px' }} />
          My quotes only
        </label>
      </div>

      {loading && <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>}
      {!loading && visible.length === 0 && (
        <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          {group === 'sent'
            ? 'Nothing waiting on an answer — every sent quote is resolved or fresh.'
            : 'No quotes match these filters.'}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {visible.map(item => {
          const isSent = item.status === 'sent';
          const quiet = quietDaysOf(item);
          const isBusy = busy === item.id;
          const key = `${item.type}-${item.id}`;
          const latestNote = item.followups.find(f => f.note);
          const showHistory = historyOpen.has(key);
          const chip = STATUS_CHIP[item.status] || { label: item.status, color: '#94a3b8' };
          return (
            <div key={key} id={`qfu-${key}`} style={{ background: 'var(--card)', border: `1px solid ${isSent && quiet >= 14 ? 'rgba(239,68,68,0.35)' : isSent && quiet >= 5 ? 'rgba(251,191,36,0.35)' : 'var(--border)'}`, borderRadius: '12px', padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '220px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '5px', textTransform: 'uppercase', background: item.type === 'estimate' ? 'rgba(96,165,250,0.12)' : 'rgba(167,139,250,0.12)', color: item.type === 'estimate' ? '#60a5fa' : '#a78bfa' }}>
                      {item.type === 'estimate' ? 'Estimate' : 'Wrap'}
                    </span>
                    <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{item.number}</span>
                    {item.altNumber && (
                      <span title="FleetSuite's own estimate number — NetSuite's is the one shown first" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>{item.altNumber}</span>
                    )}
                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{item.customer}</span>
                    <span style={{ fontSize: '13px', fontWeight: 800, color: '#f472b6' }}>{fmtMoney(item.total)}</span>
                    {(group === 'all' || !isSent) && (
                      <span style={{ fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '5px', background: `${chip.color}22`, color: chip.color }}>
                        {chip.label}
                      </span>
                    )}
                    {item.nextReminderAt && (
                      <span title="Reminder pending — quiet-day nudges are paused until this date" style={{ fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '5px', background: 'rgba(52,211,153,0.12)', color: '#34d399' }}>
                        ⏰ reminds {fmtDay(item.nextReminderAt)}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                    {item.title && <span>{item.title} · </span>}
                    {isSent ? <>sent {fmtDate(item.sentAt)}</>
                      : item.status === 'accepted' ? <>won {fmtDate(item.decidedAt || item.createdAt)}</>
                      : item.status === 'rejected' ? <>lost {fmtDate(item.decidedAt || item.createdAt)}</>
                      : <>created {fmtDate(item.createdAt)}</>}
                    {isSent && item.lastFollowupAt && <span> · last follow-up {fmtDate(item.lastFollowupAt)}</span>}
                    {item.repName && <span> · {item.repName}</span>}
                    {isSent && <span style={{ fontWeight: 800, color: quietColor(quiet) }}> · quiet {quiet}d</span>}
                  </div>
                  {isSent && latestNote && !showHistory && (
                    <div style={{ fontSize: '11px', color: 'var(--text-body)', marginTop: '4px', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '520px' }}>
                      &ldquo;{latestNote.note}&rdquo;
                      <span style={{ color: 'var(--text-muted)', fontStyle: 'normal' }}> — {latestNote.creatorName || 'Unknown'}, {fmtDate(latestNote.createdAt)}</span>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {isSent && (
                    <>
                      <button disabled={isBusy} onClick={() => { setLogTarget(item); setLogNote(''); setLogRemindAt(''); }} style={{ padding: '6px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', cursor: 'pointer' }}>
                        ☎ Log Follow-Up
                      </button>
                      <button disabled={isBusy} onClick={() => act(item, 'mark_accepted', `Mark ${item.number} (${fmtMoney(item.total)}) as accepted?`)} style={{ padding: '6px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 800, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' }}>
                        ✓ Won
                      </button>
                      <button disabled={isBusy} onClick={() => act(item, 'mark_rejected', `Mark ${item.number} as lost/rejected?`)} style={{ padding: '6px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', cursor: 'pointer' }}>
                        ✕ Lost
                      </button>
                    </>
                  )}
                  <button onClick={() => router.push(item.type === 'estimate' ? deepLinks.estimate(item.id) : deepLinks.wrapQuote(item.id))} style={{ padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                    Open →
                  </button>
                </div>
              </div>

              {/* Follow-up history — every logged touch with its comment */}
              {isSent && item.followups.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <button onClick={() => toggleHistory(key)} style={{ background: 'none', border: 'none', padding: 0, fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', cursor: 'pointer' }}>
                    {showHistory ? '▾ Hide' : `▸ ${item.followups.length} follow-up${item.followups.length !== 1 ? 's' : ''} logged`}
                  </button>
                  {showHistory && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
                      {item.followups.map(f => (
                        <div key={f.id} style={{ fontSize: '11px', padding: '6px 8px', borderRadius: '7px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', color: 'var(--text-muted)', fontSize: '10px' }}>
                            <span>{f.creatorName || 'Unknown'} · {new Date(f.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
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
              )}
            </div>
          );
        })}
      </div>

      {/* ── Log Follow-Up dialog: comment + optional reminder date ── */}
      {logTarget && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
          onClick={() => { if (!logSaving) setLogTarget(null); }}
        >
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: '14px', padding: '20px', width: '100%', maxWidth: '420px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Log Follow-Up
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
              {logTarget.number} — {logTarget.customer} · {fmtMoney(logTarget.total)}
            </div>
            <textarea
              autoFocus
              value={logNote}
              onChange={e => setLogNote(e.target.value)}
              placeholder="What did the customer say? (e.g. vehicles arrive in September)"
              style={{
                width: '100%', padding: '10px', borderRadius: '8px', fontSize: '12px',
                background: 'var(--input-bg)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', minHeight: '80px', resize: 'vertical', outline: 'none',
              }}
            />
            <div style={{ marginTop: '10px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>
                Remind me to follow up on (optional)
              </div>
              <input
                type="date"
                value={logRemindAt}
                min={new Date().toISOString().slice(0, 10)}
                onChange={e => setLogRemindAt(e.target.value)}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
                  background: 'var(--input-bg)', border: '1px solid var(--border)',
                  color: 'var(--text-primary)', outline: 'none',
                }}
              />
              {logRemindAt && (
                <div style={{ fontSize: '10px', color: '#34d399', marginTop: '4px' }}>
                  You&apos;ll get a reminder that morning, and the quiet-day nudges pause until then.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
              <button
                disabled={logSaving}
                onClick={() => setLogTarget(null)}
                style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                disabled={logSaving}
                onClick={saveFollowUp}
                style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'rgba(96,165,250,0.15)', border: '1px solid rgba(96,165,250,0.3)', color: '#60a5fa', cursor: 'pointer' }}
              >
                {logSaving ? 'Saving…' : 'Log Follow-Up'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
