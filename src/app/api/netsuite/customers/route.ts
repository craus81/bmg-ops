import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';

// Import OAuth helpers for REST Record API
import OAuth from 'oauth-1.0a';
import CryptoJS from 'crypto-js';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
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
        c.parent,
        c.isinactive
      FROM customer c
      WHERE c.isinactive = 'F'
      ORDER BY c.companyname
    `;

    const nsCustomers = await suiteqlQueryAll(customerQuery);

    // Fetch billing addresses separately
    const addressMap: Record<string, string> = {};
    try {
      const addrQuery = `
        SELECT
          ca.entity AS customer_id,
          ea.addr1,
          ea.addr2,
          ea.city,
          ea.state,
          ea.zip,
          ea.country
        FROM customerAddressbook ca
        JOIN entityAddress ea ON ea.nkey = ca.addressbookaddress
        WHERE ca.defaultbilling = 'T'
      `;
      const addrRows = await suiteqlQueryAll(addrQuery);
      for (const row of addrRows) {
        const custId = row.customer_id?.toString();
        if (custId) {
          const parts = [row.addr1, row.addr2, row.city, row.state, row.zip].filter(Boolean);
          addressMap[custId] = parts.join(', ');
        }
      }
      console.log(`[customer-sync] Loaded ${Object.keys(addressMap).length} billing addresses`);
    } catch (addrErr: any) {
      console.warn('[customer-sync] Address query failed, trying fallback:', addrErr.message?.substring(0, 200));
      // Fallback: try BUILTIN.DF on defaultbillingaddress
      try {
        const addrFallback = await suiteqlQueryAll(`SELECT c.id, BUILTIN.DF(c.defaultbillingaddress) AS addr FROM customer c WHERE c.isinactive = 'F' AND c.defaultbillingaddress IS NOT NULL`);
        for (const row of addrFallback) {
          const custId = row.id?.toString();
          if (custId && row.addr && !/^\d+$/.test(row.addr)) {
            addressMap[custId] = row.addr;
          }
        }
        console.log(`[customer-sync] Fallback loaded ${Object.keys(addressMap).length} addresses`);
      } catch (fbErr: any) {
        console.warn('[customer-sync] Address fallback also failed:', fbErr.message?.substring(0, 200));
      }
    }

    // Fetch all-time billed revenue per customer.
    //
    // We sum CustInvc + CashSale (actual money billed) rather than SalesOrd
    // (a sales order is just a promise to bill). Direct-invoice flows —
    // e.g. the graphics-only invoice path from migration 082, or any
    // customer whose work was billed without a parent SO — were invisible
    // when this query only counted SalesOrd, which is why Air Dynamics
    // (and others) showed $0 spend despite having real invoices on file.
    // CustCred (credit memos) are intentionally excluded for now; refine
    // later if we want net-of-credits revenue.
    const allTimeQuery = `
      SELECT
        t.entity AS customer_id,
        COUNT(t.id) AS order_count,
        SUM(t.foreigntotal) AS total_spend,
        MAX(t.trandate) AS last_order_date
      FROM transaction t
      WHERE t.type IN ('CustInvc', 'CashSale')
        AND t.entity IS NOT NULL
      GROUP BY t.entity
    `;

    // Fetch YTD billed revenue
    const ytdQuery = `
      SELECT
        t.entity AS customer_id,
        COUNT(t.id) AS order_count,
        SUM(t.foreigntotal) AS total_spend
      FROM transaction t
      WHERE t.type IN ('CustInvc', 'CashSale')
        AND t.entity IS NOT NULL
        AND EXTRACT(YEAR FROM t.trandate) = ${currentYear}
      GROUP BY t.entity
    `;

    // Fetch last year billed revenue
    const lastYearQuery = `
      SELECT
        t.entity AS customer_id,
        COUNT(t.id) AS order_count,
        SUM(t.foreigntotal) AS total_spend
      FROM transaction t
      WHERE t.type IN ('CustInvc', 'CashSale')
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
          address: addressMap[nsId] || null,
          // NS hierarchy only — the manual parent link (migration 186) is
          // FleetSuite-owned and stays out of this SET list. NetSuite
          // reports a customer as its own parent when it has none.
          netsuite_parent_id: nsc.parent && nsc.parent.toString() !== nsId ? nsc.parent.toString() : null,
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
        address: addressMap[nsId] || null,
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
    let firstRestError: string | null = null;
    let firstRestStatus: number | null = null;
    try {
      // Fetch contacts via REST Record API (contact sublists not available in SuiteQL)
      const rawAccountId = process.env.NETSUITE_ACCOUNT_ID || '';
      const accountId = rawAccountId.toLowerCase().replace(/_/g, '-');
      const restBaseUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/record/v1`;

      const restOAuth = new OAuth({
        consumer: { key: process.env.NETSUITE_CONSUMER_KEY!, secret: process.env.NETSUITE_CONSUMER_SECRET! },
        signature_method: 'HMAC-SHA256',
        hash_function(baseString: string, key: string) {
          return CryptoJS.HmacSHA256(baseString, key).toString(CryptoJS.enc.Base64);
        },
        realm: rawAccountId,
      });
      const restToken = { key: process.env.NETSUITE_TOKEN_ID!, secret: process.env.NETSUITE_TOKEN_SECRET! };

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

      // Process first 20 customers — each needs extra API calls for contact phone/email
      const customerIds = Object.keys(nsToProspect).slice(0, 20);
      console.log(`[customer-sync] Fetching contacts for ${customerIds.length} customers via REST API`);

      let firstSuccessKeys: string[] | null = null;

      for (const custId of customerIds) {
        try {
          const url = `${restBaseUrl}/customer/${custId}?expandSubResources=true`;
          const authData = restOAuth.authorize({ url, method: 'GET' }, restToken);
          const authHeader = restOAuth.toHeader(authData).Authorization;

          // Log first request details for debugging
          if (contactErrors === 0 && contactsSynced === 0 && contactsTotal === 0) {
            console.log(`[customer-sync] First REST request: GET ${url}`);
            console.log(`[customer-sync] Auth header prefix: ${authHeader.substring(0, 80)}...`);
          }

          const res = await fetch(url, {
            headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
          });

          if (!res.ok) {
            contactErrors++;
            // Log first 3 failures with full detail
            if (contactErrors <= 3) {
              const body = await res.text().catch(() => '(could not read body)');
              console.error(`[customer-sync] REST error for customer ${custId}: HTTP ${res.status} ${res.statusText}`);
              console.error(`[customer-sync] Response body: ${body.substring(0, 500)}`);
              if (!firstRestError) { firstRestError = body.substring(0, 300); firstRestStatus = res.status; }
            }
            continue;
          }
          const data = await res.json();

          // Log first success to see available keys
          if (!firstSuccessKeys) {
            firstSuccessKeys = Object.keys(data);
            console.log(`[customer-sync] First success keys for customer ${custId}: ${firstSuccessKeys.join(', ')}`);
            const contactKeys = firstSuccessKeys.filter(k => k.toLowerCase().includes('contact') || k.toLowerCase().includes('role'));
            console.log(`[customer-sync] Contact-related keys: ${contactKeys.join(', ') || 'none'}`);
          }

          // Try multiple possible sublist names
          const contacts = data.contactRoles?.items || data.contactList?.items || data.contacts?.items || [];
          const prospectId = nsToProspect[custId];
          if (!prospectId || contacts.length === 0) {
            contactsSkipped++;
            continue;
          }

          contactsTotal += contacts.length;

          for (const c of contacts) {
            let name = c.contactName || c.contact?.refName || c.name || 'Unknown';
            if (name === 'Unknown') continue;
            name = name.replace(/^\d+\s+/, '');

            const { error: cErr } = await supabase.from('prospect_contacts').upsert({
              prospect_id: prospectId,
              name,
              title: c.role?.refName || c.title || null,
              email: c.email || null,
              phone: null, // Phone requires separate SuiteQL sync via Contacts tab
            }, { onConflict: 'prospect_id,name' });
            if (!cErr) contactsSynced++;
            else contactErrors++;
          }
        } catch (fetchErr: any) {
          contactErrors++;
          if (contactErrors <= 3) {
            console.error(`[customer-sync] REST fetch exception for customer ${custId}: ${fetchErr.message}`);
          }
        }
      }

      console.log(`[customer-sync] Contacts: ${contactsSynced} synced, ${contactsTotal} total, ${contactErrors} errors`);
    } catch (err: any) {
      console.error('[customer-sync] Contact sync error:', err.message);
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
      ...(firstRestError ? { restApiError: { status: firstRestStatus, body: firstRestError } } : {}),
      ...(firstContactError ? { firstContactError } : {}),
      ...(firstError ? { firstError, sampleErrors: errors } : {}),
      ...(firstProspectError ? { firstProspectError } : {}),
    });
  } catch (err: any) {
    console.error('NetSuite customer sync error:', err);
    return NextResponse.json({ error: err.message || 'Failed to sync customers' }, { status: 500 });
  }
}
