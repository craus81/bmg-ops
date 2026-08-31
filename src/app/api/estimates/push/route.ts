import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { estimateContextMemo } from '@/lib/estimate-document';
import { resolveLaborItem } from '@/lib/labor-item';
import { resolveOrPromoteByName } from '@/lib/promote-prospect';

export const dynamic = 'force-dynamic';

const PushEstimateSchema = z.object({
  estimateId: z.string().uuid(),
  userId: z.string().uuid().optional().nullable(),
});

const DeleteEstimateSchema = z.object({
  estimateId: z.string().uuid(),
});

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * Resolve the NetSuite item id for the FS-CUSTOM placeholder used to land
 * line items that have no matched NetSuite item. Mirrors the same fallback
 * in api/estimates/convert-to-so/route.ts — an estimate line with no item id
 * would otherwise be silently dropped, since NetSuite estimate lines require
 * a real item and have no free-text line type.
 */
async function findCustomItemId(): Promise<string | null> {
  try {
    const { suiteqlQuery } = await import('@/lib/netsuite');
    const res = await suiteqlQuery(
      "SELECT i.id FROM item i WHERE UPPER(i.itemid) = 'FS-CUSTOM' FETCH FIRST 1 ROWS ONLY"
    );
    const id = res?.items?.[0]?.id;
    return id ? id.toString() : null;
  } catch {
    return null;
  }
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

async function getOAuthHelpers(config: ReturnType<typeof getNetSuiteConfig>) {
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
  const baseUrl = `https://${formatted}.suitetalk.api.netsuite.com/services/rest/record/v1/estimate`;

  return { oauth, token, baseUrl };
}

async function createNetSuiteEstimate(config: ReturnType<typeof getNetSuiteConfig>, payload: {
  customerId: string;
  memo?: string;
  lineItems: { itemId: string; quantity: number; rate: number; description?: string }[];
  taxExempt: boolean;
  vin?: string | null;
  /** Customer's PO → the estimate's PO/Reference field (otherRefNum). */
  poNumber?: string | null;
  /** YYYY-MM-DD → NetSuite's "Expires" field (dueDate on estimates). */
  expirationDate?: string | null;
}) {
  const { oauth, token, baseUrl: url } = await getOAuthHelpers(config);

  const authData = oauth.authorize({ url, method: 'POST' }, token);
  const authHeader = oauth.toHeader(authData).Authorization;

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

  // K5: the VIN lives on the estimate now — carry it into NetSuite's custom
  // body field so it survives NS's own estimate→SO→invoice transforms.
  if (payload.vin) {
    body.custbody_vin_number_ = payload.vin;
  }

  // Only sent when filled, so estimates without these keep the proven
  // payload shape exactly as before.
  if (payload.poNumber?.trim()) {
    body.otherRefNum = payload.poNumber.trim();
  }
  if (payload.expirationDate) {
    body.dueDate = payload.expirationDate;
  }

  // Only sent for exempt estimates so the common path's payload is
  // unchanged: NetSuite otherwise taxed exempt estimates because the flag
  // was accepted here and never written into the request.
  if (payload.taxExempt) {
    body.istaxable = false;
  }

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

// ── Update an existing NetSuite estimate via PATCH ──
async function updateNetSuiteEstimate(config: ReturnType<typeof getNetSuiteConfig>, nsEstimateId: string, payload: {
  customerId: string;
  memo?: string;
  lineItems: { itemId: string; quantity: number; rate: number; description?: string }[];
  taxExempt: boolean;
  vin?: string | null;
  poNumber?: string | null;
  expirationDate?: string | null;
}) {
  const { oauth, token, baseUrl } = await getOAuthHelpers(config);
  // ?replace=item tells NetSuite to replace the entire item sublist instead of
  // merging — without it, PATCH appends new lines and leaves old ones in place.
  const url = `${baseUrl}/${nsEstimateId}?replace=item`;

  const authData = oauth.authorize({ url, method: 'PATCH' }, token);
  const authHeader = oauth.toHeader(authData).Authorization;

  const items = payload.lineItems.map((li) => ({
    item: { id: li.itemId },
    quantity: li.quantity,
    rate: li.rate,
    ...(li.description ? { description: li.description } : {}),
  }));

  const body: any = {
    entity: { id: payload.customerId },
    item: { items },
    // Always sent on PATCH (null clears) so removing the VIN locally also
    // removes it from the NetSuite copy on the next re-push.
    custbody_vin_number_: payload.vin || null,
  };

  if (payload.memo) {
    body.memo = payload.memo;
  }

  // Like the VIN above: sent whenever set, so a re-push refreshes them.
  // (Only included when filled — clearing them locally doesn't clear NS,
  // which keeps the payload unchanged for estimates that never had them.)
  if (payload.poNumber?.trim()) {
    body.otherRefNum = payload.poNumber.trim();
  }
  if (payload.expirationDate) {
    body.dueDate = payload.expirationDate;
  }

  if (payload.taxExempt) {
    body.istaxable = false;
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Prefer': 'respondAsync=false',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, error: `NetSuite PATCH error (${response.status}): ${text}` };
  }

  return { success: true };
}

// ── Delete a NetSuite estimate ──
async function deleteNetSuiteEstimate(config: ReturnType<typeof getNetSuiteConfig>, nsEstimateId: string) {
  const { oauth, token, baseUrl } = await getOAuthHelpers(config);
  const url = `${baseUrl}/${nsEstimateId}`;

  const authData = oauth.authorize({ url, method: 'DELETE' }, token);
  const authHeader = oauth.toHeader(authData).Authorization;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, error: `NetSuite DELETE error (${response.status}): ${text}` };
  }

  return { success: true };
}

