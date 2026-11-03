'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { booksAccess } from '@/lib/books/access';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { useFileDownload } from '@/lib/use-file-download';
import {
  NOTE_MAX, PART_TEXT, RULE_GROUPS, STEP_AREAS, type HowItWorksView, type RuleGroup, type StepArea,
} from '@/lib/books/how-it-works';
import {
  centralDay, centralWhen, countText, dayText, howItWorksFilename, monthText, peopleText, reviewText, ruleUseText, switchText,
} from '@/lib/books/how-it-works-words';

/**
 * Books → How the books work (Books part 88, src/lib/books/how-it-works.ts,
 * docs/books.md "How the books work"; the NetSuite Exit Checklist's "How the
 * books work, written down").
 *
 * What posts what, who can change what, what the database refuses, the
 * controls, switches, jobs and backups, written down next to FleetSuite's
 * code for BMG's CPA and the IRS (Rev. Proc. 98-25), with what the books
 * hold today beside it: how much each rule has posted, who holds each step,
 * the last backup. Download PDF gives the same, dated, with a box for the
 * CPA to sign; Mark reviewed (the CPA, or a super admin for a review the CPA
 * did on paper) keeps who reviewed which rules, and the page says when a rule
 * changes after. Open to whoever opens the books.
 */

const GREEN = '#22c55e';
const RED = '#ef4444';
const AMBER = '#f59e0b';
const GREY = '#94a3b8';
const DOWNLOAD = '/api/admin/books/how-it-works/download';

const banner = (color: string): React.CSSProperties => ({
  padding: '10px 14px', borderRadius: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 600,
  background: `${color}10`, border: `1px solid ${color}40`, color,
});
const chip = (color: string): React.CSSProperties => ({
  fontSize: '10px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', whiteSpace: 'nowrap',
  border: `1px solid ${color}55`, color,
});
const act = (color: string | null, enabled: boolean): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800,
  border: color ? 'none' : '1px solid var(--border)', background: color ?? 'var(--card)', color: color ? '#fff' : 'var(--text-primary)',
  cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
});
const link: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};
const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: '10px', padding: '10px 12px', background: 'var(--card)' };
const item: React.CSSProperties = { borderTop: '1px solid var(--border)', padding: '8px 0' };
const sub: React.CSSProperties = { fontSize: '13px', fontWeight: 800, margin: '12px 0 4px' };
const muted: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)' };
const body: React.CSSProperties = { fontSize: '13px', color: 'var(--text-secondary)' };
const idChip: React.CSSProperties = { ...chip(GREY), fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600 };

type PartKey = 'rules' | 'steps' | 'twoStep' | 'database' | 'controls' | 'switches' | 'jobs' | 'backups' | 'records' | 'irs' | 'accounts';

/** A part of the description, closed to one line until it's opened. */
function Part({ title, summary, open, onToggle, children }: {
  title: string; summary: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div style={card}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'baseline', gap: '8px', width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', color: 'var(--text-primary)', flexWrap: 'wrap' }}
      >
        <span style={{ fontSize: '15px', fontWeight: 800 }}>{title}</span>
        <span style={muted}>{summary}</span>
        <span style={{ ...muted, marginLeft: 'auto' }}>{open ? 'Less' : 'More'}</span>
      </button>
      {open && <div style={{ marginTop: '8px' }}>{children}</div>}
    </div>
  );
}

/** A switch's state as a chip; nothing when it waits on none. */
function SwitchChip({ name, on }: { name: string | null; on: boolean | null }) {
  if (!name) return null;
  return <span style={chip(on ? GREEN : on === false ? GREY : AMBER)} title={switchText(name, on) ?? undefined}>{name}: {on === null ? '?' : on ? 'On' : 'Off'}</span>;
}

