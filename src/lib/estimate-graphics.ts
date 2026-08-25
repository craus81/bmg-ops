/**
 * The wrap content a linked wrap quote contributes to its estimate's
 * customer-facing surfaces (wrap_quotes.estimate_attach — the estimator's
 * Add-to-Estimate checkboxes, migration 223).
 *
 * ONE loader for every surface — the merged PDF, the approval email body,
 * the public approval page, and the frozen signed snapshot — so what the
 * customer is shown, what they approve, and what gets frozen as the E-SIGN
 * record cannot drift apart.
 *
 * Server-only: callers pass a service-role Supabase client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { r2PublicUrl } from './r2';

export interface EstimateGraphicsSummary {
  quoteNumber: string;
  vehicle: string | null;
  totalSqft: number;
  /** Film name → the coverage areas using it. Empty when the "Vinyl
   *  details" checkbox was off. */
  films: { name: string; areas: string[] }[];
  /** Coverage diagram (PNG): the public URL when the diagram checkbox was
   *  on, else null. NOTE the R2 object is mutable (a later quote save
   *  overwrites it) — frozen documents must go through inlineDiagrams. */
  diagramUrl: string | null;
}

export async function loadEstimateGraphics(
  supabase: SupabaseClient,
  estimateId: string,
): Promise<{ summaries: EstimateGraphicsSummary[]; wrapQuotes: any[] }> {
  const { data: wrapQuotes } = await supabase
    .from('wrap_quotes')
    .select('id, quote_number, vehicle_description, diagram_path, attachments, measurements, estimate_attach, total_area_sqft')
    .eq('estimate_id', estimateId)
    .not('estimate_attach', 'is', null);

  const summaries: EstimateGraphicsSummary[] = [];
  for (const q of wrapQuotes || []) {
    const wantFilms = !!q.estimate_attach?.films;
    const wantDiagram = !!(q.estimate_attach?.diagram && q.diagram_path);
    if (!wantFilms && !wantDiagram) continue;

    let films: { name: string; areas: string[] }[] = [];
    if (wantFilms) {
      const measurements: any[] = Array.isArray(q.measurements) ? q.measurements : [];
      const filmIds = [...new Set(measurements.map(m => m?.substrate_id).filter(Boolean))] as string[];
      const names = new Map<string, string>();
      if (filmIds.length > 0) {
        const { data: filmRows } = await supabase
          .from('wrap_substrates').select('id, name').in('id', filmIds);
        for (const f of filmRows || []) names.set(f.id, f.name);
      }
      const byFilm = new Map<string, string[]>();
      for (const m of measurements) {
        const name = m?.substrate_id ? (names.get(m.substrate_id) || 'Vinyl') : 'Vinyl';
        const areas = byFilm.get(name) || [];
        if (m?.name) areas.push(String(m.name));
        byFilm.set(name, areas);
      }
      films = [...byFilm.entries()].map(([name, areas]) => ({ name, areas }));
    }

    summaries.push({
      quoteNumber: q.quote_number,
      vehicle: q.vehicle_description,
      totalSqft: wantFilms ? parseFloat(q.total_area_sqft) || 0 : 0,
      films,
      diagramUrl: wantDiagram ? r2PublicUrl('vehicle-templates', q.diagram_path) : null,
    });
  }
  return { summaries, wrapQuotes: wrapQuotes || [] };
}

const MAX_INLINE_DIAGRAM_BYTES = 4 * 1024 * 1024;

/**
 * Replace diagram URLs with data URIs for FROZEN documents (the signed
 * acceptance snapshot). The R2 diagram is overwritten by later quote saves,
 * so a frozen legal record must never reference it by URL — inline it, or
 * (if unreadable/oversize) omit it rather than point at mutable state.
 */
export async function inlineDiagrams(
  summaries: EstimateGraphicsSummary[],
): Promise<EstimateGraphicsSummary[]> {
  const out: EstimateGraphicsSummary[] = [];
  for (const s of summaries) {
    if (!s.diagramUrl) { out.push(s); continue; }
    try {
      const res = await fetch(s.diagramUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_INLINE_DIAGRAM_BYTES) throw new Error('bad size');
      out.push({ ...s, diagramUrl: `data:image/png;base64,${buf.toString('base64')}` });
    } catch {
      out.push({ ...s, diagramUrl: null });
    }
  }
  return out;
}
