import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Find-or-create the upfit project for a sales order (R3-11).
 *
 * Estimate conversion has auto-created its project since roadmap N2 phase 1,
 * but every other way an SO comes to exist — pushed from a customer PO,
 * attached by hand via link-so, or discovered by the SO sync — created
 * nothing, and someone re-typed the SO number into a hand-made project.
 * This is that conversion block, shared.
 *
 * Semantics (identical to the conversion original):
 *  - Dedupe by estimate_id first (migration 225's partial unique index
 *    guards the race), then by netsuite_so_id (no unique index exists on
 *    the SO columns — migration 085's trigger already treats them as
 *    non-unique — so this arm is find-first, good enough for the
 *    single-click flows that use it).
 *  - An existing project missing its SO link gets the SO stamped on; an
 *    existing SO-keyed project missing its estimate link gets the estimate
 *    attached (guarded so it can never steal another estimate's project).
 *  - A fresh project starts at status 'sold' with an auto note.
 *  - Never throws: callers run this after the SO already exists in
 *    NetSuite, so a project hiccup must not fail their request. Returns
 *    null on failure.
 */
export interface EnsureUpfitProjectInput {
  netsuiteSoId: string;
  netsuiteSoNumber?: string | null;
  estimateId?: string | null;
  estimateNumber?: string | null;
  /** Estimate title (or any short work label) — second half of the name. */
  title?: string | null;
  customerName?: string | null;
  customerNetsuiteId?: string | null;
  estimatedTotal?: number | null;
  soTotal?: number | null;
  /** Overrides the derived "<customer> — <title|estimate>" name. */
  projectName?: string | null;
  /** Who to attribute the project + note to; null for system/sync paths. */
  createdBy?: string | null;
  /** Timeline note recorded when (and only when) the project is created. */
  noteContent?: string | null;
}

export async function ensureUpfitProjectForSo(
  client: SupabaseClient,
  input: EnsureUpfitProjectInput,
): Promise<{ id: string; created: boolean } | null> {
  try {
    // 1) The estimate's project, when an estimate is in play.
    if (input.estimateId) {
      const { data: existing } = await client
        .from('upfit_projects')
        .select('id, netsuite_so_id')
        .eq('estimate_id', input.estimateId)
        .maybeSingle();
      if (existing) {
        if (!existing.netsuite_so_id) {
          await client
            .from('upfit_projects')
            .update({
              netsuite_so_id: input.netsuiteSoId,
              netsuite_so_number: input.netsuiteSoNumber || null,
              so_total: input.soTotal ?? null,
            })
            .eq('id', existing.id);
        }
        return { id: existing.id, created: false };
      }
    }

    // 2) A project already carrying this SO (hand-created, or made by
    //    another path). Backfill its estimate link when it has none.
    {
      const { data: bySo } = await client
        .from('upfit_projects')
        .select('id, estimate_id')
        .eq('netsuite_so_id', input.netsuiteSoId)
        .order('created_at')
        .limit(1)
        .maybeSingle();
      if (bySo) {
        if (input.estimateId && !bySo.estimate_id) {
          // Guarded: 225's unique index rejects a second project on the
          // same estimate — losing the backfill is fine, stealing isn't.
          const { error: attachErr } = await client
            .from('upfit_projects')
            .update({
              estimate_id: input.estimateId,
              estimate_number: input.estimateNumber || null,
            })
            .eq('id', bySo.id)
            .is('estimate_id', null);
          if (attachErr && attachErr.code !== '23505') {
            console.warn('upfit project estimate backfill failed:', attachErr.message);
          }
        }
        return { id: bySo.id, created: false };
      }
    }

    // 3) Create it.
    const projectName =
      input.projectName
      || [input.customerName, input.title || input.estimateNumber].filter(Boolean).join(' — ')
      || `SO #${input.netsuiteSoNumber || input.netsuiteSoId}`;
    const { data: createdProject, error: projectErr } = await client
      .from('upfit_projects')
      .insert({
        project_name: projectName,
        status: 'sold',
        customer_name: input.customerName || null,
        customer_netsuite_id: input.customerNetsuiteId || null,
        estimate_id: input.estimateId || null,
        estimate_number: input.estimateNumber || null,
        netsuite_so_id: input.netsuiteSoId,
        netsuite_so_number: input.netsuiteSoNumber || null,
        estimated_total: input.estimatedTotal ?? null,
        so_total: input.soTotal ?? null,
        created_by: input.createdBy || null,
      })
      .select('id')
      .single();
    if (projectErr) {
      if (projectErr.code === '23505' && input.estimateId) {
        // Racing caller created it between our select and insert.
        const { data: winner } = await client
          .from('upfit_projects')
          .select('id')
          .eq('estimate_id', input.estimateId)
          .maybeSingle();
        if (winner) return { id: winner.id, created: false };
      }
      console.error('auto upfit-project create failed:', projectErr);
      return null;
    }
    if (!createdProject) return null;

    await client.from('upfit_project_notes').insert({
      project_id: createdProject.id,
      note_type: 'sales_order',
      content:
        input.noteContent
        || `Project created automatically for SO #${input.netsuiteSoNumber || input.netsuiteSoId}`,
      created_by: input.createdBy || null,
    });
    return { id: createdProject.id, created: true };
  } catch (err) {
    console.error('auto upfit-project step failed:', err);
    return null;
  }
}
