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
  let customersProcessed = 0;
  let firstRestError: string | null = null;
  let firstRestStatus: number | null = null;

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

    const url = new URL(req.url);
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const batchSize = parseInt(url.searchParams.get('limit') || '50');

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
            const body = await res.text().catch(() => '');
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
          let name = c.contactName || c.contact?.refName || c.name || 'Unknown';
          if (name === 'Unknown') continue;
          // Strip leading entity ID prefix (e.g. "161056 Brett Byrd" -> "Brett Byrd")
          name = name.replace(/^\d+\s+/, '');

          const { error: cErr } = await supabase.from('prospect_contacts').upsert({
            prospect_id: prospectId,
            name,
            title: c.role?.refName || c.title || null,
            email: c.email || null,
          }, { onConflict: 'prospect_id,name' });
          if (!cErr) contactsSynced++;
          else contactErrors++;
        }
      } catch {
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
