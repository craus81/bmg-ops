import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { loadReachReport } from '@/lib/email-reach';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * GET /api/reports/email-reach?days=30 (R6-13) — deliverability by kind and
 * recipient domain, plus the addresses we can no longer reach.
 *
 * Admin: the unreachable worklist names customer contacts and links them to
 * records, which is broader than any one person's own sent mail.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const raw = Number(req.nextUrl.searchParams.get('days') || 30);
  const days = [30, 90, 180].includes(raw) ? raw : 30;

  try {
    return NextResponse.json(await loadReachReport(service, days));
  } catch (e: any) {
    console.error('email reach report failed:', e);
    return NextResponse.json({ error: 'Could not build the report.' }, { status: 500 });
  }
}
