'use client';

/**
 * "Recent activity" — the signed-in user's own last touches, merged into
 * one feed so the dashboard answers "where was I?" per person. Every row
 * deep-links to the screen where that work continues.
 *
 * Sources are the attribution columns the destination screens already
 * write — nothing new gets logged for this:
 *  - graphics_status_history.changed_by   (job created / moved / noted)
 *  - vehicle_status_history.changed_by    (check-ins and shop moves)
 *  - estimates.created_by                 (created / edited estimates)
 *  - wrap_quotes.created_by               (created / edited wrap quotes)
 *  - prospect_activities.created_by       (CRM calls, emails, notes, ...)
 *  - cni_job_status_history.changed_by    (network install moves)
 *  - scan_logs.scanned_by                 (grouped into one row per day)
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { deepLinks } from '@/lib/deep-links';
import { GRAPHICS_STATUS_LABELS, VEHICLE_STATUS_LABELS } from '@/lib/types';
import { estimateHeadlineNumber } from '@/lib/estimate-number';

interface ActivityItem {
  key: string;
  when: string; // ISO timestamp — sort key + "ago" display
  tag: 'GFX' | 'SHOP' | 'EST' | 'QUOTE' | 'CRM' | 'CNI' | 'SCAN';
  title: string;
  subtitle: string;
  path: string;
}

const LOOKBACK_DAYS = 14;
const SHOWN = 8; // rows visible before "Show more"
const MAX_ITEMS = 25;

const TAG_COLORS: Record<ActivityItem['tag'], string> = {
  GFX: 'var(--success)',
  SHOP: '#60a5fa',
  EST: 'var(--warning)',
  QUOTE: 'var(--orange)',
  CRM: '#f472b6',
  CNI: '#a78bfa',
  SCAN: '#67e8f9',
};

const CRM_LABELS: Record<string, string> = {
  call: 'Logged a call',
  email: 'Logged an email',
  note: 'Added a note',
  meeting: 'Logged a meeting',
  quote_sent: 'Sent a quote',
  status_change: 'Updated status',
  quote_accepted: 'Customer accepted a quote',
  quote_rejected: 'Customer requested changes',
};

const timeAgo = (d: string) => {
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
};

// 'stuck_parts' → 'Stuck Parts' — for statuses missing from a label map.
const pretty = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// Embedded parents come back as an object (or a 1-element array on some
// relationship shapes) — normalize to the object, null when unreadable.
const one = (v: any) => (Array.isArray(v) ? v[0] || null : v || null);

// "Created X" right after insert vs "Updated X" on a later edit.
const wasEdited = (createdAt: string | null, updatedAt: string | null) =>
  !!createdAt && !!updatedAt && new Date(updatedAt).getTime() - new Date(createdAt).getTime() > 120_000;

export default function RecentActivity() {
  const router = useRouter();
  const { user } = useAuth();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    const uid = user.id;
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

    const load = async () => {
      const [gfxRes, vehRes, estRes, quoteRes, crmRes, cniRes, scanRes] = await Promise.allSettled([
        supabase.from('graphics_status_history')
          .select('id, from_status, to_status, note, created_at, job:graphics_jobs(id, title, customer)')
          .eq('changed_by', uid).gte('created_at', cutoff)
          .order('created_at', { ascending: false }).limit(12),
        supabase.from('vehicle_status_history')
          .select('id, from_status, to_status, created_at, vehicle:fleet_checkins(id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name)')
          .eq('changed_by', uid).gte('created_at', cutoff)
          .order('created_at', { ascending: false }).limit(12),
        supabase.from('estimates')
          .select('id, estimate_number, netsuite_estimate_number, title, customer_name, created_at, updated_at')
          .eq('created_by', uid).gte('updated_at', cutoff)
          .order('updated_at', { ascending: false }).limit(8),
        supabase.from('wrap_quotes')
          .select('id, quote_number, vehicle_description, customer, created_at, updated_at')
          .eq('created_by', uid).gte('updated_at', cutoff)
          .order('updated_at', { ascending: false }).limit(8),
        supabase.from('prospect_activities')
          .select('id, type, summary, created_at, prospect:prospects(id, company_name)')
          .eq('created_by', uid).gte('created_at', cutoff)
          .order('created_at', { ascending: false }).limit(10),
        supabase.from('cni_job_status_history')
          .select('id, from_status, to_status, created_at, job:cni_jobs(id, title, customer_name)')
          .eq('changed_by', uid).gte('created_at', cutoff)
          .order('created_at', { ascending: false }).limit(8),
        supabase.from('scan_logs')
          .select('id, vin, part_number, part_description, scanned_at')
          .eq('scanned_by', uid).gte('scanned_at', cutoff)
          .order('scanned_at', { ascending: false }).limit(40),
      ]);
      const rows = (r: PromiseSettledResult<any>): any[] => (r.status === 'fulfilled' ? (r.value?.data || []) : []);

      const out: ActivityItem[] = [];

      for (const h of rows(gfxRes)) {
        const job = one(h.job);
        if (!job) continue; // job deleted since
        const title =
          h.from_status === null ? 'Created graphics job'
          : h.from_status === h.to_status ? 'Added a note'
          : `Moved to ${(GRAPHICS_STATUS_LABELS as Record<string, string>)[h.to_status] || pretty(h.to_status)}`;
        out.push({
          key: `gfx-${h.id}`, when: h.created_at, tag: 'GFX', title,
          subtitle: [job.title, job.customer].filter(Boolean).join(' · '),
          path: deepLinks.graphicsJob(job.id),
        });
      }

      for (const h of rows(vehRes)) {
        const v = one(h.vehicle);
        if (!v) continue;
        const desc = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || v.vin;
        const title =
          h.from_status === null ? 'Checked in vehicle'
          : h.from_status === h.to_status ? 'Added a note'
          : `Moved to ${(VEHICLE_STATUS_LABELS as Record<string, string>)[h.to_status] || pretty(h.to_status)}`;
        out.push({
          key: `veh-${h.id}`, when: h.created_at, tag: 'SHOP', title,
          subtitle: [desc, v.customer_name].filter(Boolean).join(' · '),
          path: deepLinks.vehicle(v.id),
        });
      }

      for (const e of rows(estRes)) {
        out.push({
          key: `est-${e.id}`, when: e.updated_at || e.created_at, tag: 'EST',
          title: `${wasEdited(e.created_at, e.updated_at) ? 'Updated' : 'Created'} estimate ${estimateHeadlineNumber(e)}`,
          subtitle: [e.title, e.customer_name].filter(Boolean).join(' · '),
          path: deepLinks.estimate(e.id),
        });
      }

      for (const q of rows(quoteRes)) {
        out.push({
          key: `quote-${q.id}`, when: q.updated_at || q.created_at, tag: 'QUOTE',
          title: `${wasEdited(q.created_at, q.updated_at) ? 'Updated' : 'Created'} wrap quote ${q.quote_number}`,
          subtitle: [q.vehicle_description, q.customer?.name].filter(Boolean).join(' · '),
          path: deepLinks.wrapQuote(q.id),
        });
      }

      for (const a of rows(crmRes)) {
        const p = one(a.prospect);
        if (!p) continue;
        out.push({
          key: `crm-${a.id}`, when: a.created_at, tag: 'CRM',
          title: CRM_LABELS[a.type] || pretty(a.type),
          subtitle: [p.company_name, a.summary].filter(Boolean).join(' — '),
          path: deepLinks.prospect(p.id),
        });
      }

      for (const h of rows(cniRes)) {
        const job = one(h.job);
        if (!job) continue;
        out.push({
          key: `cni-${h.id}`, when: h.created_at, tag: 'CNI',
          title: `Moved to ${pretty(h.to_status)}`,
          subtitle: [job.title, job.customer_name].filter(Boolean).join(' · '),
          path: deepLinks.cniJob(job.id),
        });
      }

      // Scans are high-volume — one feed row per local calendar day.
      const scans = rows(scanRes);
      const byDay = new Map<string, { count: number; latest: any; when: string }>();
      for (const s of scans) {
        const day = new Date(s.scanned_at).toLocaleDateString('en-CA');
        const g = byDay.get(day);
        if (g) g.count++;
        else byDay.set(day, { count: 1, latest: s, when: s.scanned_at }); // rows arrive newest-first
      }
      const todayKey = new Date().toLocaleDateString('en-CA');
      for (const [day, g] of byDay) {
        const capped = scans.length >= 40 && g.count >= 40;
        out.push({
          key: `scan-${day}`, when: g.when, tag: 'SCAN',
          title: `Logged ${capped ? '40+' : g.count} scan${g.count !== 1 ? 's' : ''}`,
          subtitle: g.latest.part_description || g.latest.part_number || g.latest.vin || '',
          path: `/admin/scans?tab=all&range=${day === todayKey ? 'today' : '7d'}`,
        });
      }

      out.sort((a, b) => b.when.localeCompare(a.when));
      setItems(out.slice(0, MAX_ITEMS));
      setLoading(false);
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once per user
  }, [user?.id]);

  const visible = expanded ? items : items.slice(0, SHOWN);
  const hidden = items.length - visible.length;

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px 10px' }}>
        <h2 style={{ margin: 0, fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-secondary)' }}>
          Your recent activity
        </h2>
        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>{LOOKBACK_DAYS} days</span>
      </div>
      <div style={{ borderTop: '1px solid var(--border)' }}>
        {loading && (
          <div style={{ padding: '14px 16px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>
        )}
        {!loading && items.length === 0 && (
          <div style={{ padding: '14px 16px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
            Nothing logged in the last {LOOKBACK_DAYS} days — your latest work will show up here.
          </div>
        )}
        {visible.map(it => (
          <button key={it.key} onClick={() => router.push(it.path)} style={{
            display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 16px', width: '100%',
            background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
            cursor: 'pointer', textAlign: 'left',
          }}>
            <span style={{
              fontSize: '9px', fontWeight: 800, letterSpacing: '0.5px', padding: '2px 7px', borderRadius: '5px',
              flexShrink: 0, width: '44px', textAlign: 'center',
              background: 'var(--subtle-bg)', color: TAG_COLORS[it.tag],
            }}>{it.tag}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</span>
              {it.subtitle && (
                <span style={{ display: 'block', fontSize: '10.5px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.subtitle}</span>
              )}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>{timeAgo(it.when)}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: '15px' }}>›</span>
          </button>
        ))}
        {(hidden > 0 || expanded) && (
          <button onClick={() => setExpanded(v => !v)} style={{
            display: 'block', width: '100%', padding: '8px 16px', background: 'transparent',
            border: 'none', cursor: 'pointer', textAlign: 'center',
            fontSize: '11.5px', fontWeight: 700, color: 'var(--orange)',
          }}>
            {expanded ? 'Show less' : `Show ${hidden} more`}
          </button>
        )}
      </div>
    </div>
  );
}
