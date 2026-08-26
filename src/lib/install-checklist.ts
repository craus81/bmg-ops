/**
 * Shared install-checklist template lookup + task-row builder.
 *
 * Used by the two places that instantiate a vehicle's QC checklist:
 *   - /api/vehicle-tracking/update-status  (received → in_progress, and the
 *     on-demand instantiation inside the completion gate)
 *   - /api/vehicle-tracking/[id]/refresh-checklist  (admin "Reset checklist")
 *
 * History: both routes used to share a single query with an ordering trick —
 * `.in('install_category', [preferred, 'mixed']).order('install_category',
 * { ascending: preferred !== 'mixed' })` — whose direction was INVERTED for
 * the upfit case ('mixed' < 'upfit' alphabetically, so ascending returned the
 * mixed template first). Every upfit-only vehicle got the mixed checklist and
 * was then completion-blocked on a required "Graphics applied per proof" task
 * it could never satisfy. The two routes also disagreed on the created_at
 * tiebreak, so "Reset checklist" could produce a different checklist than the
 * automatic instantiation. This helper replaces the trick with an explicit
 * two-step lookup — exact category first, 'mixed' as the fallback — and one
 * tiebreak (newest active template wins) for both routes.
 */

export interface ChecklistTemplate {
  id: string;
  items: Array<{ label: string; required?: boolean; key?: string }>;
  install_category: string;
}

/**
 * Find the active checklist template for a vehicle category.
 * Tries the exact category first, then falls back to 'mixed'.
 * Newest active template wins when a category has more than one.
 */
export async function loadChecklistTemplate(
  supabase: any,
  preferredCategory: string,
): Promise<ChecklistTemplate | null> {
  const categories = preferredCategory === 'mixed' ? ['mixed'] : [preferredCategory, 'mixed'];
  for (const cat of categories) {
    const { data } = await supabase
      .from('install_checklist_templates')
      .select('id, items, install_category')
      .eq('is_active', true)
      .eq('install_category', cat)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.items && Array.isArray(data.items)) return data as ChecklistTemplate;
  }
  return null;
}

/** Map a template's items onto insertable job_tasks rows for a vehicle. */
export function buildTaskRows(template: ChecklistTemplate, vehicleId: string) {
  return template.items
    .filter((i) => i?.label)
    .map((item, i) => ({
      job_type: 'fleet_checkin',
      job_id: vehicleId,
      label: item.label,
      required: item.required === true,
      sort_order: i,
      template_id: template.id,
      task_key: item.key || null,
    }));
}
