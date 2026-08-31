import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  jobId: z.string().uuid(),
  print: z.string().optional(),
});

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * GET /api/graphics/packing-list?jobId=…[&print=1] — a printable pick/pack
 * sheet for the packing bench (Stage 5 finding: the only packing-list PDF
 * rendered AFTER an invoice existed, so a packer at the `packing` stage of a
 * not-yet-invoiced job had nothing).
 *
 * Deliberately invoice-free: it reads the job itself plus the material log,
 * so it works the moment work is printed. Checkbox rows are for the bench —
 * print it, tick it, tape it to the box.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, Schema);
  if (q.error) return q.error;
  const { jobId, print } = q.data;

  try {
    const supabase = getSupabase();
    const [{ data: job }, { data: materials }] = await Promise.all([
      supabase.from('graphics_jobs').select('*').eq('id', jobId).maybeSingle(),
      supabase
        .from('graphics_job_materials')
        .select('material_name, category, quantity_sqft, linear_feet, notes, created_at')
        .eq('graphics_job_id', jobId)
        .order('created_at'),
    ]);
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const rows = (materials || []).map(m => `
      <tr>
        <td class="chk"><span class="box"></span></td>
        <td>${esc(m.material_name)}</td>
        <td>${esc(m.category)}</td>
        <td class="num">${m.quantity_sqft != null ? `${esc(m.quantity_sqft)} sqft` : m.linear_feet != null ? `${esc(m.linear_feet)} lin ft` : '—'}</td>
        <td>${esc(m.notes || '')}</td>
      </tr>`).join('');

    const metaRow = (label: string, value: unknown) => value
      ? `<div class="meta"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>` : '';

    const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Packing list — ${esc(job.job_number || jobId.slice(0, 8))}</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #555; font-size: 13px; margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 24px; margin-bottom: 18px; }
  .meta span { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #777; }
  .meta strong { font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #777; border-bottom: 2px solid #111; padding: 6px 8px; }
  td { border-bottom: 1px solid #ddd; padding: 8px; vertical-align: top; }
  td.num { white-space: nowrap; }
  .chk { width: 28px; }
  .box { display: inline-block; width: 16px; height: 16px; border: 2px solid #111; border-radius: 3px; }
  .content { margin-top: 16px; font-size: 13px; white-space: pre-wrap; border: 1px solid #ddd; border-radius: 6px; padding: 10px 12px; }
  .content h2, .sign h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: #777; margin: 0 0 6px; }
  .sign { margin-top: 28px; display: flex; gap: 40px; }
  .sign .line { flex: 1; border-top: 1px solid #111; padding-top: 4px; font-size: 11px; color: #555; }
  .empty { color: #777; font-size: 13px; padding: 12px 8px; }
  @media print { body { margin: 12mm; } }
</style></head><body>
  <h1>Packing list — ${esc(job.job_number || '')} ${esc(job.title || '')}</h1>
  <div class="sub">${esc(job.customer || '')}${job.status ? ` · status: ${esc(job.status)}` : ''}</div>
  <div class="grid">
    ${metaRow('Part', job.part_number)}
    ${metaRow('Quantity', job.quantity)}
    ${metaRow('Customer PO', job.po_number)}
    ${metaRow('Due', job.due_date)}
    ${metaRow('Install date', job.scheduled_install_date)}
    ${metaRow('Ship to', job.ship_to)}
  </div>
  <table>
    <thead><tr><th></th><th>Material / piece</th><th>Category</th><th>Qty</th><th>Notes</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="empty">No materials logged yet — list the printed pieces by hand below the job description.</td></tr>'}</tbody>
  </table>
  ${job.content ? `<div class="content"><h2>Job description</h2>${esc(job.content)}</div>` : ''}
  ${job.notes ? `<div class="content"><h2>Notes</h2>${esc(job.notes)}</div>` : ''}
  <div class="sign">
    <div class="line">Packed by</div>
    <div class="line">Date</div>
    <div class="line">Pieces / boxes</div>
  </div>
  ${print ? '<script>window.print();</script>' : ''}
</body></html>`;

    return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
