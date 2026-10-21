import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { pushGraphicsJobToCalendar } from '@/lib/graphics-calendar';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const supabase = createServiceClient();

const Schema = z.object({ jobId: z.string().uuid() });

/**
 * POST /api/calendar/sync-graphics
 * Syncs a graphics job's scheduled install date to Google Calendar.
 * Creates a new event or updates an existing one. Implementation lives
 * in lib/graphics-calendar so the calendar-pull cron's reconciliation
 * sweep pushes identically.
 *
 * Body: { jobId: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId } = parsed.data;

  try {
    const result = await pushGraphicsJobToCalendar(supabase, jobId);
    if (result.reason === 'not_found') {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err: any) {
    console.error('Calendar sync error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
