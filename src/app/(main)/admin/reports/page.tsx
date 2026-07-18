'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

interface ReportLink {
  title: string;
  blurb: string;
  href: string;
  source: 'NetSuite' | 'FleetSuite';
}

const REPORTS: ReportLink[] = [
  {
    title: 'Sales by Customer — Detail',
    blurb: 'Per-line invoice detail for selected customers over a date range. Columns: invoice #, memo, location, part #, qty, net amount. Pulls live from NetSuite.',
    href: '/admin/reports/sales-by-customer-detail',
    source: 'NetSuite',
  },
  {
    title: 'Download Open Invoices',
    blurb: 'Pull every open invoice PDF for a customer from NetSuite and download them as one ZIP. Capped at 60 invoices per pull.',
    href: '/invoices/bulk-download',
    source: 'NetSuite',
  },
  {
    title: 'Installer Cost vs Invoiced',
    blurb: 'What we paid CNI installers per VIN (from recorded vendor invoices) vs. estimated customer billing, rolled up by location, installer, and part number.',
    href: '/admin/reports/installer-costs',
    source: 'FleetSuite',
  },
  {
    title: 'Sales Performance',
    blurb: 'Win rate, time-to-close, and quoted-vs-won by rep — from estimates and wrap quotes sent in a date range, with per-quote detail and CSV export.',
    href: '/admin/reports/sales-performance',
    source: 'FleetSuite',
  },
  {
    title: 'At-Risk Accounts',
    blurb: 'Customers who spent real money last year and have gone quiet — behind pace, no recent orders. A daily check alerts admins and the account owner when a new one appears.',
    href: '/admin/reports/at-risk',
    source: 'FleetSuite',
  },
];

export default function ReportsIndexPage() {
  const router = useRouter();
  const { user, isAdmin, isSales } = useAuth();

  useEffect(() => {
    if (!user) return;
    if (!isAdmin && !isSales) router.push('/home');
  }, [user, isAdmin, isSales, router]);

  return (
    <div>
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Reports</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Custom reports pulled from NetSuite + FleetSuite data. More coming as needed.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {REPORTS.map(r => (
          <button
            key={r.href}
            onClick={() => router.push(r.href)}
            style={{
              textAlign: 'left', padding: '14px 16px', borderRadius: '14px',
              background: 'var(--card)', border: '1px solid var(--border)',
              cursor: 'pointer', boxShadow: 'var(--shadow-sm)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>{r.title}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.4 }}>{r.blurb}</div>
              </div>
              <span style={{
                fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
                padding: '3px 8px', borderRadius: '8px', whiteSpace: 'nowrap',
                background: r.source === 'NetSuite' ? 'rgba(59,130,246,0.12)' : 'rgba(34,197,94,0.12)',
                color: r.source === 'NetSuite' ? '#3b82f6' : '#22c55e',
              }}>{r.source}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
