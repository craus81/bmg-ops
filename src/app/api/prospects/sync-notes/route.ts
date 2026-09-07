import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { pushProspectNotes } from '@/lib/prospect-notes-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/prospects/sync-notes — drain a linked record's human-authored
 * activity (calls, meetings, notes, voice notes) into NetSuite as user
 * notes (R3-16a's second half, owner decision 2026-09-07).
 *
 * Idempotent: synced rows carry netsuite_note_id and are skipped, so the
 * record page fires this after every new activity, the Sync notes button
 * retries failures, and repeated calls drain a backlog past the per-run
 * cap. Promotion pushes the same way internally; this route covers records
 * that were ALREADY linked when a note was written.
 */
const Schema = z.object({
  prospectId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: prospect } = await supabase
    .from('prospects')
    .select('id, netsuite_id')
    .eq('id', parsed.data.prospectId)
    .maybeSingle();
  if (!prospect) {
    return NextResponse.json({ error: 'Record not found.' }, { status: 404 });
  }
  if (!prospect.netsuite_id) {
    return NextResponse.json({ error: 'This record is not linked to NetSuite yet — promote it first; promotion pushes its notes.' }, { status: 409 });
  }

  try {
    const result = await pushProspectNotes(supabase, prospect.id, String(prospect.netsuite_id));
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    console.error('sync-notes failed:', err);
    return NextResponse.json({ error: err?.message || 'Notes sync failed' }, { status: 500 });
  }
}
