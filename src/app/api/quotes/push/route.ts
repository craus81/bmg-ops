import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { safeIntId } from '@/lib/sql-safe';

export const dynamic = 'force-dynamic';

const PushQuoteSchema = z.object({
  quoteId: z.string().uuid(),
  customerId: z.string().optional().nullable(),
  customerNsId: z.string().regex(/^\d{1,15}$/, 'customerNsId must be a NetSuite numeric id'),
  userId: z.string().uuid().optional().nullable(),
});

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function getNetSuiteConfig() {
  const accountId = process.env.NETSUITE_ACCOUNT_ID;
  const consumerKey = process.env.NETSUITE_CONSUMER_KEY;
  const consumerSecret = process.env.NETSUITE_CONSUMER_SECRET;
  const tokenId = process.env.NETSUITE_TOKEN_ID;
  const tokenSecret = process.env.NETSUITE_TOKEN_SECRET;
  if (!accountId || !consumerKey || !consumerSecret || !tokenId || !tokenSecret) {
    throw new Error('Missing NetSuite environment variables');
  }
  return { accountId, consumerKey, consumerSecret, tokenId, tokenSecret };
}

async function createNetSuiteEstimate(config: ReturnType<typeof getNetSuiteConfig>, payload: {
  customerId: string;
  memo: string;
  lineItems: { description: string; quantity: number; rate: number }[];
}) {
  const OAuth = (await import('oauth-1.0a')).default;
  const CryptoJS = (await import('crypto-js')).default;

  const oauth = new OAuth({
    consumer: { key: config.consumerKey, secret: config.consumerSecret },
    signature_method: 'HMAC-SHA256',
    hash_function(baseString: string, key: string) {
      return CryptoJS.HmacSHA256(baseString, key).toString(CryptoJS.enc.Base64);
    },
    realm: config.accountId,
  });
  const token = { key: config.tokenId, secret: config.tokenSecret };

  const formatted = config.accountId.toLowerCase().replace(/_/g, '-');
  const url = `https://${formatted}.suitetalk.api.netsuite.com/services/rest/record/v1/estimate`;

  const authData = oauth.authorize({ url, method: 'POST' }, token);
  const authHeader = oauth.toHeader(authData).Authorization;

  // For graphics quotes we may not have specific NS item IDs — we need a generic
  // "Graphics Services" or "Other Charge" item. Look it up first.
  let graphicsItemId: string | null = null;
  try {
    const { suiteqlQuery } = await import('@/lib/netsuite');
    const lookup = await suiteqlQuery(`
      SELECT i.id, i.itemid FROM item i
      WHERE (
        UPPER(i.itemid) LIKE '%GRAPHIC%'
        OR UPPER(i.itemid) LIKE '%VINYL%'
        OR UPPER(i.itemid) LIKE '%WRAP%'
        OR UPPER(i.itemid) LIKE '%DECAL%'
      )
      AND i.isinactive = 'F'
      FETCH FIRST 1 ROWS ONLY
    `);
    graphicsItemId = lookup?.items?.[0]?.id?.toString() || null;
  } catch {
    console.warn('Could not look up graphics item in NetSuite');
  }

  // If no graphics item found, try a generic "Other Charge" item
  if (!graphicsItemId) {
    try {
      const { suiteqlQuery } = await import('@/lib/netsuite');
      const lookup = await suiteqlQuery(`
        SELECT i.id, i.itemid FROM item i
        WHERE i.itemtype = 'OthCharge'
        AND i.isinactive = 'F'
        FETCH FIRST 1 ROWS ONLY
      `);
      graphicsItemId = lookup?.items?.[0]?.id?.toString() || null;
    } catch {
      console.warn('Could not look up OtherCharge item in NetSuite');
    }
  }

  if (!graphicsItemId) {
    return { success: false, error: 'No suitable NetSuite item found for graphics line items. Please create a Graphics/Vinyl/Wrap service item in NetSuite first.' };
  }

  // Build line items using the found item
  const items = payload.lineItems.map((li) => ({
    item: { id: graphicsItemId },
    quantity: li.quantity,
    rate: li.rate,
    description: li.description,
  }));

  const body: any = {
    entity: { id: payload.customerId },
    memo: payload.memo,
    item: { items },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Prefer': 'respondAsync=false',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, error: `NetSuite error (${response.status}): ${text}` };
  }

  const location = response.headers.get('Location');
  let estimateId = '';
  if (location) {
    const match = location.match(/\/(\d+)$/);
    estimateId = match?.[1] || '';
  }

  let estimateNumber = '';
  try {
    const result = await response.json();
    estimateId = estimateId || result.id?.toString() || '';
    estimateNumber = result.tranId || result.tranid || '';
  } catch {
    // 204 No Content
  }

  // Look up the estimate number if we didn't get it
  if (estimateId && !estimateNumber) {
    try {
      const safeId = safeIntId(estimateId, 'estimateId');
      const { suiteqlQuery } = await import('@/lib/netsuite');
      const lookup = await suiteqlQuery(`SELECT tranid FROM transaction WHERE id = ${safeId}`);
      estimateNumber = lookup?.items?.[0]?.tranid || '';
    } catch {
      // Non-critical
    }
  }

  return { success: true, estimateId, estimateNumber };
}

