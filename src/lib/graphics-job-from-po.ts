import type { PurchaseOrder, POLineItem } from '@/lib/types';

// Building a graphics job from a purchase order: the field values the create
// wizard prefills, and the linkage/attachments the submit applies. Shared by
// the PO screen (which deep-links into the wizard) and the graphics page
// (which owns the wizard) so every entry point creates jobs identically.

// Minimal structural type so both the browser and server Supabase clients fit.
type Db = { from: (table: string) => any };

export function formatShipTo(shipTo: PurchaseOrder['ship_to']): string | null {
  if (!shipTo) return null;
  const lines = [
    shipTo.name,
    shipTo.address,
    [shipTo.city, shipTo.state].filter(Boolean).join(', '),
    shipTo.zip,
  ].map(s => (s || '').trim()).filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : null;
}

// Short human location label for a PO row: the city ("Wentzville",
// "Kansas City") rather than plant codes like "MFG Wentzville MO Install
// Wentzville". Falls back to the "Install <city>" tail of a plant-style
// name, then the raw name.
export function shipToCityLabel(shipTo: PurchaseOrder['ship_to']): string {
  if (!shipTo) return '';
  const city = (shipTo.city || '').trim();
  if (city) return city;
  const name = (shipTo.name || '').trim();
  const install = name.match(/install\s+(.+)$/i);
  if (install) return install[1].trim();
  return name;
}

// Unified heading for graphics jobs created from a PO:
// "Customer - PO #123 - PART - Description - Location". The description is
// the flex segment and gets shortened first; the part-number segment (a
// joined list on whole-PO jobs) is capped too so it can't swallow the
// heading. Empty segments are dropped.
const GFX_TITLE_MAX = 100;

function shortenSegment(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export function buildGfxJobTitle(opts: {
  customer: string | null | undefined;
  poNumber: string | null | undefined;
  partNumber: string | null | undefined;
  description: string | null | undefined;
  location: string;
}): string {
  const customer = (opts.customer || '').trim();
  const poPart = opts.poNumber ? `PO #${String(opts.poNumber).trim()}` : '';
  const location = (opts.location || '').trim();
  const baseLen = [customer, poPart, location].filter(Boolean).join(' - ').length;
  const partNumber = shortenSegment(
    (opts.partNumber || '').trim(),
    Math.max(24, Math.min(40, GFX_TITLE_MAX - baseLen - 3))
  );
  const fixedLen = [customer, poPart, partNumber, location].filter(Boolean).join(' - ').length;
  const room = GFX_TITLE_MAX - fixedLen - 3;
  const desc = room >= 8 ? shortenSegment((opts.description || '').trim(), room) : '';
  return [customer, poPart, partNumber, desc, location].filter(Boolean).join(' - ') || 'Graphics Job';
}

export function buildJobContent(lines: { part_number: string; description: string | null; quantity: number }[]): string | null {
  if (!lines.length) return null;
  return lines
    .map(li => {
      const desc = (li.description || '').trim();
      const head = desc ? `${li.part_number} — ${desc}` : li.part_number;
      return `${head} (Qty: ${li.quantity})`;
    })
    .join('\n');
}

export interface PoJobPrefill {
  // Values for the create wizard's form fields.
  form: {
    title: string;
    part_numbers: string[];
    customer: string;
    quantity: number;
    content: string;
    ship_to: string;
    po_number: string;
    due_date: string;
  };
  // What the submit needs to write po_id / po_line_item_id and attach the
  // parts' catalog files after the job row exists.
  link: {
    poId: string;
    poLineItemId: string | null;
    customerNetsuiteId: string | null;
    partNumbers: string[];
  };
}

// Fetch a PO (optionally narrowed to one line item) and shape the create
// wizard's prefill. Returns null when the PO or line item doesn't exist.
export async function buildGraphicsJobPrefillFromPo(
  supabase: Db,
  poId: string,
  poLineItemId?: string | null,
): Promise<PoJobPrefill | null> {
  const { data: po } = await supabase
    .from('purchase_orders')
    .select('*, po_line_items(*)')
    .eq('id', poId)
    .maybeSingle();
  if (!po) return null;

  const allLines: POLineItem[] = po.po_line_items || [];
  const lines = poLineItemId ? allLines.filter(l => l.id === poLineItemId) : allLines;
  if (lines.length === 0) return null;

  const partNumbers = [...new Set(lines.map(l => l.part_number))];
  const totalQty = lines.reduce((sum, l) => sum + (l.quantity || 0), 0);
  // One shared description if every line agrees, otherwise a part count
  // stands in for it in the heading.
  const uniqueDescs = [...new Set(lines.map(l => (l.description || '').trim()).filter(Boolean))];
  const titleDesc = uniqueDescs.length === 1 ? uniqueDescs[0] : lines.length === 1 ? '' : `${lines.length} parts`;

  return {
    form: {
      title: buildGfxJobTitle({
        customer: po.customer,
        poNumber: po.po_number,
        partNumber: partNumbers.join(', '),
        description: titleDesc,
        location: shipToCityLabel(po.ship_to),
      }),
      part_numbers: partNumbers,
      customer: po.customer || '',
      quantity: totalQty || 1,
      content: buildJobContent(lines) || '',
      ship_to: formatShipTo(po.ship_to) || '',
      po_number: po.po_number || '',
      due_date: po.requested_delivery_date || '',
    },
    link: {
      poId: po.id,
      poLineItemId: poLineItemId || null,
      customerNetsuiteId: po.customer_netsuite_id || null,
      partNumbers,
    },
  };
}

// Link the files saved on each part's catalog record (proofs, install
// guides) into a graphics job — the rows reuse the parts' storage_path, same
// as PO files; both tables point at the graphics-proofs bucket. Parts are
// matched case-insensitively; a part with no catalog record simply
// contributes nothing.
export async function attachPartFilesToGraphicsJob(
  supabase: Db,
  partNumbers: string[],
  jobId: string,
  uploadedBy?: string | null,
): Promise<void> {
  const wanted = [...new Set(partNumbers.map(p => (p || '').trim()).filter(Boolean))];
  if (wanted.length === 0) return;

  // ilike fetches a case-insensitive superset; narrow to an exact match in
  // JS so wildcard chars in a part number can't cause a false positive.
  const partIds: string[] = [];
  for (const pn of wanted) {
    const { data } = await supabase
      .from('netsuite_parts')
      .select('id, item_number')
      .eq('is_active', true)
      .ilike('item_number', pn);
    const exact = ((data as any[]) || []).find(
      r => (r.item_number || '').toUpperCase() === pn.toUpperCase(),
    );
    if (exact?.id) partIds.push(exact.id);
  }
  if (partIds.length === 0) return;

  const { data: partFiles } = await supabase
    .from('part_files')
    .select('file_name, file_type, file_size, storage_path')
    .in('part_id', partIds);
  if (!partFiles || partFiles.length === 0) return;

  await supabase.from('graphics_job_files').insert(
    partFiles.map((f: any) => ({
      job_id: jobId,
      file_name: f.file_name,
      file_type: f.file_type,
      file_size: f.file_size,
      storage_path: f.storage_path,
      uploaded_by: uploadedBy || null,
    })),
  );
}
