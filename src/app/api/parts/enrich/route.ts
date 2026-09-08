import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';
import { callAnthropicWithRetry } from '@/lib/anthropic';
import { recordHeartbeat } from '@/lib/system-health';
import {
  vendorFromHistory, buildEnrichmentPrompt, parseEnrichmentReply,
  enrichmentCandidates, ENRICHMENT_SYSTEM,
  type EnrichPart, type CategoryOption, type EnrichmentProposal, type PurchaseLine,
} from '@/lib/catalog-enrichment';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SYNC_TYPE = 'part_enrichment';

const RunSchema = z.object({
  /** How many parts to send to the model. Kept small by default: each is
   *  its own request, and a pass nobody reviews is worse than no pass. */
  limit: z.number().int().min(1).max(100).optional().default(25),
  /** Vendor backfill only — deterministic, free, and covers the biggest
   *  single gap. The default pass runs it first either way. */
  vendorOnly: z.boolean().optional().default(false),
});

const DecideSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(['accept', 'reject']),
});

/** GET — the pending review queue, newest run first. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { data, error } = await supabase
    .from('part_enrichment_proposals')
    .select('*, part:netsuite_parts(id, item_number, display_name, description, catalog, image_path, product_url)')
    .eq('status', 'pending')
    .order('confidence')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: state } = await supabase
    .from('sync_state').select('last_synced_at, last_result')
    .eq('sync_type', SYNC_TYPE).maybeSingle();

  return NextResponse.json({
    success: true,
    proposals: data || [],
    lastRun: state ? { at: state.last_synced_at, result: state.last_result } : null,
    modelAvailable: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}

/**
 * POST — run an enrichment pass. Writes PROPOSALS only; the catalog is
 * untouched until somebody accepts one (see the migration-289 header for
 * why a model must not write product_category_id directly).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, RunSchema);
  if (parsed.error) return parsed.error;
  const { limit, vendorOnly } = parsed.data;

  const runId = crypto.randomUUID();
  const staged: Array<EnrichmentProposal & { partId: string; itemNumber: string }> = [];
  const problems: string[] = [];

  try {
    // ── Pass 1: vendor backfill from purchase history (deterministic) ────
    const missingVendor = await fetchAllRows<any>((from, to) => supabase
      .from('netsuite_parts')
      .select('id, item_number')
      .eq('is_active', true)
      .is('vendor', null)
      .order('item_number')
      .order('id')
      .range(from, to));
    if (missingVendor.error) throw new Error(`Could not read the catalog: ${missingVendor.error.message}`);

    if (missingVendor.data.length > 0) {
      // The PO mirror, joined in memory: lines carry no vendor, headers do.
      const pos = await fetchAllRows<any>((from, to) => supabase
        .from('netsuite_vendor_pos')
        .select('id, vendor_name, trandate')
        .order('id')
        .range(from, to));
      if (pos.error) throw new Error(`Could not read purchase orders: ${pos.error.message}`);
      const poById = new Map(pos.data.map((p: any) => [p.id as string, p]));

      const wanted = new Set(missingVendor.data.map(p => normalizeItemNumber(p.item_number)).filter(Boolean));
      const history = new Map<string, PurchaseLine[]>();
      const poLines = await fetchAllRows<any>((from, to) => supabase
        .from('netsuite_vendor_po_lines')
        .select('po_id, item_number')
        .order('id')
        .range(from, to));
      if (poLines.error) throw new Error(`Could not read purchase-order lines: ${poLines.error.message}`);
      for (const l of poLines.data) {
        const key = normalizeItemNumber(l.item_number);
        if (!key || !wanted.has(key)) continue;
        const po: any = poById.get(l.po_id);
        if (!po?.vendor_name) continue;
        const bucket = history.get(key) || [];
        bucket.push({ itemNumber: key, vendorName: po.vendor_name, date: po.trandate || null });
        history.set(key, bucket);
      }

      for (const part of missingVendor.data) {
        const key = normalizeItemNumber(part.item_number);
        const verdict = vendorFromHistory(history.get(key) || []);
        if (!verdict) continue;
        staged.push({
          partId: part.id, itemNumber: part.item_number,
          field: 'vendor', proposedValue: verdict.vendor, proposedLabel: verdict.vendor,
          currentValue: null, confidence: verdict.confidence,
          evidence: verdict.evidence, source: 'purchase_history',
        });
      }
    }

    // ── Pass 2: the model reads each part's own text ─────────────────────
    let modelParts = 0;
    let modelFailures = 0;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!vendorOnly && apiKey) {
      const { data: catRows } = await supabase
        .from('product_categories').select('id, name').order('sort_order');
      const categories: CategoryOption[] = (catRows || []).map((c: any) => ({ id: c.id, name: c.name }));

      const pool = await fetchAllRows<EnrichPart>((from, to) => supabase
        .from('netsuite_parts')
        .select('id, item_number, display_name, description, marketing_description, product_url, vendor, catalog, product_category_id, vehicle_type, graphic_package, image_path')
        .eq('is_active', true)
        .or('product_category_id.is.null,marketing_description.is.null')
        .order('item_number')
        .order('id')
        .range(from, to));
      if (pool.error) throw new Error(`Could not read the catalog: ${pool.error.message}`);

      // Skip parts that already have a live proposal — a re-run should
      // extend the queue, not re-ask the same question and burn tokens.
      const { data: openRows } = await supabase
        .from('part_enrichment_proposals')
        .select('part_id').eq('status', 'pending').limit(2000);
      const alreadyQueued = new Set((openRows || []).map((r: any) => r.part_id as string));

      const candidates = enrichmentCandidates(
        pool.data.filter(p => !alreadyQueued.has(p.id)),
        limit,
      );

      for (const part of candidates) {
        try {
          const response = await callAnthropicWithRetry({
            model: 'claude-opus-5',
            max_tokens: 700,
            system: ENRICHMENT_SYSTEM,
            messages: [{ role: 'user', content: buildEnrichmentPrompt(part, categories) }],
          }, apiKey);
          if (!response.ok) { modelFailures++; continue; }
          const result = await response.json();
          const text: string = (result.content || []).find((b: any) => b.type === 'text')?.text || '';
          const props = parseEnrichmentReply(text, part, categories);
          for (const p of props) staged.push({ ...p, partId: part.id, itemNumber: part.item_number });
          modelParts++;
        } catch (e: any) {
          // One part's failure never ends the pass: the rest still land.
          modelFailures++;
          if (problems.length < 5) problems.push(`${part.item_number}: ${e?.message || 'model call failed'}`);
        }
      }
    } else if (!vendorOnly && !apiKey) {
      problems.push('No ANTHROPIC_API_KEY is set, so only the vendor backfill ran.');
    }

    // ── Write the proposals ─────────────────────────────────────────────
    // NOT an upsert: the part+field unique index is PARTIAL (pending only),
    // and Postgres cannot infer ON CONFLICT from a partial index. So a
    // re-run reads its own open proposals, leaves an unchanged one alone,
    // and supersedes one whose answer moved — never stacking two live
    // opinions on the same gap.
    let written = 0;
    let unchanged = 0;
    if (staged.length > 0) {
      const partIds = [...new Set(staged.map(p => p.partId))];
      const openByKey = new Map<string, any>();
      for (let i = 0; i < partIds.length; i += 200) {
        const { data, error } = await supabase
          .from('part_enrichment_proposals')
          .select('id, part_id, field, proposed_value')
          .eq('status', 'pending')
          .in('part_id', partIds.slice(i, i + 200));
        if (error) throw new Error(`Could not read open proposals: ${error.message}`);
        for (const r of data || []) openByKey.set(`${r.part_id}::${r.field}`, r);
      }

      const supersede: string[] = [];
      const fresh: Record<string, unknown>[] = [];
      for (const p of staged) {
        const open = openByKey.get(`${p.partId}::${p.field}`);
        if (open) {
          if ((open.proposed_value ?? null) === (p.proposedValue ?? null)) { unchanged++; continue; }
          supersede.push(open.id);
        }
        fresh.push({
          part_id: p.partId,
          item_number: p.itemNumber,
          field: p.field,
          proposed_value: p.proposedValue,
          proposed_label: p.proposedLabel,
          current_value: p.currentValue,
          confidence: p.confidence,
          evidence: p.evidence,
          source: p.source,
          run_id: runId,
        });
      }

      // Retire the superseded rows FIRST — the partial unique index would
      // otherwise reject the replacement insert.
      for (let i = 0; i < supersede.length; i += 200) {
        const { error } = await supabase
          .from('part_enrichment_proposals')
          .update({ status: 'stale', decided_at: new Date().toISOString() })
          .in('id', supersede.slice(i, i + 200));
        if (error) throw new Error(`Could not retire superseded proposals: ${error.message}`);
      }

      for (let i = 0; i < fresh.length; i += 200) {
        const chunk = fresh.slice(i, i + 200);
        const { error } = await supabase.from('part_enrichment_proposals').insert(chunk);
        if (error) throw new Error(`Could not save proposals: ${error.message}`);
        written += chunk.length;
      }
    }

    const summary = {
      runId,
      proposals: written,
      vendorProposals: staged.filter(s => s.source === 'purchase_history').length,
      modelProposals: staged.filter(s => s.source === 'model').length,
      partsRead: modelParts,
      modelFailures,
      unchanged,
      problems,
    };
    await recordHeartbeat(supabase, SYNC_TYPE, summary);
    return NextResponse.json({ success: true, ...summary });
  } catch (e: any) {
    const message = e?.message || 'Enrichment pass failed';
    await recordHeartbeat(supabase, SYNC_TYPE, { runId, error: message }, { touchLastSyncedAt: false });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PATCH — accept or reject proposals. Accept is the ONLY path that writes
 * netsuite_parts, and it writes one field per proposal.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DecideSchema);
  if (parsed.error) return parsed.error;
  const { ids, action } = parsed.data;

  const { data: rows, error } = await supabase
    .from('part_enrichment_proposals')
    .select('id, part_id, field, proposed_value, status')
    .in('id', ids)
    .eq('status', 'pending');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: 'Nothing pending to decide — these were already reviewed.' }, { status: 409 });
  }

  const decided = { decided_by: auth.user.id, decided_at: new Date().toISOString() };
  let applied = 0;

  if (action === 'accept') {
    for (const row of rows as any[]) {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      switch (row.field) {
        case 'product_category_id':
          patch.product_category_id = row.proposed_value;
          // Same stamp the manual tagger writes: a human said yes, so the
          // rule sweep must never overwrite it (migration 209).
          patch.category_source = 'manual';
          patch.category_rule_id = null;
          break;
        case 'vehicle_type': patch.vehicle_type = row.proposed_value; break;
        case 'graphic_package': patch.graphic_package = row.proposed_value; break;
        case 'marketing_description': patch.marketing_description = row.proposed_value; break;
        case 'vendor': patch.vendor = row.proposed_value; break;
        // A misfile flag is a note for a human, not a field. Accepting it
        // means "yes, this is wrong" and closes the flag — the fix (moving
        // catalogs) stays a deliberate act on the part itself.
        case 'misfile': break;
        default: break;
      }
      if (Object.keys(patch).length > 1) {
        const { error: upErr } = await supabase
          .from('netsuite_parts').update(patch).eq('id', row.part_id);
        if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
        applied++;
      }
    }
  }

  const { error: markErr } = await supabase
    .from('part_enrichment_proposals')
    .update({ status: action === 'accept' ? 'accepted' : 'rejected', ...decided })
    .in('id', rows.map((r: any) => r.id));
  if (markErr) return NextResponse.json({ error: markErr.message }, { status: 500 });

  return NextResponse.json({ success: true, decided: rows.length, applied });
}
