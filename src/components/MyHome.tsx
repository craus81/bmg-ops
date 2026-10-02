'use client';

/**
 * Personal Home screen: "My week" (what I got done Monday through today, next
 * to the same span last week) and "Up next" (what's assigned or waiting on
 * me), tailored per role — field techs, shop techs, graphics production and
 * sales.
 *
 * Owner decisions 2026-09-29: counts only for techs and graphics, never
 * earnings (many are hourly); personal numbers only, no leaderboard; the week
 * is Monday–today. The role's main tool sits on top so Home never costs
 * anyone an extra tap.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import MentionsInbox from '@/components/MentionsInbox';
import { deepLinks } from '@/lib/deep-links';

interface WeekCount { thisWeek: number; lastWeek: number }
interface MyWeek {
  weekStart: string;
  today: string;
  done: Record<string, WeekCount | number | undefined>;
  next: {
    tasks: { id: string; title: string; due: string | null; projectId: string; project: string | null }[];
    events: { id: string; title: string; date: string; time: string | null }[];
    vehicles?: { id: string; label: string; vin: string; customer: string | null; status: string; due: string | null }[];
    vehiclesTotal?: number;
    arrivals?: { id: string; label: string; customer: string | null; date: string }[];
    graphicsJobs?: { id: string; label: string; jobNumber: string | null; customer: string | null; status: string; due: string | null }[];
    graphicsJobsTotal?: number;
    proofsWaiting?: { id: string; jobId: string; label: string; customer: string | null; round: number; sentAt: string }[];
    estimatesAwaiting?: { id: string; label: string; customer: string | null; total: number | null; since: string }[];
    reminders?: { id: string; title: string; due: string; prospectId: string }[];
    deals?: { id: string; title: string; value: number | null; close: string | null; prospectId: string }[];
  };
}

export type MyHomeRole = 'field_tech' | 'shop_tech' | 'graphics' | 'sales';

const VEHICLE_STATUS: Record<string, string> = {
  received: 'Received', checked_in: 'Checked in', in_progress: 'In progress',
  stuck_parts: 'Waiting on parts', stuck_graphics: 'Waiting on graphics',
};

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

const fmtDay = (ymd: string, today: string) => {
  if (ymd === today) return 'Today';
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const [ty, tm, td] = today.split('-').map(Number);
  const diff = Math.round((dt.getTime() - Date.UTC(ty, tm - 1, td)) / 86_400_000);
  if (diff === 1) return 'Tomorrow';
  const label = dt.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
  return diff < 0 ? `${label} · overdue` : label;
};

const fmtTime = (t: string | null) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const d = new Date(Date.UTC(2000, 0, 1, h, m));
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
};

const daysAgo = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
};

const fmtMoney = (n: number) => `$${Math.round(n).toLocaleString()}`;

interface Row { key: string; title: string; sub: string; href: string }
interface Section { title: string; rows: Row[]; link?: { label: string; href: string } }

/**
 * @param embedded  rendered above another dashboard (sales), which already
 *                  shows the Mentions inbox
 */
