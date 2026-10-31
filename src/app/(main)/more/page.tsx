'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useTheme } from '@/components/ThemeProvider';
import TextSizeToggle from '@/components/TextSizeToggle';
import DuoScreenNote from '@/components/DuoScreenNote';
import { apiFetch } from '@/lib/api-client';
import { useNavTabs } from '@/components/useNavTabs';
import { useCollapsed } from '@/components/CollapsibleCard';
import { resolveDashboardFocus } from '@/lib/dashboard-focus';
import { MORE_GROUPS, orderMoreGroups, searchMorePages, type MoreGroupId } from '@/lib/more-menu';
import { deepLinks } from '@/lib/deep-links';

export default function MorePage() {
  const router = useRouter();
  const { isAdmin, hasRole, hasFeature, profile, signOut } = useAuth();
  const { mode, setMode, resolvedTheme } = useTheme();
  const { customerOnly } = useNavTabs();
  // R3-20 gave the Purchasing/Receiving rows count badges; R6-13 moved
  // every count behind one role-filtered endpoint so no two surfaces can
  // report a different number for the same queue.
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [unknownQueues, setUnknownQueues] = useState<string[]>([]);
  /** A queue that could not be counted renders NO badge — never a 0. */
  const badgeFor = (key: string): number | undefined => {
    const n = counts[key];
    return typeof n === 'number' && n > 0 ? n : undefined;
  };

  // R6-13: one request instead of three browser queries. /api/badges
  // computes every attention queue the caller can act on, role-filtered
  // server-side and cached about a minute, so this page, the tab badge and
  // the app icon can never disagree about a number.
  //
  // A count that FAILED comes back null, not 0, and is left off the row
  // entirely — a "0" badge would say "nothing needs you" on the strength of
  // a query that errored.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/badges');
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setCounts(json.counts || {});
        setUnknownQueues(json.unknown || []);
      } catch { /* a badge that can't load simply doesn't render */ }
    })();
    return () => { cancelled = true; };
  }, [profile]);

  // Vendor Credits: admins with Parts Ordering once vendor credits are
  // switched on in Books → Switches; until then super admins only.
  const canOrderParts = hasFeature('parts_ordering');
  const [canVendorCredit, setCanVendorCredit] = useState(false);
  useEffect(() => {
    if (!canOrderParts) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/purchasing/vendor-credit?status=1');
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setCanVendorCredit(res.ok && !!body.canUse);
      } catch {
        if (!cancelled) setCanVendorCredit(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canOrderParts]);

  // Card Charges: anyone with Payments once card charges are switched on in
  // Books → Switches; until then super admins only.
  const canPayments = hasFeature('vendor_payments');
  const [canCardCharges, setCanCardCharges] = useState(false);
  useEffect(() => {
    if (!canPayments) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/card-charges?status=1');
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setCanCardCharges(res.ok && !!body.canUse);
      } catch {
        if (!cancelled) setCanCardCharges(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canPayments]);

  const F = hasFeature; // shorthand
  const [query, setQuery] = useState('');

  // One curated, grouped list (thread "Reorganize the More menu",
  // 2026-10-26): every page has exactly one entry, in the group of the work
  // it's for. The description sits behind the (i), so it's kept to two
  // lines on a phone.
  const items: (Item & { group: MoreGroupId })[] = [
    { group: 'sales', title: 'Customers', sub: 'Customers & sales pipeline', path: '/admin/prospects', show: F('prospects'), list: true, newPath: '/admin/prospects?tab=customers&new=1' },
    { group: 'sales', title: 'Estimates', sub: 'Every estimate · build, chase follow-ups, mark won or lost', path: '/estimates', show: F('estimates'), list: true, newPath: deepLinks.newEstimate() },
    { group: 'sales', title: 'Sales Orders', sub: 'Every NetSuite sales order · open, billed or closed · open one to edit or invoice it', path: '/sales-orders', show: F('estimates'), list: true },
    { group: 'sales', title: 'Invoices', sub: 'Every invoice · + New makes one from nothing · search, PDF, email, past due', path: '/invoices?tab=sent', show: F('invoicing'), list: true, newPath: '/invoices/new' },
    { group: 'sales', title: 'Ready to Invoice', sub: 'Finished graphics jobs and scanned vehicles waiting for an invoice', path: '/invoices', show: F('invoicing'), list: true },
    { group: 'sales', title: 'Customer POs', sub: 'POs customers send us (Masterack and others) · import, match, invoice', path: '/admin/pos', show: F('purchase_orders'), list: true, newPath: '/admin/pos?new=1' },
    { group: 'sales', title: 'Unmatched Sales Orders', sub: 'NetSuite orders with no estimate · accept or reject the best guesses', path: '/admin/so-matches', show: F('quotes'), list: true },
    { group: 'sales', title: 'Pricing Requests', sub: 'Masterack pricing requests · pictures, notes, your price and the PO', path: '/pricing-requests', show: F('estimates') },
    { group: 'sales', title: 'Graphics Builder', sub: 'Measure a vehicle, draw the proof and price the graphics as an estimate', path: '/admin/wrap-quote', show: F('graphics_builder') },
    { group: 'sales', title: 'Upfit Designer', sub: 'Design a van upfit in 3D & turn it into an estimate', path: '/upfit-designer', show: F('upfit_configurator') },
    { group: 'sales', title: 'After-hours Calls', sub: 'Calls the assistant took after hours · summary, recording, call back', path: '/after-hours-calls', show: F('after_hours_calls') },
    { group: 'sales', title: 'Credit Applications', sub: 'Review net-terms applications from the public form', path: '/admin/credit-applications', show: F('credit_applications') },

    { group: 'shop', title: 'Schedule', sub: 'Installs, upfits & events · two-way synced with Google Calendar', path: '/admin/schedule', show: F('schedule') },
    { group: 'shop', title: 'Scan & Log', sub: 'Scan VINs and log work', path: '/scan', show: F('scan') },
    { group: 'shop', title: 'Camera Installs', sub: 'Scan VIN, camera IMEI & GO9B IMEI for T-Mobile camera installs · CSV & PDF', path: '/camera-installs', show: F('in_shop') },
    { group: 'shop', title: 'QC Fixes', sub: 'Issues Masterack’s QC team reports through their link · fix-by date, mark fixed', path: '/qc-fixes', show: F('qc_fixes') },
    { group: 'shop', title: 'Completion Photos', sub: 'Finished-work photos from every job · download or send a link', path: '/completion-photos', show: F('completion_photos') },
    { group: 'shop', title: 'Client Files', sub: 'Every file in Dropbox › OFFICE › Clients · search, open or download', path: '/client-files', show: F('client_files') },
    { group: 'shop', title: 'Proof Search', sub: 'Find proof artwork in Dropbox by customer or part', path: '/admin/proof-search', show: F('proof_search') },

    { group: 'purchasing', title: 'Purchase Requests', sub: 'Requested parts waiting to be ordered, grouped by vendor', path: '/admin/purchasing', show: F('parts_ordering'), badge: badgeFor('purchase_requests'), list: true },
    { group: 'purchasing', title: 'Purchase Orders', sub: 'Every vendor PO · + New PO, open, undo', path: '/admin/purchasing?tab=vendor-pos', show: F('parts_ordering'), list: true, newPath: isAdmin ? '/admin/purchasing?tab=vendor-pos&new=1' : undefined },
    { group: 'purchasing', title: 'Receiving', sub: 'Check arriving parts in against vendor POs · the badge counts receipts still to enter in NetSuite by hand', path: '/admin/receiving', show: F('parts_ordering'), badge: badgeFor('manual_receipts'), list: true },
    { group: 'purchasing', title: 'Vendor Credits', sub: 'Enter a vendor’s credit · made in NetSuite and applied to their open bills', path: deepLinks.vendorCredit(), show: canVendorCredit },
    { group: 'purchasing', title: 'Parts Mail', sub: 'Incoming parts & ETAs vs. stock and job allocations', path: '/admin/parts-mail', show: F('upfit_projects') },
    { group: 'purchasing', title: 'Scan Log', sub: 'Review scans, match POs, export & invoice', path: '/admin/scans', show: F('reports') },

    { group: 'parts', title: 'Parts Catalog', sub: 'Upfit & graphic parts from NetSuite', path: '/parts', show: F('parts_catalog') },
    { group: 'parts', title: 'Parts', sub: 'Part photos, install files, labor hours and installed photos', path: '/installer-parts', show: F('installer_parts') && !F('parts_catalog') },
    { group: 'parts', title: 'Inventory', sub: 'On hand · allocated to jobs · free · on order, at a glance', path: '/admin/inventory', show: F('parts_catalog') },
    { group: 'parts', title: 'Rack Kits', sub: 'How many of each rack kit we can build from the parts on the shelf', path: '/admin/inventory/rack-kits', show: F('parts_catalog') },
    { group: 'parts', title: 'Hitch Kits', sub: 'Labor hours, brake controllers and Curt fitment for the hitch kit builder', path: '/admin/inventory/hitch-kits', show: F('parts_catalog') },

    { group: 'money', title: 'Payments (AP)', sub: 'Approve CNI vendor invoices & push bills to NetSuite', path: '/admin/ap', show: F('vendor_payments') },
    { group: 'money', title: 'Card Charges', sub: 'Code the Chase card’s charges · sent to NetSuite as a journal entry each month', path: deepLinks.cardCharges(), show: canCardCharges },
    { group: 'money', title: 'Reports', sub: 'Sales by customer detail & other custom reports', path: '/admin/reports', show: F('reports') },
    { group: 'money', title: 'Books', sub: 'FleetSuite’s own books · reports, accounts, trial balance & NetSuite lists', path: '/admin/books', show: hasRole('super_admin') },
    { group: 'money', title: 'Ledger', sub: 'QuickBooks history import, customer matching & NetSuite mirror', path: '/admin/ledger', show: F('ledger'), badge: badgeFor('ledger_unmatched_customers') },
    { group: 'money', title: 'Invoice Locations', sub: 'Backfill NetSuite invoice locations from the PO', path: '/admin/invoice-locations', show: F('invoice_admin') },

    { group: 'cni', title: 'Certified Network Installers', sub: 'Jobs, companies, installers & vendor payments', path: '/admin/cni', show: F('cni_admin') },
    { group: 'cni', title: 'Installer Portal', sub: 'The CNI installer view · available jobs, bids & invoices', path: '/installer', show: F('cni_portal') },
    { group: 'cni', title: 'Install Guides', sub: 'Dimension a 1:20 template & export a placement guide PDF for installers', path: '/graphics/install-guides', show: F('install_guides') },
    { group: 'cni', title: 'Import Installs', sub: 'Bulk-import installs from a spreadsheet, credited to a CNI installer', path: '/admin/import-installs', show: F('data_import') },

    { group: 'part-setup', title: 'Part Tagging Rules', sub: 'Auto-categorize parts by vendor & name instead of one dropdown at a time', path: '/admin/part-category-rules', show: F('part_admin') },
    { group: 'part-setup', title: 'Vendor Costs', sub: 'Upload vendor cost & target margin for outsourced parts', path: '/admin/vendor-costs', show: F('part_admin') },
    { group: 'part-setup', title: 'Fill In Part Display Names', sub: 'Copy graphic package or description into blank display names', path: '/admin/part-display-names', show: isAdmin },
    { group: 'part-setup', title: 'Part Dimensions', sub: 'Record W×D×H per part so the 3D Upfit Designer can place it', path: '/admin/part-dimensions', show: F('part_admin') },
    { group: 'part-setup', title: 'Vehicle Interiors', sub: 'Cargo geometry per wheelbase/roof · what the 3D designer draws', path: '/admin/vehicle-interiors', show: F('part_admin') },
    { group: 'part-setup', title: 'Import Vendor Assets', sub: 'Pull product photos & descriptions from a vendor’s website onto parts', path: '/admin/import-vendor-assets', show: F('data_import') },
    { group: 'part-setup', title: 'Proof Sweep', sub: 'Search Gmail for proofs by part number and attach them to parts', path: '/admin/proof-sweep', show: F('proof_admin') },
    { group: 'part-setup', title: 'Bulk Upload', sub: 'Import templates & proofs from ZIP', path: '/admin/bulk-upload', show: F('bulk_upload') },

    { group: 'admin', title: 'Permissions', sub: 'Switch what each user type can use · one place for every role', path: '/admin/permissions', show: hasRole('super_admin') },
    { group: 'admin', title: 'User Management', sub: 'Manage team access · the badge counts people waiting for approval', path: '/admin/users', show: F('user_management'), badge: badgeFor('pending_users') },
    { group: 'admin', title: 'Customer Notifications', sub: 'Who gets automatic emails · everything else is on-demand', path: '/admin/customer-notifications', show: F('customers') },
    { group: 'admin', title: 'Audit Log', sub: 'Who changed what · money edits, payouts, rates & invoices', path: '/admin/audit', show: F('audit_log') },
    { group: 'admin', title: 'System Health', sub: 'Background syncs & crons, with alerts when one dies', path: '/admin/system-health', show: F('system_health') },
    { group: 'admin', title: 'AI Instructions', sub: 'Steer FleetSuite AI behavior · global rules, no deploy', path: '/admin/ai-instructions', show: F('ai_instructions') },
    { group: 'admin', title: 'Knowledge Base', sub: 'SOPs and docs for the AI agent', path: '/admin/knowledge', show: F('knowledge_base') },

    { group: 'you', title: 'Help', sub: 'Guides for every part of the app · yours first, the rest of the library under it', path: '/help', show: true },
    { group: 'you', title: 'Settings', sub: 'Password, email signature, alerts & notifications', path: '/settings', show: true },
    { group: 'you', title: 'Sent Emails', sub: 'Every email you’ve sent from FleetSuite, with delivery status', path: '/sent-emails', show: true },
    { group: 'you', title: 'Customize Bottom Bar', sub: 'Pick which tabs sit in your bottom bar, and their order', path: '/more/bottom-bar', show: !customerOnly },
  ];
  const visible = items.filter(i => i.show);
  // Requests (Craig, 2026-10-30): top of More, for everyone, outside the
  // folding groups so it's never hidden. Search finds it too.
  const requestsItem: Item = { title: 'Requests', sub: 'Report a problem, ask for a feature or ask a question · Claude answers there', path: '/requests', show: true };

  // The person's own area first: the same focus that shapes their Dashboard.
  const focus = resolveDashboardFocus(profile?.dashboard_focus, {
    isAdmin, sales: hasRole('sales'), finance: hasRole('finance'), executive: hasRole('executive'),
  });
  const groupOrder = orderMoreGroups(focus);
  const results = searchMorePages([...visible, { ...requestsItem, group: 'you' as MoreGroupId }], query);
  const searching = query.trim().length > 0;
  const headerOf = (id: MoreGroupId) => MORE_GROUPS.find(g => g.id === id)?.header ?? '';

  return (
    <div>
      {/* Page search: finds app pages only, so it says so in the label,
          the placeholder and the empty result. */}
      <div style={{ marginBottom: '16px' }}>
        <label htmlFor="more-search" style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '6px' }}>
          Find a page in the app
        </label>
        <div style={{ position: 'relative' }}>
          <span aria-hidden style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '14px', pointerEvents: 'none' }}>⌕</span>
          <input
            id="more-search"
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="App pages only, e.g. hitch, receiving"
            autoComplete="off"
            style={{ width: '100%', boxSizing: 'border-box', padding: '11px 36px 11px 32px', borderRadius: '12px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '14px' }}
          />
          {searching && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" style={{ position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)', width: '28px', height: '28px', borderRadius: '50%', border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: '16px' }}>×</button>
          )}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '5px' }}>
          Finds FleetSuite pages and tools. It doesn’t search customers, jobs or parts.
        </div>
      </div>

      {searching ? (
        results.length === 0 ? (
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 14px', marginBottom: '20px' }}>
            No app page matches “{query.trim()}”. This box only finds pages in the app, not customers, jobs or parts.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
            {results.map(item => (
              <MenuRow key={item.path + item.title} item={item} groupLabel={headerOf(item.group)} onOpen={path => router.push(path)} />
            ))}
          </div>
        )
      ) : (
        <>
          {/* A queue we could not count shows no badge, so say why rather than
              letting its absence read as "nothing waiting". */}
          {unknownQueues.length > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '10px', padding: '8px 12px', marginBottom: '12px' }}>
              {unknownQueues.length} queue{unknownQueues.length === 1 ? '' : 's'} could not be counted just now — those rows show no badge, which is not the same as empty.
            </div>
          )}
          <div style={{ marginBottom: '20px' }}>
            <MenuRow item={requestsItem} onOpen={() => router.push(requestsItem.path)} />
          </div>
          {groupOrder.map(id => {
            const groupItems = visible.filter(i => i.group === id);
            if (groupItems.length === 0) return null;
            return <MoreGroup key={id} id={id} header={headerOf(id)} items={groupItems} onOpen={path => router.push(path)} />;
          })}
        </>
      )}

      {/* Theme Toggle */}
      <div style={{ marginTop: '24px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
          Appearance
        </div>
        <div style={{
          display: 'flex', gap: '4px', padding: '4px',
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: '14px', boxShadow: 'var(--shadow-sm)',
        }}>
          {([
            { id: 'auto' as const, label: 'Auto' },
            { id: 'light' as const, label: 'Light' },
            { id: 'dark' as const, label: 'Dark' },
          ]).map((opt) => (
            <button
              key={opt.id}
              onClick={() => setMode(opt.id)}
              style={{
                flex: 1, padding: '10px 6px', borderRadius: '10px',
                fontSize: '12px', fontWeight: 700,
                background: mode === opt.id ? 'var(--tab-active-bg)' : 'transparent',
                border: mode === opt.id ? '1px solid var(--tab-active-border)' : '1px solid transparent',
                color: mode === opt.id ? 'var(--text-primary)' : 'var(--text-muted)',
                transition: 'all 0.15s',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {mode === 'auto' && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', textAlign: 'center' }}>
            Currently showing {resolvedTheme} (matches your device)
          </div>
        )}

        {/* Text Size */}
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginTop: '16px', marginBottom: '10px' }}>
          Text Size
        </div>
        <TextSizeToggle />
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', textAlign: 'center' }}>
          Makes everything on this device larger and easier to read
        </div>
        <DuoScreenNote />
      </div>

      {/* Profile */}
      <div style={{ marginTop: '24px', padding: '16px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', boxShadow: 'var(--shadow-sm)' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{profile?.full_name}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>{profile?.email}</div>
        <div style={{ fontSize: '11px', color: isAdmin ? 'var(--orange)' : 'var(--navy-light)', marginTop: '3px', fontWeight: 600 }}>
          {(() => {
            if (isAdmin) return 'Administrator';
            const roles = (profile?.roles?.length ? profile.roles : [profile?.role]).filter(Boolean);
            const labelMap: Record<string, string> = {
              field_tech: 'Field Tech',
              shop_tech: 'Shop Tech',
              sales: 'Sales',
              graphics_production: 'Graphics Production',
              production: 'Graphics Production',
              installer: 'CNI Installer',
              finance: 'Finance / AP',
              customer: 'Customer',
            };
            return roles.map((r: any) => labelMap[r] || r).join(', ') || 'Installer';
          })()}
        </div>
        <button onClick={signOut} style={{
          marginTop: '14px', width: '100%', padding: '12px', borderRadius: '10px',
          border: '1px solid var(--error-border)', background: 'var(--error-bg)',
          color: 'var(--error)', fontSize: '13px', fontWeight: 700,
        }}>Sign Out</button>
      </div>

      <AboutLine />
    </div>
  );
}

/**
 * A page. `list` marks a list of transactions (Sales and Purchasing): its row
 * gets a List button, and a New button when `newPath` says where a new one
 * starts (Craig, 2026-10-31).
 */
interface Item { title: string; sub: string; path: string; show: boolean; badge?: number; list?: boolean; newPath?: string }

/**
 * One More category. Its header folds it, saved per user like the other
 * folding sections ('more:<group>'). Folded, it still shows how many things
 * inside are waiting on you, so a fold never hides work.
 */
function MoreGroup({ id, header, items, onOpen }: { id: MoreGroupId; header: string; items: Item[]; onOpen: (path: string) => void }) {
  const [collapsed, setCollapsed] = useCollapsed('more', id);
  const waiting = items.reduce((n, i) => n + (i.badge || 0), 0);
  return (
    <div style={{ marginBottom: collapsed ? '10px' : '20px' }}>
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        title={collapsed ? 'Show this group' : 'Hide this group — stays hidden next time'}
        style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', background: 'none', border: 'none', padding: '6px 0', marginBottom: collapsed ? 0 : '4px', cursor: 'pointer', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}
      >
        <span aria-hidden style={{ fontSize: '10px', width: '10px', display: 'inline-block', transition: 'transform 0.15s', transform: collapsed ? 'rotate(-90deg)' : 'none' }}>▾</span>
        <span>{header}</span>
        <span style={{ fontWeight: 600, letterSpacing: 0, textTransform: 'none' }}>· {items.length}</span>
        <span style={{ flex: 1 }} />
        {collapsed && waiting > 0 && <Badge n={waiting} label={`${waiting} waiting on you in ${header}`} />}
      </button>
      {!collapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {items.map(item => <MenuRow key={item.path + item.title} item={item} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  );
}

const rowAction = (color: string, border: string): React.CSSProperties => ({
  flexShrink: 0, padding: '6px 10px', borderRadius: '8px', border: `1px solid ${border}`, background: 'transparent',
  color, fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
});

/**
 * A page row: tap the title to open the page, tap (i) to slide its
 * description open underneath, two lines at most (Craig: it should only
 * grow downward).
 */
function MenuRow({ item, groupLabel, onOpen }: { item: Item; groupLabel?: string; onOpen: (path: string) => void }) {
  const [info, setInfo] = useState(false);
  return (
    <div style={{ borderRadius: '14px', border: '1px solid var(--border)', background: 'var(--card)', boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingRight: '12px' }}>
        <button type="button" onClick={() => onOpen(item.path)} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '8px', padding: '13px 0 13px 16px', background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer' }}>
          <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>{item.title}</span>
          {groupLabel && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{groupLabel}</span>}
        </button>
        {item.badge ? <Badge n={item.badge} /> : null}
        {item.list && (
          <button type="button" onClick={() => onOpen(item.path)} aria-label={`${item.title}: list`} style={rowAction('var(--text-primary)', 'var(--border)')}>List</button>
        )}
        {item.newPath && (
          <button type="button" onClick={() => onOpen(item.newPath!)} aria-label={`${item.title}: new`} style={rowAction('#16a34a', 'rgba(22,163,74,0.45)')}>+ New</button>
        )}
        <button
          type="button"
          onClick={() => setInfo(!info)}
          aria-expanded={info}
          aria-label={`What is ${item.title}?`}
          style={{
            width: '24px', height: '24px', flexShrink: 0, borderRadius: '50%', padding: 0,
            border: `1.5px solid ${info ? 'var(--navy)' : 'var(--text-muted)'}`,
            background: info ? 'var(--navy)' : 'transparent', color: info ? '#fff' : 'var(--text-muted)',
            fontSize: '12px', fontWeight: 700, fontStyle: 'italic', fontFamily: 'Georgia, serif', lineHeight: 1,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}
        >i</button>
      </div>
      <div style={{ display: 'grid', gridTemplateRows: info ? '1fr' : '0fr', transition: 'grid-template-rows 0.18s ease' }}>
        <div style={{ overflow: 'hidden' }}>
          <div style={{
            fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4, padding: '0 16px 12px',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{item.sub}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * About: the App Store / Play version of the iPhone or Android app (Craig,
 * 2026-10-26, picked "App Store version only"). It only changes with a store
 * release; website updates load live and don't change it. Not shown in a
 * browser, where there's no store version.
 */
function AboutLine() {
  const [native, setNative] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cap = await import('@capacitor/core');
        if (!cap.Capacitor?.isNativePlatform?.()) return;
        const { App } = await import('@capacitor/app');
        const info = await App.getInfo();
        if (!cancelled) setNative(`App ${info.version} (build ${info.build})`);
      } catch { /* no store version to show */ }
    })();
    return () => { cancelled = true; };
  }, []);
  if (!native) return null;
  return (
    <div style={{ marginTop: '16px', textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
      <div style={{ fontWeight: 700 }}>About FleetSuite</div>
      <div>{native}</div>
    </div>
  );
}

function Badge({ n, label }: { n: number; label?: string }) {
  return (
    <span aria-label={label} title={label} style={{
      minWidth: '22px', height: '22px', padding: '0 6px', boxSizing: 'border-box', borderRadius: '11px',
      background: 'var(--orange)', color: '#fff', fontSize: '11px', fontWeight: 800,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>{n}</span>
  );
}
