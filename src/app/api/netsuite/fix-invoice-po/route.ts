import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';
import OAuth from 'oauth-1.0a';
import CryptoJS from 'crypto-js';
import { validateBody, z } from '@/lib/validate';

const Schema = z.object({ dryRun: z.boolean().optional() });

function getConfig() {
  return {
    accountId: process.env.NETSUITE_ACCOUNT_ID!,
    consumerKey: process.env.NETSUITE_CONSUMER_KEY!,
    consumerSecret: process.env.NETSUITE_CONSUMER_SECRET!,
    tokenId: process.env.NETSUITE_TOKEN_ID!,
    tokenSecret: process.env.NETSUITE_TOKEN_SECRET!,
  };
}

function patchInvoice(invoiceId: string, fields: Record<string, any>) {
  const config = getConfig();
  const formatted = config.accountId.toLowerCase().replace(/_/g, '-');
  const url = `https://${formatted}.suitetalk.api.netsuite.com/services/rest/record/v1/invoice/${invoiceId}`;

  const oauth = new OAuth({
    consumer: { key: config.consumerKey, secret: config.consumerSecret },
    signature_method: 'HMAC-SHA256',
    hash_function(baseString: string, key: string) {
      return CryptoJS.HmacSHA256(baseString, key).toString(CryptoJS.enc.Base64);
    },
    realm: config.accountId,
  });
  const token = { key: config.tokenId, secret: config.tokenSecret };
  const authData = oauth.authorize({ url, method: 'PATCH' }, token);
  const authHeader = oauth.toHeader(authData).Authorization;

  return fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Prefer': 'respondAsync=false',
    },
    body: JSON.stringify(fields),
  });
}

/**
 * POST /api/netsuite/fix-invoice-po
 * One-time fix: finds FleetSuite-created invoices with PO info in the memo,
 * moves the PO number to otherrefnum, and sets memo to "BMG FleetSuite Invoice".
 *
 * Body: { dryRun?: boolean }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const dryRun = parsed.data.dryRun ?? false;

  try {

    const query = `
      SELECT t.id, t.tranid, t.memo, t.otherrefnum
      FROM transaction t
      WHERE t.type = 'CustInvc'
        AND t.memo LIKE '%BMG FleetSuite%'
        AND t.memo LIKE '%PO #%'
    `;

    const result = await suiteqlQuery(query);
    const invoices = result?.items || [];

    if (invoices.length === 0) {
      return NextResponse.json({ message: 'No invoices found to fix', count: 0 });
    }

    const results: { id: string; tranid: string; po: string; status: string; error?: string }[] = [];

    for (const inv of invoices) {
      const memo: string = inv.memo || '';
      const poMatch = memo.match(/PO #([^\s—·,]+)/);
      const poNumber = poMatch ? poMatch[1] : null;

      if (!poNumber) {
        results.push({ id: inv.id, tranid: inv.tranid, po: '', status: 'skipped', error: 'Could not parse PO number from memo' });
        continue;
      }

      if (dryRun) {
        results.push({ id: inv.id, tranid: inv.tranid, po: poNumber, status: 'dry_run' });
        continue;
      }

      try {
        const response = await patchInvoice(inv.id.toString(), {
          memo: 'BMG FleetSuite Invoice',
          otherrefnum: poNumber,
        });

        if (response.ok) {
          results.push({ id: inv.id, tranid: inv.tranid, po: poNumber, status: 'fixed' });
        } else {
          const text = await response.text();
          results.push({ id: inv.id, tranid: inv.tranid, po: poNumber, status: 'error', error: `${response.status}: ${text}` });
        }
      } catch (e: any) {
        results.push({ id: inv.id, tranid: inv.tranid, po: poNumber, status: 'error', error: e.message });
      }
    }

    const fixed = results.filter(r => r.status === 'fixed').length;
    const errors = results.filter(r => r.status === 'error').length;

    return NextResponse.json({
      message: dryRun ? `Dry run: found ${invoices.length} invoices to fix` : `Fixed ${fixed} of ${invoices.length} invoices`,
      count: invoices.length,
      fixed,
      errors,
      results,
    });
  } catch (err: any) {
    console.error('Fix invoice PO error:', err);
    return NextResponse.json({ error: err.message || 'Failed to fix invoices' }, { status: 500 });
  }
}