export default function MyHome({ role, embedded = false }: { role: MyHomeRole; embedded?: boolean }) {
  const router = useRouter();
  // The API only sends amounts to money roles; canSeeMoney also narrows
  // them under View As, so a preview shows what that role would see.
  const { user, profile, hasFeature, canSeeMoney } = useAuth();
  const [data, setData] = useState<MyWeek | null>(null);
  const [failed, setFailed] = useState(false);
  const view = role === 'field_tech' || role === 'shop_tech' ? 'tech' : role;

  useEffect(() => {
    if (!user) return;
    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      try {
        const res = await fetch(`/api/my/week?view=${view}`, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        if (!res.ok) throw new Error(String(res.status));
        setData(await res.json());
      } catch {
        setFailed(true);
      }
    })();
  }, [user, view]);

  const firstName = (profile?.full_name || '').trim().split(/\s+/)[0];
  const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden', marginBottom: '14px' };
  const cardHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px 10px' };
  const headTitle: React.CSSProperties = { margin: 0, fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-secondary)' };
  const headLink: React.CSSProperties = { fontSize: '11px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', padding: 0 };
  const rowStyle: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '10px 16px', background: 'none', border: 'none', borderTop: '1px solid var(--border)', cursor: 'pointer', color: 'var(--text-primary)' };
  const sub: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' };

  // ── Quick actions ───────────────────────────────────────────────
  const actions: { label: string; path: string; primary: boolean }[] = [];
  if (role === 'shop_tech' && (hasFeature('in_shop') || hasFeature('fleet_checkin'))) {
    // Pull In: scan a vehicle into a bay — starts its job timer.
    actions.push({ label: 'Pull In', path: deepLinks.pullIn(), primary: true });
    actions.push({ label: 'Check In', path: '/tracking?checkin=1', primary: false });
  }
  if ((role === 'field_tech' || role === 'shop_tech') && hasFeature('scan')) {
    actions.push({ label: role === 'field_tech' ? 'Scan an Install' : 'Scan', path: '/scan', primary: role === 'field_tech' });
  }
  if (role === 'graphics' && hasFeature('graphics')) {
    actions.push({ label: 'Graphics Production', path: '/graphics', primary: true });
    actions.push({ label: 'My Jobs', path: deepLinks.graphicsBoard({ mine: true }), primary: false });
  }
  if (role === 'sales' && hasFeature('estimates')) {
    actions.push({ label: 'New Estimate', path: deepLinks.newEstimate(), primary: true });
  }
  if (role === 'sales' && hasFeature('prospects')) {
    actions.push({ label: 'Customers', path: '/admin/prospects', primary: false });
  }

  // ── My week tiles ───────────────────────────────────────────────
  const count = (k: string) => data?.done[k] as WeekCount | undefined;
  const tileDefs: [string, string][] =
    role === 'field_tech' ? [['installs', 'Parts installed'], ['vehiclesInstalled', 'Vehicles'], ['tasks', 'Tasks done']]
    : role === 'shop_tech' ? [['checkedIn', 'Checked in'], ['completed', 'Completed'], ['installs', 'Parts installed'], ['tasks', 'Tasks done']]
    : role === 'graphics' ? [['jobsFinished', 'Jobs finished'], ['proofsSent', 'Proofs sent'], ['proofsApproved', 'Proofs approved'], ['tasks', 'Tasks done']]
    : [['estimatesCreated', 'Estimates written'], ['estimatesWon', 'Estimates won'], ['followUps', 'Follow-ups']];
  const tiles = tileDefs.flatMap(([k, label]) => { const c = count(k); return c ? [{ label, c }] : []; });
  const wonValue = canSeeMoney && typeof data?.done.wonValue === 'number' ? data.done.wonValue : null;

  const vsLast = (c: WeekCount) => {
    const d = c.thisWeek - c.lastWeek;
    if (c.thisWeek === 0 && c.lastWeek === 0) return { text: '—', color: 'var(--text-muted)' };
    if (d > 0) return { text: `▲ ${d} vs last week`, color: 'var(--success)' };
    if (d < 0) return { text: `${c.lastWeek} by now last week`, color: 'var(--text-muted)' };
    return { text: 'Same as last week', color: 'var(--text-muted)' };
  };

  const weekLabel = data
    ? (() => {
      const [y, m, d] = data.weekStart.split('-').map(Number);
      return `Week of ${new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
    })()
    : '';

  // ── Up next sections ────────────────────────────────────────────
  const sections: Section[] = [];
  if (data) {
    const n = data.next;
    const t = data.today;
    const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');
    if (n.vehicles?.length) sections.push({
      title: `My vehicles (${n.vehiclesTotal ?? n.vehicles.length})`,
      link: hasFeature('in_shop') ? { label: 'In-Shop →', href: '/tracking' } : undefined,
      rows: n.vehicles.map(v => ({
        key: v.id, title: v.label, href: deepLinks.vehicle(v.id),
        sub: join(v.customer, VEHICLE_STATUS[v.status] || v.status, v.due && `Due ${fmtDay(v.due, t)}`),
      })),
    });
    if (n.graphicsJobs?.length) sections.push({
      title: `My jobs (${n.graphicsJobsTotal ?? n.graphicsJobs.length})`,
      link: { label: 'Board →', href: deepLinks.graphicsBoard({ mine: true }) },
      rows: n.graphicsJobs.map(j => ({
        key: j.id, title: j.label, href: deepLinks.graphicsJob(j.id),
        sub: join(j.customer, titleCase(j.status), j.due && `Due ${fmtDay(j.due, t)}`),
      })),
    });
    if (n.proofsWaiting?.length) sections.push({
      title: 'Proofs waiting on the customer',
      rows: n.proofsWaiting.map(p => ({
        key: p.id, title: p.label, href: deepLinks.graphicsJob(p.jobId),
        sub: join(p.customer, `Round ${p.round}`, `sent ${daysAgo(p.sentAt)}`),
      })),
    });
    if (n.estimatesAwaiting?.length) sections.push({
      title: 'Estimates waiting on the customer',
      rows: n.estimatesAwaiting.map(e => ({
        key: e.id, title: e.label, href: deepLinks.estimate(e.id),
        sub: join(e.customer, canSeeMoney && e.total != null && fmtMoney(e.total), `last touched ${daysAgo(e.since)}`),
      })),
    });
    if (n.reminders?.length) sections.push({
      title: 'Follow-up reminders',
      rows: n.reminders.map(r => ({
        key: r.id, title: r.title, href: deepLinks.prospect(r.prospectId), sub: fmtDay(r.due, t),
      })),
    });
    if (n.deals?.length) sections.push({
      title: 'Deals closing soon',
      rows: n.deals.map(d => ({
        key: d.id, title: d.title, href: deepLinks.prospect(d.prospectId),
        sub: join(canSeeMoney && d.value != null && fmtMoney(d.value), d.close && `Close ${fmtDay(d.close, t)}`),
      })),
    });
    if (n.tasks.length) sections.push({
      title: 'My tasks',
      rows: n.tasks.map(k => ({
        key: k.id, title: k.title, href: deepLinks.upfitProject(k.projectId, { taskId: k.id }),
        sub: join(k.project, k.due && `Due ${fmtDay(k.due, t)}`),
      })),
    });
    if (n.events.length) sections.push({
      title: 'My schedule',
      link: hasFeature('schedule') ? { label: 'Schedule →', href: '/admin/schedule' } : undefined,
      rows: n.events.map(e => ({
        key: e.id, title: e.title, href: deepLinks.scheduleCard(e.id), sub: join(fmtDay(e.date, t), fmtTime(e.time)),
      })),
    });
    if (role === 'shop_tech' && n.arrivals?.length) sections.push({
      title: 'Arriving at the shop',
      rows: n.arrivals.map(a => ({
        key: a.id, title: a.label, href: deepLinks.shopArrival(a.id), sub: join(a.customer, fmtDay(a.date, t)),
      })),
    });
  }

  return (
    <div>
      {!embedded && <MentionsInbox />}

      <div style={{ marginBottom: '14px' }}>
        <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>
          {firstName ? `Hi, ${firstName}` : 'Home'}
        </h1>
        {weekLabel && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '2px' }}>{weekLabel}</div>}
      </div>

      {actions.length > 0 && (
        <div style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
          {actions.map(a => (
            <button key={a.path} onClick={() => router.push(a.path)} style={{
              flex: a.primary ? 2 : 1, padding: '16px', borderRadius: '12px', fontSize: '16px', fontWeight: 800, cursor: 'pointer',
              background: a.primary ? 'var(--navy)' : 'var(--card)', color: a.primary ? '#fff' : 'var(--text-primary)',
              border: a.primary ? 'none' : '1px solid var(--border)',
            }}>{a.label}</button>
          ))}
        </div>
      )}

      {failed && (
        <div style={{ ...card, padding: '14px 16px', color: 'var(--text-muted)', fontSize: '13px' }}>
          Couldn&apos;t load your week. Open Home again to retry.
        </div>
      )}

      {!data && !failed && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Loading your week…</div>
      )}

      {data && (
        <>
          <div style={card}>
            <div style={cardHead}><h2 style={headTitle}>My week</h2></div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${tiles.length + (wonValue != null ? 1 : 0) === 4 ? 2 : 3}, 1fr)`, gap: '10px', padding: '12px 16px 16px', borderTop: '1px solid var(--border)' }}>
              {tiles.map(tl => {
                const v = vsLast(tl.c);
                return (
                  <div key={tl.label} style={{ background: 'var(--subtle-bg)', borderRadius: '10px', padding: '12px' }}>
                    <div style={{ fontSize: '28px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{tl.c.thisWeek}</div>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginTop: '2px' }}>{tl.label}</div>
                    <div style={{ fontSize: '11px', color: v.color, marginTop: '4px' }}>{v.text}</div>
                  </div>
                );
              })}
              {wonValue != null && (
                <div style={{ background: 'var(--subtle-bg)', borderRadius: '10px', padding: '12px' }}>
                  <div style={{ fontSize: '28px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{fmtMoney(wonValue)}</div>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginTop: '2px' }}>Won this week</div>
                </div>
              )}
            </div>
          </div>

          <div style={card}>
            <div style={cardHead}><h2 style={headTitle}>Up next</h2></div>
            {sections.length === 0 && (
              <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border)', fontSize: '13px', color: 'var(--text-muted)' }}>
                Nothing waiting on you right now.
              </div>
            )}
            {sections.map(s => (
              <div key={s.title}>
                <div style={{ ...cardHead, borderTop: '1px solid var(--border)', paddingBottom: '4px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>{s.title}</span>
                  {s.link && <button style={headLink} onClick={() => router.push(s.link!.href)}>{s.link.label}</button>}
                </div>
                {s.rows.map(r => (
                  <button key={r.key} style={rowStyle} onClick={() => router.push(r.href)}>
                    <div style={{ fontSize: '14px', fontWeight: 700 }}>{r.title}</div>
                    {r.sub && <div style={sub}>{r.sub}</div>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
