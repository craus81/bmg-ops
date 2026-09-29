'use client';

/**
 * Personal Home screen for field and shop techs: "My week" (what I got done
 * Monday through today, next to the same span last week) and "Up next"
 * (vehicles, tasks, calendar, and for the shop, arrivals).
 *
 * Owner decisions 2026-09-29: counts only, never earnings (many techs are
 * hourly); personal numbers only, no leaderboard; the week is Monday–today.
 * The role's main tool (Scan / Check In) sits on top so Home never costs a
 * tech an extra tap.
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
  done: { installs: WeekCount; vehiclesInstalled: WeekCount; checkedIn: WeekCount; completed: WeekCount; tasks: WeekCount };
  next: {
    vehicles: { id: string; label: string; vin: string; customer: string | null; status: string; due: string | null }[];
    vehiclesTotal: number;
    tasks: { id: string; title: string; due: string | null; projectId: string; project: string | null }[];
    events: { id: string; title: string; date: string; time: string | null }[];
    arrivals: { id: string; label: string; customer: string | null; date: string }[];
  };
}

export type MyHomeRole = 'field_tech' | 'shop_tech';

const STATUS_LABEL: Record<string, string> = {
  received: 'Received', checked_in: 'Checked in', in_progress: 'In progress',
  stuck_parts: 'Waiting on parts', stuck_graphics: 'Waiting on graphics',
};

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

export default function MyHome({ role }: { role: MyHomeRole }) {
  const router = useRouter();
  const { user, profile, hasFeature } = useAuth();
  const [data, setData] = useState<MyWeek | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      try {
        const res = await fetch('/api/my/week', {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        if (!res.ok) throw new Error(String(res.status));
        setData(await res.json());
      } catch {
        setFailed(true);
      }
    })();
  }, [user]);

  const firstName = (profile?.full_name || '').trim().split(/\s+/)[0];
  const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden', marginBottom: '14px' };
  const cardHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px 10px' };
  const headTitle: React.CSSProperties = { margin: 0, fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-secondary)' };
  const headLink: React.CSSProperties = { fontSize: '11px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', padding: 0 };
  const row: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '10px 16px', background: 'none', border: 'none', borderTop: '1px solid var(--border)', cursor: 'pointer', color: 'var(--text-primary)' };
  const sub: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' };

  // ── Quick action ────────────────────────────────────────────────
  const actions: { label: string; path: string; primary: boolean }[] = [];
  if (role === 'shop_tech' && (hasFeature('in_shop') || hasFeature('fleet_checkin'))) {
    actions.push({ label: 'Check In a Vehicle', path: '/tracking?checkin=1', primary: true });
  }
  if (hasFeature('scan')) {
    actions.push({ label: role === 'field_tech' ? 'Scan an Install' : 'Scan', path: '/scan', primary: role === 'field_tech' });
  }

  // ── My week tiles ───────────────────────────────────────────────
  const tiles: { label: string; c: WeekCount }[] = !data ? [] : role === 'field_tech'
    ? [
      { label: 'Parts installed', c: data.done.installs },
      { label: 'Vehicles', c: data.done.vehiclesInstalled },
      { label: 'Tasks done', c: data.done.tasks },
    ]
    : [
      { label: 'Checked in', c: data.done.checkedIn },
      { label: 'Completed', c: data.done.completed },
      { label: 'Parts installed', c: data.done.installs },
      { label: 'Tasks done', c: data.done.tasks },
    ];

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

  const n = data?.next;
  const nothingNext = n && n.vehicles.length === 0 && n.tasks.length === 0 && n.events.length === 0
    && (role !== 'shop_tech' || n.arrivals.length === 0);

  return (
    <div>
      <MentionsInbox />

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
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${tiles.length === 4 ? 2 : 3}, 1fr)`, gap: '10px', padding: '12px 16px 16px', borderTop: '1px solid var(--border)' }}>
              {tiles.map(t => {
                const v = vsLast(t.c);
                return (
                  <div key={t.label} style={{ background: 'var(--subtle-bg)', borderRadius: '10px', padding: '12px' }}>
                    <div style={{ fontSize: '28px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{t.c.thisWeek}</div>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginTop: '2px' }}>{t.label}</div>
                    <div style={{ fontSize: '11px', color: v.color, marginTop: '4px' }}>{v.text}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={card}>
            <div style={cardHead}><h2 style={headTitle}>Up next</h2></div>

            {nothingNext && (
              <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border)', fontSize: '13px', color: 'var(--text-muted)' }}>
                Nothing assigned to you right now.
              </div>
            )}

            {n && n.vehicles.length > 0 && (
              <>
                <div style={{ ...cardHead, borderTop: '1px solid var(--border)', paddingBottom: '4px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>My vehicles ({n.vehiclesTotal})</span>
                  <button style={headLink} onClick={() => router.push('/tracking')}>In-Shop →</button>
                </div>
                {n.vehicles.map(v => (
                  <button key={v.id} style={row} onClick={() => router.push(deepLinks.vehicle(v.id))}>
                    <div style={{ fontSize: '14px', fontWeight: 700 }}>{v.label}</div>
                    <div style={sub}>
                      {[v.customer, STATUS_LABEL[v.status] || v.status, v.due ? `Due ${fmtDay(v.due, data.today)}` : null].filter(Boolean).join(' · ')}
                    </div>
                  </button>
                ))}
              </>
            )}

            {n && n.tasks.length > 0 && (
              <>
                <div style={{ ...cardHead, borderTop: '1px solid var(--border)', paddingBottom: '4px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>My tasks</span>
                </div>
                {n.tasks.map(t => (
                  <button key={t.id} style={row} onClick={() => router.push(deepLinks.upfitProject(t.projectId, { taskId: t.id }))}>
                    <div style={{ fontSize: '14px', fontWeight: 700 }}>{t.title}</div>
                    <div style={sub}>{[t.project, t.due ? `Due ${fmtDay(t.due, data.today)}` : null].filter(Boolean).join(' · ')}</div>
                  </button>
                ))}
              </>
            )}

            {n && n.events.length > 0 && (
              <>
                <div style={{ ...cardHead, borderTop: '1px solid var(--border)', paddingBottom: '4px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>My schedule</span>
                  {hasFeature('schedule') && <button style={headLink} onClick={() => router.push('/admin/schedule')}>Schedule →</button>}
                </div>
                {n.events.map(e => (
                  <button key={e.id} style={row} onClick={() => router.push(deepLinks.scheduleCard(e.id))}>
                    <div style={{ fontSize: '14px', fontWeight: 700 }}>{e.title}</div>
                    <div style={sub}>{[fmtDay(e.date, data.today), fmtTime(e.time)].filter(Boolean).join(' · ')}</div>
                  </button>
                ))}
              </>
            )}

            {role === 'shop_tech' && n && n.arrivals.length > 0 && (
              <>
                <div style={{ ...cardHead, borderTop: '1px solid var(--border)', paddingBottom: '4px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>Arriving at the shop</span>
                </div>
                {n.arrivals.map(a => (
                  <button key={a.id} style={row} onClick={() => router.push(deepLinks.shopArrival(a.id))}>
                    <div style={{ fontSize: '14px', fontWeight: 700 }}>{a.label}</div>
                    <div style={sub}>{[a.customer, fmtDay(a.date, data.today)].filter(Boolean).join(' · ')}</div>
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