// POST — push estimate to NetSuite
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PushEstimateSchema);
  if (parsed.error) return parsed.error;
  const { estimateId, userId } = parsed.data;

  // Pushing/syncing records NetSuite state, not sales state — an estimate
  // that is 'sent' (in the follow-up queue) or 'accepted' must keep that
  // stage when its NetSuite copy is created or refreshed. Mirrors the guard
  // in POST /api/estimates; 'pushed' only replaces 'draft'.
  const SALES_STAGES = ['sent', 'accepted', 'rejected'];

  try {
    const supabase = getSupabase();

    // Load estimate
    const { data: estimate, error: estErr } = await supabase
      .from('estimates')
      .select('*, vehicle_platforms(label)')
      .eq('id', estimateId)
      .single();

    if (estErr || !estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    }
    // Flatten the platform label for the memo's vehicle line.
    (estimate as any).vehicle_platform_label = (estimate as any).vehicle_platforms?.label || null;

    const isUpdate = !!estimate.netsuite_estimate_id;

    if (!estimate.customer_netsuite_id) {
      // Lead tier: an estimate built for a CRM lead carries a name and no
      // NetSuite id. Pushing to NetSuite is the promotion moment — resolve
      // the name to an existing NetSuite customer, or promote the matching
      // lead. Stamp the estimate so later pushes/converts skip this.
      const resolved = await resolveOrPromoteByName(supabase, estimate.customer_name || '', userId || null);
      if (!resolved) {
        return NextResponse.json({
          error: 'No NetSuite customer linked to this estimate, and no CRM lead matches the customer name. Promote the record from its CRM page, or pick a NetSuite customer.',
        }, { status: 400 });
      }
      estimate.customer_netsuite_id = resolved.netsuiteId;
      await supabase.from('estimates')
        .update({ customer_netsuite_id: resolved.netsuiteId })
        .eq('id', estimateId);
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

    // Build NS line items. NetSuite estimate lines require a real item id —
    // there is no free-text line type — so any line without netsuite_item_id
    // is routed through the FS-CUSTOM placeholder item (same fallback as
    // convert-to-so) rather than being silently dropped. If FS-CUSTOM isn't
    // set up in NetSuite yet, the line is reported back as unmapped instead
    // of vanishing without a trace.
    const nsLineItems: { itemId: string; quantity: number; rate: number; description?: string }[] = [];
    const customLineDescriptions: string[] = [];
    const unmappedLineDescriptions: string[] = [];
    let customItemId: string | null = null;

    for (const line of lines) {
      // A qty-0 line totals to $0 on the customer's document — never send
      // it to NetSuite, where it previously landed as one unit at full
      // rate (Round 3 finding).
      if ((parseFloat(line.quantity) || 0) <= 0) continue;
      if (line.netsuite_item_id) {
        nsLineItems.push({
          itemId: line.netsuite_item_id,
          quantity: line.quantity,
          rate: line.unit_price,
          description: line.description || undefined,
        });
        continue;
      }

      if (customItemId === null) customItemId = await findCustomItemId();
      const label = line.item_number
        ? `${line.item_number}${line.description ? ' — ' + line.description : ''}`
        : (line.description || 'Custom item');
      if (!customItemId) {
        unmappedLineDescriptions.push(label);
        continue;
      }
      nsLineItems.push({
        itemId: customItemId,
        quantity: line.quantity,
        rate: line.unit_price,
        description: line.notes ? `${label} (${line.notes})` : label,
      });
      customLineDescriptions.push(label);
    }

    // Add labor as a line item if there are labor hours. When no labor item
    // can be resolved the NetSuite copy is short by the entire labor amount,
    // so this is REPORTED (laborSkipped) rather than console.warn'd — the
    // silent version shipped estimates missing their labor line.
    const effectiveLaborHours = parseFloat(String(estimate.labor_hours_override ?? estimate.labor_hours)) || 0;
    const laborRate = parseFloat(String(estimate.labor_rate)) || 0;
    let laborSkipped = false;
    let laborItemNumber: string | null = null;
    if (effectiveLaborHours > 0 && laborRate > 0) {
      // One shared resolver with convert-to-so — the two routes used
      // different LIKE patterns with no ORDER BY, so the same job's labor
      // could bill to different NetSuite items (Round 1 finding, closed in
      // Round 3).
      const { item: laborItem } = await resolveLaborItem(supabase);
      if (laborItem) {
        laborItemNumber = laborItem.itemNumber;
        nsLineItems.push({
          itemId: laborItem.id,
          quantity: effectiveLaborHours,
          rate: laborRate,
          description: `Labor (${effectiveLaborHours} hrs @ $${laborRate}/hr)`,
        });
      } else {
        laborSkipped = true;
        console.warn('Could not resolve a NetSuite labor item — labor not pushed');
      }
    }
    // Echoed on both responses so the builder can name the money that did
    // not make it (or the item it billed to).
    const laborReport = {
      laborSkipped: laborSkipped || undefined,
      laborHours: laborSkipped ? effectiveLaborHours : undefined,
      laborAmount: laborSkipped ? Math.round(effectiveLaborHours * laborRate * 100) / 100 : undefined,
      laborItem: laborItemNumber || undefined,
    };

    if (nsLineItems.length === 0) {
      return NextResponse.json({
        error: 'No pushable line items. Match every line to a NetSuite item, or create the FS-CUSTOM placeholder item in NetSuite.',
        unmappedItems: unmappedLineDescriptions,
      }, { status: 400 });
    }

    const config = getNetSuiteConfig();
    // Same rich memo as convert-to-so (title, notes, vehicle/install/
    // delivery/on-site/unit context) — the push used to send a thinner
    // memo that dropped the unit number and delivery details.
    const memo = estimateContextMemo(estimate);

    if (isUpdate) {
      // ── UPDATE existing NetSuite estimate via PATCH ──
      const updateResult = await updateNetSuiteEstimate(config, estimate.netsuite_estimate_id, {
        customerId: estimate.customer_netsuite_id,
        memo,
        lineItems: nsLineItems,
        taxExempt: estimate.tax_exempt,
        vin: estimate.vin,
        poNumber: estimate.po_number,
        expirationDate: estimate.expiration_date,
      });

      if (!updateResult.success) {
        return NextResponse.json({ error: updateResult.error }, { status: 500 });
      }

      await supabase
        .from('estimates')
        .update({
          status: SALES_STAGES.includes(estimate.status) ? estimate.status : 'pushed',
          updated_at: new Date().toISOString(),
          pushed_at: new Date().toISOString(),
          pushed_by: auth.user.id,
        })
        .eq('id', estimateId);

      return NextResponse.json({
        success: true,
        updated: true,
        ...laborReport,
        netsuite_estimate_id: estimate.netsuite_estimate_id,
        netsuite_estimate_number: estimate.netsuite_estimate_number,
        customLines: customLineDescriptions.length > 0 ? customLineDescriptions : undefined,
        unmappedItems: unmappedLineDescriptions.length > 0 ? unmappedLineDescriptions : undefined,
      });
    }

    // ── CREATE new NetSuite estimate ──
    const result = await createNetSuiteEstimate(config, {
      customerId: estimate.customer_netsuite_id,
      memo,
      lineItems: nsLineItems,
      taxExempt: estimate.tax_exempt,
      vin: estimate.vin,
      poNumber: estimate.po_number,
      expirationDate: estimate.expiration_date,
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
        status: SALES_STAGES.includes(estimate.status) ? estimate.status : 'pushed',
        pushed_at: new Date().toISOString(),
        pushed_by: auth.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', estimateId);

    return NextResponse.json({
      success: true,
      ...laborReport,
      netsuite_estimate_id: result.estimateId,
      netsuite_estimate_number: result.estimateNumber,
      customLines: customLineDescriptions.length > 0 ? customLineDescriptions : undefined,
      unmappedItems: unmappedLineDescriptions.length > 0 ? unmappedLineDescriptions : undefined,
    });
  } catch (err: any) {
    console.error('Push estimate error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE — delete estimate from NetSuite
export async function DELETE(req: NextRequest) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DeleteEstimateSchema);
  if (parsed.error) return parsed.error;
  const { estimateId } = parsed.data;

  try {
    const supabase = getSupabase();

    const { data: estimate, error: estErr } = await supabase
      .from('estimates')
      .select('id, netsuite_estimate_id')
      .eq('id', estimateId)
      .single();

    if (estErr || !estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    }

    if (!estimate.netsuite_estimate_id) {
      return NextResponse.json({ error: 'Estimate has not been pushed to NetSuite' }, { status: 400 });
    }

    const config = getNetSuiteConfig();
    const result = await deleteNetSuiteEstimate(config, estimate.netsuite_estimate_id);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Clear NS fields from local record (don't delete the local estimate here — that's done by the main estimates API)
    await supabase
      .from('estimates')
      .update({
        netsuite_estimate_id: null,
        netsuite_estimate_number: null,
        status: 'draft',
        pushed_at: null,
        pushed_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', estimateId);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Delete NS estimate error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
