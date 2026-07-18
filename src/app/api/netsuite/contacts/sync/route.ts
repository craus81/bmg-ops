import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { suiteqlQueryAll } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/netsuite/contacts/sync
 *
 * Bulk-syncs ALL contacts from NetSuite using SuiteQL (fast, single query).
 * Pulls name, email, phone, title, and company association in one pass
 * instead of making individual REST calls per contact.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  let contactsSynced = 0;
  let contactsTotal = 0;
  let contactsSkipped = 0;
  let contactErrors = 0;
  let phonesFound = 0;

  try {
    // Step 1: Build prospect map (netsuite_id -> prospect_id)
    let allProspectRows: any[] = [];
    let pPage = 0;
    let pHasMore = true;
    while (pHasMore) {
      const { data: batch } = await supabase
        .from('prospects')
        .select('id, netsuite_id')
        .not('netsuite_id', 'is', null)
        .range(pPage * 1000, (pPage + 1) * 1000 - 1);
      allProspectRows = [...allProspectRows, ...(batch || [])];
      pHasMore = (batch || []).length === 1000;
      pPage++;
    }
    const nsToProspect: Record<string, string> = {};
    allProspectRows.forEach((p: any) => {
      if (p.netsuite_id) nsToProspect[p.netsuite_id] = p.id;
    });

    const totalCustomers = Object.keys(nsToProspect).length;
    if (totalCustomers === 0) {
      return NextResponse.json({ error: 'No prospects with NetSuite IDs found' }, { status: 400 });
    }

    // Step 2: Bulk-fetch ALL contacts with their company links from NetSuite via SuiteQL
    // This replaces hundreds of individual REST API calls with a single bulk query
    const contactRows = await suiteqlQueryAll(`
      SELECT
        c.id AS contact_id,
        c.entityid AS entity_name,
        c.firstname,
        c.lastname,
        c.email,
        c.phone,
        c.mobilephone,
        c.homephone,
        c.officephone,
        c.title,
        c.company AS customer_id
      FROM contact c
      WHERE c.company IS NOT NULL
      ORDER BY c.company, c.entityid
    `);

    // Step 2b: Also fetch customer-level phone numbers as fallback
    // Many contacts don't have individual phones, but the customer record does
    const customerPhoneRows = await suiteqlQueryAll(`
      SELECT
        cu.id AS customer_id,
        cu.phone AS company_phone
      FROM customer cu
      WHERE cu.phone IS NOT NULL
    `);
    const customerPhones: Record<string, string> = {};
    customerPhoneRows.forEach((r: any) => {
      if (r.customer_id && r.company_phone) {
        customerPhones[r.customer_id.toString()] = r.company_phone;
      }
    });

    contactsTotal = contactRows.length;

    // Step 3: Upsert contacts into prospect_contacts, matching by customer_id
    for (const row of contactRows) {
      const custId = row.customer_id?.toString();
      if (!custId || !nsToProspect[custId]) {
        contactsSkipped++;
        continue;
      }

      const prospectId = nsToProspect[custId];

      // Build name from available fields
      let name = '';
      if (row.firstname && row.lastname) {
        name = `${row.firstname} ${row.lastname}`;
      } else if (row.entity_name) {
        name = row.entity_name;
      } else {
        contactsSkipped++;
        continue;
      }
      // Strip leading entity ID numbers (e.g. "123 John Smith" -> "John Smith")
      name = name.replace(/^\d+\s+/, '').trim();
      if (!name || name === 'Unknown') {
        contactsSkipped++;
        continue;
      }

      // Pick the best phone number available — fall back to company phone if contact has none
      const contactPhone = row.phone || row.mobilephone || row.officephone || row.homephone || null;
      const phone = contactPhone || customerPhones[custId] || null;
      if (phone) phonesFound++;

      const { error: upsertErr } = await supabase.from('prospect_contacts').upsert({
        prospect_id: prospectId,
        name,
        title: row.title || null,
        email: row.email || null,
        phone,
      }, { onConflict: 'prospect_id,name' });

      if (!upsertErr) {
        contactsSynced++;
      } else {
        contactErrors++;
      }
    }

    return NextResponse.json({
      contactsSynced,
      contactsTotal,
      contactsSkipped,
      contactErrors,
      phonesFound,
      totalCustomers,
    });
  } catch (err: any) {
    console.error('[contact-sync] Error:', err.message);
    return NextResponse.json({ error: err.message || 'Contact sync failed' }, { status: 500 });
  }
}
