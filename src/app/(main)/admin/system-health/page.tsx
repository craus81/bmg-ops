'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import ConnectionsPanel from '@/components/ConnectionsPanel';

interface HealthCheck {
  syncType: string;
  label: string;
  intervalMinutes: number;
  status: 'ok' | 'stale' | 'error' | 'never';
  lastRunAt: string | null;
  ageMinutes: number | null;
  problem: string | null;
}

type RunHistoryState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | {
      state: 'ready';
      runs: { finishedAt: string; durationMs: number | null; outcome: 'ok' | 'error'; records: number | null; error: string | null }[];
      errorStreak: number;
      medianDurationMs: number | null;
      runsWithoutDuration: number;
      runsWithoutRecords: number;
      note: string;
    };

/**
 * The last 30 runs of one job (R6-13). Two things it refuses to imply: a
 * run with no duration renders as "—", never as an instant one, and the
 * panel repeats that only runs which finished reporting are here — a short
 * history is not proof the job has been idle.
 */
function RunHistoryPanel({ history }: { history: RunHistoryState | undefined }) {
  const muted: React.CSSProperties = { fontSize: '11px', color: 'var(--text-muted)' };
  if (!history || history.state === 'loading') {
    return <div style={{ ...muted, marginTop: '10px' }}>Loading run history…</div>;
  }
  if (history.state === 'error') {
    return <div style={{ ...muted, marginTop: '10px' }}>Could not load run history: {history.message}</div>;
  }
  if (history.runs.length === 0) {
    return (
      <div style={{ ...muted, marginTop: '10px' }}>
        No recorded runs yet. The flight recorder only sees runs from when it was switched on.
      </div>
    );
  }

  const max = Math.max(...history.runs.map(r => r.durationMs ?? 0), 1);
  return (
    <div style={{ marginTop: '10px', borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
      <div style={{ ...muted, marginBottom: '6px' }}>
        {history.errorStreak > 0 && (
          <span style={{ color: '#ef4444', fontWeight: 800 }}>
            {history.errorStreak} failure{history.errorStreak === 1 ? '' : 's'} in a row ·{' '}
          </span>
        )}
        Median {history.medianDurationMs == null ? 'unknown' : `${Math.round(history.medianDurationMs / 1000)}s`} over{' '}
        {history.runs.length} run{history.runs.length === 1 ? '' : 's'}
        {history.runsWithoutDuration > 0 && ` · ${history.runsWithoutDuration} reported no duration`}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '38px', marginBottom: '6px' }}>
        {[...history.runs].reverse().map((r, i) => (
          <div
            key={i}
            title={`${new Date(r.finishedAt).toLocaleString()} · ${r.outcome}${r.durationMs == null ? ' · duration unknown' : ` · ${Math.round(r.durationMs / 1000)}s`}${r.records == null ? ' · records not reported' : ` · ${r.records} records`}${r.error ? ` · ${r.error}` : ''}`}
            style={{
              flex: 1,
              minWidth: '3px',
              // A run with no duration gets a flat marker, not a zero bar —
              // "we don't know" must not look like "instant".
              height: r.durationMs == null ? '3px' : `${Math.max(3, (r.durationMs / max) * 38)}px`,
              background: r.outcome === 'error' ? '#ef4444' : r.durationMs == null ? 'var(--border)' : '#22c55e',
              borderRadius: '2px',
            }}
          />
        ))}
      </div>
      <div style={{ ...muted, fontSize: '10px', lineHeight: 1.5 }}>{history.note}</div>
      {history.runs.filter(r => r.error).slice(0, 3).map((r, i) => (
        <div key={i} style={{ fontSize: '10px', color: '#ef4444', marginTop: '3px' }}>
          {new Date(r.finishedAt).toLocaleString()} — {r.error}
        </div>
      ))}
    </div>
  );
}

interface EmailLogRow {
  id: string;
  kind: string;
  recipients: string[];
  subject: string | null;
  sent_by: string | null;
  context_url: string | null;
  delivery_status: string;
  delivery_detail: string | null;
  delivery_updated_at: string | null;
  created_at: string;
  // m294: a bounce stays a bounce until someone fixes the contact / re-sends.
  // Unresolved money-email bounces block the month-end close.
  resolved_at?: string | null;
  resolution_note?: string | null;
}

