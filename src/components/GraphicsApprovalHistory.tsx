'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { historySummary, type ApprovalHistory, type HistoryMessage, type HistoryRound } from '@/lib/approval-history';
import { closeOnEscape } from '@/lib/modal-escape';

interface ProofFile { id: string; file_name: string; storage_path: string; file_type: string | null }

const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

const STATUS: Record<string, { label: string; color: string }> = {
  sent: { label: 'Sent', color: 'var(--text-muted)' },
  pending: { label: 'Pending', color: 'var(--text-muted)' },
  delivered: { label: 'Delivered', color: '#22c55e' },
  delivery_delayed: { label: 'Delayed', color: '#fbbf24' },
  bounced: { label: 'Bounced', color: '#ef4444' },
  complained: { label: 'Marked spam', color: '#ef4444' },
  failed: { label: 'Failed', color: '#ef4444' },
  skipped: { label: 'Not sent: texting is off', color: '#fbbf24' },
  received: { label: 'Received', color: '#22c55e' },
};

const OUTCOME: Record<HistoryRound['outcome'], { label: string; color: string; bg: string }> = {
  pending: { label: 'Awaiting customer', color: '#fbbf24', bg: 'rgba(251,191,36,0.1)' },
  approved: { label: 'Approved', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  rejected: { label: 'Changes requested', color: '#ef4444', bg: 'rgba(239,68,68,0.08)' },
  superseded: { label: 'Replaced by a newer proof', color: 'var(--text-muted)', bg: 'var(--subtle-bg)' },
};

const VIA: Record<string, string> = { email: 'the email link', sms: 'the text link' };

const linkBtn: React.CSSProperties = {
  padding: 0, border: 'none', background: 'none', color: '#60a5fa',
  fontSize: '10px', fontWeight: 700, cursor: 'pointer', flexShrink: 0,
};

/**
 * The expandable history under a graphics job's Customer Approval card:
 * every proof round (file, who sent it, what it was fixing, how it ended)
 * with the emails, texts and customer replies that went with it.
 */
export default function GraphicsApprovalHistory<F extends ProofFile>({ jobId, refreshKey, files, fileUrl, onOpenFile }: {
  jobId: string;
  /** Changes when the job's approval state does, so a send/decision re-reads. */
  refreshKey: string;
  files: F[];
  fileUrl: (f: F) => string;
  onOpenFile: (e: React.MouseEvent, f: F) => void;
}) {
  const [history, setHistory] = useState<ApprovalHistory | null>(null);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<{ msg: HistoryMessage; html: string | null; loading: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/graphics-jobs/${encodeURIComponent(jobId)}/approval-history`);
        const data = res.ok ? await res.json() : null;
        if (!cancelled) setHistory(data);
      } catch {
        if (!cancelled) setHistory(null);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, refreshKey]);

  if (!history || (history.rounds.length === 0 && history.other.length === 0)) return null;

  const openEmail = async (msg: HistoryMessage) => {
    setViewing({ msg, html: null, loading: true });
    let html: string | null = null;
    try {
      const res = await apiFetch(`/api/sent-emails/${msg.id}`);
      if (res.ok) html = (await res.json()).body_html || null;
    } catch { /* falls through to "not available" */ }
    setViewing(v => (v?.msg.id === msg.id ? { msg, html, loading: false } : v));
  };

  const messageRow = (m: HistoryMessage) => {
    const inbound = m.direction === 'in';
    const status = m.status ? STATUS[m.status] : null;
    const icon = m.channel === 'email' ? '✉' : '💬';
    const title = inbound
      ? `${m.who} replied by ${m.channel}`
      : m.source === 'email_log'
        ? (m.reminder ? 'Reminder email' : m.kind === 'pickup_notice' ? 'Pickup notice email' : 'Proof email')
        : m.kind === 'pickup_notice' ? 'Pickup notice text' : m.source === 'sms_log' ? 'Proof link text' : `Message by ${m.channel}`;
    return (
      <div key={`${m.source}-${m.id}`} style={{
        display: 'flex', gap: '8px', padding: '6px 8px', borderRadius: '6px', minWidth: 0,
        background: inbound ? 'rgba(96,165,250,0.08)' : 'transparent',
        border: inbound ? '1px solid rgba(96,165,250,0.2)' : '1px solid transparent',
      }}>
        <span style={{ fontSize: '11px', flexShrink: 0, lineHeight: '16px' }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '6px', fontSize: '11px' }}>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{fmtWhen(m.at)}</span>
            {status && !inbound && (
              <span style={{ color: status.color, fontSize: '10px', fontWeight: 700 }}>{status.label}</span>
            )}
            {m.source === 'email_log' && (
              <button onClick={() => openEmail(m)} style={linkBtn}>Open</button>
            )}
          </div>
          {!inbound && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
              To {m.who || '—'}{m.sentByName ? ` · by ${m.sentByName}` : m.reminder ? ' · automatic' : ''}
            </div>
          )}
          {m.body && (
            <div style={{ fontSize: '11px', color: 'var(--text-body)', marginTop: '2px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontStyle: inbound ? 'normal' : 'italic' }}>
              {m.body}
            </div>
          )}
          {m.detail && (m.status === 'failed' || m.status === 'bounced') && (
            <div style={{ fontSize: '10px', color: '#ef4444', overflowWrap: 'anywhere' }}>{m.detail}</div>
          )}
        </div>
      </div>
    );
  };

  const roundCard = (r: HistoryRound, isLatest: boolean) => {
    const outcome = OUTCOME[r.outcome];
    const file = r.proofFileId ? files.find(f => f.id === r.proofFileId) : null;
    const d = isLatest ? history.decision : null;
    return (
      <div key={r.roundNumber} style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
        <div style={{ padding: '8px 10px', background: 'var(--subtle-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>{r.label}</span>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
              {r.sentAt ? `sent ${fmtWhen(r.sentAt)}` : ''}{r.sentByName ? ` by ${r.sentByName}` : ''}
            </span>
          </div>
          <div style={{ fontSize: '11px', marginTop: '3px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: 'var(--text-muted)' }}>Proof: </span>
            {file ? (
              <a href={fileUrl(file)} onClick={(e) => onOpenFile(e, file)} target="_blank" rel="noopener noreferrer"
                style={{ color: '#60a5fa', fontWeight: 600, textDecoration: 'none' }}>{file.file_name}</a>
            ) : (
              <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                {r.proofFileName ? `${r.proofFileName} (removed from job)` : r.proofFileId ? 'file removed from job' : 'not recorded'}
              </span>
            )}
          </div>
          {r.addressing && (
            <div style={{ fontSize: '11px', color: 'var(--text-body)', marginTop: '3px', overflowWrap: 'anywhere' }}>
              <span style={{ color: 'var(--text-muted)' }}>Fixing: </span><span style={{ fontStyle: 'italic' }}>{r.addressing}</span>
            </div>
          )}
        </div>
        {r.messages.length > 0 && (
          <div style={{ padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {r.messages.map(messageRow)}
          </div>
        )}
        <div style={{ padding: '6px 10px', background: outcome.bg, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: outcome.color }}>
            {r.outcome === 'approved' ? '✓ ' : r.outcome === 'rejected' ? '↺ ' : ''}{outcome.label}
            {r.decidedAt && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {fmtWhen(r.decidedAt)}</span>}
          </div>
          {r.rejectionReason && (
            <div style={{ fontSize: '11px', color: 'var(--text-body)', marginTop: '2px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              “{r.rejectionReason}”
            </div>
          )}
          {d && r.outcome !== 'pending' && r.outcome !== 'superseded' && (d.via || d.timeOnPageSeconds != null) && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', overflowWrap: 'anywhere' }}>
              {d.via ? `Through ${VIA[d.via] || d.via}${d.target ? ` sent to ${d.target}` : ''}` : ''}
              {d.timeOnPageSeconds != null ? `${d.via ? ' · ' : ''}${Math.max(1, Math.round(d.timeOnPageSeconds / 60))} min on the page` : ''}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ marginTop: '8px' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderRadius: '6px',
          background: 'var(--subtle-bg)', border: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>
          {historySummary(history) || 'History'}
        </span>
        <span style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', flexShrink: 0 }}>
          {open ? 'Hide history ▴' : 'Show history ▾'}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {history.rounds.map((r, i) => roundCard(r, i === 0))}
          {history.other.length > 0 && (
            <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '6px 2px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px', padding: '0 8px 4px' }}>
                Other customer messages
              </div>
              {history.other.map(messageRow)}
            </div>
          )}
          {history.rounds.length > 0 && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
              Texts sent before October 2026 aren&apos;t listed. Customer replies to emails go to the sender&apos;s inbox, not here.
            </div>
          )}
        </div>
      )}

      {viewing && (
        <div ref={closeOnEscape(() => setViewing(null))} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', width: '100%', maxWidth: '720px',
            maxHeight: 'calc(88vh / var(--ts))', display: 'flex', flexDirection: 'column', padding: '14px', gap: '10px',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{viewing.msg.subject || '(no subject)'}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>To {viewing.msg.who} · {fmtWhen(viewing.msg.at)}</div>
              </div>
              <button onClick={() => setViewing(null)} style={{ padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--subtle-bg)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>Close</button>
            </div>
            {viewing.loading ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>
            ) : viewing.html ? (
              <iframe srcDoc={viewing.html} title="Sent email" sandbox="" style={{ width: '100%', flex: 1, minHeight: '360px', border: '1px solid var(--border)', borderRadius: '8px', background: '#f3f4f6' }} />
            ) : (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>This email&apos;s content isn&apos;t available.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
