import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { updateItemDescription } from '@/lib/netsuite';

// Writing back to NetSuite (RESTlet round-trip) can exceed the default ceiling.
export const maxDuration = 60;

const Schema = z.object({ description: z.string().max(4000) });

// Edit a catalog part's description. For NetSuite-synced parts this writes back
// to NetSuite first (the source of truth — otherwise the next parts sync would
// overwrite a local-only edit), then mirrors the value locally so the UI
// updates immediately. Manual graphics parts (no netsuite_id) update locally.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const description = parsed.data.description.trim();
  const partId = params.id;

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: part } = await supabase
      .from('netsuite_parts')
      .select('id, netsuite_id')
      .eq('id', partId)
      .maybeSingle();
    if (!part) return NextResponse.json({ error: 'Part not found' }, { status: 404 });

    if (part.netsuite_id) {
      const res = await updateItemDescription(part.netsuite_id, description);
      if (!res.success) {
        // Don't touch the local row if NetSuite rejected the change — keeping
        // them in lockstep avoids a local edit that the next sync would revert.
        return NextResponse.json(
          { error: `NetSuite update failed: ${res.error}` },
          { status: 502 }
        );
      }
    }

    const { error } = await supabase
      .from('netsuite_parts')
      .update({ description, updated_at: new Date().toISOString() })
      .eq('id', partId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      success: true,
      description,
      syncedToNetsuite: !!part.netsuite_id,
    });
  } catch (err: any) {
    console.error('part description update error:', err);
    return NextResponse.json({ error: err.message || 'Update failed' }, { status: 500 });
  }
}
