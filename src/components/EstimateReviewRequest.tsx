'use client';

/**
 * The Send for Review note on the estimate (Craig, 2026-10-23, thread
 * "Review request note shown on the estimate"): Valarie's review email
 * carried a note, but opening the estimate from that email showed nothing
 * of it. Rendered inside the In-review box: who asked and when, their note,
 * the files that went along, a "View the email" button for the email as it
 * was sent, and the earlier rounds (migration 428).
 *
 * Reviews sent before migration 428 have no saved note; for those the
 * "View the email" button is the way to read it.
 */

import { useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { apiFetch } from '@/lib/api-client';
import { closeOnEscape } from '@/lib/modal-escape';
import { deepLinks } from '@/lib/deep-links';
import { reviewRequestFilesOf, type ReviewRound } from '@/lib/estimate-review';

interface Props {
  estimate: {
    id: string;
    internal_review_requested_by?: string | null;
    internal_review_requested_at?: string | null;
    internal_review_request_note?: string | null;
    internal_review_request_files?: unknown;
    internal_review_history?: unknown;
  };
  staffName: (id: string | null | undefined) => string;
}

const fmtWhen = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const fmtDay = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const chip = {
  fontSize: '11px', padding: '2px 7px', borderRadius: '6px',
  background: 'rgba(148,163,184,0.12)', border: '1px solid var(--border)',
  color: 'var(--text-body)', overflowWrap: 'anywhere' as const,
};

const linkBtn = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  fontSize: '11px', fontWeight: 700, color: '#60a5fa',
};

export default function EstimateReviewRequest({ estimate, staffName }: Props) {
  const [viewing, setViewing] = useState<{ loading: boolean; html: string | null; subject?: string; error?: string } | null>(null);

  const note = estimate.internal_review_request_note?.trim() || '';
  const files = reviewRequestFilesOf(estimate.internal_review_request_files);
  const history = (Array.isArray(estimate.internal_review_history) ? estimate.internal_review_history as ReviewRound[] : [])
    .filter(r => r && (r.requested_at || r.status));
  const hasRequest = !!estimate.internal_review_requested_by;

  // The review email as it went out: the latest one for this estimate.
  const openEmail = async () => {
    setViewing({ loading: true, html: null });
    try {
      const { data: row } = await createClient()
        .from('email_log')
        .select('id, subject')
        .eq('kind', 'estimate_internal_review')
        .eq('context_url', deepLinks.estimate(estimate.id))
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!row) {
        setViewing({ loading: false, html: null, error: 'No review email was found for this estimate.' });
        return;
      }
      const res = await apiFetch(`/api/sent-emails/${row.id}`);
      const data = res.ok ? await res.json() : null;
      setViewing({
        loading: false,
        html: data?.body_html || null,
        subject: row.subject || undefined,
        error: res.ok ? (data?.body_html ? undefined : 'The text of this email wasn’t saved.') : 'Couldn’t load the email. Try again in a moment.',
      });
    } catch {
      setViewing({ loading: false, html: null, error: 'Couldn’t load the email. Try again in a moment.' });
    }
  };

  if (!hasRequest && history.length === 0) return null;

  return (
    <>
      {hasRequest && (note || files.length > 0) && (
        <div style={{
          marginTop: '8px', padding: '8px 10px', borderRadius: '8px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: '#60a5fa' }}>
            {staffName(estimate.internal_review_requested_by)} asked
            <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}> · {fmtWhen(estimate.internal_review_requested_at)}</span>
          </div>
          {note && (
            <div style={{ marginTop: '4px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-body)' }}>{note}</div>
          )}
          {files.length > 0 && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
              {files.map((f, i) => (
                <span key={`${f.id || 'pdf'}-${i}`} style={chip}>{f.id ? '📎' : '📄'} {f.name}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {hasRequest && (
        <div style={{ marginTop: '6px' }}>
          <button type="button" onClick={openEmail} style={linkBtn}>View the email</button>
        </div>
      )}

      {history.length > 0 && (
        <details style={{ marginTop: '8px', fontSize: '11px' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontWeight: 700 }}>
            Earlier reviews ({history.length})
          </summary>
          {[...history].reverse().map((r, i) => {
            const answer = r.status === 'approved'
              ? `✓ ${staffName(r.decided_by)} approved${r.decided_at ? `, ${fmtDay(r.decided_at)}` : ''}`
              : r.status === 'changes_requested'
                ? `↩ ${staffName(r.decided_by)} sent it back${r.decided_at ? `, ${fmtDay(r.decided_at)}` : ''}`
                : 'Sent again before anyone answered';
            const roundFiles = reviewRequestFilesOf(r.request_files);
            return (
              <div key={`${r.requested_at || ''}-${i}`} style={{ borderTop: '1px solid var(--border)', padding: '6px 0', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontWeight: 700, color: 'var(--text-body)' }}>
                  {fmtDay(r.requested_at)} · {staffName(r.requested_by)} asked {staffName(r.reviewer_id)}
                </span>
                {r.request_note && <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>“{r.request_note}”</span>}
                {roundFiles.length > 0 && (
                  <span style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>Sent with: {roundFiles.map(f => f.name).join(', ')}</span>
                )}
                <span style={{ color: 'var(--text-muted)' }}>{answer}</span>
                {r.decision_note && <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>“{r.decision_note}”</span>}
              </div>
            );
          })}
        </details>
      )}

      {viewing && (
        <div ref={closeOnEscape(() => setViewing(null))} onClick={() => setViewing(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Review email"
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '16px', width: 'min(720px, 100%)', maxHeight: 'calc(100vh / var(--ts) - 40px)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
              <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', overflowWrap: 'anywhere', minWidth: 0 }}>
                {viewing.subject || 'Review email'}
              </div>
              <button onClick={() => setViewing(null)} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '16px', cursor: 'pointer', padding: 0 }}>✕</button>
            </div>
            {viewing.loading ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '24px 0', textAlign: 'center' }}>Loading…</div>
            ) : viewing.html ? (
              <iframe srcDoc={viewing.html} title="Review email" sandbox="" style={{ width: '100%', flex: 1, minHeight: '360px', border: '1px solid var(--border)', borderRadius: '8px', background: '#f3f4f6' }} />
            ) : (
              <div style={{ fontSize: '12px', color: '#ef4444', padding: '16px 0' }}>{viewing.error}</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
