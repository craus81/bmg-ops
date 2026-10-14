'use client';

/**
 * After-hours Calls — calls BMG's virtual assistant (Retell) answered while
 * the office was closed.
 *
 * The summary email's "Open the call" button lands here (owner ask
 * 2026-10-14: opening the customer tab from the email wasn't intuitive).
 * The list shows calls still waiting on a call back; the open call shows
 * the summary, what the caller left, the recording and the transcript,
 * with Call back, Open customer / Add as lead, and a "Called back" tick
 * for whoever returns the call (Jessie, the next business morning).
 * "Spam" files the call, and every later call from that caller ID, under
 * the Spam tab with no email or alert; "Not spam" undoes it.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { INTERNAL_STAFF_ROLES } from '@/lib/features';
import { deepLinks } from '@/lib/deep-links';
import { prettyPhone, reasonLabel, telHref, transcriptTurns } from '@/lib/after-hours-calls';

interface Call {
  id: string;
  created_at: string;
  started_at: string | null;
  duration_seconds: number | null;
  from_number: string | null;
  callback_number: string | null;
  caller_name: string | null;
  caller_company: string | null;
  caller_email: string | null;
  call_reason: string | null;
  caller_reference: string | null;
  urgent: boolean;
  summary: string | null;
  transcript: string | null;
  recording_url: string | null;
  matched_prospect_id: string | null;
  matched_company: string | null;
  called_back_at: string | null;
  called_back_by_name: string | null;
  spam: boolean;
}

interface DupeMatch { source: 'prospects' | 'customers'; id: string; company_name: string | null; netsuite_id: string | null; matchedOn: string[] }

const fmtWhen = (iso: string | null) => {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
};

const fmtLength = (s: number | null) => {
  if (!s || s < 1) return '';
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60} sec` : `${s} sec`;
};

const who = (c: Call) => [c.caller_name, c.caller_company].filter(Boolean).join(', ') || prettyPhone(c.callback_number || c.from_number) || 'Unknown caller';

const btn = (primary = false): React.CSSProperties => ({
  display: 'inline-block', padding: '10px 16px', borderRadius: '8px', fontSize: '14px', fontWeight: 800,
  cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap',
  background: primary ? 'var(--accent, #2563eb)' : 'transparent',
  color: primary ? '#fff' : 'var(--text-primary)',
  border: primary ? '1px solid var(--accent, #2563eb)' : '1px solid var(--border-strong)',
});

function AfterHoursCalls() {
  const router = useRouter();
  const params = useSearchParams();
  const openId = params.get('id');
  const { hasRole, loading: authLoading } = useAuth();
  const isStaff = INTERNAL_STAFF_ROLES.some(r => hasRole(r));

  const [show, setShow] = useState<'open' | 'all' | 'spam'>('open');
  const [calls, setCalls] = useState<Call[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [spamCount, setSpamCount] = useState(0);
  // The call just marked spam, for the Undo line once it leaves the list.
  const [justSpammed, setJustSpammed] = useState<{ id: string; label: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dupes, setDupes] = useState<DupeMatch[] | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = new URLSearchParams({ show });
      if (openId) q.set('id', openId);
      const res = await apiFetch(`/api/phone-calls?${q}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load calls');
      setCalls(json.calls || []);
      setOpenCount(json.openCount || 0);
      setSpamCount(json.spamCount || 0);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [show, openId]);

  useEffect(() => { if (!authLoading && isStaff) load(); }, [authLoading, isStaff, load]);
  useEffect(() => { setDupes(null); }, [openId]);

  const current = useMemo(() => calls.find(c => c.id === openId) || null, [calls, openId]);
  // On a phone the open call sits under the list, so bring it into view
  // (the email link lands here with ?id=).
  const cardRef = useRef<HTMLDivElement>(null);
  const currentId = current?.id;
  useEffect(() => {
    if (currentId && cardRef.current && window.matchMedia('(max-width: 760px)').matches) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [currentId]);
  const open = (id: string | null) => router.replace(id ? deepLinks.afterHoursCall(id) : deepLinks.afterHoursCalls(), { scroll: false });

  const patch = async (body: Record<string, unknown>, id = current?.id) => {
    if (!id) return false;
    setBusy(true);
    try {
      const res = await apiFetch('/api/phone-calls', { method: 'PATCH', body: JSON.stringify({ id, ...body }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not save');
      await load();
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const markSpam = async () => {
    if (!current) return;
    const label = prettyPhone(current.from_number) || who(current);
    if (await patch({ spam: true })) {
      setJustSpammed({ id: current.id, label });
      open(null);
    }
  };

  const notSpam = async (id: string) => {
    if (await patch({ spam: false }, id)) setJustSpammed(null);
  };

  const addAsLead = async (force = false) => {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/prospects', {
        method: 'POST',
        body: JSON.stringify({
          company_name: current.caller_company || current.caller_name || prettyPhone(current.callback_number || current.from_number) || 'After-hours caller',
          contact_name: current.caller_name || undefined,
          phone: current.callback_number || current.from_number || undefined,
          email: current.caller_email || undefined,
          notes: [`After-hours call ${fmtWhen(current.started_at || current.created_at)}: ${reasonLabel(current.call_reason)}.`, current.summary].filter(Boolean).join('\n'),
          source: 'manual',
          lead_source: 'After-hours call',
          force,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409 && Array.isArray(json.matches)) { setDupes(json.matches); return; }
      if (!res.ok) throw new Error(json.error || 'Could not add the lead');
      const id = json.prospect?.id;
      if (id) {
        await patch({ prospectId: id });
        router.push(deepLinks.prospect(id));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (authLoading) return null;
  if (!isStaff) return <div style={{ padding: 24, color: 'var(--text-secondary)' }}>This page is for BMG staff.</div>;

  const callback = current ? current.callback_number || current.from_number : null;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '16px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 4px' }}>After-hours Calls</h1>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
        Calls BMG&apos;s virtual assistant answered while the office was closed. {openCount} waiting on a call back.
      </div>
      {justSpammed && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-strong)', marginBottom: 12, fontSize: 14, color: 'var(--text-primary)' }}>
          <span style={{ flex: '1 1 240px' }}>Marked {justSpammed.label} as spam. Its calls are under Spam, and future calls from it won&apos;t email or alert anyone.</span>
          <button disabled={busy} onClick={() => notSpam(justSpammed.id)} style={{ ...btn(), padding: '5px 12px', fontSize: 13 }}>Undo</button>
        </div>
      )}
      {error && <div style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(239,68,68,0.12)', color: '#ef4444', marginBottom: 12, fontSize: 14 }}>{error}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        {/* List */}
        <div style={{ flex: '1 1 300px', minWidth: 0, maxWidth: current ? 380 : undefined }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {(['open', 'all', 'spam'] as const).map(s => (
              <button key={s} onClick={() => setShow(s)} style={{ ...btn(show === s), padding: '7px 12px', fontSize: 13 }}>
                {s === 'open' ? 'Needs call back' : s === 'all' ? 'All calls' : `Spam${spamCount ? ` (${spamCount})` : ''}`}
              </button>
            ))}
          </div>
          {loading ? <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Loading…</div>
            : calls.length === 0 ? <div style={{ color: 'var(--text-secondary)', fontSize: 14, padding: '20px 0' }}>{show === 'open' ? 'Every after-hours call has been called back.' : show === 'spam' ? 'No spam calls.' : 'No after-hours calls yet.'}</div>
              : calls.map(c => (
                <button key={c.id} onClick={() => open(c.id)} style={{
                  display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', marginBottom: 8, padding: '12px 14px', borderRadius: 10,
                  background: c.id === openId ? 'var(--surface-2, rgba(37,99,235,0.08))' : 'var(--surface-1, transparent)',
                  border: `1px solid ${c.id === openId ? 'var(--accent, #2563eb)' : 'var(--border)'}`, color: 'var(--text-primary)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontWeight: 800, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.urgent ? '🔴 ' : ''}{who(c)}</span>
                    {c.spam && <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 700, whiteSpace: 'nowrap' }}>Spam</span>}
                    {!c.spam && c.called_back_at && <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 700, whiteSpace: 'nowrap' }}>✓ Called back</span>}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{reasonLabel(c.call_reason)} · {fmtWhen(c.started_at || c.created_at)}</div>
                </button>
              ))}
        </div>

        {/* Open call */}
        {current && (
          <div ref={cardRef} style={{ flex: '2 1 420px', minWidth: 0, padding: 18, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface-1, transparent)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{fmtWhen(current.started_at || current.created_at)}{fmtLength(current.duration_seconds) ? ` · ${fmtLength(current.duration_seconds)}` : ''}</div>
              <button onClick={() => open(null)} style={{ ...btn(), padding: '5px 10px', fontSize: 12 }}>Close</button>
            </div>
            {current.spam && (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 10, padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border-strong)', fontSize: 14, color: 'var(--text-primary)' }}>
                <span style={{ flex: '1 1 220px' }}><strong>Spam.</strong> Calls from {prettyPhone(current.from_number) || 'this number'} are filed here and don&apos;t email or alert anyone.</span>
                <button disabled={busy} onClick={() => notSpam(current.id)} style={{ ...btn(), padding: '5px 12px', fontSize: 13 }}>Not spam</button>
              </div>
            )}
            {current.urgent && <div style={{ marginTop: 10, padding: '9px 12px', borderRadius: 8, background: 'rgba(239,68,68,0.12)', color: '#ef4444', fontWeight: 800, fontSize: 14 }}>Caller says this is urgent.</div>}
            <h2 style={{ fontSize: 19, fontWeight: 800, color: 'var(--text-primary)', margin: '10px 0 6px' }}>
              {reasonLabel(current.call_reason)}{current.caller_name ? ` from ${current.caller_name}` : ''}
            </h2>
            <p style={{ fontSize: 15, lineHeight: 1.55, color: 'var(--text-primary)', margin: '0 0 14px' }}>{current.summary || 'No summary for this call. The transcript is below.'}</p>

            <table style={{ borderCollapse: 'collapse', marginBottom: 16, fontSize: 14 }}>
              <tbody>
                {([
                  ['Caller', current.caller_name],
                  ['Company', current.caller_company],
                  ['Call back', callback ? <a href={telHref(callback)} style={{ color: 'var(--accent, #2563eb)', fontWeight: 800, textDecoration: 'none' }}>{prettyPhone(callback)}</a> : null],
                  ['Email', current.caller_email ? <a href={`mailto:${current.caller_email}`} style={{ color: 'var(--accent, #2563eb)', textDecoration: 'none' }}>{current.caller_email}</a> : null],
                  ['SO / VIN', current.caller_reference],
                  ['Customer', current.matched_prospect_id ? (current.matched_company || 'Linked') : null],
                ] as Array<[string, React.ReactNode]>).filter(([, v]) => v).map(([label, value]) => (
                  <tr key={label}>
                    <td style={{ padding: '5px 14px 5px 0', color: 'var(--text-secondary)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{label}</td>
                    <td style={{ padding: '5px 0', color: 'var(--text-primary)' }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {callback && <a href={telHref(callback)} style={btn(true)}>Call back</a>}
              {current.matched_prospect_id
                ? <a href={deepLinks.prospect(current.matched_prospect_id)} style={btn()}>Open customer</a>
                : <button disabled={busy} onClick={() => addAsLead(false)} style={btn()}>Add as lead</button>}
              {!current.spam && (
                <button disabled={busy} onClick={markSpam} title="Hide this call and send future calls from this number to Spam" style={{ ...btn(), color: '#dc2626', borderColor: 'rgba(220,38,38,0.45)', marginLeft: 'auto' }}>🚫 Spam</button>
              )}
            </div>

            {dupes && (
              <div style={{ padding: 12, borderRadius: 8, border: '1px solid var(--border-strong)', marginBottom: 12, fontSize: 14, color: 'var(--text-primary)' }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>This caller may already be in FleetSuite</div>
                {dupes.map(d => (
                  <div key={`${d.source}-${d.id}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                    <span>{d.company_name || 'Unnamed'} <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>same {d.matchedOn.join(', ')}</span></span>
                    {d.source === 'prospects'
                      ? <button disabled={busy} onClick={async () => { if (await patch({ prospectId: d.id })) setDupes(null); }} style={{ ...btn(), padding: '5px 10px', fontSize: 12 }}>Link this call</button>
                      : <a href={`/admin/prospects?ns=${d.netsuite_id}`} style={{ ...btn(), padding: '5px 10px', fontSize: 12 }}>Open</a>}
                  </div>
                ))}
                <button disabled={busy} onClick={() => addAsLead(true)} style={{ ...btn(), marginTop: 8, padding: '6px 12px', fontSize: 13 }}>No, add a new lead</button>
              </div>
            )}

            {!current.spam && <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-strong)', cursor: 'pointer', marginBottom: 16, fontSize: 15, color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={!!current.called_back_at} disabled={busy} onChange={e => patch({ calledBack: e.target.checked })} style={{ width: 20, height: 20 }} />
              <span style={{ fontWeight: 800 }}>Called back</span>
              {current.called_back_at && <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{current.called_back_by_name ? `by ${current.called_back_by_name} · ` : ''}{fmtWhen(current.called_back_at)}</span>}
            </label>}

            {current.recording_url && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: 6 }}>Recording</div>
                <audio controls preload="none" src={current.recording_url} style={{ width: '100%' }} />
              </div>
            )}

            {current.transcript && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: 6 }}>Transcript</div>
                <div style={{ padding: 14, borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, lineHeight: 1.5, color: 'var(--text-primary)' }}>
                  {transcriptTurns(current.transcript).map((t, i) => (
                    <div key={i} style={{ marginBottom: 8 }}>
                      {t.speaker && <span style={{ fontWeight: 800, color: t.speaker === 'Assistant' ? 'var(--text-secondary)' : 'var(--text-primary)' }}>{t.speaker}: </span>}
                      {t.text}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AfterHoursCallsPage() {
  return <Suspense fallback={null}><AfterHoursCalls /></Suspense>;
}
