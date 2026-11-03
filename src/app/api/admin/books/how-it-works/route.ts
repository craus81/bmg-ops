import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getProfileRoles, requireBooks } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody } from '@/lib/validate';
import { NOTE_MAX, RULE_IDS, cleanNote } from '@/lib/books/how-it-works';
import { loadHowItWorks, reviewerAs, rulesFingerprint } from '@/lib/books/how-it-works-data';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

/**
 * GET /api/admin/books/how-it-works — Books → How the books work
 * (src/lib/books/how-it-works.ts and how-it-works-data.ts, docs/books.md "How
 * the books work"): what posts what and how much each rule has posted, who
 * can change what and who holds each step now, two-step sign-in, what the
 * database refuses, the controls, switches, jobs and backups, what the IRS
 * asks, the chart of accounts, and the CPA's last review next to the rules
 * as they're written now. A part that can't be read is named and the rest
 * still shows.
 *
 * POST { action: 'reviewed', fingerprint, note? } — marks it reviewed: the
 * CPA, or a super admin writing down a review the CPA did on paper. The
 * fingerprint is the one the page showed, so a review covers the rules the
 * reviewer saw; a changed one is refused and the page reads them again. The
 * review is kept as it was made (migration 510), with the rules it covered,
 * and audited. No alert: nothing about money changes.
 *
 * Super admins, the bookkeeper and the CPA read it (docs/books.md "Who can
 * open the books"); nothing here changes the books.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;
  try {
    return NextResponse.json(await loadHowItWorks(createServiceClient(), { roles: getProfileRoles(auth.profile) }));
  } catch (err) {
    return failed(err);
  }
}

const Schema = z.object({
  action: z.literal('reviewed'),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().max(NOTE_MAX * 4).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;
  const as = reviewerAs(getProfileRoles(auth.profile));
  if (!as) {
    return NextResponse.json({ error: "Only the CPA, or a super admin writing down the CPA's review, marks this reviewed." }, { status: 403 });
  }

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const cleaned = cleanNote(parsed.data.note);
  if ('error' in cleaned) return NextResponse.json({ error: cleaned.error }, { status: 400 });
  const fingerprint = rulesFingerprint();
  if (parsed.data.fingerprint !== fingerprint) {
    return NextResponse.json({ error: 'How the books work changed since this page opened. Read it again, then mark it reviewed.' }, { status: 409 });
  }

  const name = String(auth.profile?.full_name || auth.user.email || '').trim().slice(0, 200).trim() || 'Someone';
  const service = createServiceClient();
  try {
    const { data, error } = await service.from('books_rules_reviews')
      .insert({ reviewed_by: auth.user.id, reviewed_by_name: name, reviewed_as: as, rules: [...RULE_IDS], fingerprint, note: cleaned.note })
      .select('id, reviewed_at')
      .single();
    if (error || !data) throw new Error(`The review wasn't kept (${error?.message ?? 'nothing came back'})`);
    const kept = data as { id: string; reviewed_at: string };
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'books_rules_reviews',
      recordId: kept.id,
      action: 'reviewed',
      detail: { reviewed_as: as, rules: RULE_IDS.length, fingerprint, note: cleaned.note !== null },
    });
    return NextResponse.json({ id: kept.id, reviewedAt: kept.reviewed_at, reviewedAs: as });
  } catch (err) {
    return failed(err);
  }
}
