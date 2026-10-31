'use client';

/**
 * The Sent box (Craig, 2026-10-31: "every transaction show if and when and
 * to whom it has been sent"). Latest send on top in its delivery colour,
 * customer opens under it, earlier sends expand downward, and Mark as sent
 * for anything sent outside FleetSuite. Pass several refs to show them as
 * one history (an estimate and its pro forma).
 */

import { useCallback, useEffect, useState } from 'react';
import { theme } from '@/lib/theme';
import { apiFetch } from '@/lib/api-client';
import { closeOnEscape } from '@/lib/modal-escape';
import {
  type SendSummary, type SendEvent, type SendTone, MARK_METHODS,
  sendLine, sendTone, fmtSentWhen, summarizeSends, sentChipText,
} from '@/lib/document-sends';

const TONE: Record<SendTone, string> = {
  ok: theme.success, wait: '#fbbf24', bad: theme.error, none: theme.textMuted,
};

/** Merge several refs' summaries into one history. */
export function mergeSummaries(list: (SendSummary | undefined)[]): SendSummary {
  const events: SendEvent[] = [];
  const seen = new Set<string>();
  let opens = null as SendSummary['opens'];
  for (const s of list) {
    if (!s) continue;
    for (const e of s.history) {
      const key = e.emailLogId ? `log:${e.emailLogId}` : `${e.source}:${e.at}:${e.to.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(e);
    }
    if (s.opens) {
      opens = {
        count: (opens?.count || 0) + s.opens.count,
        lastAt: [opens?.lastAt, s.opens.lastAt].filter(Boolean).sort().pop() || null,
      };
    }
  }
  return summarizeSends(events, opens);
}

/**
 * One read for many documents (a list's Sent column, the Vendor POs cards).
 * Returns ref → summary; refresh() re-reads after a send or a mark, and so
 * does a change in `version`.
 */
export function useDocumentSends(refs: string[], version: string | number = ''): { sends: Record<string, SendSummary>; loaded: boolean; refresh: () => void } {
  const [sends, setSends] = useState<Record<string, SendSummary>>({});
  const [loaded, setLoaded] = useState(false);
  const [bump, setBump] = useState(0);
  const key = [...new Set(refs)].join(',');
  useEffect(() => {
    if (!key) { setSends({}); setLoaded(true); return; }
    let cancelled = false;
    (async () => {
      const all: Record<string, SendSummary> = {};
      const list = key.split(',');
      for (let i = 0; i < list.length; i += 300) {
        try {
          const res = await apiFetch(`/api/document-sends?refs=${encodeURIComponent(list.slice(i, i + 300).join(','))}`);
          const body = await res.json().catch(() => ({}));
          if (res.ok) Object.assign(all, body.sends || {});
        } catch { /* the column just shows nothing for these */ }
      }
      if (!cancelled) { setSends(all); setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [key, bump, version]);
  return { sends, loaded, refresh: () => setBump(n => n + 1) };
}

/** A list's Sent chip: "10/31 · Delivered", orange "Not sent", red "Bounced". */
export function SentChip({ summary }: { summary: SendSummary | undefined }) {
  const tone = sendTone(summary?.latest || null);
  const colors: Record<SendTone, { bg: string; fg: string }> = {
    ok: { bg: 'rgba(34,197,94,0.12)', fg: theme.success },
    wait: { bg: 'rgba(251,191,36,0.12)', fg: '#fbbf24' },
    bad: { bg: 'rgba(239,68,68,0.14)', fg: theme.error },
    none: { bg: 'rgba(245,158,11,0.14)', fg: '#f59e0b' },
  };
  const c = colors[tone];
  return (
    <span title={summary?.latest ? sendLine(summary.latest) : 'Not sent from FleetSuite'}
      style={{ fontSize: '10px', fontWeight: 800, padding: '2px 7px', borderRadius: '6px', whiteSpace: 'nowrap', background: c.bg, color: c.fg }}>
      {sentChipText(summary)}
    </span>
  );
}

interface Props {
  refs: string[];
  /** The ref Mark as sent records against; defaults to the first. */
  markRef?: string;
  /** e.g. "INV1512" — names the document in the Mark as sent window. */
  docLabel: string;
  /** Hide Mark as sent (screens where staff can't act on the document). */
  canMark?: boolean;
  /** Bump after a send on the screen so the box re-reads. */
  refreshKey?: number | string;
  /** What "never sent" reads as. */
  emptyText?: string;
  style?: React.CSSProperties;
}

export default function SentBox({ refs, markRef, docLabel, canMark = true, refreshKey, emptyText = 'Not emailed from FleetSuite yet', style }: Props) {
  const [summary, setSummary] = useState<SendSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const key = refs.join(',');

  const load = useCallback(async () => {
    if (!key) return;
    try {
      const res = await apiFetch(`/api/document-sends?refs=${encodeURIComponent(key)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Could not check what was sent.'); return; }
      setError(null);
      setSummary(mergeSummaries(key.split(',').map(r => body.sends?.[r])));
    } catch {
      setError('Could not check what was sent.');
    }
  }, [key]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const box: React.CSSProperties = {
    border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '9px 12px',
    background: theme.subtleBg, fontSize: '13px', lineHeight: 1.35, ...style,
  };
  const clamp: React.CSSProperties = {
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  };
  const link: React.CSSProperties = {
    background: 'none', border: 'none', padding: 0, color: 'var(--accent)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
  };
  const tag = <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.06em', color: theme.textMuted, marginBottom: '3px' }}>SENT</div>;

  if (error) return <div style={box}>{tag}<div style={{ color: theme.error, fontWeight: 700 }}>{error}</div></div>;
  if (!summary) return <div style={box}>{tag}<div style={{ color: theme.textMuted }}>Checking…</div></div>;

  const latest = summary.latest;
  const earlier = summary.history.filter(e => e !== latest);
  const tone = sendTone(latest);
  const markLink = canMark && (
    <button style={link} onClick={() => setMarking(true)}>Mark as sent…</button>
  );

  return (
    <div style={box}>
      {tag}
      {latest ? (
        <div style={{ ...clamp, color: TONE[tone], fontWeight: tone === 'bad' ? 700 : 400 }}>{sendLine(latest)}</div>
      ) : (
        <div style={{ color: theme.textMuted }}>{emptyText}</div>
      )}
      {summary.opens && summary.opens.count > 0 && (
        <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '3px' }}>
          👁 Customer opened it {summary.opens.count === 1 ? 'once' : `${summary.opens.count} times`}
          {summary.opens.lastAt ? ` · last ${fmtSentWhen(summary.opens.lastAt)}` : ''}
        </div>
      )}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '4px', alignItems: 'center' }}>
        {earlier.length > 0 && (
          <button style={link} onClick={() => setOpen(o => !o)}>
            {open ? '▴' : '▾'} {earlier.length} earlier send{earlier.length === 1 ? '' : 's'}
          </button>
        )}
        {!latest && canMark && <span style={{ fontSize: '12px', color: theme.textMuted }}>Sent it some other way?</span>}
        {markLink}
      </div>
      {open && earlier.length > 0 && (
        <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: `1px dashed ${theme.border}`, display: 'grid', gap: '5px' }}>
          {earlier.map((e, i) => {
            const t = sendTone(e);
            return <div key={i} style={{ ...clamp, fontSize: '12px', color: TONE[t], fontWeight: t === 'bad' ? 700 : 400 }}>{sendLine(e)}</div>;
          })}
        </div>
      )}
      {marking && (
        <MarkSentModal
          docRef={markRef || refs[0]}
          docLabel={docLabel}
          onClose={() => setMarking(false)}
          onSaved={() => { setMarking(false); load(); }}
        />
      )}
    </div>
  );
}