const EMAIL_KIND_LABELS: Record<string, string> = {
  invoice: 'Invoice', estimate_approval: 'Estimate approval', statement: 'Statement',
  wrap_quote: 'Wrap quote', proof_approval: 'Proof approval', customer_thread: 'Customer message',
  customer_notify: 'Status update', customer_digest: 'Weekly digest', pickup_notice: 'Pickup notice',
  staff_notification: 'Staff notification', invite: 'Invite', other: 'Other',
};

const EMAIL_STATUS_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  sent: { label: 'Sent', color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' },
  delivered: { label: 'Delivered', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  delivery_delayed: { label: 'Delayed', color: '#fbbf24', bg: 'rgba(251,191,36,0.1)' },
  bounced: { label: 'Bounced', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  complained: { label: 'Spam', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  failed: { label: 'Failed', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
};
const BAD_EMAIL_STATES = ['bounced', 'complained', 'failed'];

const STATUS_STYLE: Record<HealthCheck['status'], { label: string; color: string; bg: string }> = {
  ok: { label: 'OK', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  stale: { label: 'Stale', color: '#fbbf24', bg: 'rgba(251,191,36,0.1)' },
  error: { label: 'Error', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  never: { label: 'Never ran', color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' },
};

const fmtAge = (min: number | null) => {
  if (min == null) return '—';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
  // Floor, not round: 61h shown as "3d ago" next to "no run in 61h" reads
  // like the math is broken.
  return `${Math.floor(min / 1440)}d ago`;
};

export default function SystemHealthPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAdmin, hasRole, hasFeature, loading: authLoading } = useAuth();

  const [checks, setChecks] = useState<HealthCheck[]>([]);
  // Flight recorder (R6-13): last 30 runs per job, fetched on expand.
  const [openRuns, setOpenRuns] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, RunHistoryState>>({});

  const toggleRuns = useCallback(async (syncType: string) => {
    setOpenRuns(prev => (prev === syncType ? null : syncType));
    setRuns(prev => (prev[syncType] ? prev : { ...prev, [syncType]: { state: 'loading' } }));
    if (runs[syncType]) return;   // already fetched; expanding again is free
    try {
      const res = await apiFetch(`/api/system-health/runs?job=${encodeURIComponent(syncType)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRuns(prev => ({ ...prev, [syncType]: { state: 'error', message: json.error || 'request failed' } }));
        return;
      }
      setRuns(prev => ({ ...prev, [syncType]: { state: 'ready', ...json } }));
    } catch (e: any) {
      setRuns(prev => ({ ...prev, [syncType]: { state: 'error', message: e?.message || 'request failed' } }));
    }
  }, [runs]);
  const [emails, setEmails] = useState<EmailLogRow[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  // The resolve action lives on the month-close route, which admits
  // admins + executives. A per-user system_health override doesn't, so the
  // button only appears for people it would actually let through.
  const canResolve = isAdmin || hasRole('executive');
  const [emailProblemsOnly, setEmailProblemsOnly] = useState(false);
  const [writeProbe, setWriteProbe] = useState<{ ok: boolean; error?: string } | null>(null);
  const [cronSecretConfigured, setCronSecretConfigured] = useState(true);
  const [externalPingConfigured, setExternalPingConfigured] = useState(true);
  const [generatedAt, setGeneratedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flashedEmailId, setFlashedEmailId] = useState<string | null>(null);
  // The Connections tab probes NetSuite and the three RESTlets live, so it
  // mounts (and therefore fetches) only when someone selects it.
  const [tab, setTab] = useState<'jobs' | 'connections'>('jobs');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/system-health');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setChecks(data.checks || []);
      setEmails(data.emails || []);
      setWriteProbe(data.writeProbe || null);
      setCronSecretConfigured(data.cronSecretConfigured);
      setExternalPingConfigured(!!data.externalPingConfigured);
      setGeneratedAt(data.generatedAt);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  /** Mark a delivery failure handled (m294). The month-end close gate on
   *  bounced invoice/statement emails reads this stamp, so "we fixed the
   *  address" has somewhere to be recorded instead of a bounce staying
   *  outstanding forever. */
  const resolveEmail = async (e: EmailLogRow) => {
    const note = window.prompt(
      `Mark this ${e.delivery_status} email resolved?\n\nWhat was done (optional — e.g. "new address on file, re-sent"):`,
    );
    if (note === null) return;
    setResolvingId(e.id);
    try {
      const res = await apiFetch('/api/reports/month-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve_email', emailLogId: e.id, note }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save');
      setEmails(prev => prev.map(row => row.id === e.id
        ? { ...row, resolved_at: new Date().toISOString(), resolution_note: note || null }
        : row));
    } catch (err: any) {
      setError(err.message || 'Could not save');
    }
    setResolvingId(null);
  };

  // ?email=<log id> (deepLinks.emailDelivery — bounce-alert fallback CTA):
  // scroll to and flash that row in the Email delivery section.
  const flashedOnce = useRef(false);
  useEffect(() => {
    if (loading || flashedOnce.current) return;
    const emailId = searchParams.get('email');
    if (!emailId || !emails.some(e => e.id === emailId)) return;
    flashedOnce.current = true;
    setFlashedEmailId(emailId);
    setTimeout(() => {
      document.getElementById(`email-log-${emailId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    setTimeout(() => setFlashedEmailId(null), 3500);
  }, [loading, emails, searchParams]);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!hasFeature('system_health')) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasFeature identity changes per render; auth state deps cover it
  }, [authLoading, isAdmin, router, load]);

  const badCount = checks.filter(c => c.status !== 'ok').length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>System Health</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Background jobs and syncs, and whether every outside connection the app depends on is actually configured.
            {tab === 'jobs' && externalPingConfigured && (
              <span style={{ color: '#22c55e', fontWeight: 600 }}> External dead-man&apos;s switch armed — if the scheduler itself dies, the outside monitor emails admins.</span>
            )}
          </div>
        </div>
        {tab === 'jobs' && (
          <button onClick={load} disabled={loading} style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            {loading ? 'Checking…' : '↻ Refresh'}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' }}>
        {([['jobs', 'Jobs & email'], ['connections', 'Connections']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            padding: '7px 14px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            background: tab === key ? 'rgba(96,165,250,0.12)' : 'var(--card)',
            border: `1px solid ${tab === key ? 'rgba(96,165,250,0.45)' : 'var(--border)'}`,
            color: tab === key ? '#60a5fa' : 'var(--text-muted)',
          }}>{label}</button>
        ))}
      </div>

      {tab === 'connections' && <ConnectionsPanel />}

      {tab === 'jobs' && (<>
      {writeProbe && !writeProbe.ok && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', fontWeight: 600 }}>
          Heartbeat writes to the database are failing — the jobs may be running fine, but every &quot;last run&quot; below is frozen at its last landed write, so the statuses can&apos;t be trusted until this is fixed. Error: {writeProbe.error || 'unknown'}
        </div>
      )}
      {!cronSecretConfigured && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', fontWeight: 600 }}>
          CRON_SECRET is not configured — scheduled runs can&apos;t authenticate, so every cron on this page is effectively off.
        </div>
      )}
      {!externalPingConfigured && !loading && !error && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24', fontSize: '12px', fontWeight: 600 }}>
          No external dead-man&apos;s switch: if the cron scheduler itself stops (like a Vercel outage), the watcher stops with it and nobody is alerted. Create a free check at healthchecks.io (period 30 min, grace 15 min), then set its ping URL as HEALTH_PING_URL in Vercel and redeploy — the watcher will ping it on every run and the outside service emails admins when pings stop.
        </div>
      )}
      {error && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {!loading && !error && (
        <div style={{ fontSize: '12px', fontWeight: 700, color: badCount === 0 ? '#22c55e' : '#fbbf24', marginBottom: '10px' }}>
          {badCount === 0 ? '✓ All background jobs healthy' : `⚠ ${badCount} job${badCount !== 1 ? 's' : ''} need attention`}
          {generatedAt && <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '8px' }}>checked {new Date(generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {checks.map(c => {
          const s = STATUS_STYLE[c.status];
          const open = openRuns === c.syncType;
          return (
            <div key={c.syncType} style={{ padding: '12px 14px', borderRadius: '10px', background: 'var(--card)', border: `1px solid ${c.status === 'ok' ? 'var(--border)' : s.color + '44'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '10px', fontWeight: 800, padding: '3px 9px', borderRadius: '6px', background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>{s.label}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{c.label}</div>
                  {c.problem && <div style={{ fontSize: '11px', color: s.color, marginTop: '2px' }}>{c.problem}</div>}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  Last run {fmtAge(c.ageMinutes)}<br />
                  every {c.intervalMinutes >= 60 ? `${c.intervalMinutes / 60}h` : `${c.intervalMinutes} min`}
                </div>
                {/* Flight recorder (R6-13) — the run history behind this row. */}
                <button
                  type="button"
                  onClick={() => toggleRuns(c.syncType)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '11px', fontWeight: 800, cursor: 'pointer', padding: '2px 4px', whiteSpace: 'nowrap' }}
                >
                  {open ? '▾ Runs' : '▸ Runs'}
                </button>
              </div>
              {open && <RunHistoryPanel history={runs[c.syncType]} />}
            </div>
          );
        })}
      </div>

      {/* Email delivery — the universal email_log, newest first. Composed
          sends alert their sender on bounce; this section is where the
          AUTOMATED sends' failures surface (nobody gets paged for those). */}
      {!loading && !error && (() => {
        // A resolved bounce is no longer "to fix" — it stays in the log with
        // its stamp, but it stops being counted against the shop.
        const isOpenProblem = (e: EmailLogRow) => BAD_EMAIL_STATES.includes(e.delivery_status) && !e.resolved_at;
        const badCount = emails.filter(isOpenProblem).length;
        const shown = emailProblemsOnly ? emails.filter(e => BAD_EMAIL_STATES.includes(e.delivery_status)) : emails;
        return (
          <div style={{ marginTop: '22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '8px', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '16px', fontWeight: 800 }}>Email delivery</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Every email the app sends, with its real delivery state. Human-sent emails alert the sender when they bounce; automated ones (digests, invites, notifications) only show up here.
                </div>
              </div>
              <button onClick={() => setEmailProblemsOnly(v => !v)} style={{
                padding: '6px 12px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                background: emailProblemsOnly ? 'rgba(239,68,68,0.1)' : 'var(--card)',
                border: `1px solid ${emailProblemsOnly ? 'rgba(239,68,68,0.35)' : 'var(--border)'}`,
                color: emailProblemsOnly ? '#ef4444' : 'var(--text-muted)',
              }}>{emailProblemsOnly ? '✓ Problems only' : 'Problems only'}</button>
            </div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: badCount === 0 ? '#22c55e' : '#ef4444', marginBottom: '10px' }}>
              {badCount === 0 ? '✓ No unresolved delivery problems in the last 100 sends' : `⚠ ${badCount} of the last ${emails.length} sends did not reach the recipient and are not marked resolved`}
            </div>
            {shown.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px' }}>
                {emailProblemsOnly ? 'No bounced, failed, or spam-flagged emails — nothing to fix.' : 'No emails logged yet — tracking starts with the first send after this feature deployed.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                {shown.map(e => {
                  const s = EMAIL_STATUS_STYLE[e.delivery_status] || EMAIL_STATUS_STYLE.sent;
                  const bad = BAD_EMAIL_STATES.includes(e.delivery_status);
                  const flashed = e.id === flashedEmailId;
                  return (
                    <div key={e.id} id={`email-log-${e.id}`} style={{
                      display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', borderRadius: '10px',
                      background: flashed ? 'rgba(96,165,250,0.12)' : 'var(--card)',
                      border: `1px solid ${flashed ? 'rgba(96,165,250,0.5)' : bad ? s.color + '44' : 'var(--border)'}`,
                      transition: 'background 0.6s, border-color 0.6s',
                    }}>
                      <span style={{ fontSize: '10px', fontWeight: 800, padding: '3px 9px', borderRadius: '6px', background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>{s.label}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <span style={{ color: 'var(--text-muted)', fontWeight: 800, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.4px', marginRight: '8px' }}>{EMAIL_KIND_LABELS[e.kind] || e.kind}</span>
                          {e.subject || '(no subject)'}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          to {(e.recipients || []).join(', ') || '—'}
                          {bad && e.delivery_detail && <span style={{ color: s.color }}> · {e.delivery_detail}</span>}
                          {e.resolved_at && (
                            <span style={{ color: '#22c55e', fontWeight: 700 }}>
                              {' '}· resolved {new Date(e.resolved_at).toLocaleDateString()}
                              {e.resolution_note ? ` — ${e.resolution_note}` : ''}
                            </span>
                          )}
                        </div>
                      </div>
                      {bad && !e.resolved_at && canResolve && (
                        <button onClick={() => resolveEmail(e)} disabled={resolvingId === e.id} title="Mark this delivery failure handled — the contact is fixed or the mail was re-sent" style={{
                          padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                          background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', whiteSpace: 'nowrap',
                        }}>{resolvingId === e.id ? 'Saving…' : 'Mark resolved'}</button>
                      )}
                      {e.context_url && (
                        <button onClick={() => router.push(e.context_url!)} title="Open the record this email is about" style={{
                          padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                          background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', whiteSpace: 'nowrap',
                        }}>Open record</button>
                      )}
                      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {new Date(e.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}
      </>)}
    </div>
  );
}
