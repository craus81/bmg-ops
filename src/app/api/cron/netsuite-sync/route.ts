import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { requireAdmin } from '@/lib/api-auth';
import { syncPoInvoices } from '@/lib/po-invoice-sync';
import { verifyPoInvoiceQuantities } from '@/lib/po-invoice-verify';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET /api/cron/netsuite-sync
 *
 * Automatic incremental sync from NetSuite — runs on Vercel Cron.
 * Only fetches records modified since the last successful sync.
 *
 * Syncs: customers, prospects, contacts (with phone numbers), and
 * PO-linked invoices (so invoices entered directly in NetSuite show up
 * on the PO page without anyone clicking "Sync Invoices")
 */
export async function GET(req: NextRequest) {
  // Allow Vercel Cron with the shared secret; anyone else needs an admin
  // session (manual trigger from the app). Fails closed if CRON_SECRET is
  // not configured.
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const results: Record<string, any> = {};

  // ═══════════ 1. INCREMENTAL CUSTOMER & PROSPECT SYNC ═══════════
  try {
    // Get last sync time
    const { data: syncState } = await supabase
      .from('sync_state')
      .select('last_synced_at')
      .eq('sync_type', 'netsuite_customers')
      .single();

    const lastSynced = syncState?.last_synced_at || '2020-01-01T00:00:00Z';
    // Format for SuiteQL: MM/DD/YYYY
    const sinceDate = new Date(lastSynced);
    const sinceDateStr = `${sinceDate.getMonth() + 1}/${sinceDate.getDate()}/${sinceDate.getFullYear()}`;

    // Fetch only customers modified since last sync
    const customerQuery = `
      SELECT
        c.id,
        c.companyname,
        c.entityid,
        c.email,
        c.phone,
        c.lastmodifieddate
      FROM customer c
      WHERE c.isinactive = 'F'
        AND c.lastmodifieddate >= TO_DATE('${sinceDateStr}', 'MM/DD/YYYY')
      ORDER BY c.lastmodifieddate DESC
    `;

    const nsCustomers = await suiteqlQueryAll(customerQuery);

    // Fetch addresses for modified customers
    const addressMap: Record<string, string> = {};
    if (nsCustomers.length > 0) {
      try {
        const custIds = nsCustomers.map((c: any) => c.id).join(',');
        const addrQuery = `
          SELECT
            ca.entity AS customer_id,
            ea.addr1, ea.addr2, ea.city, ea.state, ea.zip
          FROM customerAddressbook ca
          JOIN entityAddress ea ON ea.nkey = ca.addressbookaddress
          WHERE ca.defaultbilling = 'T' AND ca.entity IN (${custIds})
        `;
        const addrRows = await suiteqlQueryAll(addrQuery);
        for (const row of addrRows) {
          const custId = row.customer_id?.toString();
          if (custId) {
            addressMap[custId] = [row.addr1, row.addr2, row.city, row.state, row.zip].filter(Boolean).join(', ');
          }
        }
      } catch { /* address fetch optional */ }
    }

    // Fetch spend data for modified customers
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;
    const allTimeMap: Record<string, any> = {};
    const ytdMap: Record<string, any> = {};
    const lastYearMap: Record<string, any> = {};

    if (nsCustomers.length > 0) {
      try {
        const custIds = nsCustomers.map((c: any) => c.id).join(',');
        // Count billed revenue (CustInvc + CashSale), not sales orders. SO
        // totals miss direct-invoice flows (graphics-only billing, ad-hoc
        // invoices) — see /api/netsuite/customers for the full rationale.
        const [allTime, ytd, ly] = await Promise.all([
          suiteqlQueryAll(`SELECT t.entity AS cid, COUNT(t.id) AS cnt, SUM(t.foreigntotal) AS spend, MAX(t.trandate) AS lastdate FROM transaction t WHERE t.type IN ('CustInvc', 'CashSale') AND t.entity IN (${custIds}) GROUP BY t.entity`),
          suiteqlQueryAll(`SELECT t.entity AS cid, COUNT(t.id) AS cnt, SUM(t.foreigntotal) AS spend FROM transaction t WHERE t.type IN ('CustInvc', 'CashSale') AND t.entity IN (${custIds}) AND EXTRACT(YEAR FROM t.trandate)=${currentYear} GROUP BY t.entity`),
          suiteqlQueryAll(`SELECT t.entity AS cid, COUNT(t.id) AS cnt, SUM(t.foreigntotal) AS spend FROM transaction t WHERE t.type IN ('CustInvc', 'CashSale') AND t.entity IN (${custIds}) AND EXTRACT(YEAR FROM t.trandate)=${lastYear} GROUP BY t.entity`),
        ]);
        allTime.forEach((r: any) => { allTimeMap[r.cid?.toString()] = r; });
        ytd.forEach((r: any) => { ytdMap[r.cid?.toString()] = r; });
        ly.forEach((r: any) => { lastYearMap[r.cid?.toString()] = r; });
      } catch { /* spend data optional */ }
    }

    const nsAccountId = (process.env.NETSUITE_ACCOUNT_ID || '').toLowerCase().replace(/_/g, '-');
    const nsBaseUrl = `https://${nsAccountId}.app.netsuite.com`;

    let customersSynced = 0;
    let prospectsSynced = 0;

    for (const nsc of nsCustomers) {
      const nsId = nsc.id?.toString();
      const at = allTimeMap[nsId] || {};
      const yt = ytdMap[nsId] || {};
      const lyr = lastYearMap[nsId] || {};
      const orderCount = parseInt(at.cnt) || 0;
      const totalSpend = parseFloat(at.spend) || 0;

      // Upsert customer
      const { error } = await supabase.from('customers').upsert({
        netsuite_id: nsId,
        netsuite_url: `${nsBaseUrl}/app/common/entity/custjob.nl?id=${nsId}`,
        company_name: nsc.companyname || nsc.entityid || 'Unknown',
        entity_id: nsc.entityid || '',
        email: nsc.email || null,
        phone: nsc.phone || null,
        address: addressMap[nsId] || null,
        total_orders: orderCount,
        total_spend: totalSpend,
        avg_order_value: orderCount > 0 ? Math.round((totalSpend / orderCount) * 100) / 100 : 0,
        ytd_spend: parseFloat(yt.spend) || 0,
        ytd_orders: parseInt(yt.cnt) || 0,
        last_year_spend: parseFloat(lyr.spend) || 0,
        last_year_orders: parseInt(lyr.cnt) || 0,
        last_order_date: at.lastdate || null,
        active: true,
      }, { onConflict: 'netsuite_id' });
      if (!error) customersSynced++;

      // Upsert prospect
      const { error: pErr } = await supabase.from('prospects').upsert({
        netsuite_id: nsId,
        netsuite_url: `${nsBaseUrl}/app/common/entity/custjob.nl?id=${nsId}`,
        netsuite_type: 'customer',
        company_name: nsc.companyname || nsc.entityid || 'Unknown',
        email: nsc.email || null,
        phone: nsc.phone || null,
        address: addressMap[nsId] || null,
        status: 'converted',
        source: 'netsuite',
        pushed_at: new Date().toISOString(),
      }, { onConflict: 'netsuite_id', ignoreDuplicates: false });
      if (!pErr) prospectsSynced++;
    }

    // Update sync timestamp
    await supabase.from('sync_state').upsert({
      sync_type: 'netsuite_customers',
      last_synced_at: new Date().toISOString(),
      last_result: { customersSynced, prospectsSynced, total: nsCustomers.length },
      updated_at: new Date().toISOString(),
    });

    results.customers = { modified: nsCustomers.length, customersSynced, prospectsSynced };
  } catch (err: any) {
    console.error('[cron] Customer sync error:', err.message);
    results.customers = { error: err.message };
  }

  // ═══════════ 2. INCREMENTAL CONTACT SYNC ═══════════
  try {
    const { data: contactSync } = await supabase
      .from('sync_state')
      .select('last_synced_at')
      .eq('sync_type', 'netsuite_contacts')
      .single();

    const lastContactSync = contactSync?.last_synced_at || '2020-01-01T00:00:00Z';
    const sinceDate = new Date(lastContactSync);
    const sinceDateStr = `${sinceDate.getMonth() + 1}/${sinceDate.getDate()}/${sinceDate.getFullYear()}`;

    // Build prospect map
    let allProspectRows: any[] = [];
    let pPage = 0;
    let pHasMore = true;
    while (pHasMore) {
      const { data: batch } = await supabase.from('prospects').select('id, netsuite_id').not('netsuite_id', 'is', null).range(pPage * 1000, (pPage + 1) * 1000 - 1);
      allProspectRows = [...allProspectRows, ...(batch || [])];
      pHasMore = (batch || []).length === 1000;
      pPage++;
    }
    const nsToProspect: Record<string, string> = {};
    allProspectRows.forEach((p: any) => { if (p.netsuite_id) nsToProspect[p.netsuite_id] = p.id; });

    // Fetch contacts modified since last sync
    const contactRows = await suiteqlQueryAll(`
      SELECT
        c.id AS contact_id, c.entityid AS entity_name,
        c.firstname, c.lastname, c.email,
        c.phone, c.mobilephone, c.homephone, c.officephone,
        c.title, c.company AS customer_id
      FROM contact c
      WHERE c.company IS NOT NULL
        AND c.lastmodifieddate >= TO_DATE('${sinceDateStr}', 'MM/DD/YYYY')
      ORDER BY c.company
    `);

    // Customer phones as fallback
    const customerPhones: Record<string, string> = {};
    if (contactRows.length > 0) {
      const custIds = [...new Set(contactRows.map((r: any) => r.customer_id?.toString()).filter(Boolean))];
      if (custIds.length > 0) {
        try {
          const phoneRows = await suiteqlQueryAll(`SELECT cu.id AS cid, cu.phone FROM customer cu WHERE cu.phone IS NOT NULL AND cu.id IN (${custIds.join(',')})`);
          phoneRows.forEach((r: any) => { if (r.cid && r.phone) customerPhones[r.cid.toString()] = r.phone; });
        } catch { /* optional */ }
      }
    }

    let contactsSynced = 0;
    let phonesFound = 0;

    for (const row of contactRows) {
      const custId = row.customer_id?.toString();
      if (!custId || !nsToProspect[custId]) continue;

      let name = '';
      if (row.firstname && row.lastname) name = `${row.firstname} ${row.lastname}`;
      else if (row.entity_name) name = row.entity_name;
      else continue;
      name = name.replace(/^\d+\s+/, '').trim();
      if (!name) continue;

      const contactPhone = row.phone || row.mobilephone || row.officephone || row.homephone || null;
      const phone = contactPhone || customerPhones[custId] || null;
      if (phone) phonesFound++;

      const { error } = await supabase.from('prospect_contacts').upsert({
        prospect_id: nsToProspect[custId],
        name,
        title: row.title || null,
        email: row.email || null,
        phone,
      }, { onConflict: 'prospect_id,name' });
      if (!error) contactsSynced++;
    }

    await supabase.from('sync_state').upsert({
      sync_type: 'netsuite_contacts',
      last_synced_at: new Date().toISOString(),
      last_result: { contactsSynced, total: contactRows.length, phonesFound },
      updated_at: new Date().toISOString(),
    });

    results.contacts = { modified: contactRows.length, contactsSynced, phonesFound };
  } catch (err: any) {
    console.error('[cron] Contact sync error:', err.message);
    results.contacts = { error: err.message };
  }

  // ═══════════ 3. PO INVOICE SWEEP ═══════════
  // Link NetSuite-entered invoices to their POs by Reference No. so the
  // PO page's Invoices section stays current without the manual button.
  try {
    results.poInvoices = await syncPoInvoices(supabase);
  } catch (err: any) {
    console.error('[cron] PO invoice sync error:', err.message);
    results.poInvoices = { error: err.message };
  }

  // ═══════════ 4. INVOICED-QUANTITY CHECK ═══════════
  // Compare every PO's ordered quantities against its linked invoices' line
  // quantities and flag mismatches, so billing problems surface on the PO
  // page without anyone clicking "Check Billing".
  try {
    const check = await verifyPoInvoiceQuantities(supabase);
    results.invoiceCheck = { posChecked: check.posChecked, flagged: check.flagged, cleared: check.cleared };
  } catch (err: any) {
    console.error('[cron] Invoice quantity check error:', err.message);
    results.invoiceCheck = { error: err.message };
  }

  return NextResponse.json({ status: 'ok', ...results });
}
