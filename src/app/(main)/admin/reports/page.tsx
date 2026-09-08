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
    title: 'NetSuite Duplicate IDs',
    blurb: 'Which NetSuite-id money columns hold duplicated ids \u2014 the rows blocking migration 264\u2019s unique indexes. Clean them here, redeploy, and the indexes build themselves.',
    href: '/admin/reports/netsuite-dupes',
    source: 'FleetSuite',
  },
  {
    title: 'Never-Invoiced Recovery',
    blurb: 'Every completed or shipped vehicle with no invoice anywhere \u2014 oldest first, bucketed by what each needs: a linked sales order to bill, an estimate someone has to convert, or no paperwork at all. The queue behind the dashboard tile.',
    href: '/admin/reports/never-invoiced',
    source: 'FleetSuite',
  },
  {
    title: 'Open Order Book',
    blurb: 'Every open sales order: sold vs billed vs unbilled, with aging — money sold but not yet invoiced.',
    href: '/admin/reports/order-book',
    source: 'NetSuite',
  },
  {
    title: 'Vehicle Job Margin',
    blurb: 'Each invoiced vehicle end to end: invoice revenue vs parts bought for its project (vendor-PO lines + priced stock allocations) and the installer\u2019s bill for its VIN. Labor lands with per-vehicle labor capture.',
    href: '/admin/reports/vehicle-margin',
    source: 'FleetSuite',
  },
  {
    title: 'Vendor Scorecards',
    blurb: 'Per-vendor reality: actual lead times from receipts, promises kept vs ETA slips, short lines, spend, and price drift — with each vendor’s recent POs and receipt history. Early numbers are thin until promise/receipt history accrues.',
    href: '/admin/reports/vendors',
    source: 'FleetSuite',
  },
  {
    title: 'Material Yield & Scrap',
    blurb: 'How much of every roll became graphic and how much went in the bin \u2014 per film, worst waste first, with the scrap priced at what that film actually cost. Lines with no recorded printed area are counted separately, never scored as total waste.',
    href: '/admin/reports/material-yield',
    source: 'FleetSuite',
  },
  {
    title: 'Quoted Margin',
    blurb: 'The margin we OFFERED, frozen at each estimate send — by rep, customer, and month, distribution vs the floor, and every below-floor send with its typed reason. The leading indicator vehicle-margin confirms months later.',
    href: '/admin/reports/quoted-margin',
    source: 'FleetSuite',
  },
  {
    title: 'Installer Cost vs Invoiced',
    blurb: 'What we paid CNI installers per VIN (from recorded vendor invoices) vs. estimated customer billing, rolled up by location, installer, and part number.',
    href: '/admin/reports/installer-costs',
    source: 'FleetSuite',
  },
  {
    title: 'Monthly Accounting Package',
    blurb: 'One ZIP per month for your accountant: vendor invoices with the original documents, payouts paid, and per-VIN pay credits — all with NetSuite references.',
    href: '/admin/reports/accounting-package',
    source: 'FleetSuite',
  },
  {
    title: 'Graphics Costs — Revenue vs Material',
    blurb: 'Invoiced revenue minus logged vinyl/laminate cost per graphics job, plus a per-material usage rollup for buying decisions.',
    href: '/admin/reports/graphics-costs',
    source: 'FleetSuite',
  },
  {
    title: 'Sales Performance',
    blurb: 'Win rate, time-to-close, and quoted-vs-won by rep — from estimates and wrap quotes sent in a date range, with per-quote detail and CSV export.',
    href: '/admin/reports/sales-performance',
    source: 'FleetSuite',
  },
  {
    title: 'Invoice Reconciliation',
    blurb: 'NetSuite invoices for a period vs the FleetSuite records claiming them — amount mismatches, invoices with no FleetSuite record, and FleetSuite records pointing at invoices NetSuite doesn\'t have. CSV export. Admin only.',
    href: '/admin/reports/invoice-reconciliation',
    source: 'NetSuite',
  },
  {
    title: 'At-Risk Accounts',
    blurb: 'Customers who spent real money last year and have gone quiet — behind pace, no recent orders. A daily check alerts admins and the account owner when a new one appears.',
    href: '/admin/reports/at-risk',
    source: 'FleetSuite',
  },
  {
    title: 'On-Time Delivery',
    blurb: 'Promises kept: vehicles completed by their promised-back date, monthly and per customer, plus what’s overdue on the floor right now. A daily guardian alerts before dates slip.',
    href: '/admin/reports/on-time',
    source: 'FleetSuite',
  },
];

export default function ReportsIndexPage() {
  const router = useRouter();
  const { user, isAdmin, isSales, hasFeature } = useAuth();

  useEffect(() => {
    if (!user) return;
    // finance holds the `reports` feature and sees the Reports tile, but was
    // bounced here (gate was sales/admin only) — the audit's finance dead-end.
    if (!isAdmin && !isSales && !hasFeature('reports')) router.push('/home');
  }, [user, isAdmin, isSales, hasFeature, router]);

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
