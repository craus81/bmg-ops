import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

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
  memo?: string;
  lineItems: { itemId: string; quantity: number; rate: number; description?: string }[];
  taxExempt: boolean;
}) {
  // Dynamic import for oauth
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

  // Build line items
  const items = payload.lineItems.map((li) => ({
    item: { id: li.itemId },
    quantity: li.quantity,
    rate: li.rate,
    ...(li.description ? { description: li.description } : {}),
  }));

  const body: any = {
    entity: { id: payload.customerId },
    item: { items },
  };

  if (payload.memo) {
    body.memo = payload.memo;
  }

  // If tax exempt, set the isTaxable flag or tax override
  // NetSuite handles tax exemption at the customer or transaction level
  // We'll let the NS tax engine handle it based on the customer's tax status

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
      const { suiteqlQuery } = await import('@/lib/netsuite');
      const lookup = await suiteqlQuery(`SELECT tranid FROM transaction WHERE id = ${estimateId}`);
      estimateNumber = lookup?.items?.[0]?.tranid || '';
    } catch {
      // Non-critical
    }
  }

  return { success: true, estimateId, estimateNumber };
}

// POST — push estimate to NetSuite
export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabase();
    const { estimateId, userId } = await req.json();

    if (!estimateId) {
      return NextResponse.json({ error: 'Missing estimateId' }, { status: 400 });
    }

    // Load estimate
    const { data: estimate, error: estErr } = await supabase
      .from('estimates')
      .select('*')
      .eq('id', estimateId)
      .single();

    if (estErr || !estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    }

    if (estimate.netsuite_estimate_id) {
      return NextResponse.json({ error: 'Estimate already pushed to NetSuite' }, { status: 400 });
    }

    if (!estimate.customer_netsuite_id) {
      return NextResponse.json({ error: 'No NetSuite customer linked to this estimate' }, { status: 400 });
    }

    // Load line items
    const { data: lines } = await supabase
      .from('estimate_line_items')
      .select('*')
      .eq('estimate_id', estimateId)
      .order('sort_order');

    if (!lines || lines.length === 0) {
      return NextResponse.json({ error: 'No line items on this estimate' }, { status: 400 });
    }

    // Build NS line items — only items with netsuite_item_id can be pushed
    // Custom lines without NS item ID will use a generic "Other Charge" item or be skipped
    const nsLineItems: { itemId: string; quantity: number; rate: number; description?: string }[] = [];

    for (const line of lines) {
      if (line.netsuite_item_id) {
        nsLineItems.push({
          itemId: line.netsuite_item_id,
          quantity: line.quantity,
          rate: line.unit_price,
          description: line.description || undefined,
        });
      } else if (line.is_custom) {
        // For custom lines, we'll add them as a description line
        // They need a generic NS item — skip for now if no NS item
        // The user can map these in NetSuite after push
        console.warn(`Skipping custom line without NS item ID: ${line.item_number}`);
      }
    }

    // Add labor as a line item if there are labor hours
    const effectiveLaborHours = estimate.labor_hours_override ?? estimate.labor_hours;
    if (effectiveLaborHours > 0 && estimate.labor_rate > 0) {
      // Look for a "Labor" item in NetSuite
      try {
        const { suiteqlQuery } = await import('@/lib/netsuite');
        const laborLookup = await suiteqlQuery(`
          SELECT i.id, i.itemid FROM item i
          WHERE UPPER(i.itemid) LIKE '%LABOR%'
          AND i.isinactive = 'F'
          FETCH FIRST 1 ROWS ONLY
        `);
        const laborItem = laborLookup?.items?.[0];
        if (laborItem) {
          nsLineItems.push({
            itemId: laborItem.id.toString(),
            quantity: effectiveLaborHours,
            rate: estimate.labor_rate,
            description: `Labor (${effectiveLaborHours} hrs @ $${estimate.labor_rate}/hr)`,
          });
        }
      } catch {
        console.warn('Could not find Labor item in NetSuite');
      }
    }

    if (nsLineItems.length === 0) {
      return NextResponse.json({ error: 'No pushable line items (all items need NetSuite IDs)' }, { status: 400 });
    }

    const config = getNetSuiteConfig();
    const result = await createNetSuiteEstimate(config, {
      customerId: estimate.customer_netsuite_id,
      memo: [estimate.title, estimate.notes].filter(Boolean).join(' — '),
      lineItems: nsLineItems,
      taxExempt: estimate.tax_exempt,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Update local estimate with NS data
    await supabase
      .from('estimates')
      .update({
        netsuite_estimate_id: result.estimateId,
        netsuite_estimate_number: result.estimateNumber,
        status: 'pushed',
        pushed_at: new Date().toISOString(),
        pushed_by: userId || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', estimateId);

    return NextResponse.json({
      success: true,
      netsuite_estimate_id: result.estimateId,
      netsuite_estimate_number: result.estimateNumber,
    });
  } catch (err: any) {
    console.error('Push estimate error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
