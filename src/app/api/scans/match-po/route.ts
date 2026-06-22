import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { matchScansToOpenPos } from '@/lib/scan-match';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/scans/match-po
 * Retroactively match unmatched scan_logs to open POs by part number (location
 * breaks ties). Called after PO import or manually from the admin scan review
 * page. Matching logic lives in @/lib/scan-match so the at-scan-time path
 * (/api/scans/log) stays in sync.
 */
export async function POST(req: NextRequest) {
  // Allow internal calls (from cron/PO import) or authenticated users
  const authHeader = req.headers.get('authorization');
  const isInternal = authHeader === `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;
  if (!isInternal) {
    const auth = await requireAuth(req);
    if (auth.error) return auth.error;
  }

  try {
    const result = await matchScansToOpenPos(supabase);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error('Scan PO match error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
