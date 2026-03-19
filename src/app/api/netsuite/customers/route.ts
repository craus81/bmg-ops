import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { createClient } from '@supabase/supabase-js';

export async function GET(req: NextRequest) {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Fetch customers from NetSuite via SuiteQL
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
      FETCH FIRST 500 ROWS ONLY
    `;

    const result = await suiteqlQuery(customerQuery);
    const nsCustomers = result?.items || [];

    // Fetch order/spend data per customer
    const spendQuery = `
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

    let spendMap: Record<string, { order_count: number; total_spend: number; last_order_date: string | null }> = {};
    try {
      const spendResult = await suiteqlQuery(spendQuery);
      for (const row of (spendResult?.items || [])) {
        spendMap[row.customer_id?.toString()] = {
          order_count: parseInt(row.order_count) || 0,
          total_spend: parseFloat(row.total_spend) || 0,
          last_order_date: row.last_order_date || null,
        };
      }
    } catch (spendErr: any) {
      console.warn('Could not fetch spend data:', spendErr.message);
      // Continue without spend data — not critical
    }

    // Upsert into our local customers table
    let synced = 0;
    let firstError: string | null = null;
    const errors: string[] = [];

    for (const nsc of nsCustomers) {
      const nsId = nsc.id?.toString();
      const spend = spendMap[nsId] || { order_count: 0, total_spend: 0, last_order_date: null };
      const avgOrder = spend.order_count > 0 ? spend.total_spend / spend.order_count : 0;

      const { error } = await supabase
        .from('customers')
        .upsert({
          netsuite_id: nsId,
          company_name: nsc.companyname || nsc.entityid || 'Unknown',
          entity_id: nsc.entityid || '',
          email: nsc.email || null,
          phone: nsc.phone || null,
          address: nsc.defaultbillingaddress || null,
          total_orders: spend.order_count,
          total_spend: spend.total_spend,
          avg_order_value: Math.round(avgOrder * 100) / 100,
          last_order_date: spend.last_order_date || null,
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
