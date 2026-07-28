import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { requireAdmin } from '@/lib/api-auth';
import { syncPoInvoices } from '@/lib/po-invoice-sync';
import { verifyPoInvoiceQuantities } from '@/lib/po-invoice-verify';
import { syncVendorPos } from '@/lib/vendor-po-sync';
import { syncInventoryQuantities } from '@/lib/inventory-sync';
import { syncVendorBillPayments } from '@/lib/vendor-bill-sync';
import { recordHeartbeat } from '@/lib/system-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET /api/cron/netsuite-sync
 *
 * Automatic incremental sync from NetSuite — runs on Vercel Cron.
 * Only fetches records modified since the last successful sync.
 *
 * Syncs: customers, prospects, spend numbers for any customer with
 * recent invoice/cash-sale activity (their record alone may not have
 * moved), contacts (with phone numbers), and PO-linked invoices (so
 * invoices entered directly in NetSuite show up on the PO page without
 * anyone clicking "Sync Invoices")
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

  const supabase = createServiceClient();

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
    const customersWrite = await recordHeartbeat(
      supabase, 'netsuite_customers', { customersSynced, prospectsSynced, total: nsCustomers.length },
    );

    results.customers = { modified: nsCustomers.length, customersSynced, prospectsSynced, syncStateWrite: customersWrite };
  } catch (err: any) {
    console.error('[cron] Customer sync error:', err.message);
    results.customers = { error: err.message };
  }

  // ═══════════ 1b. SPEND REFRESH BY TRANSACTION ACTIVITY ═══════════
  // Phase 1 only sees customers whose RECORD changed in NetSuite. A new
  // invoice (or a payment touching an old one) doesn't necessarily modify
  // the customer record, so spend tiles could lag indefinitely. Key on
  // transaction activity instead: every customer with an invoice/cash-sale
  // modified since the last run gets their spend numbers recomputed,
  // whether or not their customer record moved.
  try {
    const { data: spendState } = await supabase
      .from('sync_state')
      .select('last_synced_at')
      .eq('sync_type', 'netsuite_spend_refresh')
      .maybeSingle();
    const lastSpendSync = new Date(spendState?.last_synced_at || '2020-01-01T00:00:00Z');
    const sinceStr = `${lastSpendSync.getMonth() + 1}/${lastSpendSync.getDate()}/${lastSpendSync.getFullYear()}`;

    const activeRows = await suiteqlQueryAll(`
      SELECT DISTINCT t.entity AS cid
      FROM transaction t
      WHERE t.type IN ('CustInvc', 'CashSale')
        AND t.lastmodifieddate >= TO_DATE('${sinceStr}', 'MM/DD/YYYY')
    `);
    const activeIds = [...new Set(
      activeRows.map((r: any) => String(r.cid ?? '')).filter((id: string) => /^\d+$/.test(id)),
    )];

    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;
    let spendRefreshed = 0;

    for (let i = 0; i < activeIds.length; i += 200) {
      const chunk = activeIds.slice(i, i + 200);
      const custIds = chunk.join(',');
      const [allTime, ytd, ly] = await Promise.all([
        suiteqlQueryAll(`SELECT t.entity AS cid, COUNT(t.id) AS cnt, SUM(t.foreigntotal) AS spend, MAX(t.trandate) AS lastdate FROM transaction t WHERE t.type IN ('CustInvc', 'CashSale') AND t.entity IN (${custIds}) GROUP BY t.entity`),
        suiteqlQueryAll(`SELECT t.entity AS cid, COUNT(t.id) AS cnt, SUM(t.foreigntotal) AS spend FROM transaction t WHERE t.type IN ('CustInvc', 'CashSale') AND t.entity IN (${custIds}) AND EXTRACT(YEAR FROM t.trandate)=${currentYear} GROUP BY t.entity`),
        suiteqlQueryAll(`SELECT t.entity AS cid, COUNT(t.id) AS cnt, SUM(t.foreigntotal) AS spend FROM transaction t WHERE t.type IN ('CustInvc', 'CashSale') AND t.entity IN (${custIds}) AND EXTRACT(YEAR FROM t.trandate)=${lastYear} GROUP BY t.entity`),
      ]);
      const atMap: Record<string, any> = {};
      const ytMap: Record<string, any> = {};
      const lyMap: Record<string, any> = {};
      allTime.forEach((r: any) => { atMap[r.cid?.toString()] = r; });
      ytd.forEach((r: any) => { ytMap[r.cid?.toString()] = r; });
      ly.forEach((r: any) => { lyMap[r.cid?.toString()] = r; });

      for (const cid of chunk) {
        const at = atMap[cid] || {};
        const yt = ytMap[cid] || {};
        const lyr = lyMap[cid] || {};
        const orderCount = parseInt(at.cnt) || 0;
        const totalSpend = parseFloat(at.spend) || 0;
        // Update spend fields only — phase 1 owns record creation, so a
        // customer that's never been synced simply isn't touched here.
        const { data: updated } = await supabase
          .from('customers')
          .update({
            total_orders: orderCount,
            total_spend: totalSpend,
            avg_order_value: orderCount > 0 ? Math.round((totalSpend / orderCount) * 100) / 100 : 0,
            ytd_spend: parseFloat(yt.spend) || 0,
            ytd_orders: parseInt(yt.cnt) || 0,
            last_year_spend: parseFloat(lyr.spend) || 0,
            last_year_orders: parseInt(lyr.cnt) || 0,
            last_order_date: at.lastdate || null,
          })
          .eq('netsuite_id', cid)
          .select('id');
        spendRefreshed += (updated || []).length;
      }
    }

    const spendWrite = await recordHeartbeat(
      supabase, 'netsuite_spend_refresh', { customersWithActivity: activeIds.length, spendRefreshed },
    );

    results.spendRefresh = { customersWithActivity: activeIds.length, spendRefreshed, syncStateWrite: spendWrite };
  } catch (err: any) {
    console.error('[cron] Spend refresh error:', err.message);
    results.spendRefresh = { error: err.message };
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

    const contactsWrite = await recordHeartbeat(
      supabase, 'netsuite_contacts', { contactsSynced, total: contactRows.length, phonesFound },
    );

    results.contacts = { modified: contactRows.length, contactsSynced, phonesFound, syncStateWrite: contactsWrite };
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

  // ═══════════ 3b. VENDOR PO SYNC ═══════════
  // BMG's purchase orders to parts vendors (Ranger, Masterack, Legend, ...)
  // land in netsuite_vendor_pos so the upfit parts-readiness check can see
  // what's on order per part number.
  try {
    results.vendorPos = await syncVendorPos(supabase);
  } catch (err: any) {
    console.error('[cron] Vendor PO sync error:', err.message);
    results.vendorPos = { error: err.message };
  }

  // ═══════════ 3c. INVENTORY QUANTITY SWEEP ═══════════
  // Item quantities move without bumping lastmodifieddate, so the parts
  // catalog snapshot (and everything reading on-hand/available from it)
  // gets a light quantities-only refresh here.
  try {
    results.inventory = await syncInventoryQuantities(supabase);
  } catch (err: any) {
    console.error('[cron] Inventory sweep error:', err.message);
    results.inventory = { error: err.message };
  }

  // ═══════════ 3d. VENDOR BILL PAYMENT SWEEP ═══════════
  // CNI vendor invoices waiting at "billed" get flipped to "paid" once
  // NetSuite shows their vendor bill Paid In Full — with the submitter and
  // finance notified — so the AP queue tracks reality without a manual
  // "Mark Paid" for bills settled inside NetSuite.
  try {
    results.vendorBills = await syncVendorBillPayments(supabase);
  } catch (err: any) {
    console.error('[cron] Vendor bill payment sweep error:', err.message);
    results.vendorBills = { error: err.message };
  }

  // ═══════════ 4. INVOICED-QUANTITY CHECK ═══════════
  // Compare every PO's ordered quantities against its linked invoices' line
  // quantities and flag mismatches, so billing problems surface on the PO
  // page without anyone clicking "Check Billing".
  try {
    const check = await verifyPoInvoiceQuantities(supabase);
    results.invoiceCheck = {
      posChecked: check.posChecked,
      flagged: check.flagged,
      cleared: check.cleared,
      noInvoices: check.noInvoices,
      noInvoicesFulfilled: check.noInvoicesFulfilled,
    };
  } catch (err: any) {
    console.error('[cron] Invoice quantity check error:', err.message);
    results.invoiceCheck = { error: err.message };
  }

  return NextResponse.json({ status: 'ok', ...results });
}
