import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { parseCurtPriceRows } from '@/lib/curt-prices';

/**
 * POST /api/hitch-kits/curt-prices — upload Curt's "Customer Item Prices"
 * spreadsheet (multipart `file`, .xlsx). Rows replace curt_prices by part
 * number; the hitch builder's list prices follow the file's List column.
 * Nothing is written unless the whole file reads cleanly.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'Choose the Curt price file (.xlsx) to upload.' }, { status: 400 });
  if (!/\.xlsx$/i.test(file.name)) return NextResponse.json({ error: 'The Curt price file must be an .xlsx spreadsheet.' }, { status: 400 });

  let parsed;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await file.arrayBuffer()) as any);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('The spreadsheet has no sheets.');
    const sheet: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, row => {
      // row.values is 1-based; drop the empty first slot.
      sheet.push((row.values as unknown[]).slice(1).map(v => (v && typeof v === 'object' && 'result' in (v as any) ? (v as any).result : v)));
    });
    parsed = parseCurtPriceRows(sheet);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not read the spreadsheet.' }, { status: 400 });
  }
  if (parsed.rows.length === 0) return NextResponse.json({ error: 'No priced parts were found in the file.' }, { status: 400 });

  const supabase = createServiceClient();
  const now = new Date().toISOString();
  for (let i = 0; i < parsed.rows.length; i += 500) {
    const { error } = await supabase.from('curt_prices').upsert(parsed.rows.slice(i, i + 500).map(r => ({ ...r, updated_at: now })), { onConflict: 'item_number' });
    if (error) return NextResponse.json({ error: `Saved ${i} of ${parsed.rows.length} parts, then failed: ${error.message}` }, { status: 500 });
  }

  // The builder sells at Curt List: keep its list prices current.
  const listBySku = new Map(parsed.rows.filter(r => r.list_price != null).map(r => [r.item_number, r.list_price!]));
  const { data: parts } = await supabase.from('hitch_parts').select('sku, list_price');
  let listUpdated = 0;
  for (const p of parts || []) {
    const list = listBySku.get(String(p.sku));
    if (list == null || Number(p.list_price) === list) continue;
    const { error } = await supabase.from('hitch_parts').update({ list_price: list, updated_at: now }).eq('sku', p.sku);
    if (!error) listUpdated++;
  }
  const hitchMissing = (parts || []).filter(p => !listBySku.has(String(p.sku))).map(p => String(p.sku));

  await supabase.from('hitch_settings').update({
    price_file_name: file.name, price_file_date: parsed.reportDate, price_file_rows: parsed.rows.length, price_file_loaded_at: now,
  }).eq('id', 1);

  return NextResponse.json({ rows: parsed.rows.length, skipped: parsed.skipped, reportDate: parsed.reportDate, listUpdated, hitchMissing });
}