export function MarkSentModal({ docRef, docLabel, onClose, onSaved }: {
  docRef: string; docLabel: string; onClose: () => void; onSaved: () => void;
}) {
  const [method, setMethod] = useState<string>(MARK_METHODS[0].value);
  const [to, setTo] = useState('');
  const [sentOn, setSentOn] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailed = method === 'netsuite' || method === 'own_email';

  const save = async () => {
    const recipients = to.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    if (emailed && recipients.length === 0) { setError('Please enter who it was emailed to.'); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/document-sends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: docRef, method, recipients, sentOn }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || `Could not save (${res.status}).`); return; }
      onSaved();
    } catch (e: any) {
      setError(e?.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const label: React.CSSProperties = { display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: theme.textMuted, marginBottom: '4px' };
  const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '14px' };

  return (
    <div ref={closeOnEscape(onClose)} className="mark-sent-backdrop"
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '16px' }}>
      <style>{`
        @media (max-width: 520px) {
          .mark-sent-backdrop { padding: 0 !important; align-items: stretch !important; }
          .mark-sent-window { max-width: none !important; border-radius: 0 !important; border: none !important;
            padding-top: calc(16px + env(safe-area-inset-top, 0px)) !important; padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)) !important; }
        }
      `}</style>
      <div className="mark-sent-window" role="dialog" aria-modal="true" aria-label={`Mark ${docLabel} as sent`}
        style={{ width: '100%', maxWidth: '420px', maxHeight: '100%', overflowY: 'auto', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '16px', display: 'grid', gap: '12px', alignContent: 'start', boxSizing: 'border-box', color: theme.textPrimary }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
          <div>
            <div style={{ fontSize: '16px', fontWeight: 800 }}>Mark {docLabel} as sent</div>
            <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '2px' }}>For something sent outside FleetSuite. Nothing is emailed.</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: theme.textMuted, fontSize: '20px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
        </div>
        <div>
          <label style={label} htmlFor="mark-how">How</label>
          <select id="mark-how" style={input} value={method} onChange={e => setMethod(e.target.value)}>
            {MARK_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <label style={label} htmlFor="mark-to">{emailed ? 'Emailed to' : 'To (optional)'}</label>
          <input id="mark-to" style={{ ...input, borderColor: error && emailed && !to.trim() ? theme.error : theme.border }}
            value={to} onChange={e => setTo(e.target.value)} placeholder={emailed ? 'ap@customer.com' : 'Who got it'} />
        </div>
        <div>
          <label style={label} htmlFor="mark-when">When</label>
          <input id="mark-when" type="date" style={input} value={sentOn} onChange={e => setSentOn(e.target.value)} />
        </div>
        {error && <div style={{ color: theme.error, fontWeight: 700, fontSize: '13px' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button onClick={onClose} style={{ padding: '8px 14px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'transparent', color: theme.textPrimary, fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', background: theme.success, color: '#fff', fontWeight: 700, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
