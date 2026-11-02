import { NextRequest, NextResponse } from 'next/server';
import { requireBooks, requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { loadBackups, runBackup } from '@/lib/books/backups';
import { loadDrills, runRestoreDrill } from '@/lib/books/restore-drill';
import { centralTime } from '@/lib/books/backup-workbook';

export const dynamic = 'force-dynamic';
// A backup or restore test made by hand runs in the request, as the nightly one
// does: 270 s of its own, so it fails saying how far it got, and 300 as the platform's backstop.
export const maxDuration = 300;

const BUDGET_MS = 270_000;

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

/**
 * GET /api/admin/books/backups — Books → Backups (src/lib/books/backups.ts,
 * docs/books.md "Backups"): the newest backups of FleetSuite's books with how
 * each went, the last good one, whether one is due, when the next nightly
 * one runs, and why BMG's file storage can't take one, if it can't; and under
 * `restore`, the restore tests (src/lib/books/restore-drill.ts, docs/books.md
 * "The restore drill"): the newest with how each went, the last that passed,
 * how the newest good backup's stands, and when the next nightly one runs.
 *
 * POST { action: 'back_up' } — makes a backup now, as the nightly run does,
 * and says how it went. One already running is said, not doubled. Audited.
 *
 * POST { action: 'test_restore' } — puts the newest good backup back into a
 * scratch database and checks it, as the nightly test does, and says how it
 * went. The books themselves are never touched. One already running is said,
 * not doubled. Audited.
 *
 * Super admins, the bookkeeper and the CPA see the list; making a backup,
 * testing a restore and downloading a backup (./download) are super admins'
 * only, since a backup holds every table of the books (docs/books.md "Who can
 * open the books").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  try {
    const service = createServiceClient();
    const [backups, restore] = await Promise.all([loadBackups(service), loadDrills(service)]);
    return NextResponse.json({ ...backups, restore });
  } catch (err) {
    return failed(err);
  }
}

const Schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('back_up') }),
  z.object({ action: z.literal('test_restore') }),
]);

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const service = createServiceClient();
  const byName = auth.profile?.full_name || auth.user.email || null;
  if (parsed.data.action === 'test_restore') {
    try {
      const result = await runRestoreDrill(service, {
        how: 'by_hand',
        by: auth.user.id,
        byName,
        deadline: Date.now() + BUDGET_MS,
      });
      if (result.state === 'running') {
        const began = result.startedAt ? ` It began ${centralTime(result.startedAt)}.` : '';
        return NextResponse.json({ error: `A restore test is already running.${began} How it went shows here when it's done.` }, { status: 409 });
      }
      if (result.state === 'none') {
        return NextResponse.json({ error: "There's no good backup to restore yet." }, { status: 409 });
      }
      await logAudit(service, {
        actorId: auth.user.id,
        table: 'books_restore_drills',
        recordId: result.id,
        action: 'test_restore_books',
        detail: { state: result.state, backup: result.backupId, ...(result.counts ?? {}), error: result.error },
      });
      if (result.state === 'failed') return NextResponse.json({ id: result.id, error: result.error }, { status: 500 });
      return NextResponse.json({ id: result.id, state: result.state, backupId: result.backupId, startedAt: result.startedAt, counts: result.counts });
    } catch (err) {
      return failed(err);
    }
  }
  try {
    const result = await runBackup(service, {
      how: 'by_hand',
      by: auth.user.id,
      byName,
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
