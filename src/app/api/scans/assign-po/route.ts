import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { assignScanToPoLine } from '@/lib/scan-match';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  scanId: z.string().uuid(),
  lineId: z.string().uuid(),
});

/**
 * POST /api/scans/assign-po — put a scan the matcher held back for location
 * on one of the other plants' PO lines anyway. Admin-only, like the bulk
 * editor's PO dropdown, since it overrides the location rule on purpose.
 * The rules live in assignScanToPoLine (@/lib/scan-match).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { scanId, lineId } = parsed.data;

  try {
    const result = await assignScanToPoLine(service, scanId, lineId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    await logAudit(service, {
      actorId: auth.user.id,
      table: 'scan_logs',
      recordId: scanId,
      action: 'assign_po_despite_location',
      detail: { lineId, poId: result.poId, poNumber: result.poNumber },
    });

    return NextResponse.json({ success: true, poNumber: result.poNumber });
  } catch (err: any) {
    console.error('Assign PO error:', err);
    return NextResponse.json({ error: err.message || 'Failed to assign PO' }, { status: 500 });
  }
}
