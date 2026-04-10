import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;

    // Fetch ALL active customers from NetSuite via paginated SuiteQL
    const customerQuery = `
      SELECT
        c.id,
        c.companyname,
        c.entityid,
        c.email,
        c.phone,
        c.defaultbillingaddress,
        c.isinactive
      FROM customer c
      WHERE c.isinactive = 'F'
      ORDER BY c.companyname
    `;

    const nsCustomers = await suiteqlQueryAll(customerQuery);

    // Fetch all-time spend data per customer
    const allTimeQuery = `
      SELECT
        t.entity AS customer_id,
        COUNT(t.id) AS order_count,
        SUM(t.foreigntotal) AS total_spend,
        MAX(t.trandate) AS last_order_date
      FROM transaction t
      WHERE t.type = 'SalesOrd'
        AND t.entity IS NOT NULL
      GROUP BY t.entity
    `;

    // Fetch YTD spend
    const ytdQuery = `
      SELECT
        t.entity AS customer_id,
        COUNT(t.id) AS order_count,
        SUM(t.foreigntotal) AS total_spend
      FROM transaction t
      WHERE t.type = 'SalesOrd'
        AND t.entity IS NOT NULL
        AND EXTRACT(YEAR FROM t.trandate) = ${currentYear}
      GROUP BY t.entity
    `;

    // Fetch last year spend
    const lastYearQuery = `
      SELECT
        t.entity AS customer_id,
        COUNT(t.id) AS order_count,
        SUM(t.foreigntotal) AS total_spend
      FROM transaction t
      WHERE t.type = 'SalesOrd'
        AND t.entity IS NOT NULL
        AND EXTRACT(YEAR FROM t.trandate) = ${lastYear}
      GROUP BY t.entity
    `;

    type SpendRow = { customer_id: string; order_count: number; total_spend: number; last_order_date?: string | null };
    const allTimeMap: Record<string, SpendRow> = {};
    const ytdMap: Record<string, SpendRow> = {};
    const lastYearMap: Record<string, SpendRow> = {};

    try {
      const [allTimeItems, ytdItems, lastYearItems] = await Promise.all([
        suiteqlQueryAll(allTimeQuery),
        suiteqlQueryAll(ytdQuery),
        suiteqlQueryAll(lastYearQuery),
      ]);

      for (const row of allTimeItems) {
        allTimeMap[row.customer_id?.toString()] = {
          customer_id: row.customer_id?.toString(),
          order_count: parseInt(row.order_count) || 0,
          total_spend: parseFloat(row.total_spend) || 0,
          last_order_date: row.last_order_date || null,
        };
      }
      for (const row of ytdItems) {
        ytdMap[row.customer_id?.toString()] = {
          customer_id: row.customer_id?.toString(),
          order_count: parseInt(row.order_count) || 0,
          total_spend: parseFloat(row.total_spend) || 0,
        };
      }
      for (const row of lastYearItems) {
        lastYearMap[row.customer_id?.toString()] = {
          customer_id: row.customer_id?.toString(),
          order_count: parseInt(row.order_count) || 0,
          total_spend: parseFloat(row.total_spend) || 0,
        };
      }
    } catch (spendErr: any) {
      console.warn('Could not fetch spend data:', spendErr.message);
    }

    // Build NetSuite base URL for customer links
    const nsAccountId = (process.env.NETSUITE_ACCOUNT_ID || '').toLowerCase().replace(/_/g, '-');
    const nsBaseUrl = `https://${nsAccountId}.app.netsuite.com`;

    // Upsert into our local customers table
    let synced = 0;
    let prospectsSynced = 0;
    let firstError: string | null = null;
    let firstProspectError: string | null = null;
    const errors: string[] = [];

    for (const nsc of nsCustomers) {
      const nsId = nsc.id?.toString();
      const allTime = allTimeMap[nsId] || { order_count: 0, total_spend: 0, last_order_date: null };
      const ytd = ytdMap[nsId] || { order_count: 0, total_spend: 0 };
      const ly = lastYearMap[nsId] || { order_count: 0, total_spend: 0 };
      const avgOrder = allTime.order_count > 0 ? allTime.total_spend / allTime.order_count : 0;

      const { error } = await supabase
        .from('customers')
        .upsert({
          netsuite_id: nsId,
          netsuite_url: nsAccountId ? `${nsBaseUrl}/app/common/entity/custjob.nl?id=${nsId}` : null,
          company_name: nsc.companyname || nsc.entityid || 'Unknown',
          entity_id: nsc.entityid || '',
          email: nsc.email || null,
          phone: nsc.phone || null,
          address: nsc.defaultbillingaddress || null,
          total_orders: allTime.order_count,
          total_spend: allTime.total_spend,
          avg_order_value: Math.round(avgOrder * 100) / 100,
          ytd_spend: ytd.total_spend,
          ytd_orders: ytd.order_count,
          last_year_spend: ly.total_spend,
          last_year_orders: ly.order_count,
          last_order_date: allTime.last_order_date || null,
          active: true,
        }, { onConflict: 'netsuite_id' });

      if (error) {
        if (!firstError) firstError = `${error.code}: ${error.message} (hint: ${error.hint || 'none'})`;
        if (errors.length < 3) errors.push(`${nsc.companyname}: ${error.message}`);
      } else {
        synced++;
      }

      // Also upsert into prospects table for unified CRM view
      const { error: prospectErr } = await supabase.from('prospects').upsert({
        netsuite_id: nsId,
        netsuite_url: nsAccountId ? `${nsBaseUrl}/app/common/entity/custjob.nl?id=${nsId}` : null,
        netsuite_type: 'customer',
        company_name: nsc.companyname || nsc.entityid || 'Unknown',
        email: nsc.email || null,
        phone: nsc.phone || null,
        address: nsc.defaultbillingaddress || null,
        status: 'converted',
        source: 'netsuite',
        pushed_at: new Date().toISOString(),
      }, { onConflict: 'netsuite_id', ignoreDuplicates: false });
      if (prospectErr) {
        if (!firstProspectError) firstProspectError = `${prospectErr.code}: ${prospectErr.message} (hint: ${prospectErr.hint || 'none'})`;
        if (prospectsSynced === 0) console.error('[customer-sync] Prospect upsert failed:', prospectErr.message, prospectErr.details, prospectErr.hint, prospectErr.code);
      } else {
        prospectsSynced++;
      }
    }

    // Sync contacts from NetSuite into prospect_contacts
    let contactsSynced = 0;
    let contactsTotal = 0;
    let contactsSkipped = 0;
    let contactErrors = 0;
    let firstContactError: string | null = null;
    try {
      // Try multiple approaches to find contacts
      let nsContacts: any[] = [];

      const contactQueries = [
        // Approach 1: Contact record type (most common)
        `SELECT c.id, c.firstname, c.lastname, c.email, c.phone, c.title, c.company AS customer_id FROM Contact c WHERE c.isinactive = 'F' AND c.company IS NOT NULL`,
        // Approach 2: Via N_CONTACT
        `SELECT c.id, c.firstname, c.lastname, c.email, c.phone, c.title, c.company AS customer_id FROM N_CONTACT c WHERE c.isinactive = 'F' AND c.company IS NOT NULL`,
        // Approach 3: Via contactList on customer (subquery)
        `SELECT cl.contact AS contact_id, cl.company AS customer_id, cl.contactname, cl.email, cl.phone, cl.contactrole FROM customerbookcontact cl`,
        // Approach 4: REST-style entity query
        `SELECT e.id, e.firstname, e.lastname, e.email, e.phone, e.title, e.company AS customer_id FROM entityindex e WHERE e.type = 'Contact' AND e.isinactive = 'F'`,
      ];

      for (const q of contactQueries) {
        try {
          const result = await suiteqlQueryAll(q);
          if (result && result.length > 0) {
            nsContacts = result;
            console.log(`[customer-sync] Contact query succeeded with ${result.length} results`);
            break;
          }
          console.log(`[customer-sync] Contact query returned 0 results`);
        } catch (err: any) {
          const errMsg = err.message?.substring(0, 150) || 'unknown';
          console.log(`[customer-sync] Contact query failed: ${errMsg}`);
        }
      }
      contactsTotal = nsContacts.length;
      console.log(`[customer-sync] Found ${nsContacts.length} contacts from NetSuite`);

      // Build a map of netsuite customer id → prospect id (paginate past 1000 limit)
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
      console.log(`[customer-sync] Prospect map has ${Object.keys(nsToProspect).length} entries`);

      for (const nc of nsContacts) {
        const custId = (nc.customer_id || nc.company)?.toString();
        const prospectId = nsToProspect[custId];
        if (!prospectId) { contactsSkipped++; continue; }
        const name = nc.contactname || [nc.firstname, nc.lastname].filter(Boolean).join(' ') || nc.entityid || 'Unknown';
        if (!name || name === 'Unknown') { contactsSkipped++; continue; }
        const { data: inserted, error: cErr } = await supabase.from('prospect_contacts').upsert({
          prospect_id: prospectId,
          name,
          title: nc.title || null,
          email: nc.email || null,
          phone: nc.phone || null,
        }, { onConflict: 'prospect_id,name' }).select('id');
        if (cErr) {
          contactErrors++;
          if (!firstContactError) firstContactError = `${cErr.code}: ${cErr.message}`;
        } else if (inserted && inserted.length > 0) {
          contactsSynced++;
        }
      }
    } catch (err: any) {
      console.error('[customer-sync] Contact sync error:', err.message, err.stack);
      firstContactError = firstContactError || `Exception: ${err.message}`;
    }

    return NextResponse.json({
      status: 'synced',
      total: nsCustomers.length,
      synced,
      prospectsSynced,
      contactsSynced,
      contactsTotal,
      contactsSkipped,
      contactErrors,
      ...(firstContactError ? { firstContactError } : {}),
      ...(firstError ? { firstError, sampleErrors: errors } : {}),
      ...(firstProspectError ? { firstProspectError } : {}),
    });
  } catch (err: any) {
    console.error('NetSuite customer sync error:', err);
    return NextResponse.json({ error: err.message || 'Failed to sync customers' }, { status: 500 });
  }
}
