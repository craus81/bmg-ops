'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { STATE_LABEL, JOB_STATE_LABEL, NEEDS_ACTION, type InviteState, type JobSlaState } from '@/lib/invite-sla';

/**
 * Invite & bid aging (R6-8). Every job still looking for an installer, with
 * each invite's state against the clock.
 *
 * Two things the wording is careful about: "no view recorded" is a fact
 * about OUR record, not a claim that the installer is ignoring us — they may
 * have the email or have phoned. And a job whose invites were all declined
 * is not "waiting"; it has its answer, and that is the more urgent problem.
 */

interface Invite {
  id: string; companyId: string | null; companyName: string | null;
  sentAt: string; seenAt: string | null; repingedAt: string | null;
  state: InviteState; hoursOut: number; hoursToRespond: number | null;
  breached: boolean; declineReason: string | null;
}
interface Job {
  jobId: string; jobNumber: string | null; title: string | null; status: string | null;
  deadline: string | null; invites: Invite[];
  interested: number; declined: number; unanswered: number; breachedInvites: number;
  oldestHoursOut: number | null; state: JobSlaState; alertedAt: string | null;
}
interface Board {
  jobs: Job[];
  totals: {
    open: number; late: number; allDeclined: number; noInvites: number;
    medianResponseHours: number | null; answeredSamples: number;
  };
  slaHours: number;
  generatedAt: string;
}

const JOB_COLOR: Record<JobSlaState, string> = {
  ok: '#22c55e', waiting: '#60a5fa', late: '#f59e0b', all_declined: '#ef4444', no_invites: '#a78bfa',
};
const INVITE_COLOR: Record<InviteState, string> = {
  unseen: '#94a3b8', seen_unanswered: '#f59e0b', interested: '#22c55e', declined: '#ef4444',
};

const age = (hours: number) => hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;

export default function InviteSlaPage() {
  const { isAdmin, hasFeature, loading: authLoading } = useAuth();
  const router = useRouter();
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyAction, setOnlyAction] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/cni/invite-sla');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      setBoard(json as Board);
    } catch (e: any) {
      setError(e.message || 'Failed');
      setBoard(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasFeature('cni_admin')) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasFeature identity changes per render; auth state deps cover it
  }, [authLoading, isAdmin, router, load]);

  const tile = (label: string, value: string, color: string, sub: string) => (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', minWidth: '145px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>{label}</div>
      <div style={{ fontSize: '22px', fontWeight: 800, color, marginTop: '2px' }}>{value}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>
    </div>
  );

  if (authLoading || !hasFeature('cni_admin')) return null;

  const shown = (board?.jobs || []).filter(j => !onlyAction || NEEDS_ACTION.includes(j.state));

  return (
    <div style={{ maxWidth: '900px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Invite &amp; Bid Aging</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Every job still looking for an installer, with each invite against a {board?.slaHours ?? 48}-hour clock. Worst first.
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', marginBottom: '12px' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {board && !loading && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '6px' }}>
            {tile('Open jobs', String(board.totals.open), '#2563eb', 'awaiting assignment or bidding')}
            {tile('No takers', String(board.totals.late + board.totals.allDeclined),
              board.totals.late + board.totals.allDeclined > 0 ? '#ef4444' : '#22c55e',
              `${board.totals.allDeclined} all declined · ${board.totals.late} past SLA`)}
            {tile('Nobody invited', String(board.totals.noInvites),
              board.totals.noInvites > 0 ? '#a78bfa' : '#22c55e', 'no invite sent yet')}
            {tile('Typical answer',
              board.totals.medianResponseHours == null ? '—' : age(board.totals.medianResponseHours),
              '#2563eb',
              board.totals.answeredSamples > 0
                ? `median over ${board.totals.answeredSamples} answered`
                : 'no answers to measure yet')}
          </div>
          {board.totals.answeredSamples > 0 && board.totals.medianResponseHours != null && (
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '14px' }}>
              Installers typically answer in {age(board.totals.medianResponseHours)}, against a {board.slaHours}h SLA —
              the number to check the SLA itself against, not just the jobs.
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' }}>
            <button onClick={() => setOnlyAction(v => !v)} style={{
              padding: '7px 13px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
              border: '1px solid var(--border)', background: onlyAction ? 'var(--card)' : 'transparent', color: 'var(--text-primary)',
            }}>{onlyAction ? '✓ Needs action only' : 'Needs action only'}</button>
            <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>{shown.length} of {board.jobs.length} jobs</span>
          </div>

          {shown.length === 0 ? (
            <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '18px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              {board.jobs.length === 0
                ? 'No jobs are looking for an installer right now.'
                : 'Nothing needs chasing — every open job has an interested installer or is still inside the SLA.'}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '10px' }}>
              {shown.map(j => (
                <div key={j.jobId} style={{
                  border: `1px solid ${NEEDS_ACTION.includes(j.state) ? JOB_COLOR[j.state] : 'var(--border)'}`,
                  borderRadius: '12px', padding: '12px 14px', background: 'var(--card)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <Link href={`/admin/cni/jobs/${j.jobId}`} style={{ fontWeight: 800, fontSize: '13.5px', color: 'var(--accent, #2563eb)', textDecoration: 'none' }}>
                        {j.jobNumber || j.title || 'Untitled job'}
                      </Link>
                      {j.jobNumber && j.title && (
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '7px' }}>{j.title}</span>
                      )}
                    </div>
                    <span style={{
                      fontSize: '10.5px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px',
                      color: JOB_COLOR[j.state], background: `${JOB_COLOR[j.state]}1f`,
                      padding: '3px 8px', borderRadius: '999px', whiteSpace: 'nowrap',
                    }}>{JOB_STATE_LABEL[j.state]}</span>
                  </div>
                  <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '3px' }}>
                    {j.invites.length} invite{j.invites.length === 1 ? '' : 's'}
                    {j.oldestHoursOut != null && <> · oldest {age(j.oldestHoursOut)} out</>}
                    {j.deadline && <> · needed by {j.deadline}</>}
                    {j.alertedAt && <> · coordinator alerted {new Date(j.alertedAt).toLocaleDateString()}</>}
                  </div>

                  {j.invites.length > 0 && (
                    <div style={{ marginTop: '8px', display: 'grid', gap: '4px' }}>
                      {j.invites.map(inv => (
                        <div key={inv.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '12px', flexWrap: 'wrap' }}>
                          <span style={{ minWidth: '150px', fontWeight: 600 }}>{inv.companyName || 'Unknown company'}</span>
                          <span style={{ color: INVITE_COLOR[inv.state], fontWeight: 700, fontSize: '11px' }}>
                            {STATE_LABEL[inv.state]}
                          </span>
                          <span style={{ color: inv.breached ? '#f59e0b' : 'var(--text-muted)', fontSize: '11px' }}>
                            {inv.hoursToRespond != null ? `answered in ${age(inv.hoursToRespond)}` : `${age(inv.hoursOut)} out`}
                            {inv.breached && ' · past SLA'}
                            {inv.repingedAt && ' · re-pinged'}
                          </span>
                          {inv.declineReason && (
                            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>&ldquo;{inv.declineReason}&rdquo;</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '12px' }}>
            &ldquo;No view recorded&rdquo; means the portal never logged an open — not that the installer is ignoring us; they may have
            the email or have called. The daily CNI sweep re-pings each unanswered invite ONCE past the SLA and tells a coordinator
            once per job when nobody is coming, naming the next best match that has not been invited. An answered invite never
            counts as breached, however slow the answer was: the clock is for chasing, not for scoring people afterwards.
          </div>
        </>
      )}
    </div>
  );
}
