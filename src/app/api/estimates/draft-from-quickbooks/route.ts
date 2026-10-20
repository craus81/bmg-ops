import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { profileCanSeeMoney, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { getHistoryDetail } from '@/lib/ledger/history';
import { looseItemRegex, summarize, type CatalogPart, type DraftLine } from '@/lib/paste-to-estimate';
import { matchQuickbooksLine, quickbooksDraftRequests } from '@/lib/quickbooks-estimate-copy';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Schema = z.object({ recordId: z.string().uuid() });

/** A build longer than this is added by hand past the cut, and says so. */
const MAX_LINES = 80;
/** Catalog lookups in flight at once. */
const CONCURRENCY = 6;

const PART_FIELDS =
  'id, netsuite_id, item_number, display_name, description, sales_price, labor_hours, catalog, purchase_price, avg_install_cost';

/**
 * POST /api/estimates/draft-from-quickbooks — turn a QuickBooks record from
 * before the cutover into the builder's review grid (src/lib/quickbooks-
 * estimate-copy.ts). Same response shape as draft-from-text, plus `source`.
 *
 * Writes nothing: lines reach an estimate only when the rep accepts them in
 * the builder. Estimates feature, and the money wall on top, because the
 * grid carries the old document's prices.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) {
    return NextResponse.json({ error: 'Forbidden: this account cannot see billing' }, { status: 403 });
  }

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const service = createServiceClient();
  try {
    const detail = await getHistoryDetail(service, parsed.data.recordId);
    if (!detail) return NextResponse.json({ error: 'QuickBooks record not found' }, { status: 404 });

    const all = quickbooksDraftRequests(detail);
    const requests = all.slice(0, MAX_LINES);
    const lines: DraftLine[] = new Array(requests.length);
    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const i = next++;
        if (i >= requests.length) return;
        const q = requests[i];
        // Catalog numbers equal to the item name once punctuation is
        // ignored; the matcher decides exact vs suggestion. Inactive parts
        // are left out, so they come back as no match.
        const re = looseItemRegex(q.qboItem);
        let candidates: CatalogPart[] = [];
        if (re) {
          const { data } = await service
            .from('netsuite_parts')
            .select(PART_FIELDS)
            .eq('is_active', true)
            .filter('item_number', 'imatch', re)
            .limit(15);
          candidates = (data as CatalogPart[]) || [];
        }
        lines[i] = matchQuickbooksLine(q, candidates);
      }
    }));

    return NextResponse.json({
      vehicleCount: null,
      lines,
      summary: summarize(lines),
      truncated: all.length > requests.length ? { found: all.length, shown: requests.length } : null,
      source: {
        id: detail.id,
        number: detail.number,
        typeLabel: detail.typeLabel,
        date: detail.date,
        customerId: detail.customerId,
        customerName: detail.customerName,
      },
    });
  } catch (e: any) {
    console.error('draft-from-quickbooks failed:', e);
    return NextResponse.json({ error: e?.message || 'Could not copy that QuickBooks record' }, { status: 500 });
  }
}
