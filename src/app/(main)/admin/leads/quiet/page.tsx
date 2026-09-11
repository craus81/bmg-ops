'use client';

/**
 * Quiet-lead triage (R6-9). One screen whose job is to empty itself: every
 * row is a lead nobody has touched in a month, and every decision it can
 * need — touch, park, close, remind, flag — is on the row.
 *
 * "Days quiet" counts from a logged ACTIVITY where one exists. Rows dated
 * only from a record edit say so in as many words, because an edit is not
 * contact and a queue that blurs the two sends people to chase leads they
 * already called.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { touchLabel, type QuietLead } from '@/lib/quiet-leads';

const LOST_REASONS = [
  { id: 'price', label: 'Price' },
  { id: 'timing', label: 'Timing' },
  { id: 'competitor', label: 'Competitor' },
  { id: 'no_response', label: 'No response' },
  { id: 'other', label: 'Other' },
];

type ActionKind = 'touch' | 'nurture' | 'lost' | 'hot' | 'unhot' | 'remind';

const quietColor = (d: number) => d >= 90 ? '#ef4444' : d >= 60 ? '#fb923c' : '#fbbf24';

export default function QuietLeadsPage() {
  const router = useRouter();
  const { isAdmin, isSales, loading: authLoading } = useAuth();

  const [leads, setLeads] = useState<QuietLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // The one modal every action funnels through — it carries whichever inputs
  // the action actually requires, so a Lost can never be recorded without a
  // reason and a Touch can never be recorded without saying what it was.
  const [prompt, setPrompt] = useState<{ action: ActionKind; ids: string[]; title: string } | null>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('price');
  const [remindAt, setRemindAt] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/leads/quiet?days=${days}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load quiet leads');
      setLeads(data.leads || []);
      setSelected(new Set());
    } catch (e: any) {
      setError(e.message || 'Could not load quiet leads');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    load();
  }, [authLoading, isAdmin, isSales, load, router]);

  const openPrompt = (action: ActionKind, ids: string[]) => {
    if (ids.length === 0) return;
    setNote('');
    setReason('price');
    setRemindAt(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
    const names = ids.length === 1
      ? leads.find(l => l.id === ids[0])?.companyName || 'this lead'
      : `${ids.length} leads`;
    const title = action === 'touch' ? `Log a touch on ${names}`
      : action === 'nurture' ? `Park ${names} as nurturing`
      : action === 'lost' ? `Close ${names} as lost`
      : action === 'remind' ? `Remind me about ${names}`
      : action === 'hot' ? `Mark ${names} hot`
      : `Remove the hot flag from ${names}`;
    setPrompt({ action, ids, title });
  };

  const submit = async () => {
    if (!prompt || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/leads/quiet', {
        method: 'POST',
        body: JSON.stringify({
          ids: prompt.ids,
          action: prompt.action,
          note: note.trim() || undefined,
          reason: prompt.action === 'lost' ? reason : undefined,
          remindAt: prompt.action === 'remind' ? remindAt : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'That did not go through');
      setPrompt(null);
      setMsg({ ok: true, text: `${data.updated} lead${data.updated === 1 ? '' : 's'} updated.` });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message || 'That did not go through' });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const card: React.CSSProperties = {
    background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 14px',
  };
  const btn = (color?: string): React.CSSProperties => ({
    padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700,
    background: 'var(--card)', color: color || 'var(--text-body)',
    border: `1px solid ${color ? `${color}55` : 'var(--border)'}`, cursor: 'pointer',
  });

  if (authLoading || loading) {
    return <div style={{ padding: '24px', color: 'var(--text-muted)' }}>Loading quiet leads…</div>;
  }

  return (
    <div style={{ padding: '18px 16px 90px', maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ marginBottom: '4px', fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>
        Quiet Lead Triage
      </div>
      <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.5, maxWidth: '72ch' }}>
        Active leads with no logged contact in {days}+ days, longest-quiet first. Every row needs one of three
        answers — touch it, park it as nurturing, or close it as lost. Rows that have never had contact logged
        are dated from the record itself and say so; that is not the same as a call nobody wrote down.
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
        {[30, 60, 90].map(d => (
          <button key={d} onClick={() => setDays(d)} style={{
            ...btn(days === d ? 'var(--orange)' : undefined),
            background: days === d ? 'rgba(249,115,22,0.12)' : 'var(--card)',
          }}>
            {d}+ days
          </button>
        ))}
        <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '4px' }}>
          {leads.length} lead{leads.length === 1 ? '' : 's'}
        </span>
        {selected.size > 0 && (
          <span style={{ display: 'flex', gap: '6px', marginLeft: 'auto', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)', alignSelf: 'center' }}>
              {selected.size} selected
            </span>
            <button onClick={() => openPrompt('nurture', [...selected])} style={btn('#60a5fa')}>Park as nurturing</button>
            <button onClick={() => openPrompt('lost', [...selected])} style={btn('#ef4444')}>Close as lost</button>
          </span>
        )}
      </div>

      {msg && (
        <div style={{
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', fontSize: '12px', fontWeight: 600,
          background: msg.ok ? 'var(--success-bg)' : 'var(--error-bg)',
          border: `1px solid ${msg.ok ? 'var(--success-border)' : 'var(--error-border)'}`,
          color: msg.ok ? 'var(--success)' : 'var(--error)',
        }}>{msg.text}</div>
      )}

      {error && (
        <div style={{ ...card, borderColor: 'var(--error-border)', color: 'var(--error)', fontSize: '13px' }}>{error}</div>
      )}

      {!error && leads.length === 0 && (
        <div style={{ ...card, color: 'var(--text-muted)', fontSize: '13px' }}>
          Nothing is quiet past {days} days. This page is supposed to be empty.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {leads.map(lead => (
          <div key={lead.id} style={card}>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <input
                type="checkbox"
                checked={selected.has(lead.id)}
                onChange={() => toggle(lead.id)}
                aria-label={`Select ${lead.companyName}`}
                style={{ marginTop: '3px' }}
              />
              <div style={{ flex: 1, minWidth: '240px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <a href={deepLinks.prospect(lead.id)} style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', textDecoration: 'none' }}>
                    {lead.companyName}
                  </a>
                  <span style={{ fontSize: '11px', fontWeight: 800, color: quietColor(lead.daysQuiet || 0) }}>
                    quiet {lead.daysQuiet}d
                  </span>
                  {lead.isHot && (
                    <span style={{ fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '5px', background: 'rgba(249,115,22,0.14)', color: '#f97316' }}>HOT</span>
                  )}
                  {lead.openQuoteCount > 0 && (
                    <span title="Quotes already sent and still unanswered — this lead has something outstanding" style={{ fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '5px', background: 'rgba(56,189,248,0.14)', color: '#38bdf8' }}>
                      {lead.openQuoteCount} open quote{lead.openQuoteCount === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                  {touchLabel(lead.lastTouch)}
                  {lead.createdByName && <span> · created by {lead.createdByName}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button onClick={() => openPrompt('touch', [lead.id])} style={btn('#22c55e')}>Log touch</button>
                <button onClick={() => openPrompt('remind', [lead.id])} style={btn('#34d399')}>Remind me</button>
                <button onClick={() => openPrompt('nurture', [lead.id])} style={btn('#60a5fa')}>Nurture</button>
                <button onClick={() => openPrompt('lost', [lead.id])} style={btn('#ef4444')}>Lost</button>
                <button onClick={() => openPrompt(lead.isHot ? 'unhot' : 'hot', [lead.id])} style={btn('#f97316')}>
                  {lead.isHot ? 'Not hot' : 'Hot'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {prompt && (
        <div
          onClick={() => !busy && setPrompt(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 60 }}
        >
          <div onClick={e => e.stopPropagation()} style={{ ...card, width: '100%', maxWidth: '440px' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '10px' }}>
              {prompt.title}
            </div>

            {prompt.action === 'lost' && (
              <label style={{ display: 'block', marginBottom: '10px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-label)', display: 'block', marginBottom: '4px' }}>
                  Why (required)
                </span>
                <select
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '9px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)' }}
                >
                  {LOST_REASONS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </label>
            )}

            {prompt.action === 'remind' && (
              <label style={{ display: 'block', marginBottom: '10px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-label)', display: 'block', marginBottom: '4px' }}>
                  Remind me on
                </span>
                <input
                  type="date"
                  value={remindAt}
                  onChange={e => setRemindAt(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '9px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)' }}
                />
              </label>
            )}

            <label style={{ display: 'block', marginBottom: '12px' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-label)', display: 'block', marginBottom: '4px' }}>
                {prompt.action === 'touch' ? 'What was the touch? (required)' : 'Note (optional)'}
              </span>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                rows={3}
                placeholder={prompt.action === 'touch' ? 'Called Dana — asked to revisit in Q4' : ''}
                style={{ width: '100%', padding: '10px 12px', borderRadius: '9px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', resize: 'vertical' }}
              />
            </label>

            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.5 }}>
              Whatever you choose lands on each record&rsquo;s timeline, so the next person can see what was
              decided and why.
            </div>

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={() => setPrompt(null)} disabled={busy} style={btn()}>Cancel</button>
              <button
                onClick={submit}
                disabled={busy || (prompt.action === 'touch' && !note.trim())}
                style={{
                  ...btn('#fff'),
                  background: busy || (prompt.action === 'touch' && !note.trim()) ? 'var(--text-muted)' : 'var(--orange)',
                  border: 'none', padding: '8px 16px', fontSize: '12px',
                }}
              >
                {busy ? 'Working…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
