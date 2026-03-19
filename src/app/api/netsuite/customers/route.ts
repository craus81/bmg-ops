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
    const query = `
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

    const result = await suiteqlQuery(query);
    const nsCustomers = result?.items || [];

    // Upsert into our local customers table
    let synced = 0;
    let firstError: string | null = null;
    const errors: string[] = [];

    for (const nsc of nsCustomers) {
      const { error } = await supabase
        .from('customers')
        .upsert({
          netsuite_id: nsc.id?.toString(),
          company_name: nsc.companyname || nsc.entityid || 'Unknown',
          entity_id: nsc.entityid || '',
          email: nsc.email || null,
          phone: nsc.phone || null,
          address: nsc.defaultbillingaddress || null,
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
