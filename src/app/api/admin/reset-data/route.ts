import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';

/**
 * POST /api/admin/reset-data
 * Wipes all operational data (POs, scans, photos, etc.) while keeping
 * config/reference tables (catalog, profiles, google_tokens, etc.) intact.
 *
 * Requires confirm: "DELETE ALL DATA" in the body for safety.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  try {
    const { confirm } = await req.json();

    if (confirm !== 'DELETE ALL DATA') {
      return NextResponse.json(
        { error: 'Safety check failed. Send { confirm: "DELETE ALL DATA" } to proceed.' },
        { status: 400 }
      );
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Order matters due to foreign key constraints — delete children first
    const tables = [
      'po_invoices',          // references purchase_orders
      'vehicle_photos',       // references scanned_vehicles
      'vehicle_status_history', // references scanned_vehicles
      'gmail_po_imports',     // references purchase_orders
      'po_line_items',        // references purchase_orders
      'scanned_vehicles',     // may reference po_line_items
      'purchase_orders',      // parent table
      'notifications',        // transactional
    ];

    const results: { table: string; status: string; error?: string }[] = [];

    for (const table of tables) {
      // Delete all rows — using neq on a non-existent value to match everything
      const { error } = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');

      if (error) {
        results.push({ table, status: 'error', error: error.message });
      } else {
        results.push({ table, status: 'cleared' });
      }
    }

    const errors = results.filter(r => r.status === 'error');

    return NextResponse.json({
      message: errors.length === 0
        ? 'All operational data has been cleared.'
        : `Completed with ${errors.length} error(s).`,
      results,
    });
  } catch (err: any) {
    console.error('Reset data error:', err);
    return NextResponse.json({ error: err.message || 'Failed to reset data' }, { status: 500 });
  }
}
