import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import OAuth from 'oauth-1.0a';
import CryptoJS from 'crypto-js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  let contactsSynced = 0;
  let contactsTotal = 0;
  let contactsSkipped = 0;
  let contactErrors = 0;
  let firstRestError: string | null = null;
  let firstRestStatus: number | null = null;
  let customersProcessed = 0;

  try {
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

    // Get offset from query params for pagination across syncs
    const url = new URL(req.url);
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const batchSize = 20; // Keep small — each customer needs 1+ extra API calls for contact details

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

    const allCustomerIds = Object.keys(nsToProspect);
    const customerIds = allCustomerIds.slice(offset, offset + batchSize);
    console.log(`[contact-sync] Processing customers ${offset}-${offset + customerIds.length} of ${allCustomerIds.length}`);

    for (const custId of customerIds) {
      customersProcessed++;
      try {
        const reqUrl = `${restBaseUrl}/customer/${custId}?expandSubResources=true`;
        const authData = restOAuth.authorize({ url: reqUrl, method: 'GET' }, restToken);
        const authHeader = restOAuth.toHeader(authData).Authorization;

        const res = await fetch(reqUrl, {
          headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        });

        if (!res.ok) {
          contactErrors++;
          if (contactErrors <= 3) {
            const body = await res.text().catch(() => '(could not read body)');
            if (!firstRestError) { firstRestError = body.substring(0, 300); firstRestStatus = res.status; }
          }
          continue;
        }
        const data = await res.json();

        const contacts = data.contactRoles?.items || data.contactList?.items || data.contacts?.items || [];
        const prospectId = nsToProspect[custId];
        if (!prospectId || contacts.length === 0) {
          contactsSkipped++;
          continue;
        }

        contactsTotal += contacts.length;

        for (const c of contacts) {
          const name = c.contactName || c.contact?.refName || c.name || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown';
          if (name === 'Unknown') continue;

          let email = c.email || null;
          let phone = c.phone || null;
          const title = c.role?.refName || c.title || c.jobTitle || null;

          // If no email/phone, fetch the full contact record
          const contactId = c.contact?.id || c.contactId || c.id;
          if ((!email || !phone) && contactId) {
            try {
              const contactUrl = `${restBaseUrl}/contact/${contactId}`;
              const cAuthData = restOAuth.authorize({ url: contactUrl, method: 'GET' }, restToken);
              const cAuthHeader = restOAuth.toHeader(cAuthData).Authorization;
              const cRes = await fetch(contactUrl, {
                headers: { 'Authorization': cAuthHeader, 'Content-Type': 'application/json' },
              });
              if (cRes.ok) {
                const cData = await cRes.json();
                if (!email) email = cData.email || null;
                if (!phone) phone = cData.phone || cData.mobilePhone || cData.homePhone || null;
              }
            } catch { /* skip if contact fetch fails */ }
          }

          const { error: cErr } = await supabase.from('prospect_contacts').upsert({
            prospect_id: prospectId,
            name,
            title,
            email: email || null,
            phone: phone || null,
          }, { onConflict: 'prospect_id,name' });
          if (!cErr) contactsSynced++;
          else contactErrors++;
        }
      } catch (fetchErr: any) {
        contactErrors++;
      }
    }

    const hasMore = offset + batchSize < allCustomerIds.length;
    const nextOffset = hasMore ? offset + batchSize : null;

    return NextResponse.json({
      contactsSynced,
      contactsTotal,
      contactsSkipped,
      contactErrors,
      customersProcessed,
      totalCustomers: allCustomerIds.length,
      offset,
      nextOffset,
      hasMore,
      ...(firstRestError ? { restApiError: { status: firstRestStatus, body: firstRestError } } : {}),
    });
  } catch (err: any) {
    console.error('[contact-sync] Error:', err.message);
    return NextResponse.json({ error: err.message || 'Contact sync failed' }, { status: 500 });
  }
}
