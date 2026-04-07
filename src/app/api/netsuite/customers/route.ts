import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
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
    let firstError: string | null = null;
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
    }

    return NextResponse.json({
      status: 'synced',
      total: nsCustomers.length,
      synced,
      ...(firstError ? { firstError, sampleErrors: errors } : {}),
    });
  } catch (err: any) {
    console.error('NetSuite customer sync error:', err);
    return NextResponse.json({ error: err.message || 'Failed to sync customers' }, { status: 500 });
  }
}
