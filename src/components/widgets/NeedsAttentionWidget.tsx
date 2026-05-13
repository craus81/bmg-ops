'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function NeedsAttentionWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<{ label: string; count: number; color: string; path: string }[]>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { load(); }, []);

  const load = async () => {
    const results: { label: string; count: number; color: string; path: string }[] = [];

    // Scanned vehicle photos submitted for review and still pending
    const { count: pendingReviews } = await supabase
      .from('scanned_vehicles')
      .select('*', { count: 'exact', head: true })
      .eq('submitted_for_review', true)
      .eq('review_status', 'pending');
    if ((pendingReviews || 0) > 0) {
      results.push({ label: 'Photos to Review', count: pendingReviews || 0, color: 'var(--warning)', path: '/admin/reviews' });
    }

    // Graphics jobs just received — need triage / production assignment
    const { count: gfxReceived } = await supabase
      .from('graphics_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'received');
    if ((gfxReceived || 0) > 0) {
      results.push({ label: 'New Graphics Jobs', count: gfxReceived || 0, color: 'var(--navy-light)', path: '/graphics' });
    }

    // Fleet check-ins invoiced but not yet paid
    const { count: unpaid } = await supabase
      .from('fleet_checkins')
      .select('*', { count: 'exact', head: true })
      .not('invoice_number', 'is', null)
      .eq('is_paid', false);
    if ((unpaid || 0) > 0) {
      results.push({ label: 'Awaiting Payment', count: unpaid || 0, color: 'var(--orange)', path: '/tracking' });
    }

    // CNI pending photos (if table exists)
    try {
      const { count: pendingPhotos } = await supabase
        .from('cni_job_photos')
        .select('*', { count: 'exact', head: true })
        .eq('review_status', 'pending');
      if ((pendingPhotos || 0) > 0) {
        results.push({ label: 'CNI Photos to Review', count: pendingPhotos || 0, color: 'var(--error)', path: '/admin/cni' });
      }
    } catch {}

    // CNI submitted invoices waiting on coordinator approval
    try {
      const { count: cniInvoices } = await supabase
        .from('cni_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('invoice_status', 'submitted');
      if ((cniInvoices || 0) > 0) {
        results.push({ label: 'CNI Invoices to Review', count: cniInvoices || 0, color: 'var(--warning)', path: '/admin/cni' });
      }
    } catch {}

    // CNI bidding jobs
    try {
      const { count: biddingJobs } = await supabase
        .from('cni_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'bidding_open');
      if ((biddingJobs || 0) > 0) {
        results.push({ label: 'Open Bids', count: biddingJobs || 0, color: 'var(--navy-light)', path: '/admin/cni' });
      }
    } catch {}

    setItems(results);
    setLoading(false);
  };

  const total = items.reduce((s, i) => s + i.count, 0);

  return (
    <WidgetShell title="Needs Attention" icon="" loading={loading} accentColor={total > 0 ? 'var(--warning)' : undefined}>
      {items.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--success)', fontWeight: 700, fontSize: '14px', paddingTop: '10px' }}>
          All caught up!
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {items.map((item, i) => (
            <button key={i} onClick={() => router.push(item.path)} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
              padding: '8px 10px', borderRadius: '8px', border: 'none', textAlign: 'left',
              background: 'var(--subtle-bg)', cursor: 'pointer',
            }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: theme.textPrimary }}>{item.label}</span>
              <span style={{
                fontSize: '13px', fontWeight: 800, color: item.color,
                background: `${item.color}15`, padding: '2px 8px', borderRadius: '6px',
              }}>{item.count}</span>
            </button>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}
