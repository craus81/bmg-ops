import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sales-orders/items?q=… — parts and labor items for "+ Add line"
 * on the sales order page. Admin only, like editing. Only items NetSuite
 * knows (netsuite_id set), since the new line is written to NetSuite.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const q = (req.nextUrl.searchParams.get('q') || '').trim().replace(/[%,()]/g, ' ').slice(0, 60);
  if (q.length < 2) return NextResponse.json({ items: [] });

  const like = `%${q}%`;
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('netsuite_parts')
    .select('netsuite_id, item_number, display_name, description, sales_price')
    .eq('is_active', true)
    .not('netsuite_id', 'is', null)
    .or(`item_number.ilike.${like},display_name.ilike.${like},description.ilike.${like}`)
    .order('item_number')
    .limit(25);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    items: (data || []).map(p => ({
      itemId: String(p.netsuite_id),
      itemNumber: p.item_number,
      description: p.description || p.display_name || '',
      price: p.sales_price != null ? Number(p.sales_price) : null,
    })),
  });
}
