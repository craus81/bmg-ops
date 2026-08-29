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
import { r2GetBytes, r2PublicUrl } from './r2';

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

// ═══════════ Graphics-job proofs on the estimate ═══════════
// The proof files linked graphics jobs contribute to the estimate's
// customer-facing surfaces (graphics_jobs.estimate_attach, migration 235 —
// the compose screen's per-job proof picker). Same ONE-loader rule as the
// wrap content above: the email body, the public approval page, the staff
// preview, the merged PDF, and the frozen signed snapshot all load through
// here, so what the customer sees, approves, and gets frozen cannot drift.
// When the customer accepts, the approval route approves exactly the jobs
// this loader returns — it is the source of truth for propagation too.

export interface EstimateProofFile {
  id: string;
  name: string;
  /** Public URL for rendering (frozen documents must go through
   *  inlineProofImages instead — the R2 object is mutable). Null when the
   *  snapshot inliner dropped an unreadable/oversize image. */
  url: string | null;
  isPdf: boolean;
  /** R2 key under the graphics-proofs prefix — for credentialed reads
   *  (PDF merge, acceptance archival). Stripped from public payloads. */
  storagePath: string;
}

export interface EstimateProofBlock {
  jobId: string;
  jobNumber: string | null;
  jobTitle: string | null;
  files: EstimateProofFile[];
}

const isPdfFile = (name: string | null, type: string | null): boolean =>
  (type || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(name || '');

/**
 * The proof blocks the estimate's customer surfaces render, in job
 * creation order with files in selection order.
 *
 * `override` (the compose preview) renders a proposed selection without
 * persisting it; otherwise the stored estimate_attach drives everything.
 * File ids are always re-verified against graphics_job_files rows of the
 * owning job — a stale id (deleted file) drops out rather than erroring.
 * Defensive on purpose: this feeds LIVE approval links, so any load error
 * (including the column not existing yet) degrades to "no proofs".
 */
export async function loadEstimateProofs(
  supabase: SupabaseClient,
  estimateId: string,
  override?: { jobId: string; fileIds: string[] }[],
): Promise<EstimateProofBlock[]> {
  try {
    const { data: jobs, error } = await supabase
      .from('graphics_jobs')
      .select('id, job_number, title, estimate_attach')
      .eq('estimate_id', estimateId)
      .order('created_at', { ascending: true });
    if (error || !jobs || jobs.length === 0) return [];

    const wantedByJob = new Map<string, string[]>();
    for (const j of jobs) {
      const ids = override
        ? (override.find(o => o.jobId === j.id)?.fileIds || [])
        : (Array.isArray(j.estimate_attach?.file_ids) ? j.estimate_attach.file_ids : []);
      if (ids.length > 0) wantedByJob.set(j.id, ids.filter(Boolean));
    }
    if (wantedByJob.size === 0) return [];

    const allIds = [...new Set([...wantedByJob.values()].flat())];
    const { data: fileRows } = await supabase
      .from('graphics_job_files')
      .select('id, job_id, file_name, file_type, storage_path')
      .in('id', allIds);
    const byId = new Map((fileRows || []).map(f => [f.id, f]));

    const blocks: EstimateProofBlock[] = [];
    for (const j of jobs) {
      const ids = wantedByJob.get(j.id);
      if (!ids) continue;
      const files: EstimateProofFile[] = [];
      for (const id of ids) {
        const f = byId.get(id);
        if (!f || f.job_id !== j.id) continue; // stale or foreign id — drop
        files.push({
          id: f.id,
          name: f.file_name,
          url: r2PublicUrl('graphics-proofs', f.storage_path),
          isPdf: isPdfFile(f.file_name, f.file_type),
          storagePath: f.storage_path,
        });
      }
      if (files.length > 0) blocks.push({ jobId: j.id, jobNumber: j.job_number, jobTitle: j.title, files });
    }
    return blocks;
  } catch {
    return [];
  }
}

const MAX_INLINE_PROOF_BYTES = 4 * 1024 * 1024;

/**
 * Proof images as data URIs for FROZEN documents (the signed acceptance
 * snapshot) — same reasoning as inlineDiagrams: the R2 objects are
 * mutable (a re-uploaded proof file can overwrite them), so a frozen
 * legal record must never reference them by URL. Images inline or drop;
 * PDF proofs keep their name with url null (the snapshot lists them —
 * their frozen bytes live in the acceptance archival, not this HTML).
 */
export async function inlineProofImages(
  blocks: EstimateProofBlock[],
): Promise<EstimateProofBlock[]> {
  const out: EstimateProofBlock[] = [];
  for (const b of blocks) {
    const files: EstimateProofFile[] = [];
    for (const f of b.files) {
      if (f.isPdf) { files.push({ ...f, url: null }); continue; }
      try {
        const got = await r2GetBytes('graphics-proofs', f.storagePath, MAX_INLINE_PROOF_BYTES);
        if (!got || got.bytes.byteLength === 0) throw new Error('unreadable');
        const mime = got.contentType && got.contentType.startsWith('image/') ? got.contentType : 'image/png';
        files.push({ ...f, url: `data:${mime};base64,${got.bytes.toString('base64')}` });
      } catch {
        files.push({ ...f, url: null });
      }
    }
    out.push({ ...b, files });
  }
  return out;
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
