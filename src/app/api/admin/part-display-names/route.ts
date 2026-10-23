import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { updateItemFields } from '@/lib/netsuite';
import { logAudit } from '@/lib/audit';
import { proposeDisplayName, isRealNetsuiteId, DisplayNamePart } from '@/lib/part-display-names';

// Each part is one RESTlet round-trip, so the page sends small batches.
export const maxDuration = 60;

const COLS = 'id, netsuite_id, item_number, display_name, description, graphic_package';

// The before/after list: every active part whose display name would change.
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const supabase = createServiceClient();
  const { data, error } = await fetchAllRows<DisplayNamePart>((from, to) =>
    supabase
      .from('netsuite_parts')
      .select(COLS)
      .eq('is_active', true)
      .order('item_number')
      .order('id')
      .range(from, to),
  );
  if (error) return NextResponse.json({ error: `Could not read the parts catalog: ${error.message}` }, { status: 500 });

  const proposals = data.map(proposeDisplayName).filter((p): p is NonNullable<typeof p> => !!p);
  return NextResponse.json({ totalParts: data.length, proposals });
}

const Schema = z.object({ ids: z.array(z.string().min(1)).min(1).max(10) });

// Apply a batch. Each part is re-read and re-checked against the rule, so a
// name someone edited since the list loaded is left alone. Real NetSuite
// parts are written to NetSuite first — the parts sync copies NetSuite's
// displayname back, so a FleetSuite-only change would revert — and the local
// row only changes once NetSuite confirms it wrote displayname.
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const supabase = createServiceClient();
  const { data: rows, error } = await supabase.from('netsuite_parts').select(COLS).in('id', parsed.data.ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: { id: string; ok: boolean; skipped?: boolean; error?: string }[] = [];
  for (const id of parsed.data.ids) {
    const part = (rows || []).find((r: any) => r.id === id) as DisplayNamePart | undefined;
    const proposal = part ? proposeDisplayName(part) : null;
    if (!part || !proposal) {
      results.push({ id, ok: true, skipped: true });
      continue;
    }

    const toNetsuite = isRealNetsuiteId(part.netsuite_id);
    if (toNetsuite) {
      const res = await updateItemFields(part.netsuite_id!, { displayName: proposal.proposed });
      if (!res.success || !(res.fieldsSet || []).includes('displayname')) {
        results.push({
          id, ok: false,
          error: res.success
            ? 'NetSuite did not apply the display name. The item RESTlet may need to be re-deployed.'
            : `NetSuite refused it: ${res.error}`,
        });
        continue;
      }
    }

    const { error: upErr } = await supabase
      .from('netsuite_parts')
      .update({ display_name: proposal.proposed, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (upErr) {
      results.push({
        id, ok: false,
        error: toNetsuite
          ? `Saved in NetSuite but not in FleetSuite (${upErr.message}). The next parts sync will bring it over.`
          : upErr.message,
      });
      continue;
    }

    await logAudit(supabase, {
      actorId: auth.user.id,
      table: 'netsuite_parts',
      recordId: id,
      action: 'update',
      detail: {
        item_number: part.item_number,
        before: { display_name: part.display_name },
        after: { display_name: proposal.proposed },
        source: `display-name fill from ${proposal.source}`,
        syncedToNetsuite: toNetsuite,
      },
    });
    results.push({ id, ok: true });
  }

  return NextResponse.json({ results });
}