export default function BooksHowItWorksPage() {
  const router = useRouter();
  const { hasRole, loading: authLoading } = useAuth();
  const [data, setData] = useState<HowItWorksView | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<Set<PartKey>>(() => new Set());
  const [marking, setMarking] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [markError, setMarkError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const file = useFileDownload(setDownloadError);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/books/how-it-works');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setError('');
    } catch (e: any) {
      setError(e?.message || "Couldn't read how the books work");
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!booksAccess(hasRole)) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasRole identity changes per render; auth state covers it
  }, [authLoading, router, load]);

  const toggle = (key: PartKey) => setOpen((was) => {
    const next = new Set(was);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const markReviewed = async () => {
    if (!data) return;
    setSaving(true);
    setMarkError('');
    try {
      const res = await apiFetch('/api/admin/books/how-it-works', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reviewed', fingerprint: data.review.fingerprint, note: note.trim() || null }),
      });
      const json = await res.json().catch(() => ({}));
      // The rules changed since the page opened: read them again before anyone marks them.
      if (res.status === 409) await load();
      if (!res.ok) throw new Error(json.error || `It wasn't marked reviewed (${res.status})`);
      setMarking(false);
      setNote('');
      await load();
    } catch (e: any) {
      setMarkError(e?.message || "It wasn't marked reviewed");
    }
    setSaving(false);
  };

  const review = data ? reviewText(data.review) : null;
  const reviewColor = review?.tone === 'good' ? GREEN : review?.tone === 'changed' ? AMBER : GREY;
  const posted = data ? data.rules.reduce((n, r) => n + r.use.reduce((m, u) => m + u.entries, 0), 0) : 0;
  const setUp = data?.twoStep.people?.filter((p) => p.setUp).length ?? 0;

  return (
    <div style={{ maxWidth: '820px' }}>
      <div style={{ marginBottom: '14px' }}>
        <Link href="/admin/books" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>← Books</Link>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>How the books work</div>
        <div style={muted}>
          What posts what, who can change what and how backups work, written down for BMG&apos;s CPA and the IRS.{' '}
          <button onClick={() => setMore(!more)} style={link}>{more ? 'Less' : 'More'}</button>
          {more && data && (
            <span style={{ display: 'block', marginTop: '4px' }}>
              {data.about} {PART_TEXT.written} The IRS asks a business keeping its records in software to keep a description like
              this one (Revenue Procedure 98-25); What the IRS asks, below, says where this answers it. The PDF is the same, dated,
              with a box for the CPA to sign.
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>
          <Link href="/admin/books/switches" style={{ color: 'var(--text-secondary)' }}>Switches</Link>
          {' · '}
          <Link href={deepLinks.booksChangeHistory()} style={{ color: 'var(--text-secondary)' }}>Change history</Link>
          {' · '}
          <Link href={deepLinks.booksBackups()} style={{ color: 'var(--text-secondary)' }}>Backups</Link>
          {' · '}
          <Link href="/admin/books" style={{ color: 'var(--text-secondary)' }}>Chart of accounts</Link>
        </div>
      </div>

      {error && <div style={banner(RED)}>{error}</div>}
      {!data && !error && <div style={muted}>Reading the books…</div>}

      {data && review && (
        <>
          {data.problems.length > 0 && (
            <div style={banner(RED)}>
              Some of what the books hold today couldn&apos;t be read, so it&apos;s left out below:
              {data.problems.map((p) => <span key={p} style={{ display: 'block', fontWeight: 500 }}>{p}</span>)}
            </div>
          )}
          {data.unwritten.length > 0 && (
            <div style={banner(RED)}>
              The journal holds entries posted by a rule that isn&apos;t written down here:{' '}
              {data.unwritten.map((u) => `${u.rule} (${u.company}, ${countText(u.entries, 'entry', 'entries')})`).join(', ')}.
            </div>
          )}
          <div style={banner(reviewColor)}>
            {review.text}
            {data.review.last?.note && <span style={{ display: 'block', fontWeight: 500, fontStyle: 'italic' }}>Their note: {data.review.last.note}</span>}
          </div>

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' }}>
            <button onClick={() => { setDownloadError(''); file.download(DOWNLOAD, howItWorksFilename(data.asOf)); }} disabled={file.busy} style={act(null, !file.busy)}>
              {file.busy ? 'Making the PDF…' : file.ready(DOWNLOAD) ? '⬇ Tap to save' : '⬇ Download PDF'}
            </button>
            {data.review.canMark && !marking && (
              <button onClick={() => { setMarking(true); setMarkError(''); }} style={act(GREEN, true)}>Mark reviewed</button>
            )}
            <span style={muted}>As of {centralWhen(data.asOf)}</span>
          </div>
          {downloadError && <div style={banner(RED)}>{downloadError}</div>}

          {marking && (
            <div style={{ ...card, marginBottom: '10px', display: 'grid', gap: '8px' }}>
              <div style={body}>
                {hasRole('cpa')
                  ? `Marks the ${countText(data.rules.length + data.workedOut.length, 'rule')} as they're written now reviewed by you, as BMG's CPA. It's kept as it's made.`
                  : `Marks the ${countText(data.rules.length + data.workedOut.length, 'rule')} as they're written now reviewed, for a review BMG's CPA did on paper. Say in the note who signed it and when. It's kept as it's made.`}
              </div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={NOTE_MAX}
                rows={2}
                placeholder="Note (optional), such as where the signed PDF is kept"
                style={{ fontSize: '16px', padding: '8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg, var(--card))', color: 'var(--text-primary)', resize: 'vertical' }}
              />
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <button onClick={markReviewed} disabled={saving} style={act(GREEN, !saving)}>{saving ? 'Marking…' : 'Mark reviewed'}</button>
                <button onClick={() => { setMarking(false); setNote(''); setMarkError(''); }} disabled={saving} style={act(null, !saving)}>Leave without saving</button>
              </div>
              {markError && <div style={{ fontSize: '12px', fontWeight: 700, color: RED }}>{markError}</div>}
            </div>
          )}

          <div style={{ display: 'grid', gap: '8px', marginTop: '12px' }}>
            <Part
              title="What posts what"
              summary={`${countText(data.rules.length, 'rule')}, ${countText(posted, 'entry', 'entries')} posted`}
              open={open.has('rules')}
              onToggle={() => toggle('rules')}
            >
              <div style={muted}>{PART_TEXT.rules}</div>
              {(Object.keys(RULE_GROUPS) as RuleGroup[]).map((group) => (
                <div key={group}>
                  <div style={sub}>{RULE_GROUPS[group].name}</div>
                  <div style={{ ...muted, marginBottom: '4px' }}>{RULE_GROUPS[group].about}</div>
                  {data.rules.filter((r) => r.group === group).map((r) => (
                    <div key={r.id} style={item}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '14px', fontWeight: 800 }}>{r.name}</span>
                        <span style={idChip}>{r.id}</span>
                      </div>
                      <div style={body}>{r.from}</div>
                      <ul style={{ ...body, margin: '2px 0', paddingLeft: '18px' }}>
                        {r.posts.map((p) => <li key={p}>{p}</li>)}
                      </ul>
                      {r.note && <div style={{ ...muted, fontStyle: 'italic' }}>{r.note}</div>}
                      <div style={muted}>Posted so far: {ruleUseText(r.use)}</div>
                    </div>
                  ))}
                </div>
              ))}
              <div style={sub}>Reversals</div>
              <div style={body}>{data.reversals}</div>
              <div style={sub}>Rules that work out what&apos;s sent</div>
              <div style={{ ...muted, marginBottom: '4px' }}>{PART_TEXT.workedOut}</div>
              {data.workedOut.map((r) => (
                <div key={r.id} style={item}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '14px', fontWeight: 800 }}>{r.name}</span>
                    <span style={idChip}>{r.id}</span>
                    <SwitchChip name={r.switchName} on={r.switchOn} />
                  </div>
                  <div style={body}>{r.what}</div>
                </div>
              ))}
            </Part>

            <Part
              title="Who can change what"
              summary={`${countText(data.steps.length, 'step')}, each with who holds it now`}
              open={open.has('steps')}
              onToggle={() => toggle('steps')}
            >
              <div style={muted}>{PART_TEXT.steps}</div>
              <div style={sub}>Levels in the books</div>
              {data.levels.map((l) => (
                <div key={l.level} style={item}>
                  <div style={{ fontSize: '14px', fontWeight: 800 }}>{l.name} <span style={{ ...muted, fontWeight: 600 }}>{l.who}</span></div>
                  <div style={body}>{l.can}</div>
                  <div style={muted}>Now: {peopleText(l.people)}</div>
                </div>
              ))}
              {(Object.keys(STEP_AREAS) as StepArea[]).map((area) => {
                const steps = data.steps.filter((s) => s.area === area);
                if (!steps.length) return null;
                return (
                  <div key={area}>
                    <div style={sub}>{STEP_AREAS[area]}</div>
                    {steps.map((s) => (
                      <div key={s.key} style={item}>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '14px', fontWeight: 800 }}>{s.step}</span>
                          <SwitchChip name={s.switchName} on={s.switchOn} />
                        </div>
                        <div style={muted}>{s.where}</div>
                        <div style={body}>{s.who}</div>
                        {s.approval && <div style={body}>Second person: {s.approval}</div>}
                        {s.note && <div style={muted}>{s.note}</div>}
                        {s.posts.length > 0 && <div style={muted}>Posts by {s.posts.join(', ')}</div>}
                        <div style={muted}>Now: {peopleText(s.people)}</div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </Part>

            <Part
              title="Two-step sign-in"
              summary={`${data.twoStep.on === null ? "Couldn't be read" : data.twoStep.on ? 'Switched on' : 'Switched off'}${data.twoStep.people ? `, ${setUp} of ${data.twoStep.people.length} set up` : ''}`}
              open={open.has('twoStep')}
              onToggle={() => toggle('twoStep')}
            >
              <div style={body}>
                {data.twoStep.on === null
                  ? "Whether it's switched on couldn't be read."
                  : data.twoStep.on
                    ? 'Switched on: everyone with a money role gives a code from an authenticator app when they sign in.'
                    : 'Switched off: only people who set up an authenticator themselves give a code when they sign in.'}
              </div>
              {data.twoStep.people === null && <div style={{ ...body, color: RED }}>Who has an authenticator set up couldn&apos;t be read.</div>}
              {data.twoStep.people?.length === 0 && <div style={body}>Nobody holds a money role.</div>}
              {data.twoStep.people?.map((p) => (
                <div key={`${p.name}-${p.roles}`} style={{ ...item, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '14px', fontWeight: 700 }}>{p.name}</span>
                  <span style={muted}>{p.roles}</span>
                  <span style={chip(p.setUp ? GREEN : p.setUp === false ? AMBER : GREY)}>
                    {p.setUp === null ? "Couldn't be read" : p.setUp ? 'Set up' : 'Not yet'}
                  </span>
                </div>
              ))}
            </Part>

            <Part
              title="What the database won't let anyone do"
              summary={countText(data.database.length, 'refusal')}
              open={open.has('database')}
              onToggle={() => toggle('database')}
            >
              <div style={muted}>{PART_TEXT.database}</div>
              <ul style={{ ...body, margin: '6px 0', paddingLeft: '18px' }}>
                {data.database.map((d) => <li key={d}>{d}</li>)}
              </ul>
              <div style={body}>{data.databaseAccess}</div>
            </Part>

            <Part title="Controls" summary={countText(data.controls.length, 'control')} open={open.has('controls')} onToggle={() => toggle('controls')}>
              {data.controls.map((c) => (
                <div key={c.name} style={item}>
                  <div style={{ fontSize: '14px', fontWeight: 800 }}>{c.name}</div>
                  <div style={body}>{c.text}</div>
                  <div style={muted}>{c.where}</div>
                </div>
              ))}
            </Part>

            <Part
              title="The switches"
              summary={data.switches ? `${data.switches.filter((s) => s.on).length} of ${data.switches.length} on` : "Couldn't be read"}
              open={open.has('switches')}
              onToggle={() => toggle('switches')}
            >
              <div style={muted}>{PART_TEXT.switches}</div>
              {data.switches === null && <div style={{ ...body, color: RED }}>The switches couldn&apos;t be read.</div>}
              {data.switches?.map((s) => (
                <div key={s.name} style={item}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '14px', fontWeight: 800 }}>{s.name}</span>
                    <span style={chip(s.on ? GREEN : GREY)}>{s.on ? 'On' : 'Off'}</span>
                    {s.changedAt && <span style={muted}>since {centralDay(s.changedAt)}</span>}
                  </div>
                  <div style={body}>{s.what}</div>
                  {s.later && !s.on && <div style={muted}>{s.later}</div>}
                </div>
              ))}
            </Part>

            <Part
              title="Jobs that run by themselves"
              summary={data.lastPosting ? `The posting run last ran ${centralWhen(data.lastPosting)}` : "The posting run hasn't run yet"}
              open={open.has('jobs')}
              onToggle={() => toggle('jobs')}
            >
              {data.jobs.map((j) => (
                <div key={j.name} style={item}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '14px', fontWeight: 800 }}>{j.name}</span>
                    <span style={muted}>{j.when}</span>
                  </div>
                  <div style={body}>{j.what}</div>
                </div>
              ))}
              <div style={{ ...muted, marginTop: '4px' }}>
                {data.lastCopy ? `NetSuite's general ledger was last copied ${centralWhen(data.lastCopy)}.` : "NetSuite's general ledger hasn't been copied yet."}
              </div>
            </Part>

            <Part
              title="Backups"
              summary={data.backups.lastMade ? `The last good backup was made ${centralWhen(data.backups.lastMade)}` : 'No good backup has been made yet'}
              open={open.has('backups')}
              onToggle={() => toggle('backups')}
            >
              {data.backups.problem && <div style={banner(RED)}>{data.backups.problem}</div>}
              {data.backups.text.map((t) => <div key={t} style={{ ...body, marginBottom: '6px' }}>{t}</div>)}
              <div style={muted}>
                {data.backups.lastDrillPassed ? `The last restore drill passed ${centralWhen(data.backups.lastDrillPassed)}.` : 'No restore drill has passed yet.'}{' '}
                <Link href={deepLinks.booksBackups()} style={{ color: 'var(--text-secondary)' }}>Backups</Link>
              </div>
            </Part>

            <Part title="Records kept" summary="The journal and what's behind each entry" open={open.has('records')} onToggle={() => toggle('records')}>
              <ul style={{ ...body, margin: 0, paddingLeft: '18px' }}>
                {data.records.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </Part>

            <Part title="What the IRS asks" summary="Revenue Procedure 98-25, ask by ask" open={open.has('irs')} onToggle={() => toggle('irs')}>
              <div style={muted}>{data.irs.intro}</div>
              {data.irs.asks.map((a) => (
                <div key={a.ask} style={item}>
                  <div style={{ fontSize: '14px', fontWeight: 800 }}>{a.ask}</div>
                  <div style={body}>{a.answer}</div>
                </div>
              ))}
            </Part>

            <Part
              title="Chart of accounts"
              summary={data.accounts ? countText(data.accounts.length, 'account') : "Couldn't be read"}
              open={open.has('accounts')}
              onToggle={() => toggle('accounts')}
            >
              {data.accounts === null && <div style={{ ...body, color: RED }}>The chart of accounts couldn&apos;t be read.</div>}
              {data.accounts?.length === 0 && <div style={body}>No accounts yet.</div>}
              {data.accounts?.map((a, i) => (
                <div key={`${a.number}-${a.name}-${i}`} style={{ ...item, display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', opacity: a.active ? 1 : 0.6 }}>
                  <span style={{ fontSize: '13px', fontWeight: 700, minWidth: '52px' }}>{a.number}</span>
                  <span style={{ fontSize: '13px' }}>{a.name}</span>
                  <span style={muted}>{a.type} · {a.company}</span>
                  {!a.active && <span style={chip(GREY)}>Inactive</span>}
                  {a.heading && <span style={chip(GREY)}>Heading</span>}
                  {a.control && <span style={chip(GREY)}>Posted only by its documents</span>}
                </div>
              ))}
            </Part>
          </div>

          <div style={{ ...muted, marginTop: '12px' }}>{PART_TEXT.review}</div>
          {data.companies.length > 0 && (
            <div style={{ ...muted, marginTop: '6px' }}>
              {data.companies.map((c) => (
                <span key={c.code} style={{ display: 'block' }}>
                  {c.name} ({c.code}): {c.liveFrom ? `live from ${dayText(c.liveFrom)}` : 'not live yet'}
                  {c.closedThrough ? `, closed through ${monthText(c.closedThrough)}` : ''}
                  {c.yearsClosed.length ? `, years closed ${c.yearsClosed.join(', ')}` : ''}.
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
