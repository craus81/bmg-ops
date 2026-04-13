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
  let phonesFound = 0;
  let firstRestError: string | null = null;
  let firstRestStatus: number | null = null;
  let timedOut = false;

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

    const startTime = Date.now();
    const timeLimit = 100_000; // Stop after 100s to leave buffer for response

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

    // Find prospects that already have contacts synced WITH phone numbers (skip on re-runs)
    // If a prospect's contacts all have null phones, re-process to fetch phone numbers
    const alreadySynced = new Set<string>();
    let sPage = 0;
    let sHasMore = true;
    const prospectContactPhones: Record<string, { total: number; withPhone: number }> = {};
    while (sHasMore) {
      const { data: batch } = await supabase.from('prospect_contacts').select('prospect_id, phone').range(sPage * 1000, (sPage + 1) * 1000 - 1);
      (batch || []).forEach((r: any) => {
        if (!prospectContactPhones[r.prospect_id]) {
          prospectContactPhones[r.prospect_id] = { total: 0, withPhone: 0 };
        }
        prospectContactPhones[r.prospect_id].total++;
        if (r.phone) prospectContactPhones[r.prospect_id].withPhone++;
      });
      sHasMore = (batch || []).length === 1000;
      sPage++;
    }
    // Only skip prospects where at least one contact has a phone number
    Object.entries(prospectContactPhones).forEach(([pid, counts]) => {
      if (counts.withPhone > 0) alreadySynced.add(pid);
    });

    const allCustomerIds = Object.keys(nsToProspect).filter(id => !alreadySynced.has(nsToProspect[id]));
    const totalCustomers = Object.keys(nsToProspect).length;
    const alreadyDone = totalCustomers - allCustomerIds.length;

    for (const custId of allCustomerIds) {
      // Check time limit
      if (Date.now() - startTime > timeLimit) {
        timedOut = true;
        break;
      }

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
          name = name.replace(/^\d+\s+/, '');

          let phone: string | null = null;
          const contactId = c.contact?.id || c.contactId;
          if (contactId && (Date.now() - startTime < timeLimit)) {
            try {
              const contactUrl = `${restBaseUrl}/contact/${contactId}`;
              const cAuth = restOAuth.authorize({ url: contactUrl, method: 'GET' }, restToken);
              const cHeader = restOAuth.toHeader(cAuth).Authorization;
              const cRes = await fetch(contactUrl, {
                headers: { 'Authorization': cHeader, 'Content-Type': 'application/json' },
              });
              if (cRes.ok) {
                const cData = await cRes.json();
                phone = cData.phone || cData.mobilePhone || cData.homePhone || cData.officePhone || null;
                if (phone) phonesFound++;
              }
            } catch { /* skip */ }
          }

          const { error: cErr } = await supabase.from('prospect_contacts').upsert({
            prospect_id: prospectId,
            name,
            title: c.role?.refName || c.title || null,
            email: c.email || null,
            phone,
          }, { onConflict: 'prospect_id,name' });
          if (!cErr) contactsSynced++;
          else contactErrors++;
        }
      } catch {
        contactErrors++;
      }
    }

    return NextResponse.json({
      contactsSynced,
      contactsTotal,
      contactsSkipped,
      contactErrors,
      phonesFound,
      customersProcessed,
      totalCustomers,
      alreadyDone,
      remaining: allCustomerIds.length - customersProcessed,
      timedOut,
      ...(firstRestError ? { restApiError: { status: firstRestStatus, body: firstRestError } } : {}),
    });
  } catch (err: any) {
    console.error('[contact-sync] Error:', err.message);
    return NextResponse.json({ error: err.message || 'Contact sync failed' }, { status: 500 });
  }
}
