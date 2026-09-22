import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { callAnthropicWithRetry } from '@/lib/anthropic';
import {
  DRAFT_SYSTEM, DRAFT_MODEL, parseDraftReply, matchRequest, summarize,
  type CatalogPart, type DraftLine,
} from '@/lib/paste-to-estimate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({ text: z.string().trim().min(10).max(20_000) });

/** More than this and it is a catalog import, not an RFQ — and the per-line
 *  catalog lookups would run past the route's time budget. */
const MAX_LINES = 40;

const PART_FIELDS =
  'id, netsuite_id, item_number, display_name, description, sales_price, labor_hours, catalog, purchase_price, avg_install_cost';

/** The words worth searching on — the same shape the builder's own part
 *  search uses, minus the filler. */
function searchTerms(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(t => t.length > 2)
    .slice(0, 4);
}

/**
 * POST /api/estimates/draft-from-text — read an RFQ and return a REVIEW GRID
 * of candidate estimate lines (R6-9).
 *
 * Writes nothing. The rep accepts lines in the builder, which is the only
 * place an estimate line is ever created — a drafter that could quietly
 * append priced lines to a live document is a drafter that can quote a
 * number nobody chose.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      error: 'Drafting from text needs ANTHROPIC_API_KEY, which is not configured on this deployment.',
    }, { status: 503 });
  }

  try {
    const response = await callAnthropicWithRetry({
      model: DRAFT_MODEL,
      max_tokens: 2000,
      system: DRAFT_SYSTEM,
      messages: [{ role: 'user', content: parsed.data.text }],
    }, apiKey);
    if (!response.ok) {
      return NextResponse.json({ error: 'The drafting service did not respond. Nothing was changed.' }, { status: 502 });
    }
    const result = await response.json();
    const text: string = (result.content || []).find((b: any) => b.type === 'text')?.text || '';
    const extraction = parseDraftReply(text);
    // An unreadable reply is NOT an empty RFQ. Saying "nothing was requested"
    // when we simply could not read the answer would send a rep away
    // believing the email asked for nothing.
    if (!extraction) {
      return NextResponse.json({ error: 'The reply could not be read. Try again, or add the lines by hand.' }, { status: 502 });
    }

    const requests = extraction.lines.slice(0, MAX_LINES);
    const lines: DraftLine[] = [];
    for (const request of requests) {
      // Candidates for THIS request only: a stated part number searches on
      // the number, everything else on the request's own words.
      const terms = request.itemNumber ? [request.itemNumber] : searchTerms(request.description);
      let candidates: CatalogPart[] = [];
      if (terms.length > 0) {
        const filters = terms.flatMap(t => [
          `item_number.ilike.%${t}%`,
          `display_name.ilike.%${t}%`,
          `description.ilike.%${t}%`,
        ]);
        const { data } = await service
          .from('netsuite_parts')
          .select(PART_FIELDS)
          .eq('is_active', true)
          .or(filters.join(','))
          .limit(12);
        candidates = (data as CatalogPart[]) || [];
      }
      lines.push(matchRequest(request, candidates));
    }

    return NextResponse.json({
      vehicleCount: extraction.vehicleCount,
      lines,
      summary: summarize(lines),
      // Said out loud rather than silently dropped: a 60-line RFQ would
      // otherwise come back looking complete at 40.
      truncated: extraction.lines.length > requests.length
        ? { found: extraction.lines.length, shown: requests.length }
        : null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not draft from that text' }, { status: 500 });
  }
}
