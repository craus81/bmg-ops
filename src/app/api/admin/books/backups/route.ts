import { NextRequest, NextResponse } from 'next/server';
import { requireBooks, requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { loadBackups, runBackup } from '@/lib/books/backups';
import { centralTime } from '@/lib/books/backup-workbook';

export const dynamic = 'force-dynamic';
// A backup made by hand runs in the request, as the nightly one does: 270 s
// of its own, so it fails saying how far it got, and 300 as the platform's backstop.
export const maxDuration = 300;

const BUDGET_MS = 270_000;

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

/**
 * GET /api/admin/books/backups — Books → Backups (src/lib/books/backups.ts,
 * docs/books.md "Backups"): the newest backups of FleetSuite's books with how
 * each went, the last good one, whether one is due, when the next nightly
 * one runs, and why BMG's file storage can't take one, if it can't.
 *
 * POST { action: 'back_up' } — makes a backup now, as the nightly run does,
 * and says how it went. One already running is said, not doubled. Audited.
 *
 * Super admins, the bookkeeper and the CPA see the list; making a backup and
 * downloading one (./download) are super admins' only, since a backup holds
 * every table of the books (docs/books.md "Who can open the books").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  try {
    return NextResponse.json(await loadBackups(createServiceClient()));
  } catch (err) {
    return failed(err);
  }
}

const Schema = z.object({ action: z.literal('back_up') });

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const service = createServiceClient();
  try {
    const result = await runBackup(service, {
      how: 'by_hand',
      by: auth.user.id,
      byName: auth.profile?.full_name || auth.user.email || null,
      deadline: Date.now() + BUDGET_MS,
    });
    if (result.state === 'running') {
      const began = result.startedAt ? ` It began ${centralTime(result.startedAt)}.` : '';
      return NextResponse.json({ error: `A backup is already running.${began} How it went shows here when it's done.` }, { status: 409 });
    }
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'books_backups',
      recordId: result.id,
      action: 'back_up_books',
      detail: { state: result.state, file: result.file, bytes: result.bytes, error: result.error },
    });
    if (result.state === 'failed') return NextResponse.json({ id: result.id, error: result.error }, { status: 500 });
    return NextResponse.json({ id: result.id, state: result.state, startedAt: result.startedAt, file: result.file, bytes: result.bytes });
  } catch (err) {
    return failed(err);
  }
}