// POST — push a graphics quote to NetSuite as an Estimate
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PushQuoteSchema);
  if (parsed.error) return parsed.error;
  const { quoteId, customerId, customerNsId, userId } = parsed.data;

  try {
    const supabase = getSupabase();

    // Load quote
    const { data: quote, error: qErr } = await supabase
      .from('quotes')
      .select('*')
      .eq('id', quoteId)
      .single();

    if (qErr || !quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
    }

    if (quote.netsuite_estimate_id) {
      return NextResponse.json({ error: 'Quote already pushed to NetSuite' }, { status: 400 });
    }

    // Build line items from the quote
    const lineItems: { description: string; quantity: number; rate: number }[] = [];
    const vehicleQty = quote.vehicle_qty || 1;

    // Material line
    if (quote.material_total > 0) {
      lineItems.push({
        description: `Graphics Material — ${quote.total_vinyl_sqft?.toFixed(1)} sq ft @ $${quote.material_cost_per_sqft}/sqft (${quote.vehicle_description || 'Vehicle'})`,
        quantity: vehicleQty,
        rate: quote.material_total,
      });
    }

    // Labor line
    if (quote.labor_total > 0) {
      lineItems.push({
        description: `Graphics Labor — ${quote.total_vinyl_sqft?.toFixed(1)} sq ft @ $${quote.labor_cost_per_sqft}/sqft`,
        quantity: vehicleQty,
        rate: quote.labor_total,
      });
    }

    // If both are zero, push the total_price as a single line
    if (lineItems.length === 0 && quote.total_price > 0) {
      lineItems.push({
        description: `Graphics Package — ${quote.vehicle_description || 'Vehicle'}`,
        quantity: vehicleQty,
        rate: quote.total_price / vehicleQty,
      });
    }

    if (lineItems.length === 0) {
      return NextResponse.json({ error: 'No line items to push (quote total is $0)' }, { status: 400 });
    }

    const config = getNetSuiteConfig();
    const memo = [
      `FleetSuite Quote ${quote.quote_number}`,
      quote.customer_name,
      quote.vehicle_description,
      `${quote.coverage_percentage?.toFixed(0)}% coverage`,
      `Markup: ${quote.markup_percentage}%`,
    ].filter(Boolean).join(' — ');

    const result = await createNetSuiteEstimate(config, {
      customerId: customerNsId,
      memo,
      lineItems,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Update quote with NS tracking data
    await supabase
      .from('quotes')
      .update({
        customer_id: customerId || null,
        customer_netsuite_id: customerNsId,
        netsuite_estimate_id: result.estimateId,
        netsuite_estimate_number: result.estimateNumber,
        pushed_at: new Date().toISOString(),
        pushed_by: userId || null,
        status: 'sent',
        updated_at: new Date().toISOString(),
      })
      .eq('id', quoteId);

    return NextResponse.json({
      success: true,
      netsuite_estimate_id: result.estimateId,
      netsuite_estimate_number: result.estimateNumber,
    });
  } catch (err: any) {
    console.error('Push quote error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
