import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getAccessToken, requireBooks, requireSuperAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { SWITCHES, SWITCH_ON_DATE_TEXT, isSwitchPiece, readSwitches, setSwitch } from '@/lib/books/switches';
import { tokenLevel } from '@/lib/two-step';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/**
 * Books → Switches (migration 466, src/lib/books/switches.ts): the pieces that
 * take the team out of NetSuite, each built switched off.
 *
 * GET  — every switch, whether it's on, and who changed it last; anyone who
 *        opens the books.
 * POST — { piece, on }: turn one on or off. Super admins only, and audited.
 *        Two-step sign-in for money roles switches on only from a sign-in
 *        that gave its own two-step code (src/lib/two-step.ts), so whoever
 *        switches it on has set theirs up and seen it work.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  try {
    const states = await readSwitches(service);
    const ids = [...new Set(states.map((s) => s.changedBy).filter((id): id is string => !!id))];
    const { data, error } = ids.length
      ? await service.from('profiles').select('id, full_name').in('id', ids)
      : { data: [], error: null };
    if (error) throw new Error(error.message);
    const names = new Map(((data ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name]));
    return NextResponse.json({
      onDate: SWITCH_ON_DATE_TEXT,
      switches: states.map((s) => ({
        ...SWITCHES[s.piece],
        piece: s.piece,
        on: s.on,
        changedAt: s.changedAt,
        changedBy: s.changedBy ? names.get(s.changedBy) || 'Someone' : null,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

const Schema = z.object({
  piece: z.string().max(60),
  on: z.boolean(),
});

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { piece, on } = parsed.data;
  if (!isSwitchPiece(piece)) return NextResponse.json({ error: `There's no switch called ${piece}.` }, { status: 400 });
  if (piece === 'two_step_sign_in' && on && tokenLevel(getAccessToken(req)) !== 'aal2') {
    return NextResponse.json({
      error: 'Set up two-step sign-in for yourself first (Settings → Two-step sign-in), then switch it on: it switches on only from a sign-in that gave its own code.',
    }, { status: 409 });
  }

  try {
    const { was } = await setSwitch(service, piece, on, auth.user.id);
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'books_switches',
      recordId: piece,
      action: on ? 'switch_on' : 'switch_off',
      detail: { piece, name: SWITCHES[piece].name, was_on: was, on },
    });
    return NextResponse.json({ piece, on });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
